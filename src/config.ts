import path from 'node:path';

function readInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : def;
}

export const config = {
  port: readInt('PORT', 4000),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
};

export const limits = {
  maxRows: 1000,
  maxWhereClauses: 20,
  maxInValues: 50,
  queryTimeoutMs: readInt('QUERY_TIMEOUT_MS', 30_000),
  connectionTimeoutMs: readInt('CONNECTION_TIMEOUT_MS', 10_000),
  apiKeyRateLimit: readInt('RATE_LIMIT_PER_MIN', 60),
  metadataCacheMs: readInt('METADATA_CACHE_MS', 15_000),
};

export const oauthConfig = {
  enabled: process.env.OAUTH_ENABLED !== '0',
  codeTtlMs: readInt('OAUTH_CODE_TTL_S', 600) * 1000,
  accessTtlMs: readInt('OAUTH_ACCESS_TTL_S', 3600) * 1000,
  refreshTtlMs: readInt('OAUTH_REFRESH_TTL_S', 30 * 24 * 3600) * 1000,
  allowedScopes: ['mcp'],
  registerRateLimit: readInt('OAUTH_REGISTER_PER_MIN', 20),
  tokenRateLimit: readInt('OAUTH_TOKEN_PER_MIN', 120),
};

export function validateEnv(): string[] {
  const errors: string[] = [];
  if (!config.adminPassword) errors.push('ADMIN_PASSWORD wajib diisi (env ADMIN_PASSWORD)');
  if (config.adminPassword.length < 8) errors.push('ADMIN_PASSWORD minimal 8 karakter');
  return errors;
}