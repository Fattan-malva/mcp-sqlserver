/* ============================================================
   TEST TOOLS PLAYGROUND — mcp-sqlserv
   Jalankan: node test/tools.mjs
   (memakai server produksi/deploy live; butuh ADMIN creds di .env)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.env.TOOLS_TEST_BASE || 'https://mcp-sqlserv.mallvaa.xyz';

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

const ADMIN_USER = readEnv('ADMIN_USER') || 'admin';
const ADMIN_PASSWORD = readEnv('ADMIN_PASSWORD');
if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD tidak ditemukan (env atau .env)');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const txt = (r) => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));

async function api(pathname, opts = {}, cookie = '') {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...opts,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

/* --- login admin --- */
let cookies = '';
{
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASSWORD }) });
  check('login admin', r.status === 200, String(r.status));
  const sc = r.headers.get('set-cookie') || '';
  const kv = (sc.split(';')[0] || '').trim();
  if (kv) cookies = kv;
}

/* --- akses tanpa auth --- */
{
  const r = await api('/api/tools');
  check('GET /api/tools tanpa auth (401)', r.status === 401, String(r.status));
}

let mcpKey = null;
let ssoKey = null;

const mcpSessions = new Map();
async function parseMcpBody(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) return {};
    try { return JSON.parse(dataLine.slice(5).trim()); } catch { return {}; }
  }
  try { return JSON.parse(text); } catch { return {}; }
}

async function mcpCall(payload, bearer, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const sid = mcpSessions.get(bearer);
  if (sid && !opts.fresh) headers['mcp-session-id'] = sid;
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify(payload) });
  const newSid = res.headers.get('mcp-session-id');
  if (newSid) mcpSessions.set(bearer, newSid);
  return { status: res.status, body: await parseMcpBody(res), sid: newSid };
}

async function mcpInit(bearer, fresh = false) {
  const r = await mcpCall({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tools-test', version: '1.0.0' } },
  }, bearer, { fresh });
  mcpSessions.set(bearer, r.sid || mcpSessions.get(bearer));
  await mcpCall({ jsonrpc: '2.0', id: 1, method: 'notifications/initialized', params: {} }, bearer).catch(() => undefined);
  return r.status === 200;
}

async function freshMcpKey() {
  const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'tools-test' }) }, cookies);
  if (r.status !== 200) return null;
  const k = await api('/api/keys', {}, cookies);
  const key = r.body?.plainKey ?? '';
  ssoKey = k.body?.keys?.find((x) => x.name === 'tools-test')?.id ?? null;
  return key;
}
async function cleanupKey() {
  if (ssoKey) await api('/api/keys/' + ssoKey, { method: 'DELETE' }, cookies).catch(() => undefined);
}

/* --- buat MCP key utk seluruh pengujian --- */
{
  mcpKey = await freshMcpKey();
  check('MCP key dibuat', !!mcpKey);
  const ok = await mcpInit(mcpKey);
  check('MCP initialize', ok);
}

/* --- identifikasi tabel yang boleh dibaca & tidak + contoh kolom/nilai --- */
let allowedTable = null;
let deniedTable = null;
let probeCol = null;
let probeVal = null;
{
  const r = await api('/api/permissions', {}, cookies);
  check('GET /api/permissions', r.status === 200, String(r.status));
  const tabs = r.body?.tables ?? [];
  allowedTable = tabs.find((t) => t.allowRead)?.table ?? null;
  deniedTable = tabs.find((t) => !t.allowRead)?.table ?? null;
  check('ada tabel allow_read', !!allowedTable, `tables=${tabs.length}`);

  if (allowedTable) {
    const rr = await mcpCall({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'read_records', arguments: { table: allowedTable, limit: 1 } },
    }, mcpKey);
    const text = rr.body?.result?.content?.[0]?.text ?? '';
    try {
      const parsed = JSON.parse(text);
      const row = parsed?.rows?.[0];
      if (row && typeof row === 'object') {
        const keys = Object.keys(row).filter((k) => /^[A-Za-z_][A-Za-z0-9_@$#]*$/.test(k));
        probeCol = keys[0];
        probeVal = String(row[probeCol] ?? '');
      }
    } catch {
      /* tidak fatal */
    }
    check('contoh kolom + nilai dapat diambil', !!probeCol, text.slice(0, 80));
  }
}

/* --- toggle builtin via MCP tools/list --- */
const BUILTIN_TEST = 'read_records';
{
  let l = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, mcpKey);
  check('tools/list MCP (awal)', l.status === 200 && Array.isArray(l.body?.result?.tools), txt(l).slice(0, 80));
  check('builtin read_records ada di awal', l.body?.result?.tools?.some((t) => t.name === BUILTIN_TEST));

  const off = await api('/api/tools/builtin', { method: 'PUT', body: JSON.stringify({ tools: [{ name: BUILTIN_TEST, enabled: false }] }) }, cookies);
  check('toggle read_records OFF', off.status === 200, String(off.status));

  await mcpInit(mcpKey, true);
  l = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, mcpKey);
  check('read_records hilang dari tools/list', l.status === 200 && !l.body?.result?.tools?.some((t) => t.name === BUILTIN_TEST), txt(l).slice(0, 80));

  const on = await api('/api/tools/builtin', { method: 'PUT', body: JSON.stringify({ tools: [{ name: BUILTIN_TEST, enabled: true }] }) }, cookies);
  check('toggle read_records ON (restore)', on.status === 200, String(on.status));
  await mcpInit(mcpKey, true);
  l = await mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpKey);
  check('read_records kembali', l.body?.result?.tools?.some((t) => t.name === BUILTIN_TEST));
}

/* --- custom tool: builder --- */
const TOOL_NAME = `t_test_${Date.now() % 100000}`;
let toolId = null;
{
  const def = {
    name: TOOL_NAME,
    title: 'Test builder tool',
    description: 'Reads allowed table rows filtered by a parameter, ordered desc.',
    mode: 'builder',
    builder: {
      baseTable: allowedTable,
      alias: 't',
      columns: undefined,
      joins: [],
      where: [{ ref: `t.${probeCol}`, op: 'eq', param: 'v' }],
      orderBy: [{ ref: `t.${probeCol}`, dir: 'desc' }],
      limit: 5,
    },
    params: [{ name: 'v', type: 'string', required: true }],
  };

  /* draft test pre-save */
  const tt = await api('/api/tools/test-query', {
    method: 'POST',
    body: JSON.stringify({ ...def, paramValues: { v: probeVal } }),
  }, cookies);
  check('test-query draft (200 + data)', tt.status === 200 && Array.isArray(tt.body?.rows) && typeof tt.body?.sql === 'string', txt(tt).slice(0, 120));
  check('test-query menampilkan SQL final', (tt.body?.sql || '').includes('SELECT'), tt.body?.sql?.slice(0, 60));

  const bad = await api('/api/tools/test-query', {
    method: 'POST',
    body: JSON.stringify({ ...def, paramValues: {} }),
  }, cookies);
  check('test-query tanpa param wajib ditolak', bad.status === 400, String(bad.status) + ' ' + txt(bad).slice(0, 80));

  /* save */
  const cr = await api('/api/tools', { method: 'POST', body: JSON.stringify(def) }, cookies);
  check('create custom tool', cr.status === 200, txt(cr).slice(0, 100));

  const dup = await api('/api/tools', { method: 'POST', body: JSON.stringify(def) }, cookies);
  check('nama duplikat ditolak', dup.status === 400, String(dup.status));

  const g = await api('/api/tools', {}, cookies);
  const saved = g.body?.custom?.find((c) => c.name === TOOL_NAME);
  toolId = saved?.id ?? null;
  check('custom tool muncul di GET /api/tools', !!saved, txt(g).slice(0, 100));
  check('custom tool definition tersimpan lengkap', saved?.definition?.params?.length === 1 && saved?.definition?.mode === 'builder');

  /* test pasca-save */
  const tk = await api(`/api/tools/${toolId}/test`, { method: 'POST', body: JSON.stringify({ paramValues: { v: probeVal } }) }, cookies);
  check('test tool tersimpan (200 + data)', tk.status === 200 && Array.isArray(tk.body?.rows), txt(tk).slice(0, 120));

  /* MCP: custom tool terdaftar + bisa dipanggil */
  await mcpInit(mcpKey, true);
  const l = await mcpCall({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, mcpKey);
  const listed = l.body?.result?.tools?.find((t) => t.name === TOOL_NAME);
  check('custom tool di tools/list MCP', !!listed, txt(l).slice(0, 100));
  check('schema custom tool punya param v', JSON.stringify(listed?.inputSchema || {}).includes('v'));

  const call = await mcpCall({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: TOOL_NAME, arguments: { v: probeVal } } }, mcpKey);
  const callText = call.body?.result?.content?.[0]?.text ?? '';
  check('custom tool dipanggil via MCP',
    call.status === 200 && callText.includes('"rowCount"'), String(call.status) + ' ' + callText.slice(0, 100));

  /* audit tercatat untuk custom tool */
  const au = await api('/api/audit?limit=50&tool=' + TOOL_NAME, {}, cookies);
  const auditRows = au.body?.rows ?? [];
  check('audit custom tool tercatat', auditRows.some((r) => r.tool === TOOL_NAME && r.status === 200), txt(au).slice(0, 100));

  /* update tool */
  const up = await api('/api/tools/' + toolId, {
    method: 'PUT',
    body: JSON.stringify({ ...def, title: 'Test builder tool (updated)' }),
  }, cookies);
  check('update custom tool', up.status === 200, txt(up).slice(0, 100));
}

/* --- custom tool: raw SQL + penolakan --- */
{
  const badQ = (name, sql, params = []) =>
    api('/api/tools', {
      method: 'POST',
      body: JSON.stringify({ name, title: 'Bad', description: 'd', mode: 'sql', sql: { sql }, params }),
    }, cookies);

  const t1 = await badQ(`t_bad_ins_${Date.now() % 100000}`, `INSERT INTO x VALUES (1)`);
  check('INSERT ditolak', t1.status === 400, txt(t1).slice(0, 80));
  const t2 = await badQ(`t_bad_drop_${Date.now() % 100000}`, `SELECT * FROM [dbo].[x] DROP TABLE y`);
  check('DROP ditolak', t2.status === 400, txt(t2).slice(0, 80));
  const t3 = await badQ(`t_bad_semi_${Date.now() % 100000}`, `SELECT 1; SELECT 2`);
  check('titik koma ditolak', t3.status === 400, txt(t3).slice(0, 80));
  const t4 = await badQ(`t_bad_param_${Date.now() % 100000}`, `SELECT * FROM [dbo].[${allowedTable}] WHERE id = @bogus`, []);
  check('param tidak dideklarasikan ditolak', t4.status === 400, txt(t4).slice(0, 80));

  if (deniedTable) {
    const t5 = await badQ(`t_bad_perm_${Date.now() % 100000}`, `SELECT TOP (1) * FROM [dbo].[${deniedTable}]`);
    check('tabel tanpa allow_read ditolak', t5.status === 400, txt(t5).slice(0, 100));
  }

  /* sql yang valid dengan parameter */
  const sqlTool = {
    name: `t_sql_ok_${Date.now() % 100000}`,
    title: 'SQL tool',
    description: 'Raw SQL with one parameter.',
    mode: 'sql',
    sql: { sql: `SELECT TOP (10) * FROM [dbo].[${allowedTable}] WHERE [${probeCol}] = @v` },
    params: [{ name: 'v', type: 'string', required: true }],
  };
  const ok = await api('/api/tools', { method: 'POST', body: JSON.stringify(sqlTool) }, cookies);
  check('raw SQL valid diterima', ok.status === 200, txt(ok).slice(0, 100));
  const gl = await api('/api/tools', {}, cookies);
  const row2 = gl.body?.custom?.find((c) => c.name === sqlTool.name);
  if (row2) {
    const tt = await api('/api/tools/' + row2.id + '/test', { method: 'POST', body: JSON.stringify({ paramValues: { v: probeVal } }) }, cookies);
    check('test SQL tool (200 + data)', tt.status === 200 && Array.isArray(tt.body?.rows), txt(tt).slice(0, 120));
    await api('/api/tools/' + row2.id, { method: 'DELETE' }, cookies);
  }
}

/* --- disable + hapus --- */
{
  if (toolId) {
    const dis = await api('/api/tools/' + toolId, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }, cookies);
    check('PATCH disable tool', dis.status === 200, String(dis.status));
    await mcpInit(mcpKey, true);
    const l = await mcpCall({ jsonrpc: '2.0', id: 20, method: 'tools/list' }, mcpKey);
    check('custom tool hilang dari MCP setelah disabled', !l.body?.result?.tools?.some((t) => t.name === TOOL_NAME), txt(l).slice(0, 80));

    const dl = await api('/api/tools/' + toolId, { method: 'DELETE' }, cookies);
    check('DELETE tool', dl.status === 200, String(dl.status));
    const g = await api('/api/tools', {}, cookies);
    check('tool tidak ada lagi', !g.body?.custom?.some((c) => c.id === toolId));
  }
}

await cleanupKey();

console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);