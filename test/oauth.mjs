/* ============================================================
   TEST OAUTH 2.1 — mcp-sqlserv (Claude custom connector flow)
   Jalankan: node test/oauth.mjs  (otomatis spawn server di :4100)
   ============================================================ */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 4100;
const EPH_ADMIN_USER = 'admin';
const EPH_ADMIN_PASSWORD = 'rahasia123';

const BASE = process.env.OAUTH_TEST_BASE || `http://localhost:${SERVER_PORT}`;
const ADMIN_USER = process.env.ADMIN_USER || EPH_ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || EPH_ADMIN_PASSWORD;

/* --- spawn & teardown server sendiri bila tidak memakai server eksternal --- */
let serverProc = null;
if (!process.env.OAUTH_TEST_BASE) {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      DATA_DIR: path.join(__dirname, '..', 'oauth-test-data'),
      ADMIN_USER: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch {
      /* belum up */
    }
    if (Date.now() > deadline) {
      console.error('Server tidak merespons dalam 20 detik.');
      process.exit(1);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}
process.on('exit', () => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
});
process.on('SIGINT', () => process.exit(0));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name} ${extra}`); }
}

/* ---------------- helpers ---------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256b = (s) => crypto.createHash('sha256').update(s).digest();
const randS = (n) => b64url(crypto.randomBytes(n));

function makeVerifier() {
  const verifier = randS(48);
  return { verifier, challenge: b64url(sha256b(verifier)) };
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body, text };
}

let cookies = '';
function storeCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (res.headers.get('set-cookie')) sc.push(res.headers.get('set-cookie'));
  for (const c of sc) {
    const kv = c.split(';')[0];
    if (kv) cookies = (cookies ? cookies + '; ' : '') + kv;
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

async function adminLogin() {
  const res = await req('/oauth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: ADMIN_USER, password: ADMIN_PASSWORD, next: '/oauth/authorize' }),
  });
  storeCookies(res);
  return res;
}

/* ============================================================
   1. Discovery metadata
   ============================================================ */
console.log('\n[DISCOVERY]');

let r = await req('/.well-known/oauth-protected-resource');
check('protected-resource metadata JSON', r.status === 200 && typeof r.body === 'object');
check('resource = <origin>/mcp', typeof r.body?.resource === 'string' && r.body.resource.endsWith('/mcp'), String(r.body?.resource));
check('authorization_servers berisi origin', Array.isArray(r.body?.authorization_servers) && r.body.authorization_servers.length >= 1, JSON.stringify(r.body));

r = await req('/.well-known/oauth-authorization-server');
check('AS metadata JSON', r.status === 200 && typeof r.body === 'object');
check('authorization_endpoint ada', typeof r.body?.authorization_endpoint === 'string' && r.body.authorization_endpoint.includes('/oauth/authorize'));
check('token_endpoint ada', typeof r.body?.token_endpoint === 'string' && r.body.token_endpoint.includes('/oauth/token'));
check('registration_endpoint ada (DCR)', typeof r.body?.registration_endpoint === 'string' && r.body.registration_endpoint.includes('/oauth/register'));
check('PKCE S256 dukungan', Array.isArray(r.body?.code_challenge_methods_supported) && r.body.code_challenge_methods_supported.includes('S256'), JSON.stringify(r.body?.code_challenge_methods_supported));

/* ============================================================
   2. /mcp harus 401 + WWW-Authenticate resource_metadata
   ============================================================ */
console.log('\n[MCP CHALLENGE]');

r = await req('/mcp', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
check('401 tanpa kredensial', r.status === 401, String(r.status));
const www = String(r.headers.get('www-authenticate') ?? '');
check('WWW-Authenticate resource_metadata', /Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/.test(www), www);
check('error JSON-RPC -32001', r.body?.error?.code === -32001, r.text.slice(0, 120));

/* ============================================================
   3. DCR + authorization code + PKCE + token (flow Claude web)
   ============================================================ */
console.log('\n[FLOW: DCR -> LOGIN -> CONSENT -> TOKEN]');

const REDIR = 'https://claude.ai/api/mcp/auth_callback';
r = await req('/oauth/register', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({
    client_name: 'Test Claude Web',
    redirect_uris: [REDIR],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
check('DCR 201 + client_id', r.status === 201 && !!r.body?.client_id, r.text.slice(0, 150));
const clientId = r.body?.client_id;

// deny redirect_uri jelek
r = await req('/oauth/register', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ client_name: 'evil', redirect_uris: ['http://evil.example/cb'] }),
});
check('DCR tolak redirect uri http non-loopback', r.status === 400, r.text.slice(0, 100));

// tanpa login -> halaman login
const { verifier, challenge } = makeVerifier();
const authorizeQs = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIR,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'st123',
  scope: 'mcp',
  resource: BASE + '/mcp',
});
r = await req('/oauth/authorize?' + authorizeQs);
check('login page tanpa sesi (401)', r.status === 401 && r.text.includes('OPERATOR LOGIN'), r.status + ' ' + r.text.slice(0, 80));

// tanpa code_challenge -> ditolak
const qsNoPkce = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIR });
r = await req('/oauth/authorize?' + qsNoPkce);
check('authorize tanpa PKCE ditolak', r.status === 400 && r.text.includes('PKCE'), r.status);

// login admin
r = await adminLogin();
check('login operator sukses (307)', [302, 307].includes(r.status), String(r.status));

// sekarang authorize -> consent
r = await req('/oauth/authorize?' + authorizeQs, { headers: { Cookie: cookies } });
check('consent page shown (200)', r.status === 200 && r.text.includes('Allow'), r.status + ' ' + r.text.slice(0, 100));

// approve
r = await req('/oauth/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
  body: new URLSearchParams({
    decision: 'approve',
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIR,
    scope: 'mcp',
    resource: BASE + '/mcp',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st123',
  }),
});
check('redirect ke claude callback + code + iss + state', r.status === 302 && r.headers.get('location')?.startsWith(REDIR), r.headers.get('location') ?? '');
const loc = new URL(r.headers.get('location'));
const code = loc.searchParams.get('code');
check('ada code', !!code);
check('ada iss (RFC 9207)', !!loc.searchParams.get('iss'), loc.searchParams.get('iss') ?? '');
check('state di-echo', loc.searchParams.get('state') === 'st123');

// tukar code (PKCE benar)
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: REDIR,
    code_verifier: verifier,
    resource: BASE + '/mcp',
  }),
});
check('token exchange sukses', r.status === 200 && !!r.body?.access_token && !!r.body?.refresh_token, r.text.slice(0, 150));
const access = r.body?.access_token;
const refresh = r.body?.refresh_token;
check('access token berprefix oat_', typeof access === 'string' && access.startsWith('oat_'));
check('token_type Bearer + expires_in', r.body?.token_type === 'Bearer' && r.body?.expires_in > 0);

// replay code -> invalid_grant
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIR, code_verifier: verifier }),
});
check('replay code ditolak (invalid_grant)', r.status === 400 && r.body?.error === 'invalid_grant', r.text.slice(0, 100));

// PKCE salah -> invalid_grant
const wrongVerifier = { verifier: randS(48) };
const { challenge: c2 } = makeVerifier();
r = await req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIR, code_challenge: c2, code_challenge_method: 'S256', scope: 'mcp' }), { headers: { Cookie: cookies } });
r = await req('/oauth/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
  body: new URLSearchParams({ decision: 'approve', response_type: 'code', client_id: clientId, redirect_uri: REDIR, code_challenge: c2, code_challenge_method: 'S256', scope: 'mcp' }),
});
const code2 = new URL(r.headers.get('location'))?.searchParams.get('code');
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIR, code_verifier: wrongVerifier.verifier }),
});
check('PKCE verifier salah ditolak', r.status === 400 && r.body?.error === 'invalid_grant', r.text.slice(0, 120));

// /mcp dengan access token OAuth
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const mcpCall = (token, id) =>
  req('/mcp', {
    method: 'POST',
    headers: { ...mcpHeaders, Authorization: `Bearer ${token}`, 'mcp-session-id': `oauth-test-${id}-${randS(6)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });

r = await mcpCall(access, 2);
const okMcp = (rr) => rr.status === 200 && (typeof rr.body === 'string' ? rr.text.includes('"result"') : !!rr.body?.result);
check('initialize dengan access token OAuth diterima', okMcp(r), r.status + ' ' + r.text.slice(0, 150));

// refresh rotation
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
});
check('refresh rotation sukses (pasangan baru)', r.status === 200 && !!r.body?.access_token && !!r.body?.refresh_token, r.text.slice(0, 120));
const refresh2 = r.body?.refresh_token;
const access2 = r.body?.access_token;

r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
});
check('refresh token lama ditolak setelah rotasi', r.status === 400 && r.body?.error === 'invalid_grant', r.text.slice(0, 100));

r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh2, client_id: clientId }),
});
check('refresh token baru tetap valid', r.status === 200 && !!r.body?.access_token, r.text.slice(0, 100));
const access3 = r.body?.access_token;

r = await mcpCall(access3, 3);
check('access token hasil refresh diterima /mcp', okMcp(r), r.status + ' ' + r.text.slice(0, 150));

// API key lama tetap jalan
const keyRes = await req('/api/auth/login', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASSWORD }),
});
storeCookies(keyRes);
check('login admin API ok', keyRes.status === 200 && keyRes.body?.ok === true, keyRes.text.slice(0, 100));
const keyCreated = await req('/api/keys', { method: 'POST', headers: { ...jsonHeaders, Cookie: cookies }, body: JSON.stringify({ name: 'oauth-test-key' }) });
check('buat API key admin ok', keyCreated.status === 200 && keyCreated.body?.plainKey?.startsWith('sk-'), keyCreated.text.slice(0, 100));

/* ============================================================
   4. Client confidential (client_secret) — isi form Claude
   ============================================================ */
console.log('\n[FLOW: PRE-REGISTERED CONFIDENTIAL CLIENT]');

const adminCreate = await req('/api/oauth-clients', {
  method: 'POST',
  headers: { ...jsonHeaders, Cookie: cookies },
  body: JSON.stringify({ name: 'claude-web', redirectUris: [REDIR], confidential: true }),
});
check('admin buat client confidential', adminCreate.status === 200 && !!adminCreate.body?.client?.clientId && !!adminCreate.body?.plainSecret, adminCreate.text.slice(0, 150));
const cid = adminCreate.body?.client?.clientId;
const csecret = adminCreate.body?.plainSecret;

// authorize + approve sebagai client confidential (tanpa PKCE dilarang juga)
const v3 = makeVerifier();
r = await req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIR, code_challenge: v3.challenge, code_challenge_method: 'S256', scope: 'mcp' }), { headers: { Cookie: cookies } });
check('consent client pre-registered', r.status === 200 && r.text.includes('Allow'), r.status);
r = await req('/oauth/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
  body: new URLSearchParams({ decision: 'approve', response_type: 'code', client_id: cid, redirect_uri: REDIR, code_challenge: v3.challenge, code_challenge_method: 'S256', scope: 'mcp' }),
});
const code3 = new URL(r.headers.get('location'))?.searchParams.get('code');

// token tanpa secret -> invalid_client
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code3, client_id: cid, redirect_uri: REDIR, code_verifier: v3.verifier }),
});
check('confidential tanpa secret ditolak', r.status === 401 && r.body?.error === 'invalid_client', r.text.slice(0, 100));

// token dengan secret salah -> invalid_client
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code3, client_id: cid, redirect_uri: REDIR, code_verifier: v3.verifier, client_secret: 'wrong' }),
});
check('confidential secret salah ditolak', r.status === 401 && r.body?.error === 'invalid_client', r.text.slice(0, 100));

// code3 sudah dipakai saat attempt pertama? Tidak — ditolak di clientAuth sebelum consume.
// secret benar via Basic auth
r = await req('/oauth/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from(`${cid}:${csecret}`).toString('base64'),
  },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code3, client_id: cid, redirect_uri: REDIR, code_verifier: v3.verifier, resource: BASE + '/mcp' }),
});
check('token dengan Basic auth (client_secret_basic) sukses', r.status === 200 && !!r.body?.access_token, r.text.slice(0, 150));
const access4 = r.body?.access_token;
r = await mcpCall(access4, 4);
check('access token client confidential diterima /mcp', okMcp(r), r.status + ' ' + r.text.slice(0, 150));

/* ============================================================
   5. Loopback redirect (Claude Code) port-agnostic
   ============================================================ */
console.log('\n[FLOW: LOOPBACK REDIRECT — CLAUDE CODE]');

r = await req('/oauth/register', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ client_name: 'claude-code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
});
const ccId = r.body?.client_id;
check('DCR client claude-code', r.status === 201 && !!ccId);

const v4 = makeVerifier();
const loopbackQs = new URLSearchParams({ response_type: 'code', client_id: ccId, redirect_uri: 'http://127.0.0.1:4321/callback', code_challenge: v4.challenge, code_challenge_method: 'S256', scope: 'mcp' });
r = await req('/oauth/authorize?' + loopbackQs, { headers: { Cookie: cookies } });
check('loopback different port accepted (RFC 8252 §7.3)', r.status === 200 && r.text.includes('Allow'), r.status + ' ' + r.text.slice(0, 120));
r = await req('/oauth/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
  body: new URLSearchParams({ decision: 'approve', response_type: 'code', client_id: ccId, redirect_uri: 'http://127.0.0.1:4321/callback', code_challenge: v4.challenge, code_challenge_method: 'S256', scope: 'mcp' }),
});
const code4 = new URL(r.headers.get('location'))?.searchParams.get('code');
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code4, client_id: ccId, redirect_uri: 'http://127.0.0.1:4321/callback', code_verifier: v4.verifier }),
});
check('token loopback redirect sukses', r.status === 200 && !!r.body?.access_token, r.text.slice(0, 120));

// redirect uri asing ditolak
r = await req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: ccId, redirect_uri: 'https://evil.example/cb', code_challenge: v4.challenge, code_challenge_method: 'S256' }), { headers: { Cookie: cookies } });
check('redirect uri asing ditolak', r.status === 400 && r.text.includes('redirect_uri'), r.status);

/* ============================================================
   6. Revoke client
   ============================================================ */
console.log('\n[REVOKE]');

// token segar untuk client publik DCR (clientId)
const v5 = makeVerifier();
r = await req('/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIR, code_challenge: v5.challenge, code_challenge_method: 'S256', scope: 'mcp' }), { headers: { Cookie: cookies } });
r = await req('/oauth/authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
  body: new URLSearchParams({ decision: 'approve', response_type: 'code', client_id: clientId, redirect_uri: REDIR, code_challenge: v5.challenge, code_challenge_method: 'S256', scope: 'mcp' }),
});
const code5v = new URL(r.headers.get('location'))?.searchParams.get('code');
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: code5v, client_id: clientId, redirect_uri: REDIR, code_verifier: v5.verifier }),
});
const freshRefresh = r.body?.refresh_token;
check('token segar siap untuk uji revoke', r.status === 200 && !!freshRefresh, r.text.slice(0, 100));

// revoke client publik DCR -> semua token & refresh client mati
r = await req('/api/oauth-clients/' + clientId, { method: 'DELETE', headers: { Cookie: cookies } });
check('revoke client publik ok', r.status === 200 && r.body?.ok === true, r.text.slice(0, 100));
r = await req('/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: freshRefresh, client_id: clientId }),
});
check('refresh client yang di-revoke ditolak (invalid_client)', r.status === 401 && r.body?.error === 'invalid_client', r.text.slice(0, 100));

console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);