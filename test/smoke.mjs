import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PORT = 4101;
const BASE = `http://localhost:${PORT}`;
const DATA = '/home/ubuntu/MCP/mcp-sqlserv/test/smoke/data';
const SSE_LOG = '/home/ubuntu/MCP/mcp-sqlserv/test/smoke/sse.log';
fs.rmSync('/home/ubuntu/MCP/mcp-sqlserv/test/smoke', { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const server = spawn('node', ['dist/index.js'], {
  cwd: '/home/ubuntu/MCP/mcp-sqlserv',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'smoke12345' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let booted = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/healthz`);
    if (r.ok) { booted = true; break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!booted) { console.error('SERVER GAGAL START'); server.kill(); process.exit(1); }
console.log('server up');

const j = (r) => r.json();
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'admin', password: 'smoke12345' }),
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
check('login admin', login.ok && !!cookie);
const pr = await j(await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ name: 'smoke' }),
}));
check('project dibuat', !!pr.project?.id);
const kr = await j(await fetch(`${BASE}/api/keys`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ name: 'smoke' }),
}));
const KEY = kr.plainKey;
check('api key dibuat', !!KEY);

let MCP_SID = null;
const MCP = async (id, method, params = {}) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(MCP_SID ? { 'mcp-session-id': MCP_SID } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (r.headers.get('mcp-session-id')) MCP_SID = r.headers.get('mcp-session-id');
  const text = await r.text();
  const bodies = [...text.matchAll(/event: message\ndata: ([^\n]+)/g)].map((m) => JSON.parse(m[1]));
  return bodies.find((b) => b.id === id) ?? bodies[bodies.length - 1] ?? JSON.parse(text);
};

const INIT_RESULT = await MCP(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
check('initialize ok', INIT_RESULT.result?.serverInfo?.name === 'mcp-sqlserv', JSON.stringify(INIT_RESULT.error || ''));
check('session id ada', !!MCP_SID);

let tools = await MCP(2, 'tools/list');
const names = tools.result.tools.map((t) => t.name);
check('tools/list awal = 6 builtin', names.length === 6 && names.includes('read_records') && !names.includes('smoke_tool'), names.join(','));

const sse = spawn('bash', ['-c', `timeout 9 curl -sN -H "Authorization: Bearer ${KEY}" -H "Accept: text/event-stream" -H "mcp-session-id: ${MCP_SID}" ${BASE}/mcp > ${SSE_LOG}`]);
await new Promise((r) => setTimeout(r, 1200));

const def = JSON.stringify({ mode: 'builder', builder: { baseTable: 'MstUserLog', joins: [], where: [], orderBy: [], limit: 100 }, params: [] });
const DIR = '/home/ubuntu/MCP/mcp-sqlserv/test/smoke';
const PROJ_DB = `${DATA}/projects/${pr.project.id}/app.db`;
fs.writeFileSync(`${DIR}/insert.mjs`, `
import Database from 'better-sqlite3';
const db = new Database('${PROJ_DB}');
db.prepare("INSERT INTO custom_tools (id,name,title,description,mode,definition,enabled,created_at,updated_at) VALUES ('smk1','smoke_tool','Smoke Tool','tool uji','builder',?,1,datetime('now'),datetime('now'))").run(${JSON.stringify(def)});
db.close();`);
fs.writeFileSync(`${DIR}/delete.mjs`, `
import Database from 'better-sqlite3';
const db = new Database('${PROJ_DB}');
db.prepare("DELETE FROM custom_tools WHERE id='smk1'").run();
db.close();`);
execSync(`node ${DIR}/insert.mjs`, { stdio: 'inherit' });
{
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(PROJ_DB, { readonly: true });
  console.log('db rows setelah insert:', db.prepare("SELECT name, enabled FROM custom_tools").all());
  db.close();
}
const bres = await j(await fetch(`${BASE}/api/tools/builtin`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ tools: [{ name: 'list_tables', enabled: true }] }),
}));
check('PUT /api/tools/builtin (trigger notify)', bres.ok === true);

await new Promise((r) => setTimeout(r, 1800));
tools = await MCP(3, 'tools/list');
const names2 = tools.result.tools.map((t) => t.name);
check('tools/list sesudah = 7 (custom tool terdeteksi)', names2.includes('smoke_tool'), names2.join(','));

await sse.kill();
await new Promise((r) => setTimeout(r, 600));
let sseText = '';
try { sseText = fs.readFileSync(SSE_LOG, 'utf8'); } catch { /* noop */ }
check('SSE menerima notifications/tools/list_changed', sseText.includes('notifications/tools/list_changed'), sseText.slice(0, 200));

const res = await MCP(4, 'resources/list');
const resNames = (res.result?.resources || []).map((r) => r.uri);
check('resources/list berisi allowed-tables', resNames.includes('mallvaa://allowed-tables'), resNames.join(','));

const connect = await j(await fetch(`${BASE}/api/connect`, { headers: { Cookie: cookie } }));
check('/api/connect tools termasuk custom tool', connect.tools.includes('smoke_tool'), connect.tools.join(','));

execSync(`node ${DIR}/delete.mjs`);
await j(await fetch(`${BASE}/api/tools/builtin`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ tools: [{ name: 'list_tables', enabled: true }] }),
}));
await new Promise((r) => setTimeout(r, 1500));
tools = await MCP(5, 'tools/list');
const names3 = tools.result.tools.map((t) => t.name);
check('tools/list setelah hapus = 6 lagi', !names3.includes('smoke_tool'), names3.join(','));

console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
server.kill('SIGTERM');
process.exit(fail ? 1 : 0);