import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

export interface DbConfigRow {
  id: number;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  database: string;
  encrypt: number;
  trust_server_cert: number;
}

export interface PermissionRow {
  table_name: string;
  schema_name: string;
  allow_schema: number;
  allow_read: number;
}

export interface OauthClientRow {
  client_id: string;
  client_name: string;
  client_secret_hash: string | null;
  redirect_uris: string;
  token_endpoint_auth_method: string;
  is_dynamic: number;
  created_at: string;
  revoked: number;
  resource: string | null;
}

/** Apakah resource OAuth menyebut project eksplisit (URL /mcp/<projectId>). */
export function isProjectBoundResource(resource: string | null | undefined): boolean {
  if (!resource) return false;
  try {
    return /\/mcp\/[A-Za-z0-9_-]+\/?$/.test(new URL(resource).pathname);
  } catch {
    return /\/mcp\/[A-Za-z0-9_-]+\/?$/.test(resource);
  }
}

export interface OauthCodeRow {
  code_hash: string;
  client_id: string;
  api_key_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string;
  expires_at: number;
  used_at: number | null;
}

export interface OauthTokenRow {
  token_hash: string;
  client_id: string;
  api_key_id: string;
  scope: string;
  expires_at: number;
  refresh_token_hash: string | null;
  refresh_expires_at: number | null;
  revoked: number;
  created_at: number;
}

export interface AuditRow {
  id: number;
  ts: string;
  key_id: string | null;
  key_name: string | null;
  tool: string;
  table_name: string | null;
  params: string | null;
  row_count: number | null;
  duration_ms: number | null;
  ip: string | null;
  status: number;
}

export interface CustomToolRow {
  id: string;
  name: string;
  title: string;
  description: string;
  mode: 'builder' | 'sql';
  definition: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(config.dataDir, 'app.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* sudah tertutup */
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS db_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 1433,
        username TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        database TEXT NOT NULL,
        encrypt INTEGER NOT NULL DEFAULT 1,
        trust_server_cert INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS permissions (
        table_name TEXT PRIMARY KEY,
        schema_name TEXT NOT NULL DEFAULT 'dbo',
        allow_schema INTEGER NOT NULL DEFAULT 1,
        allow_read INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        key_id TEXT,
        key_name TEXT,
        tool TEXT NOT NULL,
        table_name TEXT,
        params TEXT,
        row_count INTEGER,
        duration_ms INTEGER,
        ip TEXT,
        status INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_log(table_name);

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        client_secret_hash TEXT,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        is_dynamic INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        resource TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT,
        scope TEXT NOT NULL DEFAULT 'mcp',
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'mcp',
        expires_at INTEGER NOT NULL,
        refresh_token_hash TEXT UNIQUE,
        refresh_expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_settings (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS custom_tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('builder', 'sql')),
        definition TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_apikey ON oauth_tokens(api_key_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec('ALTER TABLE oauth_clients ADD COLUMN resource TEXT');
    } catch {
      /* kolom sudah ada */
    }
  }

  /**
   * Secret persisten untuk enkripsi password DB + mitigasi JWT.
   * Auto-generate 32 byte acak saat pertama kali dipakai.
   */
  getSecret(): string {
    if (config.sessionSecret) return config.sessionSecret;
    const existing = this.db.prepare('SELECT v FROM kv WHERE k = ?').get('session_secret') as { v: string } | undefined;
    if (existing) return existing.v;
    const secret = crypto.randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('session_secret', secret);
    return secret;
  }

  encrypt(plain: string): string {
    const key = crypto.createHash('sha256').update(this.getSecret()).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const key = crypto.createHash('sha256').update(this.getSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  // ---------------- API keys ----------------

  createApiKey(name: string): { row: ApiKeyRow; plainKey: string } {
    const plainKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
    const row: ApiKeyRow = {
      id: crypto.randomUUID(),
      name,
      key_hash: sha256(plainKey),
      key_prefix: plainKey.slice(0, 11),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked: 0,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, revoked)
         VALUES (@id, @name, @key_hash, @key_prefix, @created_at, @last_used_at, @revoked)`,
      )
      .run(row);
    return { row, plainKey };
  }

  findKeyByHash(hash: string): ApiKeyRow | undefined {
    return this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) as ApiKeyRow | undefined;
  }

  getApiKeyById(id: string): ApiKeyRow | undefined {
    return this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
  }

  /**
   * API key pendamping untuk OAuth: satu key non-revocable otomatis per client.
   * Dibuat saat consent pertama; dipakai ulang untuk consent berikutnya.
   */
  getOauthApiKey(clientId: string): ApiKeyRow {
    const name = `oauth:${clientId}`;
    const existing = this.db
      .prepare('SELECT * FROM api_keys WHERE name = ? ORDER BY created_at DESC LIMIT 1')
      .get(name) as ApiKeyRow | undefined;
    if (existing && existing.revoked === 0) return existing;

    const plainKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
    const row: ApiKeyRow = {
      id: crypto.randomUUID(),
      name,
      key_hash: sha256(plainKey),
      key_prefix: plainKey.slice(0, 11),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked: 0,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, revoked)
         VALUES (@id, @name, @key_hash, @key_prefix, @created_at, @last_used_at, @revoked)`,
      )
      .run(row);
    return row;
  }

  listApiKeys(): ApiKeyRow[] {
    return this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[];
  }

  renameApiKey(id: string, name: string): boolean {
    const r = this.db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(name, id);
    return r.changes > 0;
  }

  revokeApiKey(id: string): boolean {
    const r = this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
    return r.changes > 0;
  }

  deleteApiKey(id: string): boolean {
    const tx = this.db.transaction((keyId) => {
      const r = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
      if (r.changes === 0) return false;
      this.db.prepare('DELETE FROM oauth_tokens WHERE api_key_id = ?').run(keyId);
      this.db.prepare('DELETE FROM oauth_codes WHERE api_key_id = ?').run(keyId);
      return true;
    });
    return tx(id);
  }

  touchApiKey(id: string): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  // ---------------- OAuth clients ----------------

  createOauthClient(meta: {
    clientId: string;
    clientName: string;
    clientSecretHash: string | null;
    redirectUris: string[];
    tokenEndpointAuthMethod: string;
    dynamic: boolean;
    resource?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, token_endpoint_auth_method, is_dynamic, created_at, revoked, resource)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        meta.clientId,
        meta.clientName.slice(0, 200),
        meta.clientSecretHash,
        JSON.stringify(meta.redirectUris),
        meta.tokenEndpointAuthMethod,
        meta.dynamic ? 1 : 0,
        new Date().toISOString(),
        meta.resource ?? null,
      );
  }

  /**
   * Pindahkan seluruh jejak OAuth sebuah client (client + api key + token + code
   * aktif) dari storage ini ke storage project lain, lalu ikat resource-nya agar
   * tidak berpindah lagi. Dipakai untuk first-use claim: client yang terdaftar
   * tanpa resource project akan diadopsi oleh project URL pertama yang memakainya.
   */
  relocOauthCredsTo(target: Storage, clientId: string, bindResource: string): boolean {
    const c = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | OauthClientRow
      | undefined;
    if (!c) return false;
    const keys = this.db.prepare('SELECT * FROM api_keys WHERE name = ?').all(`oauth:${clientId}`) as ApiKeyRow[];
    const tokens = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE client_id = ? AND revoked = 0')
      .all(clientId) as OauthTokenRow[];
    const codes = this.db
      .prepare('SELECT * FROM oauth_codes WHERE client_id = ? AND used_at IS NULL')
      .all(clientId) as OauthCodeRow[];

    target.db
      .transaction(() => {
        target.db
          .prepare(
            `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, token_endpoint_auth_method, is_dynamic, created_at, revoked, resource)
             VALUES (@client_id, @client_name, @client_secret_hash, @redirect_uris, @token_endpoint_auth_method, @is_dynamic, @created_at, @revoked, @resource)`,
          )
          .run({ ...c, resource: bindResource });
        for (const k of keys) {
          target.db
            .prepare(
              `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, revoked)
               VALUES (@id, @name, @key_hash, @key_prefix, @created_at, @last_used_at, @revoked)`,
            )
            .run(k);
        }
        for (const t of tokens) {
          target.db
            .prepare(
              `INSERT INTO oauth_tokens (token_hash, client_id, api_key_id, scope, expires_at, refresh_token_hash, refresh_expires_at, revoked, created_at)
               VALUES (@token_hash, @client_id, @api_key_id, @scope, @expires_at, @refresh_token_hash, @refresh_expires_at, @revoked, @created_at)`,
            )
            .run(t);
        }
        for (const cd of codes) {
          target.db
            .prepare(
              `INSERT INTO oauth_codes (code_hash, client_id, api_key_id, redirect_uri, code_challenge, resource, scope, expires_at, used_at)
               VALUES (@code_hash, @client_id, @api_key_id, @redirect_uri, @code_challenge, @resource, @scope, @expires_at, @used_at)`,
            )
            .run(cd);
        }
      })();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
      this.db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').run(clientId);
      this.db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').run(clientId);
      for (const k of keys) {
        this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(k.id);
      }
    })();
    return true;
  }

  findOauthClient(clientId: string): OauthClientRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as OauthClientRow | undefined;
  }

  listOauthClients(): OauthClientRow[] {
    return this.db.prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC').all() as OauthClientRow[];
  }

  revokeOauthClient(clientId: string): boolean {
    const r = this.db.prepare('UPDATE oauth_clients SET revoked = 1 WHERE client_id = ?').run(clientId);
    return r.changes > 0;
  }

  deleteOauthClient(clientId: string): boolean {
    const tx = this.db.transaction((cid) => {
      const r = this.db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(cid);
      if (r.changes === 0) return false;
      this.db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').run(cid);
      this.db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').run(cid);
      const linked = this.db
        .prepare('SELECT id FROM api_keys WHERE name = ?')
        .all(`oauth:${cid}`) as { id: string }[];
      for (const k of linked) {
        this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(k.id);
      }
      return true;
    });
    return tx(clientId);
  }

  // ---------------- OAuth authorization codes ----------------

  saveOauthCode(code: OauthCodeRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, api_key_id, redirect_uri, code_challenge, resource, scope, expires_at, used_at)
         VALUES (@code_hash, @client_id, @api_key_id, @redirect_uri, @code_challenge, @resource, @scope, @expires_at, @used_at)`,
      )
      .run(code);
    this.cleanExpiredOauthCodes();
  }

  getOauthCode(codeHash: string): OauthCodeRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as OauthCodeRow | undefined;
  }

  markOauthCodeUsed(codeHash: string): void {
    this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(Date.now(), codeHash);
  }

  private cleanExpiredOauthCodes(): void {
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(Date.now());
  }

  // ---------------- OAuth tokens ----------------

  saveOauthToken(token: OauthTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (token_hash, client_id, api_key_id, scope, expires_at, refresh_token_hash, refresh_expires_at, revoked, created_at)
         VALUES (@token_hash, @client_id, @api_key_id, @scope, @expires_at, @refresh_token_hash, @refresh_expires_at, @revoked, @created_at)`,
      )
      .run(token);
  }

  findOauthTokenByHash(tokenHash: string): OauthTokenRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash) as OauthTokenRow | undefined;
  }

  findOauthTokenByRefreshHash(refreshHash: string): OauthTokenRow | undefined {
    return this.db
      .prepare('SELECT * FROM oauth_tokens WHERE refresh_token_hash = ?')
      .get(refreshHash) as OauthTokenRow | undefined;
  }

  revokeOauthTokensByClient(clientId: string): void {
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
  }

  revokeOauthTokenByHash(tokenHash: string): void {
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
  }

  revokeOauthTokenByRefreshHash(refreshHash: string): void {
    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE refresh_token_hash = ?').run(refreshHash);
  }

  // ---------------- DB config ----------------

  getDbConfig(): DbConfigRow | null {
    return (this.db.prepare('SELECT * FROM db_config WHERE id = 1').get() as DbConfigRow) || null;
  }

  saveDbConfig(cfg: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    encrypt: boolean;
    trustServerCert: boolean;
  }): void {
    const enc = this.encrypt(cfg.password);
    this.db
      .prepare(
        `INSERT INTO db_config (id, host, port, username, password_enc, database, encrypt, trust_server_cert)
         VALUES (1, @host, @port, @username, @password_enc, @database, @encrypt, @trust_server_cert)
         ON CONFLICT(id) DO UPDATE SET
           host = @host, port = @port, username = @username, password_enc = @password_enc,
           database = @database, encrypt = @encrypt, trust_server_cert = @trust_server_cert`,
      )
      .run({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        password_enc: enc,
        database: cfg.database,
        encrypt: cfg.encrypt ? 1 : 0,
        trust_server_cert: cfg.trustServerCert ? 1 : 0,
      });
  }

  // ---------------- Permissions ----------------

  listPermissions(): PermissionRow[] {
    return this.db.prepare('SELECT * FROM permissions').all() as PermissionRow[];
  }

  getPermission(tableName: string): PermissionRow | undefined {
    return this.db.prepare('SELECT * FROM permissions WHERE table_name = ?').get(tableName) as PermissionRow | undefined;
  }

  /**
   * Replace seluruh permission. Default deny: tabel yang tidak terdaftar TIDAK boleh diakses.
   */
  replacePermissions(rows: { tableName: string; schemaName: string; allowRead: boolean; allowSchema: boolean }[]): void {
    const tx = this.db.transaction((items) => {
      this.db.prepare('DELETE FROM permissions').run();
      const ins = this.db.prepare(
        `INSERT INTO permissions (table_name, schema_name, allow_schema, allow_read)
         VALUES (?, ?, ?, ?)`,
      );
      for (const it of items) {
        ins.run(it.tableName, it.schemaName, it.allowSchema ? 1 : 0, it.allowRead ? 1 : 0);
      }
    });
    tx(rows);
  }

  // ---------------- Tool settings (built-in tools) ----------------

  listToolSettings(): { name: string; enabled: number }[] {
    return this.db.prepare('SELECT * FROM tool_settings').all() as { name: string; enabled: number }[];
  }

  setToolSettings(rows: { name: string; enabled: boolean }[]): void {
    const tx = this.db.transaction((items) => {
      const upsert = this.db.prepare(
        'INSERT INTO tool_settings (name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled',
      );
      for (const it of items) upsert.run(it.name, it.enabled ? 1 : 0);
    });
    tx(rows);
  }

  getToolSetting(name: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM tool_settings WHERE name = ?').get(name) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  // ---------------- Custom tools ----------------

  listCustomTools(): CustomToolRow[] {
    return this.db.prepare('SELECT * FROM custom_tools ORDER BY created_at DESC').all() as CustomToolRow[];
  }

  getCustomTool(id: string): CustomToolRow | undefined {
    return this.db.prepare('SELECT * FROM custom_tools WHERE id = ?').get(id) as CustomToolRow | undefined;
  }

  getCustomToolByName(name: string): CustomToolRow | undefined {
    return this.db.prepare('SELECT * FROM custom_tools WHERE name = ?').get(name) as CustomToolRow | undefined;
  }

  saveCustomTool(row: CustomToolRow): void {
    this.db
      .prepare(
        `INSERT INTO custom_tools (id, name, title, description, mode, definition, enabled, created_at, updated_at)
         VALUES (@id, @name, @title, @description, @mode, @definition, @enabled, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, title = @title, description = @description, mode = @mode,
           definition = @definition, enabled = @enabled, updated_at = @updated_at`,
      )
      .run(row);
  }

  deleteCustomTool(id: string): boolean {
    const r = this.db.prepare('DELETE FROM custom_tools WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ---------------- Audit ----------------

  addAudit(entry: Partial<AuditRow> & { tool: string; status: number }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, key_id, key_name, tool, table_name, params, row_count, duration_ms, ip, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts || new Date().toISOString(),
        entry.key_id ?? null,
        entry.key_name ?? null,
        entry.tool,
        entry.table_name ?? null,
        entry.params ?? null,
        entry.row_count ?? null,
        entry.duration_ms ?? null,
        entry.ip ?? null,
        entry.status,
      );
  }

  listAudit(limit: number, filter?: { tool?: string; tableName?: string }): AuditRow[] {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.tool) {
      sql += ' AND tool = ?';
      params.push(filter.tool);
    }
    if (filter?.tableName) {
      sql += ' AND table_name = ?';
      params.push(filter.tableName);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(Math.min(limit, 500));
    return this.db.prepare(sql).all(...params) as AuditRow[];
  }

  // ---------------- Project registry (root storage only) ----------------

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  createProject(name: string): ProjectRow {
    const row: ProjectRow = {
      id: crypto.randomUUID(),
      name: name.slice(0, 64),
      created_at: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(row.id, row.name, row.created_at);
    return row;
  }

  /** Registrasi project hasil migrasi legacy (id ditentukan, bukan random). */
  createProject0(id: string, name: string, createdAt: string): void {
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);
  }

  renameProject(id: string, name: string): boolean {
    const r = this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.slice(0, 64), id);
    return r.changes > 0;
  }

  deleteProject(id: string): boolean {
    const r = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return r.changes > 0;
  }

  /** Migrasi: salin kv (mis. session secret) dari DB lama ke root. */
  importKv(rows: { k: string; v: string }[]): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)');
    for (const row of rows) ins.run(row.k, row.v);
  }
}

/* ============================================================
   LAYOUT MULTI-PROJECT
   - root registry : data/app.db (kv secret + registry projects)
   - per project   : data/projects/<id>/app.db (skema lengkap)
   Proxy `storage` + AsyncLocalStorage => kode existing otomatis
   beroperasi di project yang sedang aktif dalam request.
   ============================================================ */

/**
 * Migrasi satu-kali dari instalasi single-project lama:
 * data/app.db dipindah menjadi project "default", kv (session secret)
 * disalin ke root agar sesi JWT & password terenkripsi tetap valid.
 */
export function ensureDataLayout(): { migrated: boolean } {
  const dataDir = config.dataDir;
  const projectsDir = path.join(dataDir, 'projects');
  const legacyDb = path.join(dataDir, 'app.db');
  if (fs.existsSync(projectsDir)) {
    // Recongiliasi: root `projects` kosong padahal ada dir data legacy
    // (mis. migrasi lama terganggu) -> daftarkan kembali project "default".
    try {
      const root = new Database(path.join(dataDir, 'app.db'), { readonly: true });
      const count = (root.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
      root.close();
      if (count === 0 && fs.existsSync(path.join(projectsDir, 'default', 'app.db'))) {
        MIGRATED_LEGACY_ID = 'default';
      }
    } catch {
      /* root belum punya tabel projects — biarkan */
    }
    return { migrated: false };
  }
  fs.mkdirSync(projectsDir, { recursive: true });
  if (!fs.existsSync(legacyDb)) return { migrated: false };

  let kvRows: { k: string; v: string }[] = [];
  try {
    const tmp = new Database(legacyDb, { readonly: true });
    kvRows = tmp.prepare('SELECT k, v FROM kv').all() as { k: string; v: string }[];
    tmp.close();
  } catch {
    kvRows = [];
  }

  const id = 'default';
  const dir = path.join(projectsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(legacyDb, path.join(dir, 'app.db'));
  for (const ext of ['-wal', '-shm']) {
    const p = legacyDb + ext;
    if (fs.existsSync(p)) {
      try {
        fs.renameSync(p, path.join(dir, 'app.db') + ext);
      } catch {
        /* wal/shm opsional */
      }
    }
  }

  // kv disalin ke root yang baru dibuka (lihat MIGRATED_KV dibawah)
  MIGRATED_KV = kvRows;
  MIGRATED_LEGACY_ID = id;
  return { migrated: true };
}

let MIGRATED_KV: { k: string; v: string }[] = [];
let MIGRATED_LEGACY_ID: string | null = null;

const projectCtx = new AsyncLocalStorage<{ id: string; storage: Storage }>();
const openProjectStorages = new Map<string, Storage>();

const projectDbPath = (id: string): string => path.join(config.dataDir, 'projects', id, 'app.db');

export function openProjectStorage(id: string): Storage {
  let s = openProjectStorages.get(id);
  if (!s) {
    s = new Storage(projectDbPath(id));
    openProjectStorages.set(id, s);
  }
  return s;
}

export function closeProjectStorage(id: string): void {
  openProjectStorages.get(id)?.close();
  openProjectStorages.delete(id);
}

/** Jalankan fn dalam konteks sebuah project (storage + pool ikut ter-scope). */
export function withProject<T>(id: string, fn: () => T): T {
  return projectCtx.run({ id, storage: openProjectStorage(id) }, fn);
}

export function currentProjectId(): string | null {
  return projectCtx.getStore()?.id ?? null;
}

/** Registry root (session secret, daftar project) — aman dipakai kapan saja. */
export const registryStorage = (() => {
  // Migrasi single-project lama -> project "default" harus selesai
  // SEBELUM root registry dibuka (kv lama disalin ke root).
  ensureDataLayout();
  const s = new Storage();
  if (MIGRATED_KV.length) {
    s.importKv(MIGRATED_KV);
    MIGRATED_KV = [];
  }
  if (MIGRATED_LEGACY_ID) {
    const id = MIGRATED_LEGACY_ID;
    MIGRATED_LEGACY_ID = null;
    const stamp = fs.statSync(path.join(config.dataDir, 'projects', id, 'app.db')).mtime.toISOString();
    s.createProject0(id, 'default', stamp);
  }
  return s;
})();

/**
 * Storage aktif: proxy ke project yang sedang diproses (per-request),
 * fallback ke registry root di luar konteks request.
 */
export const storage: Storage = new Proxy({} as Storage, {
  get: (_t, prop) =>
    ((projectCtx.getStore()?.storage ?? registryStorage) as unknown as Record<string | symbol, unknown>)[prop],
}) as unknown as Storage;