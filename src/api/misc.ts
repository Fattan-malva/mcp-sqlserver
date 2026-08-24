import express from 'express';
import { storage } from '../db/storage.js';
import { getStatus } from './auth.js';

export function auditRouter(): express.Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500);
    const tool = typeof req.query.tool === 'string' && req.query.tool ? req.query.tool : undefined;
    const tableName = typeof req.query.table === 'string' && req.query.table ? req.query.table : undefined;
    const rows = storage.listAudit(limit, { tool, tableName });
    res.json({ rows });
  });

  return router;
}

export function statusRouter(): express.Router {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    const status = await getStatus();
    let dbConnected: boolean | null = null;
    let dbError: string | null = null;
    if (status.dbConfigured) {
      try {
        const { getPool } = await import('../sqlserver/connection.js');
        const pool = await getPool();
        const r = await pool.request().query('SELECT 1 AS ok');
        dbConnected = r.recordset[0]?.ok === 1;
      } catch (err) {
        dbConnected = false;
        dbError = err instanceof Error ? err.message : String(err);
      }
    }
    res.json({ ...status, dbConnected, dbError, version: '1.0.0' });
  });
  return router;
}