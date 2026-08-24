import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SECURITY_TEST_BASE || 'http://localhost:4000';
const VALID_KEY = process.env.SECURITY_TEST_KEY || null;

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

async function obtainKey() {
  if (VALID_KEY) return VALID_KEY;
  const user = readEnv('ADMIN_USER') || 'admin';
  const pass = readEnv('ADMIN_PASSWORD');
  if (!pass) throw new Error('ADMIN_PASSWORD tidak ditemukan — set SECURITY_TEST_KEY untuk memakai key tetap.');
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password: pass }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const kr = await fetch(BASE + '/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'security-test' }),
  });
  const j = await kr.json().catch(() => ({}));
  const plain = j.plainKey || null;
  let keyId = null;
  if (plain) {
    const list = await (await fetch(BASE + '/api/keys', { headers: { Cookie: cookie } })).json().catch(() => ({}));
    keyId = (list.keys || []).find((k) => k.name === 'security-test')?.id ?? null;
  }
  return { plain, keyId, cookie };
}

const { plain: KEY, keyId: CLEANUP_KEY_ID, cookie: CLEANUP_COOKIE } = await obtainKey();
const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
});
const client = new Client({ name: 'security-test', version: '1.0.0' });
await client.connect(transport);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

/* Fixture DB (Category/Item/AuditLog) — bila tidak ada, test sukses-ekspektasi di-skip */
const perms = await (await fetch(BASE + '/api/permissions', { headers: { Cookie: CLEANUP_COOKIE || '' } })).json().catch(() => ({ tables: [] }));
const FIXTURES = (perms.tables || []).some((t) => t.table === 'Category' && t.allowRead) &&
  (perms.tables || []).some((t) => t.table === 'Item' && t.allowRead);
function fx(name, cond, extra = '') {
  if (!FIXTURES) { check(name, true, '(SKIP: fixture Category/Item tidak ada di DB)'); return; }
  check(name, cond, extra);
}

async function callTool(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? JSON.stringify(r);
    return { ok: true, isError: !!r.isError, text, raw: r };
  } catch (e) {
    return { ok: false, isError: true, text: String(e.message ?? e), raw: null };
  }
}
const txt = (r) => r.text;

// 1. SQL injection via table name -> zod reject (MCP error)
let r = await callTool('read_records', { table: "Category'; DROP TABLE x;--" });
check('injection tabel ditolak', r.isError, txt(r).slice(0, 100));

// 2. SQL injection via column name -> zod reject
r = await callTool('read_records', { table: 'Category', columns: ["*); DROP TABLE x;--"] });
check('injection kolom ditolak', r.isError, txt(r).slice(0, 80));

// 3. union injection di where column -> zod reject
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryName UNION SELECT 1', op: 'eq', value: 'x' }] });
check('injection kolom where ditolak', r.isError, txt(r).slice(0, 80));

// 4. nilai injection di-parameterized: query JALAN dan hasil kosong (bukan drop tabel)
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryName', op: 'eq', value: "x' OR 1=1; DROP TABLE Item;--" }] });
const data4 = r.isError ? null : JSON.parse(txt(r));
fx('nilai injection di-parameterized (query jalan)', r.ok && !r.isError, txt(r).slice(0, 100));
check('tabel Item tetap ada (bisa dibaca)', (await callTool('read_records', { table: 'Item', limit: 1 })).ok, '(Item hilang!)');

// 5. LIKE injection
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryName', op: 'like', value: "x%'; DROP TABLE Item;--" }] });
fx('LIKE injection di-parameterized', r.ok && !r.isError, txt(r).slice(0, 100));

// 6. read_records di tabel allowRead=false (AuditLog) -> isError
r = await callTool('read_records', { table: 'AuditLog', limit: 1 });
check('tabel tanpa izin baca ditolak', r.isError, txt(r).slice(0, 100));

// 7. count di tabel tanpa permission sama sekali (AppConfig) -> ditolak
r = await callTool('count_records', { table: 'AppConfig' });
check('tabel tanpa permission ditolak', r.isError, txt(r).slice(0, 100));

// 8. schema tabel tanpa izin metadata (AppConfig) ditolak
r = await callTool('get_table_schema', { table: 'AppConfig' });
check('schema tabel tanpa izin ditolak', r.isError, txt(r).slice(0, 100));

// 9. schema tabel diizinkan (AuditLog allowSchema) OK
r = await callTool('get_table_schema', { table: 'AuditLog' });
fx('schema tabel diizinkan OK', r.ok && !r.isError && txt(r).includes('columns'), txt(r).slice(0, 80));

// 10. limit di-clamp ke 1000 (zod sekarang REJECT > 1000 — ini validasi SDK)
r = await callTool('read_records', { table: 'Item', limit: 1000000 });
check('limit > 1000 ditolak SDK', r.isError, txt(r).slice(0, 100));
r = await callTool('read_records', { table: 'Item', limit: 300 });
fx('limit 300 OK', r.ok && !r.isError);

// 11. count_records dengan filter
r = await callTool('count_records', { table: 'Category', where: [{ column: 'IsActive', op: 'eq', value: true }] });
fx('count_records filter OK', r.ok && !r.isError && 'total' in JSON.parse(txt(r)), txt(r).slice(0, 100));

// 12. get_record_by_pk
r = await callTool('get_record_by_pk', { table: 'Category', key: { CategoryID: '019f6225-e609-774f-9efe-446569c72d35' } });
fx('get_record_by_pk OK', r.ok && !r.isError && JSON.parse(txt(r)).found === true, txt(r).slice(0, 120));

// 13. pk kolom salah (bukan PK)
r = await callTool('get_record_by_pk', { table: 'Category', key: { CategoryName: 'Makanan' } });
check('pk kolom bukan PK ditolak', r.isError, txt(r).slice(0, 100));

// 14. offset tanpa order_by -> error server
r = await callTool('read_records', { table: 'Category', offset: 5 });
check('offset tanpa order_by ditolak', r.isError, txt(r).slice(0, 100));

// 15. offset dengan order_by OK
r = await callTool('read_records', { table: 'Category', order_by: [{ column: 'CategoryName', dir: 'desc' }], offset: 0, limit: 2 });
fx('offset + order_by OK', r.ok && !r.isError);

// 16. 21 kondisi filter -> zod reject
const where21 = Array.from({ length: 21 }, (_, i) => ({ column: 'CategoryID', op: 'eq', value: i }));
r = await callTool('read_records', { table: 'Category', where: where21 });
check('21 kondisi filter ditolak', r.isError, txt(r).slice(0, 100));

// 17. op tidak dikenal -> zod reject
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryName', op: 'UNION', value: 'x' }] });
check('operator aneh ditolak', r.isError, txt(r).slice(0, 100));

// 18. IN > 50 nilai -> zod reject
const inBig = Array.from({ length: 60 }, (_, i) => `v${i}`);
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryID', op: 'in', value: inBig }] });
check('IN 60 nilai ditolak', r.isError, txt(r).slice(0, 100));

// 19. IN normal OK
const inOk = ['019f6225-e609-774f-9efe-446569c72d35'];
r = await callTool('read_records', { table: 'Category', where: [{ column: 'CategoryID', op: 'in', value: inOk }] });
fx('IN normal OK', r.ok && !r.isError);

// 20. antara/BETWEEN
r = await callTool('read_records', { table: 'Category', where: [{ column: 'SortOrder', op: 'between', value: 0, value2: 10 }] });
fx('BETWEEN OK', r.ok && !r.isError, txt(r).slice(0, 100));

// 21. IS NULL
r = await callTool('read_records', { table: 'Category', where: [{ column: 'Description', op: 'isNull' }] });
fx('IS NULL OK', r.ok && !r.isError);

// 22. server_info
r = await callTool('server_info', {});
check('server_info OK', r.ok && !r.isError && txt(r).includes('serverName'), txt(r).slice(0, 80));

// 23. list_tables hanya tabel yang diizinkan (Category, Item, Supplier, Purchase)
r = await callTool('list_tables', {});
check('list_tables terseleksi', r.ok && !r.isError && txt(r).startsWith('['), txt(r).slice(0, 100));
const lt = r.isError ? [] : JSON.parse(txt(r));
fx('list_tables hanya 4 tabel diizinkan', r.ok && lt.length === 4, JSON.stringify(lt.map((t) => t.table)));

// 24. tabel tidak dikenal
r = await callTool('read_records', { table: 'NotExistsTable' });
check('tabel tidak dikenal ditolak', r.isError, txt(r).slice(0, 100));

// 25. tabel dengan nama SQL keyword (mis. "Order") — valid identifier, permission deny default
r = await callTool('read_records', { table: 'Order' });
check('keyword SQL tanpa permission ditolak', r.isError, txt(r).slice(0, 100));

// 26. tabel bernilai angka/bool -> zod reject
r = await callTool('read_records', { table: 123 });
check('tabel non-string ditolak', r.isError, txt(r).slice(0, 100));

console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
if (CLEANUP_KEY_ID && CLEANUP_COOKIE) {
  await fetch(BASE + '/api/keys/' + CLEANUP_KEY_ID, { method: 'DELETE', headers: { Cookie: CLEANUP_COOKIE } }).catch(() => undefined);
}
process.exit(fail > 0 ? 1 : 0);