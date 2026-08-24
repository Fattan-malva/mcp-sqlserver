import express from 'express';
import cookieParser from 'cookie-parser';
import { config, validateEnv } from './config.js';
import { storage, registryStorage, withProject, currentProjectId, openProjectStorage } from './db/storage.js';
import { adminRouter, requireAdmin } from './api/auth.js';
import { configRouter } from './api/config.js';
import { keysRouter } from './api/keys.js';
import { permissionsRouter } from './api/permissions.js';
import { auditRouter, statusRouter } from './api/misc.js';
import { agentRouter } from './api/agent.js';
import { mcpMiddleware } from './mcp/server.js';
import { oauthRouter } from './oauth/router.js';
import { asMetadataHandler, protectedResourceHandler } from './oauth/wellknown.js';
import { oauthClientsRouter } from './api/oauthclients.js';
import { toolsRouter } from './api/tools.js';
import { projectsRouter } from './api/projects.js';
import { getEffectiveTools } from './mcp/tools.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const ASSET_VERSION = (() => {
  const sum = ['app.js', 'style.css'].reduce((a, f) => a + fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs, 0);
  return Math.round(sum).toString(36);
})();

// Migrasi single-project lama -> project "default" dijalankan di storage.ts.
const errors = validateEnv();
if (errors.length) {
  console.error('[mcp-sqlserv] Konfigurasi tidak valid:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('Create .env from .env.example and restart.');
  process.exit(1);
}

// Warm-up: buka storage semua project yang ada agar error DB terdeteksi saat boot.
for (const p of storage.listProjects()) openProjectStorage(p.id);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health check publik (tanpa auth) — untuk monitoring
app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'mcp-sqlserv', time: new Date().toISOString() }));

// MCP endpoint — Streamable HTTP, wajib API key ATAU access token OAuth.
// 1) /mcp — auto-detect project dari API key / OAuth token (backward compatible).
// 2) /mcp/<projectId> — URL eksplisit per project (diprioritaskan untuk client baru).
// OAuth 2.1 discovery juga tersedia di bawah path /mcp[/<projectId>] (RFC 9728),
// karena client biasanya fetch metadata relatif terhadap URL resource yang diketik.
app.get(
  ['/mcp/.well-known/oauth-protected-resource', '/mcp/:projectId/.well-known/oauth-protected-resource'],
  protectedResourceHandler,
);
app.get(['/mcp/.well-known/oauth-authorization-server', '/mcp/:projectId/.well-known/oauth-authorization-server'], asMetadataHandler);

app.all('/mcp', mcpMiddleware());
app.all('/mcp/:projectId', (req, res, next) => {
  const pid = String(req.params.projectId ?? '');
  if (!/^[A-Za-z0-9_-]+$/.test(pid)) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Project tidak dikenal.' }, id: null });
    return;
  }
  mcpMiddleware(pid)(req, res, next);
});
app.use('/mcp', (_req, res) => res.status(405).json({ error: 'Method not supported' }));

// OAuth 2.1: discovery metadata (RFC 9728 / RFC 8414) + authorization server
app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
app.get('/.well-known/oauth-authorization-server', asMetadataHandler);
app.use('/oauth', oauthRouter());

// Projek gate: seluruh API admin beroperasi dalam satu project (cookie mcp_project).
// Bila belum ada cookie: fallback otomatis ke project tunggal agar setup lama tetap jalan.
function projectGate(): express.RequestHandler {
  return (req, res, next) => {
    const all = storage.listProjects();
    if (all.length === 0) {
      res.status(400).json({ error: 'Belum ada project. Buat project dulu.' });
      return;
    }
    const cookie = String(req.cookies?.mcp_project ?? '');
    let pid = all.some((p) => p.id === cookie) ? cookie : '';
    if (!pid) {
      if (all.length === 1) pid = all[0].id;
      else {
        res.status(400).json({ error: 'Pilih project dahulu.' });
        return;
      }
    }
    withProject(pid, next);
  };
}

// REST admin API
const api = express.Router();
api.use('/auth', adminRouter());
api.use('/projects', requireAdmin(), projectsRouter());
api.use('/config', requireAdmin(), projectGate(), configRouter());
api.use('/keys', requireAdmin(), projectGate(), keysRouter());
api.use('/permissions', requireAdmin(), projectGate(), permissionsRouter());
api.use('/audit', requireAdmin(), projectGate(), auditRouter());
api.use('/status', requireAdmin(), projectGate(), statusRouter());
api.use('/agent', requireAdmin(), projectGate(), agentRouter());
api.use('/oauth-clients', requireAdmin(), projectGate(), oauthClientsRouter());
api.use('/tools', requireAdmin(), projectGate(), toolsRouter());

api.get('/connect', requireAdmin(), projectGate(), (_req, res) => {
  const pid = currentProjectId() ?? '';
  const project = registryStorage.getProject(pid);
  const keys = storage.listApiKeys().filter((k) => k.revoked === 0);
  const proto = 'https';
  const host = _req.headers.host ?? `localhost:${config.port}`;
  res.json({
    project: project ? { id: project.id, name: project.name } : null,
    mcpUrl: `${proto}://${host}/mcp/${pid}`,
    mcpUrlLegacy: `${proto}://${host}/mcp`,
    auth: 'Bearer <api-key>',
    note: 'Use this project URL + an API key to connect any AI agent / MCP client. Generic config format:',
    oauth: {
      url: `${proto}://${host}/mcp/${pid}`,
      discovery: `${proto}://${host}/.well-known/oauth-authorization-server`,
      claudeCallback: 'https://claude.ai/api/mcp/auth_callback',
      guide:
        'Claude custom connector: Customize -> Connectors -> Add custom connector -> isi Remote MCP server URL ini, lalu Advanced settings: OAuth Client ID + Secret (lihat halaman OAuth Clients). Bisa juga dikosongkan (Dynamic Client Registration — resource akan mengarah ke project ini).',
    },
    exampleConfig: {
      mcpServers: {
        'sql-server': {
          url: `${proto}://${host}/mcp/${pid}`,
          headers: { Authorization: 'Bearer sk-paste-apikey-disini' },
        },
      },
    },
    tools: getEffectiveTools().map((t) => t.name),
    activeKeys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.key_prefix })),
    projects: registryStorage.listProjects().map((p) => ({ id: p.id, name: p.name })),
  });
});
app.use('/api', api);

// Web UI
const renderIndex = (req: express.Request) => {
  const host = `https://${req.headers.host ?? `localhost:${config.port}`}`;
  return INDEX_HTML.replaceAll('__V__', ASSET_VERSION).replaceAll('__HOST__', host);
};
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.type('html').send(renderIndex(_req));
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.set('Cache-Control', 'no-store, max-age=0');
  res.type('html').send(renderIndex(req));
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[mcp-sqlserv] Error:', err);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`[mcp-sqlserv] Web UI + MCP running on port ${config.port}`);
  console.log(`[mcp-sqlserv] MCP endpoint: /mcp (Streamable HTTP, requires API key)`);
  console.log(`[mcp-sqlserv] Admin login: ${config.adminUser}`);
});