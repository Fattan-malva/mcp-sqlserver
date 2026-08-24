import express from 'express';
import { storage } from '../db/storage.js';
import { getTableListCached, sanitizeIdentifier, invalidateTableCache, type TableInfo } from '../sqlserver/metadata.js';
import { notifyResourcesChanged } from '../mcp/changes.js';

export function permissionsRouter(): express.Router {
  const router = express.Router();

  /**
   * GET /api/permissions
   * Metadta: daftar tabel live dari DB + permission yang tersimpan.
   * Tabel tanpa permission = DENY (default deny).
   */
  router.get('/', async (_req, res) => {
    const stored = storage.listPermissions();
    let tables: TableInfo[] = [];
    let error: string | null = null;
    const cfg = storage.getDbConfig();
    if (!cfg) {
      error = 'Database connection not configured';
    } else {
      try {
        tables = await getTableListCached();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    const byName = new Map(stored.map((p) => [p.table_name, p]));
    const items = tables.map((t) => {
      const perm = byName.get(t.name);
      return {
        schema: t.schema,
        table: t.name,
        rowCount: t.rowCount,
        allowRead: perm ? perm.allow_read === 1 : false,
        allowSchema: perm ? perm.allow_schema === 1 : false,
        registered: !!perm,
      };
    });
    res.json({ tables: items, stored, configError: error, defaultDeny: true });
  });

  router.put('/', (req, res) => {
    const body = (req.body ?? {}) as {
      tables?: { table: string; schema?: string; allowRead: boolean; allowSchema: boolean }[];
    };
    const items = body.tables ?? [];
    if (items.length > 5000) return res.status(400).json({ error: 'Too many tables' });
    try {
      const rows = items.map((it) => {
        const tableName = sanitizeIdentifier(it.table);
        const schemaName = it.schema ? sanitizeIdentifier(it.schema) : 'dbo';
        return {
          tableName,
          schemaName,
          allowRead: !!it.allowRead,
          allowSchema: !!it.allowSchema,
        };
      });
      storage.replacePermissions(rows);
      invalidateTableCache();
      notifyResourcesChanged();
      res.json({ ok: true, updated: rows.length });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Refresh cache metadata setelah tabel berubah di DB
  router.post('/refresh', async (_req, res) => {
    try {
      invalidateTableCache();
      await getTableListCached();
      notifyResourcesChanged();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}