import { z } from 'zod';
import { limits } from '../config.js';
import type { CustomToolRow } from '../db/storage.js';
import { getPool } from '../sqlserver/connection.js';
import { getTableSchema, checkTableGranted } from '../sqlserver/metadata.js';
import { buildCustomSelect, executeQuery, splitRef, type CustomSelectSpec } from '../sqlserver/queryBuilder.js';
import { validateRawSql, extractTableRefs } from '../sqlserver/sqlGuard.js';
import { recordAudit, type ToolDef, type ToolContext } from './tools.js';


export const BUILTIN_TOOL_NAMES = ['list_tables', 'get_table_schema', 'read_records', 'count_records', 'get_record_by_pk', 'server_info'];

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export type ParamType = 'string' | 'number' | 'boolean' | 'date';

export interface ToolParam {
  name: string;
  type: ParamType;
  required: boolean;
  default?: string;
}

export interface BuilderDef {
  baseTable: string;
  alias?: string;
  columns?: { name: string; alias?: string }[];
  joins: CustomSelectSpec['joins'];
  where: { ref: string; op: string; value?: unknown; value2?: unknown; param?: string }[];
  orderBy: { ref: string; dir: 'asc' | 'desc' }[];
  limit: number;
}

export interface SqlDef {
  sql: string;
}

export interface CustomToolDef {
  mode: 'builder' | 'sql';
  builder?: BuilderDef;
  sql?: string;
  params: ToolParam[];
}

const builderWhereOpSchema = z.enum([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'startsWith', 'endsWith', 'in', 'between', 'isNull', 'isNotNull',
]);

export const toolParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME_RE, 'Nama parameter tidak valid (huruf, angka, _, maks 32)'),
    type: z.enum(['string', 'number', 'boolean', 'date']),
    required: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict();

export const builderDefSchema = z
  .object({
    baseTable: z.string().min(1).max(128),
    alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_@$#]{0,127}$/).optional(),
    columns: z
      .array(z.object({ name: z.string().min(1).max(256), alias: z.string().max(128).optional() }).strict())
      .max(50)
      .optional(),
    joins: z
      .array(
        z
          .object({
            type: z.enum(['inner', 'left', 'right', 'full']),
            table: z.string().min(1).max(128),
            alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_@$#]{0,127}$/),
            on: z
              .object({
                left: z.string().min(1).max(256),
                right: z.string().min(1).max(256),
                op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    where: z
      .array(
        z
          .object({
            ref: z.string().min(1).max(256),
            op: builderWhereOpSchema,
            value: z.unknown().optional(),
            value2: z.unknown().optional(),
            param: z.string().regex(PARAM_NAME_RE).optional(),
          })
          .strict()
          .refine((w) => (w.op === 'isNull' || w.op === 'isNotNull' ? true : w.param !== undefined || w.value !== undefined), 'Setel nilai atau referensi parameter @nama'),
      )
      .max(limits.maxWhereClauses)
      .default([]),
    orderBy: z
      .array(z.object({ ref: z.string().min(1).max(256), dir: z.enum(['asc', 'desc']) }).strict())
      .max(10)
      .default([]),
    limit: z.number().int().min(1).max(limits.maxRows).default(100),
  })
  .strict();

export const sqlDefSchema = z.object({ sql: z.string().min(1).max(8000) }).strict();

export function parseCustomToolDef(row: Pick<CustomToolRow, 'mode' | 'definition'>): CustomToolDef {
  const parsed = JSON.parse(row.definition) as CustomToolDef;
  if (parsed.mode !== row.mode) throw new Error('Mode tool tidak konsisten');
  return parsed;
}

/** Koersi nilai parameter runtime sesuai tipe deklarasinya. */
export function coerceParamValue(param: ToolParam, raw: unknown): unknown {
  const val = raw === undefined || raw === null ? param.default ?? undefined : raw;
  switch (param.type) {
    case 'number': {
      if (val === undefined) return undefined;
      const n = typeof val === 'number' ? val : Number(val);
      if (!Number.isFinite(n)) throw new Error(`Parameter @${param.name}: nilai bukan angka`);
      return n;
    }
    case 'boolean':
      if (val === undefined) return undefined;
      return val === true || val === 'true' || val === 1 || val === '1';
    case 'date': {
      if (val === undefined) return undefined;
      const d = val instanceof Date ? val : new Date(String(val));
      if (Number.isNaN(d.getTime())) throw new Error(`Parameter @${param.name}: nilai bukan tanggal`);
      return d;
    }
    default:
      return val === undefined ? undefined : String(val);
  }
}

export function validateParamsStruct(params: ToolParam[], mode: 'builder' | 'sql', payload: { builder?: BuilderDef; sql?: string }): void {
  const names = new Set<string>();
  for (const p of params) {
    if (names.has(p.name)) throw new Error(`Parameter @${p.name} duplikat`);
    names.add(p.name);
    if (p.default !== undefined && p.required) throw new Error(`Parameter @${p.name}: tidak boleh required sekaligus punya default`);
  }
  if (mode === 'sql') {
    const declared = params.map((p) => p.name);
    const guard = validateRawSql(payload.sql ?? '', declared);
    if (!guard.ok) throw new Error(guard.error);
  } else if (mode === 'builder') {
    const def = payload.builder;
    if (!def) throw new Error('Definisi builder kosong');
    for (const w of def.where) {
      if (w.param && !names.has(w.param)) throw new Error(`Parameter @${w.param} pada where tidak ada di daftar parameter`);
    }
  }
}

interface TableSchemaMap {
  [table: string]: { columns: string[] };
}

async function loadSchemas(tables: string[]): Promise<TableSchemaMap> {
  const map: TableSchemaMap = {};
  for (const t of [...new Set(tables)]) {
    const schema = await getTableSchema(t);
    map[t] = { columns: schema.columns.map((c) => c.name) };
  }
  return map;
}

function assertRefColumn(ref: string, aliasMap: Map<string, string>, schemas: TableSchemaMap, context: string): void {
  const { alias, column } = splitRef(ref);
  const table = alias ? (aliasMap.get(alias) ?? (() => { throw new Error(`${context}: alias "${alias}" tidak dikenal`); })()) : aliasMap.get('__base')!;
  const cols = schemas[table]?.columns;
  if (!cols) throw new Error(`${context}: tabel "${table}" tidak ditemukan`);
  if (!cols.some((c) => c.toLowerCase() === column.toLowerCase())) {
    throw new Error(`${context}: kolom "${ref}" tidak ada di tabel "${table}"`);
  }
}

/** Validasi penuh definisi tool (struktur + live DB: tabel, kolom, permission). */
export async function validateToolDefinition(def: CustomToolDef): Promise<void> {
  if (def.params.length > 20) throw new Error('Maksimal 20 parameter per tool');
  validateParamsStruct(def.params, def.mode, { builder: def.builder, sql: def.sql });

  let hadDb = true;
  const pool = await getPool().catch(() => { hadDb = false; return null; });
  if (!pool) throw new Error('Database tidak terhubung — buat & verifikasi koneksi di menu DB Connection dulu');
  void hadDb;

  if (def.mode === 'builder') {
    for (const t of refTablesFromBuilder(def.builder!)) checkTableGranted(t, true);
  } else {
    // Custom SQL tool: scope dibatasi ketat ke schema `dbo` saja (sama seperti
    // builder mode). Referensi schema lain ditolak agar model permission
    // per-tabel (default deny) tidak bisa dilewati.
    for (const t of extractTableRefs(def.sql!)) {
      if (t.schema !== 'dbo') {
        throw new Error(`Custom SQL tool hanya boleh mengakses schema 'dbo' (ditemukan: ${t.schema}.${t.name})`);
      }
      checkTableGranted(t.name, true);
    }
  }

  if (def.mode === 'builder') {
    const b = def.builder!;
    const allTables = [b.baseTable, ...b.joins.map((j) => j.table)];
    const schemas = await loadSchemas(allTables);
    const aliasMap = new Map<string, string>();
    aliasMap.set('__base', b.baseTable);
    aliasMap.set(b.alias ?? b.baseTable, b.baseTable);
    for (const j of b.joins) {
      if (aliasMap.has(j.alias) && aliasMap.get(j.alias) !== j.table) throw new Error(`Alias "${j.alias}" dipakai lebih dari satu tabel`);
      aliasMap.set(j.alias, j.table);
    }
    for (const c of b.columns ?? []) assertRefColumn(c.name, aliasMap, schemas, 'Kolom select');
    for (const j of b.joins) {
      assertRefColumn(j.on.left, aliasMap, schemas, `ON ${j.type} JOIN`);
      assertRefColumn(j.on.right, aliasMap, schemas, `ON ${j.type} JOIN`);
    }
    for (const w of b.where) assertRefColumn(w.ref, aliasMap, schemas, 'Where');
    for (const o of b.orderBy) assertRefColumn(o.ref, aliasMap, schemas, 'Order by');
  }
}

export function refTablesFromBuilder(b: BuilderDef): string[] {
  return [b.baseTable, ...b.joins.map((j) => j.table)];
}


/** Jalankan tool (dipakai handler MCP, Agent Test, dan test runner). */
export async function runCustomTool(
  def: CustomToolDef,
  rawParams: Record<string, unknown>,
): Promise<{ sql: string; rows: Record<string, unknown>[]; rowCount: number; durationMs: number }> {
  const t0 = Date.now();
  const values: Record<string, unknown> = {};
  for (const p of def.params) {
    const v = coerceParamValue(p, rawParams[p.name]);
    if (v === undefined && p.required) throw new Error(`Parameter wajib @${p.name} tidak diisi`);
    if (v !== undefined) values[p.name] = v;
  }

  const pool = await getPool();

  if (def.mode === 'builder') {
    const b = def.builder!;
    for (const t of refTablesFromBuilder(b)) checkTableGranted(t, true);
    const spec: CustomSelectSpec = {
      baseTable: b.baseTable,
      alias: b.alias,
      columns: b.columns,
      joins: b.joins,
      where: b.where.map((w) => ({ ref: w.ref, op: w.op as CustomSelectSpec['where'][number]['op'], value: w.value, value2: w.value2, param: w.param })),
      orderBy: b.orderBy,
      limit: b.limit,
      paramValues: values,
    };
    const built = buildCustomSelect(spec);
    const rows = await executeQuery(pool, built);
    return { sql: built.sql, rows, rowCount: rows.length, durationMs: Date.now() - t0 };
  }

  const sqlText = def.sql!;
  for (const t of extractTableRefs(sqlText)) {
    if (t.schema !== 'dbo') {
      throw new Error(`Custom SQL tool hanya boleh mengakses schema 'dbo' (ditemukan: ${t.schema}.${t.name})`);
    }
    checkTableGranted(t.name, true);
  }
  const usedParams = def.params.filter((p) => new RegExp(`@${p.name}\\b`).test(sqlText.replace(/'((?:[^']|'')*)'/g, ' ')));
  const named: { name: string; value: unknown }[] = [];
  for (const p of usedParams) {
    const v = values[p.name] ?? coerceParamValue(p, undefined);
    if (v === undefined && p.required) throw new Error(`Parameter wajib @${p.name} tidak diisi`);
    if (v !== undefined) named.push({ name: p.name, value: v });
  }
  const rows = await executeQuery(pool, { sql: sqlText, params: named });
  return { sql: sqlText, rows, rowCount: rows.length, durationMs: Date.now() - t0 };
}

function buildInputSchema(def: CustomToolDef): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const props: Record<string, z.ZodTypeAny> = {};
  for (const p of def.params) {
    let s: z.ZodTypeAny;
    switch (p.type) {
      case 'number':
        s = z.coerce.number();
        break;
      case 'boolean':
        s = z.union([z.boolean(), z.literal('true'), z.literal('false'), z.literal(1), z.literal(0)]).transform((v) => v === true || v === 'true' || v === 1);
        break;
      case 'date':
        s = z.coerce.date();
        break;
      default:
        s = z.string();
    }
    props[p.name] = p.required ? s : s.optional();
  }
  return z.object(props).strict();
}

export function buildCustomToolDef(row: CustomToolRow): ToolDef {
  const def = parseCustomToolDef(row);
  const inputSchema = buildInputSchema(def);
  return {
    name: row.name,
    title: row.title,
    description: row.description,
    inputSchema,
    version: row.updated_at,
    async handler(args, ctx: ToolContext) {
      const t0 = Date.now();
      const primaryTable = def.mode === 'builder' ? def.builder!.baseTable : extractTableRefs(def.sql!)[0]?.name ?? null;
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        const res = await runCustomTool(def, a);
        recordAudit(ctx, row.name, primaryTable, { __custom: true, ...a }, res.rowCount, res.durationMs, 200);
        const payload = { tool: row.name, rowCount: res.rowCount, durationMs: res.durationMs, rows: res.rows };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        recordAudit(ctx, row.name, primaryTable, { __custom: true, ...(args ?? {}) }, null, Date.now() - t0, 500);
        throw err;
      }
    },
  };
}

/** Jalankan tool (dipakai handler MCP, Agent Test, dan test runner). */