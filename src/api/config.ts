import express from 'express';
import { storage } from '../db/storage.js';
import { getPool, resolveConfig, testConnection, closePool } from '../sqlserver/connection.js';
import { invalidateTableCache } from '../sqlserver/metadata.js';

function sanitizeConfig(cfg: NonNullable<ReturnType<typeof resolveConfig>>) {
  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    database: cfg.database,
    encrypt: cfg.encrypt,
    trustServerCert: cfg.trustServerCert,
  };
}

export function configRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const cfg = resolveConfig();
    res.json({ configured: !!cfg, config: cfg ? sanitizeConfig(cfg) : null });
  });

  router.put('/', async (req, res) => {
    const body = (req.body ?? {}) as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      database?: string;
      encrypt?: boolean;
      trustServerCert?: boolean;
    };
    const host = body.host?.trim();
    const database = body.database?.trim();
    const username = body.username?.trim();
    const password = body.password;
    const port = Number(body.port);

    if (!host) return res.status(400).json({ error: 'Host is required' });
    if (!username) return res.status(400).json({ error: 'Username is required' });
    if (!database) return res.status(400).json({ error: 'Database name is required' });
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Invalid port (1-65535)' });
    }

    const existing = resolveConfig();
    const finalPassword = password ?? (existing ? storage.decrypt(storage.getDbConfig()!.password_enc) : '');

    storage.saveDbConfig({
      host,
      port,
      username,
      password: finalPassword,
      database,
      encrypt: body.encrypt ?? true,
      trustServerCert: body.trustServerCert ?? !(body.encrypt ?? true),
    });
    closePool().catch(() => undefined);
    invalidateTableCache();
    res.json({ ok: true });
  });

  router.post('/test', async (req, res) => {
    const body = (req.body ?? {}) as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      database?: string;
      encrypt?: boolean;
      trustServerCert?: boolean;
    };
    const existing = resolveConfig();
    const cfg = {
      host: body.host?.trim() || existing?.host || '',
      port: Number(body.port ?? existing?.port ?? 1433),
      username: body.username?.trim() || existing?.username || '',
      password: body.password ?? (existing ? storage.decrypt(storage.getDbConfig()!.password_enc) : ''),
      database: body.database?.trim() || existing?.database || '',
      encrypt: body.encrypt ?? existing?.encrypt ?? true,
      trustServerCert: body.trustServerCert ?? existing?.trustServerCert ?? false,
    };
    const result = await testConnection(cfg);
    res.json(result);
  });

  router.post('/refresh', async (_req, res) => {
    closePool().catch(() => undefined);
    invalidateTableCache();
    res.json({ ok: true });
  });

  router.get('/status', async (_req, res) => {
    try {
      const pool = await getPool();
      const r = await pool.request().query('SELECT 1 AS ok');
      res.json({ connected: r.recordset[0]?.ok === 1 });
    } catch (err) {
      res.json({ connected: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}