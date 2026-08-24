import express from 'express';
import crypto from 'node:crypto';
import { config, oauthConfig } from '../config.js';
import { sha256, storage, registryStorage, openProjectStorage, withProject, type OauthClientRow } from '../db/storage.js';
import { readAdminSession, setAdminSession } from '../api/auth.js';
import { consentPageHtml, errorPageHtml, loginPageHtml } from './pages.js';
import {
  b64url,
  clientIpOf,
  constantTimeEqual,
  hitLimit,
  isAllowedRedirectUri,
  originOf,
  randId,
  randToken,
  redirectUriMatches,
} from './helpers.js';

/* ============================================================
   OAuth 2.1 Authorization Server untuk mcp-sqlserv.
   - Authorization Code + PKCE (S256) — wajib untuk Claude
   - RFC 7591 Dynamic Client Registration
   - RFC 8707 resource indicator, RFC 9207 iss parameter
   - Redirect URI host Claude (web/desktop):
     https://claude.ai/api/mcp/auth_callback
   - Identitas consent = sesi admin (ADMIN_USER / ADMIN_PASSWORD)
   - Access token memetakan ke API key `oauth:<client_id>` sehingga
     izin tabel, rate limit, dan audit log existing tetap berlaku.
   ============================================================ */

function codeChallengeS256(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

function validateScope(scope: string | undefined): string | null {
  if (!scope) return 'mcp';
  const parts = String(scope).split(/\s+/).filter(Boolean);
  if (parts.length && parts.every((s) => oauthConfig.allowedScopes.includes(s))) return parts.join(' ');
  return null;
}

/** Cek kredensial client confidential (basic / post). */
function confidentialOk(row: OauthClientRow, secret?: string): boolean {
  if (!row.client_secret_hash) return false;
  return !!secret && constantTimeEqual(sha256(secret), row.client_secret_hash);
}

/** Cari client lintas project (setiap project punya DB sendiri). */
function findClientOwner(clientId: string): { pid: string; row: OauthClientRow } | null {
  if (!clientId) return null;
  for (const p of registryStorage.listProjects()) {
    const row = openProjectStorage(p.id).findOauthClient(clientId);
    if (row) return { pid: p.id, row };
  }
  return null;
}

/** Project tujuan DCR: dari resource (URL /mcp/<projectId>), fallback project tunggal/default. */
function resolveRegistrationProject(resource: string | undefined): string | null {
  if (resource) {
    const extId = (url: string): string | null => {
      try {
        const m = /\/mcp\/([A-Za-z0-9_-]+)\/?$/.exec(new URL(url).pathname);
        return m ? m[1] : null;
      } catch {
        const m = /\/mcp\/([A-Za-z0-9_-]+)\/?$/.exec(url);
        return m ? m[1] : null;
      }
    };
    const pid = extId(resource);
    if (pid) {
      if (registryStorage.getProject(pid)) return pid;
      return null;
    }
  }
  const all = registryStorage.listProjects();
  if (all.length === 0) return null;
  if (all.length === 1) return all[0].id;
  return all.find((p) => p.id === 'default')?.id ?? all[0].id;
}

function clientAuth(req: express.Request): { ok: true; row: OauthClientRow; pid: string } | { ok: false; error: string } {
  const owner = findClientOwner(String(req.body?.client_id ?? ''));
  if (!owner || owner.row.revoked === 1) return { ok: false, error: 'invalid_client' };
  const row = owner.row;
  const method = row.token_endpoint_auth_method;
  if (method === 'none') return { ok: true, row, pid: owner.pid };
  const header = req.headers.authorization ?? '';
  if (method === 'client_secret_basic') {
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (!m) return { ok: false, error: 'invalid_client' };
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return { ok: false, error: 'invalid_client' };
    if (decoded.slice(0, sep) !== row.client_id || !confidentialOk(row, decoded.slice(sep + 1))) {
      return { ok: false, error: 'invalid_client' };
    }
    return { ok: true, row, pid: owner.pid };
  }
  if (!confidentialOk(row, String(req.body?.client_secret ?? ''))) return { ok: false, error: 'invalid_client' };
  return { ok: true, row, pid: owner.pid };
}

function issueTokens(row: { client_id: string; api_key_id: string; scope: string }): { accessToken: string; refreshToken: string } {
  const now = Date.now();
  const accessToken = randToken('oat_');
  const refreshToken = randToken('ort_');
  storage.saveOauthToken({
    token_hash: sha256(accessToken),
    client_id: row.client_id,
    api_key_id: row.api_key_id,
    scope: row.scope,
    expires_at: now + oauthConfig.accessTtlMs,
    refresh_token_hash: sha256(refreshToken),
    refresh_expires_at: now + oauthConfig.refreshTtlMs,
    revoked: 0,
    created_at: now,
  });
  return { accessToken, refreshToken };
}

function tokenResponse(res: express.Response, row: { client_id: string; api_key_id: string; scope: string }): void {
  const { accessToken, refreshToken } = issueTokens(row);
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(oauthConfig.accessTtlMs / 1000),
    refresh_token: refreshToken,
    scope: row.scope,
  });
}

export function oauthRouter(): express.Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '256kb' });

  /* ---- RFC 7591: Dynamic Client Registration ---- */
  router.post('/register', form, (req, res) => {
    const ip = clientIpOf(req);
    if (hitLimit(ip, 'oauth-register', oauthConfig.registerRateLimit)) {
      res.status(429).json({ error: 'invalid_request', error_description: 'Terlalu banyak registrasi client.' });
      return;
    }
    const meta = (req.body ?? {}) as Record<string, unknown>;
    const pid = resolveRegistrationProject(String(meta.resource ?? ''));
    if (!pid) {
      const hasProjectRef = meta.resource && /\/mcp\/[A-Za-z0-9_-]+\/?$/.test(String(meta.resource));
      res.status(422).json({
        error: 'invalid_request',
        error_description: hasProjectRef
          ? 'Project pada URL resource (bagian /mcp/<id>) tidak dikenal di konsol admin.'
          : 'Belum ada project untuk registrasi client. Buat project dulu di konsol admin.',
      });
      return;
    }
    const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.map(String) : [];
    if (!redirectUris.length || !redirectUris.every(isAllowedRedirectUri)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris wajib HTTPS atau http://localhost (loopback).',
      });
      return;
    }
    if (validateScope(meta.scope ? String(meta.scope) : undefined) === null) {
      res.status(400).json({ error: 'invalid_scope', error_description: `scope harus salah satu dari: ${oauthConfig.allowedScopes.join(', ')}.` });
      return;
    }

    const allowedMethods = ['none', 'client_secret_basic', 'client_secret_post'];
    const authMethod = allowedMethods.includes(String(meta.token_endpoint_auth_method ?? 'none'))
      ? String(meta.token_endpoint_auth_method ?? 'none')
      : 'none';
    const grantTypes = Array.isArray(meta.grant_types) ? meta.grant_types.map(String) : ['authorization_code', 'refresh_token'];
    if (!grantTypes.length || !grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'grant_types tidak didukung.' });
      return;
    }
    const responseTypes = Array.isArray(meta.response_types) ? meta.response_types.map(String) : ['code'];
    if (!responseTypes.every((t) => t === 'code')) {
      res.status(400).json({ error: 'invalid_request', error_description: 'response_types harus ["code"].' });
      return;
    }

    const clientId = randId(16);
    const clientName = String(meta.client_name ?? 'mcp-client').slice(0, 200);
    let secret: string | null = null;
    let secretHash: string | null = null;
    if (authMethod !== 'none') {
      secret = randToken('ocs_', 32);
      secretHash = sha256(secret);
    }
    withProject(pid, () => {
      storage.createOauthClient({
        clientId,
        clientName,
        clientSecretHash: secretHash,
        redirectUris,
        tokenEndpointAuthMethod: authMethod,
        dynamic: true,
        resource: String(meta.resource ?? '') || null,
      });
    });
    const out: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: grantTypes,
      response_types: responseTypes,
    };
    if (secret) out.client_secret = secret;
    res.status(201).json(out);
  });

  /* ---- Authorization endpoint (GET = login/consent page) ---- */
  router.get('/authorize', (req, res) => {
    const q = req.query;
    const owner = findClientOwner(String(q.client_id ?? ''));
    if (!owner || owner.row.revoked === 1) {
      res.status(400).send(errorPageHtml('Client tidak dikenal atau sudah dicabut.'));
      return;
    }
    const client = owner.row;
    if (String(q.response_type ?? '') !== 'code') {
      res.status(400).send(errorPageHtml('response_type harus "code".'));
      return;
    }
    const redirectUri = String(q.redirect_uri ?? '');
    const registered = (JSON.parse(client.redirect_uris) as string[]).find((r) => redirectUriMatches(r, redirectUri));
    if (!registered) {
      res.status(400).send(errorPageHtml('redirect_uri tidak terdaftar untuk client ini.'));
      return;
    }
    const challenge = String(q.code_challenge ?? '');
    if (!challenge || String(q.code_challenge_method ?? '') !== 'S256') {
      res.status(400).send(errorPageHtml('PKCE wajib: code_challenge + code_challenge_method=S256.'));
      return;
    }
    const scope = validateScope(q.scope ? String(q.scope) : undefined);
    if (scope === null) {
      res.status(400).send(errorPageHtml(`Scope tidak didukung. Tersedia: ${oauthConfig.allowedScopes.join(', ')}.`));
      return;
    }
    const resource = q.resource ? String(q.resource) : `${originOf(req)}/mcp`;

    if (!readAdminSession(req)) {
      res.status(401).send(loginPageHtml(req.query.note === 'reload' ? 'Sesi sudah kedaluwarsa, silakan login ulang.' : undefined));
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.send(
      consentPageHtml({
        clientName: client.client_name,
        clientId: client.client_id,
        redirectUri,
        scope,
        resource,
        codeChallenge: challenge,
        state: String(q.state ?? ''),
      }),
    );
  });

  /* ---- Login operator (sesi admin untuk consent) ---- */
  router.post('/login', form, (req, res) => {
    const { user, password } = (req.body ?? {}) as { user?: string; password?: string };
    const ip = clientIpOf(req);
    if (hitLimit(ip, 'oauth-login', 10)) {
      res.status(429).send(loginPageHtml('Terlalu banyak percobaan. Coba lagi nanti.'));
      return;
    }
    if (user !== config.adminUser || !constantTimeEqual(password ?? '', config.adminPassword)) {
      res.status(401).send(loginPageHtml('User atau kunci akses salah.'));
      return;
    }
    setAdminSession(res, req);
    // Validasi `next`: hanya izinkan path relatif same-origin (cegah open redirect).
    const rawNext = String(req.body?.next ?? '/oauth/authorize').slice(0, 4096);
    const next = /^\/(?!\/)/.test(rawNext) ? rawNext : '/oauth/authorize';
    res.redirect(307, next);
  });

  /* ---- Consent submit ---- */
  router.post('/authorize', form, (req, res) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const owner = findClientOwner(String(b.client_id ?? ''));
    if (!owner || owner.row.revoked === 1) {
      res.status(400).send(errorPageHtml('Client tidak dikenal atau sudah dicabut.'));
      return;
    }
    const client = owner.row;
    if (String(b.response_type ?? '') !== 'code' || String(b.code_challenge_method ?? '') !== 'S256' || !b.code_challenge) {
      res.status(400).send(errorPageHtml('Parameter authorization tidak valid.'));
      return;
    }
    const redirectUri = String(b.redirect_uri ?? '');
    const registered = (JSON.parse(client.redirect_uris) as string[]).find((r) => redirectUriMatches(r, redirectUri));
    if (!registered) {
      res.status(400).send(errorPageHtml('redirect_uri tidak terdaftar untuk client ini.'));
      return;
    }
    if (!readAdminSession(req)) {
      res.status(401).send(loginPageHtml('Sesi berakhir. Silakan login ulang.'));
      return;
    }
    const scope = validateScope(String(b.scope ?? 'mcp'));
    if (scope === null) {
      res.status(400).send(errorPageHtml('Scope tidak didukung.'));
      return;
    }
    const state = String(b.state ?? '');
    const issuer = originOf(req);

    if (String(b.decision ?? '') !== 'approve') {
      const target = new URL(redirectUri);
      target.searchParams.set('error', 'access_denied');
      if (state) target.searchParams.set('state', state);
      res.redirect(302, target.toString());
      return;
    }

    let code = '';
    withProject(owner.pid, () => {
      const apiKeyRow = storage.getOauthApiKey(client.client_id);
      code = randToken('', 16);
      storage.saveOauthCode({
        code_hash: sha256(code),
        client_id: client.client_id,
        api_key_id: apiKeyRow.id,
        redirect_uri: redirectUri,
        code_challenge: String(b.code_challenge),
        resource: String(b.resource ?? `${issuer}/mcp`),
        scope,
        expires_at: Date.now() + oauthConfig.codeTtlMs,
        used_at: null,
      });
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('iss', issuer);
    if (state) target.searchParams.set('state', state);
    res.redirect(302, target.toString());
  });

  /* ---- Token endpoint (auth code PKCE + refresh rotation) ---- */
  router.post('/token', form, (req, res) => {
    const ip = clientIpOf(req);
    if (hitLimit(ip, 'oauth-token', oauthConfig.tokenRateLimit)) {
      res.status(429).json({ error: 'slow_down', error_description: 'Terlalu banyak permintaan token.' });
      return;
    }
    const grant = String(req.body?.grant_type ?? '');
    const auth = clientAuth(req);
    if (!auth.ok) {
      res.set('WWW-Authenticate', 'Basic realm="mcp"');
      res.status(401).json({ error: 'invalid_client', error_description: 'Kredensial client tidak valid.' });
      return;
    }
    withProject(auth.pid, () => {
      const client = auth.row;

      if (grant === 'authorization_code') {
        const code = String(req.body?.code ?? '');
        const row = storage.getOauthCode(sha256(code));
        if (!row || row.client_id !== client.client_id || row.used_at !== null || row.expires_at < Date.now()) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'Code tidak valid atau sudah dipakai.' });
          return;
        }
        if (row.redirect_uri !== String(req.body?.redirect_uri ?? '')) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri tidak cocok dengan code.' });
          return;
        }
        if (req.body?.resource !== undefined && String(req.body.resource) !== String(row.resource)) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'resource tidak cocok dengan code.' });
          return;
        }
        const verifier = String(req.body?.code_verifier ?? '');
        if (!verifier || codeChallengeS256(verifier) !== row.code_challenge) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification gagal.' });
          return;
        }
        storage.markOauthCodeUsed(row.code_hash);
        tokenResponse(res, { client_id: client.client_id, api_key_id: row.api_key_id, scope: row.scope });
        return;
      }

      if (grant === 'refresh_token') {
        const refresh = String(req.body?.refresh_token ?? '');
        const row = storage.findOauthTokenByRefreshHash(sha256(refresh));
        if (!row || row.client_id !== client.client_id || row.revoked === 1 || (row.refresh_expires_at ?? 0) < Date.now()) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token tidak valid.' });
          return;
        }
        storage.revokeOauthTokenByHash(row.token_hash);
        tokenResponse(res, { client_id: client.client_id, api_key_id: row.api_key_id, scope: row.scope });
        return;
      }

      res.status(400).json({ error: 'unsupported_grant_type', error_description: 'grant_type harus authorization_code atau refresh_token.' });
    });
  });

  /* ---- Revocation (RFC 7009) ---- */
  router.post('/revoke', form, (req, res) => {
    const token = String(req.body?.token ?? '');
    if (!token || !/^(oat_|ort_)/.test(token)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'token wajib diisi.' });
      return;
    }
    const hash = sha256(token);
    for (const p of registryStorage.listProjects()) openProjectStorage(p.id).revokeOauthTokenByHash(hash);
    res.json({});
  });

  return router;
}