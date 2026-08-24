import sql from 'mssql';
import { config, limits } from '../config.js';
import { storage, currentProjectId } from '../db/storage.js';

export interface SqlServerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCert: boolean;
}

export function resolveConfig(): SqlServerConfig | null {
  const row = storage.getDbConfig();
  if (!row) return null;
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password: storage.decrypt(row.password_enc),
    database: row.database,
    encrypt: row.encrypt === 1,
    trustServerCert: row.trust_server_cert === 1,
  };
}

function poolCfg(cfg: SqlServerConfig): sql.config {
  return {
    user: cfg.username,
    password: cfg.password,
    server: cfg.host,
    port: cfg.port,
    database: cfg.database,
    requestTimeout: limits.queryTimeoutMs,
    connectionTimeout: limits.connectionTimeoutMs,
    pool: { max: 5, min: 0, idleTimeoutMillis: 60_000 },
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCert,
      enableArithAbort: true,
    },
  };
}

export async function testConnection(cfg: SqlServerConfig): Promise<{ ok: boolean; message: string }> {
  const pool = new sql.ConnectionPool(poolCfg(cfg));
  try {
    await pool.connect();
    const r = await pool.request().query('SELECT @@SERVERNAME AS server_name, @@VERSION AS version, DB_NAME() AS db_name');
    const row = r.recordset[0];
    const version = String(row.version).split('\n')[0];
    return { ok: true, message: `Koneksi sukses: ${row.server_name} / ${row.db_name} (${version})` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

interface PoolEntry {
  pool: sql.ConnectionPool;
  stamp: string;
}

/** Pool per project: kunci = project id ('' = konteks non-project, tak dipakai). */
const pools = new Map<string, PoolEntry>();

function poolKey(): string {
  return currentProjectId() ?? '';
}

function isPoolAlive(e: PoolEntry | undefined): e is PoolEntry {
  return !!e?.pool && (e.pool as sql.ConnectionPool).connected;
}

export async function getPool(): Promise<sql.ConnectionPool> {
  const key = poolKey();
  const cfg = resolveConfig();
  if (!cfg) throw new Error('Koneksi database belum dikonfigurasi. Konfigurasikan lewat web UI.');
  const row = storage.getDbConfig();
  const stamp = row ? `${row.host}|${row.port}|${row.database}` : '';
  const entry = pools.get(key);
  if (isPoolAlive(entry) && entry.stamp === stamp) return entry.pool;
  await closePool();
  const pool = new sql.ConnectionPool(poolCfg(cfg));
  await pool.connect();
  pools.set(key, { pool, stamp });
  return pool;
}

export async function closePool(): Promise<void> {
  const entry = pools.get(poolKey());
  if (entry) {
    pools.delete(poolKey());
    await entry.pool.close().catch(() => undefined);
  }
}

/** Tutup pool milik project tertentu (dipakai saat project dihapus). */
export async function closePoolForProject(projectId: string): Promise<void> {
  const entry = pools.get(projectId);
  if (entry) {
    pools.delete(projectId);
    await entry.pool.close().catch(() => undefined);
  }
}

export type { config as sqlConfig };