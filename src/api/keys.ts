import express from 'express';
import { randomUUID } from 'node:crypto';
import { storage } from '../db/storage.js';

export function keysRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const keys = storage.listApiKeys().map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revoked: k.revoked === 1,
    }));
    res.json({ keys });
  });

  router.post('/', (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 64) || 'API Key';
    const { row, plainKey } = storage.createApiKey(name);
    res.json({
      key: {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        createdAt: row.created_at,
        revoked: false,
      },
      plainKey,
      // plainKey hanya dikembalikan SEKALI ini. Tidak dapat diambil lagi.
    });
  });

  router.put('/:id', (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
    const ok = storage.renameApiKey(req.params.id, name);
    res.json({ ok });
  });

  // DELETE = revoke (soft); DELETE ?permanent=1 = hapus permanen
  router.delete('/:id', (req, res) => {
    const ok =
      req.query?.permanent === '1'
        ? storage.deleteApiKey(req.params.id)
        : storage.revokeApiKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'API key tidak ditemukan' });
    res.json({ ok });
  });

  router.post('/generate-sample', (_req, res) => {
    // bantuan: buat key sample untuk testing (diberi nama jelas)
    const { row, plainKey } = storage.createApiKey(`sample-${randomUUID().slice(0, 8)}`);
    res.json({ id: row.id, plainKey });
  });

  return router;
}