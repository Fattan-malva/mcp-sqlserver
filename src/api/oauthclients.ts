import express from 'express';
import { sha256, storage } from '../db/storage.js';
import { isAllowedRedirectUri, randId, randToken } from '../oauth/helpers.js';

export function oauthClientsRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const clients = storage.listOauthClients().map((c) => ({
      clientId: c.client_id,
      name: c.client_name,
      redirectUris: JSON.parse(c.redirect_uris) as string[],
      authMethod: c.token_endpoint_auth_method,
      dynamic: c.is_dynamic === 1,
      createdAt: c.created_at,
      revoked: c.revoked === 1,
    }));
    res.json({ clients });
  });

  router.post('/', (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Client name is required.' });
    const rawUris = Array.isArray(req.body?.redirectUris) ? req.body.redirectUris.map(String) : [];
    const redirectUris = rawUris.map((u: string) => u.trim()).filter(Boolean);
    if (!redirectUris.length || !redirectUris.every(isAllowedRedirectUri)) {
      return res.status(400).json({ error: 'At least one redirect URI is required: HTTPS or http://localhost (loopback).' });
    }
    const confidential = req.body?.confidential === true;

    const clientId = randId(16);
    let secret: string | null = null;
    let secretHash: string | null = null;
    const authMethod = confidential ? 'client_secret_basic' : 'none';
    if (confidential) {
      secret = randToken('ocs_', 32);
      secretHash = sha256(secret);
    }
    storage.createOauthClient({
      clientId,
      clientName: name,
      clientSecretHash: secretHash,
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
      dynamic: false,
    });
    res.json({
      client: {
        clientId,
        name,
        redirectUris,
        authMethod,
        dynamic: false,
        createdAt: new Date().toISOString(),
        revoked: false,
      },
      // Dikembalikan SEKALI ini saja, tidak dapat diambil lagi.
      ...(secret ? { plainSecret: secret } : {}),
    });
  });

  // DELETE = revoke (soft); DELETE ?permanent=1 = hapus permanen + cascade token/code/key
  router.delete('/:clientId', (req, res) => {
    if (req.query?.permanent === '1') {
      const ok = storage.deleteOauthClient(req.params.clientId);
      if (!ok) return res.status(404).json({ error: 'OAuth client tidak ditemukan' });
      return res.json({ ok });
    }
    const ok = storage.revokeOauthClient(req.params.clientId);
    if (!ok) return res.status(404).json({ error: 'OAuth client tidak ditemukan' });
    if (ok) storage.revokeOauthTokensByClient(req.params.clientId);
    res.json({ ok });
  });

  return router;
}