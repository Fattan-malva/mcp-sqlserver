import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { storage, type CustomToolRow } from '../db/storage.js';
import {
  BUILTIN_TOOL_NAMES,
  TOOL_NAME_RE,
  toolParamSchema,
  builderDefSchema,
  sqlDefSchema,
  parseCustomToolDef,
  validateToolDefinition,
  runCustomTool,
  type CustomToolDef,
} from '../mcp/customTools.js';
import { tools, recordAudit, type ToolContext } from '../mcp/tools.js';
import { notifyToolsChanged } from '../mcp/changes.js';
import type { ApiKeyRow } from '../db/storage.js';
import { extractTableRefs } from '../sqlserver/sqlGuard.js';

const customToolPayloadSchema = z
  .object({
    name: z.string().regex(TOOL_NAME_RE, 'Nama tool: huruf kecil a-z, angka, underscore; maks 64'),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    mode: z.enum(['builder', 'sql']),
    builder: builderDefSchema.optional(),
    sql: sqlDefSchema.optional(),
    params: z.array(toolParamSchema).max(20).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'builder' && !v.builder) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode builder butuh definisi builder' });
    }
    if (v.mode === 'sql' && !v.sql) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mode sql butuh isi query' });
    }
  });

const zPayload = (v: unknown): CustomToolPayload => z.parse(customToolPayloadSchema, v);

type CustomToolPayload = z.infer<typeof customToolPayloadSchema>;

function toDef(p: CustomToolPayload): CustomToolDef {
  return {
    mode: p.mode,
    builder: p.builder,
    sql: p.sql?.sql,
    params: p.params as CustomToolDef['params'],
  };
}

const MAX_PREVIEW_ROWS = 200;

function testAuditCtx(req: express.Request, toolName: string, tableName: string | null): { ctx: ToolContext; tool: string; table: string | null } {
  const key: ApiKeyRow = {
    id: `admin-test:${toolName}`,
    name: 'Playground test (UI)',
    key_hash: '',
    key_prefix: 'test',
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: 0,
  };
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'web-ui';
  return { ctx: { key, ip }, tool: toolName, table: tableName };
}

function toRow(p: CustomToolPayload): CustomToolRow {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: p.name,
    title: p.title,
    description: p.description,
    mode: p.mode,
    definition: JSON.stringify({ mode: p.mode, builder: p.builder, sql: p.sql?.sql, params: p.params }),
    enabled: 1,
    created_at: now,
    updated_at: now,
  };
}

export function toolsRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const settings = new Map(storage.listToolSettings().map((s) => [s.name, s.enabled === 1]));
      const builtin = tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        enabled: settings.get(t.name) ?? true,
      }));
      const custom = storage.listCustomTools().map((row) => ({ ...row, definition: parseCustomToolDef(row) }));
      res.json({ builtin, custom });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/builtin', async (req, res) => {
    const body = (req.body ?? {}) as { tools?: { name: string; enabled: boolean }[] };
    const items = body.tools ?? [];
    try {
      if (items.length === 0) return res.json({ ok: true, updated: 0 });
      const valid = new Set(BUILTIN_TOOL_NAMES);
      for (const it of items) {
        if (!valid.has(it.name)) throw new Error(`Tool built-in tidak dikenal: ${it.name}`);
      }
      storage.setToolSettings(items.map((it) => ({ name: it.name, enabled: !!it.enabled })));
      notifyToolsChanged();
      res.json({ ok: true, updated: items.length });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const payload = zPayload(req.body);
      if (BUILTIN_TOOL_NAMES.includes(payload.name)) {
        return res.status(400).json({ error: `Nama "${payload.name}" bentrok dengan tool bawaan` });
      }
      if (storage.getCustomToolByName(payload.name)) {
        return res.status(400).json({ error: `Tool "${payload.name}" sudah ada` });
      }
      const def = toDef(payload);
      await validateToolDefinition(def);
      storage.saveCustomTool(toRow(payload));
      notifyToolsChanged();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const existing = storage.getCustomTool(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Tool tidak ditemukan' });
      const payload = zPayload(req.body);
      if (payload.name !== existing.name && storage.getCustomToolByName(payload.name)) {
        return res.status(400).json({ error: `Tool "${payload.name}" sudah ada` });
      }
      const def = toDef(payload);
      await validateToolDefinition(def);
      const row = toRow(payload);
      row.id = existing.id;
      row.created_at = existing.created_at;
      storage.saveCustomTool(row);
      notifyToolsChanged();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const existing = storage.getCustomTool(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Tool tidak ditemukan' });
      const body = (req.body ?? {}) as { enabled?: boolean };
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'Field enabled wajib boolean' });
      const def = parseCustomToolDef(existing);
      if (!body.enabled) {
        await validateToolDefinition(def);
      }
      storage.saveCustomTool({ ...existing, enabled: body.enabled ? 1 : 0, updated_at: new Date().toISOString() });
      notifyToolsChanged();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      if (!storage.deleteCustomTool(req.params.id)) return res.status(404).json({ error: 'Tool tidak ditemukan' });
      notifyToolsChanged();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Uji DRAFT (belum disimpan): jalankan langsung ke DB dan tampilkan data. */
  router.post('/test-query', async (req, res) => {
    let payload: CustomToolPayload | null = null;
    try {
      const { paramValues, ...rest } = (req.body ?? {}) as { paramValues?: Record<string, unknown> };
      payload = zPayload(rest);
      const def = toDef(payload);
      await validateToolDefinition(def);
      const given = paramValues ?? {};
      const result = await runCustomTool(def, given);
      const primaryTable = def.mode === 'builder' ? def.builder!.baseTable : extractTableRefs(def.sql!)[0]?.name ?? null;
      const { ctx } = testAuditCtx(req, `draft:${payload.name}`, primaryTable);
      res.json({
        ok: true,
        sql: result.sql,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
        rows: result.rows.slice(0, MAX_PREVIEW_ROWS),
        previewTruncated: result.rows.length > MAX_PREVIEW_ROWS,
        testMode: true,
      });
      recordAudit(ctx, `draft:${payload.name}`, primaryTable, { __test: true, ...given }, result.rowCount, result.durationMs, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      const { ctx } = testAuditCtx(req, `draft:${payload?.name ?? '?'}`, null);
      recordAudit(ctx, `draft:${payload?.name ?? '?'}`, null, { __test: true }, null, 0, 500);
    }
  });

  /** Uji tool yang SUDAH disimpan (jalur kode identik MCP + tercatat audit). */
  router.post('/:id/test', async (req, res) => {
    const existing = storage.getCustomTool(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Tool tidak ditemukan' });
    }
    const { ctx } = testAuditCtx(req, existing.name, null);
    try {
      const def = parseCustomToolDef(existing);
      await validateToolDefinition(def);
      const { paramValues } = (req.body ?? {}) as { paramValues?: Record<string, unknown> };
      const given = paramValues ?? {};
      const result = await runCustomTool(def, given);
      const primaryTable = def.mode === 'builder' ? def.builder!.baseTable : extractTableRefs(def.sql!)[0]?.name ?? null;
      res.json({
        ok: true,
        sql: result.sql,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
        rows: result.rows.slice(0, MAX_PREVIEW_ROWS),
        previewTruncated: result.rows.length > MAX_PREVIEW_ROWS,
        testMode: true,
      });
      recordAudit(ctx, existing.name, primaryTable, { __test: true, ...given }, result.rowCount, result.durationMs, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      recordAudit(ctx, existing.name, null, { __test: true }, null, 0, 500);
    }
  });

  return router;
}