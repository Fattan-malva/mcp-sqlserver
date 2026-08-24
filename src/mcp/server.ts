import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { limits, config } from '../config.js';
import { sha256, storage, registryStorage, openProjectStorage, withProject, isProjectBoundResource, type ApiKeyRow } from '../db/storage.js';
import { getEffectiveTools, type ToolDef, type ToolContext } from './tools.js';
import { getTableListCached } from '../sqlserver/metadata.js';
import { onResourcesChanged, onToolsChanged } from './changes.js';

const toolContext = new AsyncLocalStorage<ToolContext>();

/** Handle hasil registerTool — dipakai hanya untuk update()/remove(), tanpa import tipe internal SDK. */
interface RegisteredToolLike {
  title?: string;
  description?: string;
  update(updates: {
    title?: string;
    description?: string;
    paramsSchema?: unknown;
    callback?: (args: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>;
    enabled?: boolean;
  }): void;
  remove(): void;
}

interface ToolHandle {
  fp: string;
  handle: RegisteredToolLike;
}

interface Session {
  pid: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActive: number;
  revision: number;
  toolHandles: Map<string, ToolHandle>;
}

const sessions = new Map<string, Session>();

const sessionKey = (pid: string, sessionId: string): string => `${pid}|${sessionId}`;

/** Feldisi versi daftar tool; dinaikkan tiap kali tool berubah (api/tools). */
let toolsRevision = 0;

export function bumpToolsRevision(): void {
  toolsRevision++;
}

function toolFingerprint(t: ToolDef): string {
  return [
    t.name,
    t.title,
    t.description,
    JSON.stringify(z.toJSONSchema(t.inputSchema)),
    t.version ?? '',
  ].join('|');
}

/** Ekstrak raw shape dari ZodObject (v3/v4) untuk dipakai di RegisteredTool.update(). */
function zodRawShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const s = schema as { _zod?: { def?: { shape?: Record<string, z.ZodType> } }; shape?: Record<string, z.ZodType> };
  return s._zod?.def?.shape ?? s.shape;
}

function wrapHandler(t: ToolDef) {
  return async (args: unknown): Promise<{ content: { type: 'text'; text: string }[] }> => {
    const ctx = toolContext.getStore();
    if (!ctx) throw new Error('Konteks request tidak tersedia');
    return t.handler(args ?? {}, ctx);
  };
}

/**
 * Sinkronkan tool yang terdaftar di session dengan getEffectiveTools() (storage).
 * - tool baru  -> registerTool()  (SDK otomatis kirim tools/list_changed)
 * - berubah    -> handle.update() (SDK otomatis kirim tools/list_changed)
 * - dihapus    -> handle.remove() (SDK otomatis kirim tools/list_changed)
 */
async function syncSession(session: Session): Promise<void> {
  const desired = getEffectiveTools();
  const reg = session.toolHandles;

  for (const t of desired) {
    const fp = toolFingerprint(t);
    const existing = reg.get(t.name);
    if (existing) {
      if (existing.fp === fp) continue;
      existing.handle.update({
        title: t.title,
        description: t.description,
        paramsSchema: zodRawShape(t.inputSchema) ?? {},
        callback: wrapHandler(t),
      });
      existing.fp = fp;
    } else {
      reg.set(t.name, {
        fp,
        handle: session.server.registerTool(
          t.name,
          { title: t.title, description: t.description, inputSchema: t.inputSchema },
          wrapHandler(t),
        ) as unknown as RegisteredToolLike,
      });
    }
  }

  for (const [name, entry] of reg) {
    if (!desired.some((t) => t.name === name)) {
      entry.handle.remove();
      reg.delete(name);
    }
  }
}

function syncAllSessions(): void {
  for (const s of sessions.values()) {
    withProject(s.pid, () =>
      syncSession(s)
        .then(() => {
          s.revision = toolsRevision;
        })
        .catch((err) => console.error('[mcp-sqlserv] Sync tools error:', err)),
    );
  }
}

function sendResourcesChangedAll(): void {
  for (const s of sessions.values()) {
    try {
      if (s.server.isConnected()) s.server.sendResourceListChanged();
    } catch {
      /* noop */
    }
  }
}

// Perubahan tools (via API admin) -> bump revisi + sinkron semua session yang connect
onToolsChanged(() => {
  bumpToolsRevision();
  syncAllSessions();
});

// Perubahan izin tabel / skema DB -> kabari client yang support resources/list_changed
onResourcesChanged(() => {
  sendResourcesChangedAll();
});

const ALLOWED_TABLES_URI = 'mallvaa://allowed-tables';

/** Resource MCP: daftar tabel yang boleh dibaca AI — selalu segar (baca storage + cache metadata). */
function registerAllowedTablesResource(server: McpServer): void {
  server.registerResource(
    'allowed-tables',
    ALLOWED_TABLES_URI,
    {
      title: 'Daftar tabel yang diizinkan untuk AI',
      description:
        'Daftar tabel database yang boleh dibaca AI (permission admin). Otomatis diperbarui saat izin tabel atau skema database berubah.',
      mimeType: 'application/json',
    },
    async () => {
      const perms = storage.listPermissions().filter((p) => p.allow_read === 1 || p.allow_schema === 1);
      const tables = (await getTableListCached()).filter((t) => perms.some((p) => p.table_name === t.name));
      return {
        contents: [
          {
            uri: ALLOWED_TABLES_URI,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                tables: tables.map((t) => ({ schema: t.schema, table: t.name, rowCount: t.rowCount })),
                updatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'mcp-sqlserv', version: '1.0.0' }, { capabilities: { tools: {} } });
  registerAllowedTablesResource(server);
  return server;
}

// Sweep sesi yang tidak aktif > 2 jam (transport SSE yang ditinggal client)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > 2 * 3600_000) {
      sessions.delete(id);
      s.transport.close().catch(() => undefined);
      s.server.close().catch(() => undefined);
    }
  }
}, 60_000).unref();

function getClientIp(req: express.Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

const rateHits = new Map<string, number[]>();
setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of rateHits) {
    const f = hits.filter((t) => now - t < 60_000);
    if (f.length) rateHits.set(id, f);
    else rateHits.delete(id);
  }
}, 60_000).unref();

export interface KeyAuthResult {
  ok: boolean;
  key: ApiKeyRow;
  projectId: string;
  error?: string;
}

const CRED_NOT_FOUND: KeyAuthResult = { ok: false, key: {} as ApiKeyRow, projectId: '', error: 'API key tidak valid.' };

/**
 * Autentikasi /mcp:
 * 1. API key (`sk-...` via Authorization: Bearer / X-Api-Key) — jalur asli.
 * 2. Access token OAuth (`oat_...`) — di-resolve ke API key pendamping
 *    `oauth:<client_id>` sehingga izin, rate limit, dan audit berlaku sama.
 * Setiap projekt punya DB sendiri -> lookup dilakukan per project.
 */
function resolveKey(st: ReturnType<typeof openProjectStorage>, cred: string): ApiKeyRow | undefined {
  if (cred.startsWith('oat_')) {
    const tok = st.findOauthTokenByHash(sha256(cred));
    if (!tok || tok.revoked === 1 || tok.expires_at < Date.now()) return undefined;
    return st.getApiKeyById(tok.api_key_id);
  }
  return st.findKeyByHash(sha256(cred));
}

/** Auth dalam satu project tertentu (URL /mcp/<projectId>). */
export function authenticateInProject(projectId: string, req: express.Request): KeyAuthResult {
  const header = req.headers.authorization;
  const cred = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
  if (!cred) {
    return {
      ok: false,
      key: {} as ApiKeyRow,
      projectId,
      error: 'API key missing. Gunakan header Authorization: Bearer <api-key> atau X-Api-Key.',
    };
  }
  const st = openProjectStorage(projectId);
  const keyRow = resolveKey(st, cred);
  if (keyRow) {
    if (keyRow.revoked === 1) return { ok: false, key: keyRow, projectId, error: 'API key sudah di-revoke.' };
    return { ok: true, key: keyRow, projectId };
  }

  // First-use claim: token OAuth boleh milik client "unbound" (terdaftar tanpa
  // resource project, mis. klien yang hanya memakai discovery di origin root).
  // Pemakaian pertama token di URL /mcp/<projectId> memindahkan seluruh jejak
  // OAuth (client + api key + tokens) ke project tersebut dan mengikatnya di sana.
  if (cred.startsWith('oat_')) {
    const tokenHash = sha256(cred);
    for (const p of registryStorage.listProjects()) {
      if (p.id === projectId) continue;
      const pst = openProjectStorage(p.id);
      const tok = pst.findOauthTokenByHash(tokenHash);
      if (!tok || tok.revoked === 1 || tok.expires_at < Date.now()) continue;
      const owner = pst.findOauthClient(tok.client_id);
      if (!owner || isProjectBoundResource(owner.resource)) continue;
      console.log(`[oauth] first-use claim: client ${owner.client_id} (${owner.client_name}) dari project ${p.id} -> ${projectId}`);
      pst.relocOauthCredsTo(st, owner.client_id, `/mcp/${projectId}`);
      const adopted = resolveKey(st, cred);
      if (adopted) {
        if (adopted.revoked === 1) return { ok: false, key: adopted, projectId, error: 'API key sudah di-revoke.' };
        return { ok: true, key: adopted, projectId };
      }
      break;
    }
  }

  return { ...CRED_NOT_FOUND, projectId };
}

/** Auth scan lintas project: project pemilik key/token ditemukan otomatis (URL /mcp). */
export function authenticateScan(req: express.Request): KeyAuthResult {
  const header = req.headers.authorization;
  const cred = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined);
  if (!cred) {
    return { ok: false, key: {} as ApiKeyRow, projectId: '', error: 'API key missing. Gunakan header Authorization: Bearer <api-key> atau X-Api-Key.' };
  }
  for (const p of registryStorage.listProjects()) {
    const keyRow = resolveKey(openProjectStorage(p.id), cred);
    if (!keyRow) continue;
    if (keyRow.revoked === 1) return { ok: false, key: keyRow, projectId: p.id, error: 'API key sudah di-revoke.' };
    return { ok: true, key: keyRow, projectId: p.id };
  }
  return CRED_NOT_FOUND;
}

/** Perbesar sesi yang transport-nya milik project yang dihapus. */
export function dropProjectSessions(pid: string): void {
  for (const [key, s] of sessions) {
    if (s.pid !== pid) continue;
    sessions.delete(key);
    s.transport.close().catch(() => undefined);
    s.server.close().catch(() => undefined);
  }
}

/** WWW-Authenticate untuk memicu discovery OAuth Claude (RFC 9728). */
function challengeHeader(req: express.Request): string {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.port}`;
  return `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`;
}

export function mcpMiddleware(projectId?: string): express.RequestHandler {
  return async (req, res, next) => {
    let auth: KeyAuthResult;

    if (projectId) {
      if (!registryStorage.getProject(projectId)) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Project tidak dikenal.' }, id: null });
        return;
      }
      auth = authenticateInProject(projectId, req);
    } else {
      auth = authenticateScan(req);
    }

    if (!auth.ok) {
      if (!auth.key.id) {
        res.set('WWW-Authenticate', challengeHeader(req)).status(401);
      } else {
        res.status(401);
      }
      res.json({ jsonrpc: '2.0', error: { code: -32001, message: auth.error }, id: null });
      return;
    }

    const pid = auth.projectId;
    const now = Date.now();
    const rateKey = `${pid}|${auth.key.id}`;
    const hits = rateHits.get(rateKey) ?? [];
    const filtered = hits.filter((t) => now - t < 60_000);
    if (filtered.length >= limits.apiKeyRateLimit) {
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32001, message: `Rate limit tercapai (${limits.apiKeyRateLimit} request/menit).` }, id: null });
      return;
    }
    filtered.push(now);
    rateHits.set(rateKey, filtered);
    openProjectStorage(pid).touchApiKey(auth.key.id);

    const ctx: ToolContext = { key: auth.key, ip: getClientIp(req) };

    const sessionId = (req.headers['mcp-session-id'] as string) || randomUUID();
    const skey = sessionKey(pid, sessionId);
    let session = sessions.get(skey);
    if (!session) {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      session = { pid, server, transport, lastActive: Date.now(), revision: toolsRevision, toolHandles: new Map() };
      sessions.set(skey, session);
      transport.onclose = () => {
        if (sessions.get(skey) === session) sessions.delete(skey);
        session!.server.close().catch(() => undefined);
      };
      await withProject(pid, () => syncSession(session!));
      await server.connect(transport).catch(() => undefined);
    }
    session.lastActive = Date.now();

    // Tool baru/berubah via storage sejak session dibuat -> sinkronkan dulu agar
    // tools/list selalu menjawab kondisi terkini (berlaku untuk semua client).
    if (session.revision !== toolsRevision) {
      await withProject(pid, () => syncSession(session!));
      session.revision = toolsRevision;
    }

    try {
      await withProject(pid, async () => {
        await toolContext.run(ctx, async () => {
          await session!.transport.handleRequest(req, res, req.body);
        });
      });
    } catch (err) {
      if (!res.headersSent) next(err);
      else res.end();
    }
  };
}