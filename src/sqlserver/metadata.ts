import sql from 'mssql';
import { limits } from '../config.js';
import { storage, currentProjectId } from '../db/storage.js';
import { getPool, type SqlServerConfig } from './connection.js';
import { notifyResourcesChanged } from '../mcp/changes.js';

export interface TableInfo {
  schema: string;
  name: string;
  rowCount: number | null;
  /** nama lengkap schema.name */
  fullName: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isIdentity: boolean;
  isPrimaryKey: boolean;
  isComputed: boolean;
}

export interface SchemaInfo {
  table: string;
  schema: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  indexes: { name: string; type: string; columns: string }[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_@$#]*$/;

export function sanitizeIdentifier(name: string): string {
  if (!IDENT_RE.test(name) || name.length > 128) {
    throw new Error(`Nama identifier tidak valid (hanya huruf, angka, _ @ $ #): "${name}"`);
  }
  return name;
}

export function checkTableGranted(tableName: string, needRead: boolean): void {
  const perm = storage.getPermission(tableName);
  if (!perm) {
    throw new Error(`Akses ditolak: tabel "${tableName}" tidak terdaftar di permission. Hubungi admin.`);
  }
  if (needRead && perm.allow_read !== 1) {
    throw new Error(`Akses ditolak: pembacaan data tabel "${tableName}" tidak diizinkan (hanya metadata).`);
  }
  if (!needRead && perm.allow_schema !== 1) {
    throw new Error(`Akses ditolak: metadata tabel "${tableName}" tidak diizinkan.`);
  }
}

/**
 * Daftar tabel + jumlah baris (dari metadata sys.partitions — cepat, tanpa scan data).
 */
export async function listTables(): Promise<TableInfo[]> {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT
      s.name AS schema_name,
      t.name AS table_name,
      SUM(p.rows) AS row_count
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
    GROUP BY s.name, t.name
    ORDER BY s.name, t.name
  `);
  return r.recordset.map((row) => ({
    schema: String(row.schema_name),
    name: String(row.table_name),
    rowCount: row.row_count == null ? null : Number(row.row_count),
    fullName: `${row.schema_name}.${row.table_name}`,
  }));
}

async function getPrimaryKeys(pool: sql.ConnectionPool, fullName: string): Promise<string[]> {
  const r = await pool.request().input('obj', sql.NVarChar(260), fullName).query(`
    SELECT c.name AS column_name
    FROM sys.indexes i
    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.object_id = OBJECT_ID(@obj) AND i.is_primary_key = 1
    ORDER BY ic.key_ordinal
  `);
  return r.recordset.map((row) => String(row.column_name));
}

export async function getTableSchema(tableName: string): Promise<SchemaInfo> {
  const pool = await getPool();
  const fullName = `dbo.${tableName}`;

  const colsRes = await pool.request().input('obj', sql.NVarChar(260), fullName).query(`
    SELECT
      c.name AS column_name,
      ty.name AS data_type,
      c.max_length,
      c.precision,
      c.scale,
      c.is_nullable,
      COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity') AS is_identity,
      COLUMNPROPERTY(c.object_id, c.name, 'IsComputed') AS is_computed
    FROM sys.columns c
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE c.object_id = OBJECT_ID(@obj)
    ORDER BY c.column_id
  `);

  const idxRes = await pool.request().input('obj', sql.NVarChar(260), fullName).query(`
    SELECT
      i.name AS index_name,
      i.type_desc AS type_desc,
      i.index_id,
      STUFF((
        SELECT ', ' + c2.name
        FROM sys.index_columns ic2
        JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id
        WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
        ORDER BY ic2.key_ordinal
        FOR XML PATH('')
      ), 1, 2, '') AS columns
    FROM sys.indexes i
    WHERE i.object_id = OBJECT_ID(@obj) AND i.index_id > 0
    ORDER BY i.index_id
  `);

  const primaryKeys = await getPrimaryKeys(pool, fullName);

  return {
    table: tableName,
    schema: 'dbo',
    columns: colsRes.recordset.map((row) => ({
      name: String(row.column_name),
      dataType: String(row.data_type),
      maxLength: row.max_length == null ? null : Number(row.max_length),
      precision: row.precision == null ? null : Number(row.precision),
      scale: row.scale == null ? null : Number(row.scale),
      nullable: row.is_nullable === true,
      isIdentity: Number(row.is_identity) === 1,
      isPrimaryKey: primaryKeys.includes(String(row.column_name)),
      isComputed: Number(row.is_computed) === 1,
    })),
    primaryKeys,
    indexes: idxRes.recordset.map((row) => ({
      name: String(row.index_name),
      type: String(row.type_desc),
      columns: String(row.columns || ''),
    })),
  };
}

export async function serverInfo(): Promise<Record<string, unknown>> {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT
      @@SERVERNAME AS server_name,
      @@VERSION AS version,
      DB_NAME() AS db_name,
      SYSTEM_USER AS login_user
  `);
  const row = r.recordset[0];
  return {
    serverName: String(row.server_name),
    version: String(row.version).split('\n')[0],
    database: String(row.db_name),
    loginUser: String(row.login_user),
    allowedTables: storage.listPermissions().filter((p) => p.allow_read === 1 || p.allow_schema === 1).length,
    time: new Date().toISOString(),
  };
}

export async function scanTables(): Promise<TableInfo[]> {
  return listTables();
}

// cache kecil untuk daftar tabel (metadata) — per project
interface TableCacheEntry {
  at: number;
  tables: TableInfo[];
}
const tableCaches = new Map<string, TableCacheEntry>();
const lastTableFingerprints = new Map<string, string>();

function cacheKey(): string {
  return currentProjectId() ?? '';
}

function tableFingerprint(tables: TableInfo[]): string {
  return tables
    .map((t) => `${t.schema}.${t.name}`)
    .sort()
    .join(',');
}

export async function getTableListCached(): Promise<TableInfo[]> {
  const key = cacheKey();
  const cache = tableCaches.get(key);
  if (cache && Date.now() - cache.at < limits.metadataCacheMs) return cache.tables;
  const tables = await listTables();
  tableCaches.set(key, { at: Date.now(), tables });

  // Tabel baru/hapus di SQL Server -> kabari client (resources/list_changed)
  const fp = tableFingerprint(tables);
  const prev = lastTableFingerprints.get(key);
  if (prev !== null && prev !== undefined && fp !== prev) notifyResourcesChanged();
  lastTableFingerprints.set(key, fp);

  return tables;
}

export function invalidateTableCache(): void {
  tableCaches.delete(cacheKey());
  lastTableFingerprints.delete(cacheKey());
}

export type { SqlServerConfig };