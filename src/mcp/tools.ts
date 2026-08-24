import { z } from 'zod';
import { limits } from '../config.js';
import { storage, type ApiKeyRow } from '../db/storage.js';
import { getPool } from '../sqlserver/connection.js';
import { buildCustomToolDef } from './customTools.js';
import {
  checkTableGranted,
  getTableListCached,
  getTableSchema,
  serverInfo,
} from '../sqlserver/metadata.js';
import {
  buildCount,
  buildGetByPk,
  buildSelect,
  executeQuery,
  executeScalar,
  type WhereClause,
} from '../sqlserver/queryBuilder.js';

export interface ToolContext {
  key: ApiKeyRow;
  ip: string;
}

const tableSchema = z
  .string()
  .min(1, 'Nama tabel wajib diisi')
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_@$#]*$/, 'Nama tabel tidak valid (hanya huruf, angka, _ @ $ #)');

const scalarValue = z.string().or(z.number()).or(z.boolean()).or(z.null());

const whereItemSchema = z
  .object({
    column: z.string().min(1).max(128),
    op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'startsWith', 'endsWith', 'in', 'between', 'isNull', 'isNotNull']),
    value: scalarValue.or(z.array(z.any()).max(50)).optional(),
    value2: scalarValue.optional(),
  })
  .strict();

const whereArraySchema = z.array(whereItemSchema).max(limits.maxWhereClauses);

const orderBySchema = z
  .object({
    column: z.string().min(1).max(128),
    dir: z.enum(['asc', 'desc']),
  })
  .strict();

export function recordAudit(
  ctx: ToolContext,
  tool: string,
  tableName: string | null,
  params: unknown,
  rowCount: number | null,
  durationMs: number,
  status: number,
): void {
  storage.addAudit({
    key_id: ctx.key.id,
    key_name: ctx.key.name,
    tool,
    table_name: tableName,
    params: JSON.stringify(params).slice(0, 2000),
    row_count: rowCount,
    duration_ms: durationMs,
    ip: ctx.ip,
    status,
  });
}

function trimOutput(data: unknown): unknown {
  const json = JSON.stringify(data);
  if (json.length > 30_000) return { truncated: true, preview: JSON.parse(json.slice(0, 30_000)) };
  return data;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (args: unknown, ctx: ToolContext) => Promise<{ content: { type: 'text'; text: string }[] }>;
  /** versi definisi (updated_at untuk custom tool) — untuk deteksi perubahan tandatangan tool */
  version?: string;
}

/**
 * Daftar tool efektif untuk satu session: builtin yang ENABLED (tool_settings)
 * + custom tool yang enabled. Dibaca dari storage — perubahan berlaku pada
 * session yang baru dibuat.
 */
export function getEffectiveTools(): ToolDef[] {
  const disabled = new Set(storage.listToolSettings().filter((s) => s.enabled !== 1).map((s) => s.name));
  const builtins = tools.filter((t) => !disabled.has(t.name));
  const customs = storage.listCustomTools().filter((c) => c.enabled === 1).map(buildCustomToolDef);
  return [...builtins, ...customs];
}

export const tools: ToolDef[] = [
  {
    name: 'list_tables',
    title: 'Daftar tabel yang diizinkan',
    description:
      'Menampilkan daftar tabel database yang TELAH DIIZINKAN oleh admin untuk dibaca AI, lengkap dengan schema dan perkiraan jumlah baris (dari metadata server, tanpa scan data). Hanya tabel yang diizinkan yang muncul.',
    inputSchema: z.object({}),
    async handler(_args, ctx) {
      const t0 = Date.now();
      try {
        const tables = await getTableListCached();
        const allowed = storage.listPermissions();
        const result = tables
          .filter((t) => allowed.some((p) => p.table_name === t.name && p.allow_read === 1))
          .map((t) => ({ schema: t.schema, table: t.name, rowCount: t.rowCount }));
        recordAudit(ctx, 'list_tables', null, {}, result.length, Date.now() - t0, 200);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        recordAudit(ctx, 'list_tables', null, {}, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },

  {
    name: 'get_table_schema',
    title: 'Skema tabel',
    description:
      'Melihat struktur tabel: daftar kolom, tipe data, nullable, identity, primary key, dan indeks. Hanya untuk tabel yang diizinkan admin. Isi nama tabel TANPA prefix schema (misal "users", bukan "dbo.users").',
    inputSchema: z.object({ table: tableSchema }).strict(),
    async handler(args, ctx) {
      const { table } = args as { table: string };
      const t0 = Date.now();
      try {
        checkTableGranted(table, false);
        const schema = await getTableSchema(table);
        recordAudit(ctx, 'get_table_schema', table, { table }, null, Date.now() - t0, 200);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { table: schema.table, schema: schema.schema, primaryKeys: schema.primaryKeys, columns: schema.columns, indexes: schema.indexes },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        recordAudit(ctx, 'get_table_schema', table, { table }, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },

  {
    name: 'read_records',
    title: 'Baca baris data (query aman)',
    description:
      `Membaca data dari tabel yang diizinkan dengan filter TERSTRUKTUR (bukan SQL mentah — SQL injection tidak mungkin). Parameter: table (wajib), columns (opsional, default semua), where (array: column + op + value; op: eq,neq,lt,lte,gt,gte,like,startsWith,endsWith,in,between,isNull,isNotNull), order_by (array: column + dir asc/desc), limit (1-${limits.maxRows}, default 100), offset (butuh order_by). Contoh where: [{"column":"status","op":"eq","value":"active"},{"column":"total","op":"gte","value":1000}]. Nama tabel TANPA schema.`,
    inputSchema: z
      .object({
        table: tableSchema,
        columns: z.array(z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_@$#]*$/)).max(50).optional(),
        where: whereArraySchema.optional(),
        order_by: z.array(orderBySchema).max(10).optional(),
        limit: z.number().int().min(1).max(limits.maxRows).default(100),
        offset: z.number().int().min(0).max(100_000).default(0),
      })
      .strict(),
    async handler(args, ctx) {
      const a = args as {
        table: string;
        columns?: string[];
        where?: WhereClause[];
        order_by?: { column: string; dir: 'asc' | 'desc' }[];
        limit?: number;
        offset?: number;
      };
      const t0 = Date.now();
      try {
        checkTableGranted(a.table, true);
        const pool = await getPool();
        const built = buildSelect({
          table: a.table,
          columns: a.columns,
          where: a.where,
          orderBy: a.order_by?.map((o) => ({ column: o.column, dir: o.dir })),
          limit: a.limit,
          offset: a.offset,
        });
        const rows = await executeQuery(pool, built);
        recordAudit(ctx, 'read_records', a.table, a, rows.length, Date.now() - t0, 200);
        const result = {
          table: a.table,
          rowCount: rows.length,
          limitApplied: built.limit,
          offsetApplied: a.offset ?? 0,
          rows: trimOutput(rows),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        recordAudit(ctx, 'read_records', a.table ?? null, a, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },

  {
    name: 'count_records',
    title: 'Hitung jumlah baris',
    description:
      'Menghitung jumlah baris pada tabel yang diizinkan, dengan filter opsional yang sama seperti read_records (tanpa pagination). Contoh: [{"column":"status","op":"eq","value":"active"}].',
    inputSchema: z
      .object({
        table: tableSchema,
        where: whereArraySchema.optional(),
      })
      .strict(),
    async handler(args, ctx) {
      const a = args as { table: string; where?: WhereClause[] };
      const t0 = Date.now();
      try {
        checkTableGranted(a.table, true);
        const pool = await getPool();
        const built = buildCount(a.table, a.where);
        const total = await executeScalar(pool, built.sql, built.params);
        recordAudit(ctx, 'count_records', a.table, a, total, Date.now() - t0, 200);
        return { content: [{ type: 'text', text: JSON.stringify({ table: a.table, total }, null, 2) }] };
      } catch (err) {
        recordAudit(ctx, 'count_records', a.table ?? null, a, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },

  {
    name: 'get_record_by_pk',
    title: 'Ambil record by primary key',
    description:
      'Mengambil SATU baris berdasarkan primary key tabel yang diizinkan. Kirim key sebagai object kolom->nilai (bisa lebih dari satu kolom untuk composite key). Contoh: {"table":"users","key":{"id":42}}.',
    inputSchema: z
      .object({
        table: tableSchema,
        key: z.record(z.string(), scalarValue).refine((k) => Object.keys(k).length > 0, 'Key minimal 1 kolom'),
      })
      .strict(),
    async handler(args, ctx) {
      const { table, key } = args as { table: string; key: Record<string, unknown> };
      const t0 = Date.now();
      try {
        checkTableGranted(table, true);
        const schema = await getTableSchema(table);
        const pkCols = schema.primaryKeys;
        if (!pkCols.length) throw new Error(`Tabel "${table}" tidak punya primary key — gunakan read_records`);
        const entries = Object.entries(key);
        if (entries.some(([c]) => !pkCols.includes(c))) {
          throw new Error(`Kolom key tidak cocok dengan primary key (${pkCols.join(', ')}): ${entries.map(([c]) => c).join(', ')}`);
        }
        const pool = await getPool();
        const built = buildGetByPk(table, entries.map(([column, value]) => ({ column, value })));
        const rows = await executeQuery(pool, built);
        recordAudit(ctx, 'get_record_by_pk', table, { table, key }, rows.length, Date.now() - t0, 200);
        return {
          content: [{ type: 'text', text: JSON.stringify({ table, found: rows.length > 0, row: trimOutput(rows[0] ?? null) }, null, 2) }],
        };
      } catch (err) {
        recordAudit(ctx, 'get_record_by_pk', table ?? null, { table, key }, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },

  {
    name: 'server_info',
    title: 'Info server database',
    description:
      'Informasi server SQL Server yang terhubung: nama server, versi, nama database aktif, user login, dan jumlah tabel yang diizinkan. Tidak membaca data apa pun.',
    inputSchema: z.object({}),
    async handler(_args, ctx) {
      const t0 = Date.now();
      try {
        const info = await serverInfo();
        recordAudit(ctx, 'server_info', null, {}, null, Date.now() - t0, 200);
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      } catch (err) {
        recordAudit(ctx, 'server_info', null, {}, null, Date.now() - t0, 500);
        throw err;
      }
    },
  },
];