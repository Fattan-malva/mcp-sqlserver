/**
 * Validasi tegas SQL mode "paste query" pada custom tools.
 * Hanya SELECT read-only: tanpa ;, tanpa komentar, tanpa keyword berbahaya,
 * dan setiap @token wajib termasuk daftar parameter yang dideklarasikan.
 * Semua parameter di-bind lewat mssql (request.input) — tidak pernah disisipkan
 * mentah ke SQL.
 */

export const MAX_SQL_LENGTH = 8000;

const DENY_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'MERGE',
  'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'USE', 'BACKUP', 'RESTORE',
  'RECONFIGURE', 'DECLARE', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
  'RAISERROR', 'PRINT', 'WAITFOR', 'SHUTDOWN', 'KILL', 'BULK', 'OPENROWSET',
  'OPENDATASOURCE', 'OPENQUERY', 'OPENXML', 'DBCC', 'INTO', 'OUTPUT', 'READTEXT',
  'WRITETEXT', 'UPDATETEXT', 'READPAST', 'HOLDLOCK', 'TABLOCK', 'TABLOCKX',
  'UPDLOCK', 'XLOCK', 'SNAPSHOT', 'COMPUTE', 'TEXTIMAGE_ON', 'ONLINE', 'ASYNC_IO',
  'MAXDOP', 'CHECKPOINT', 'EXTENDED_PROTECTION',
];

const PARAM_RE = /@([A-Za-z_][A-Za-z0-9_]*)/g;

/** Hapus string literal ('...') agar keyword di dalam string tidak ikut terlarang. */
export function scrubSqlStrings(sql: string): string {
  return sql.replace(/'((?:[^']|'')*)'/g, (m) => ' '.repeat(m.length));
}

function tokens(text: string): string[] {
  return text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

export function extractTableRefs(sqlText: string): TableRef[] {
  const scrubbed = scrubSqlStrings(sqlText);
  const refs = new Map<string, TableRef>();
  const re = /(?:FROM|JOIN)\s+((?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?(?:\[)?([A-Za-z_][A-Za-z0-9_@$#]*)(?:\])?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scrubbed)) !== null) {
    const schema = (m[1] ? m[1].replace(/[\[\]\s.]/g, '') : 'dbo').toLowerCase();
    const name = m[2];
    if (!name) continue;
    // Simpan semua referensi (termasuk non-dbo) agar pemanggil bisa menolak
    // schema di luar skop. Pemeriksaan schema dilakukan di customTools.ts.
    refs.set(`${schema}.${name}`, { schema, name });
  }
  return [...refs.values()];
}

export interface SqlGuardResult {
  ok: boolean;
  error?: string;
}

export interface TableRef {
  schema: string;
  name: string;
}

/** Validasi SELECT-only + whitelist parameter. Tidak mengecek permission tabel. */
export function validateRawSql(sqlText: string, declaredParams: string[]): SqlGuardResult {
  if (!sqlText || !sqlText.trim()) return { ok: false, error: 'SQL wajib diisi' };
  if (sqlText.length > MAX_SQL_LENGTH) return { ok: false, error: `SQL terlalu panjang (maks ${MAX_SQL_LENGTH} karakter)` };
  if (sqlText.includes(';')) return { ok: false, error: 'Tanda titik koma (;) tidak diizinkan — satu statement saja' };
  if (sqlText.includes('--')) return { ok: false, error: 'Komentar (--) tidak diizinkan' };
  if (sqlText.includes('/*')) return { ok: false, error: 'Komentar (/* */) tidak diizinkan' };
  if (sqlText.includes('@@')) return { ok: false, error: 'Variabel sistem (@@...) tidak diizinkan' };

  const scrubbed = scrubSqlStrings(sqlText).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  // Ambil token kata pertama dengan regex (bukan split spasi) agar SQL tanpa
  // spasi seperti `SELECT*FROM t` tetap dikenali sebagai SELECT (bukan false positive).
  const firstMatch = scrubbed.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  const first = firstMatch ? firstMatch[0].toUpperCase() : '';
  if (first !== 'SELECT') return { ok: false, error: 'Query harus diawali SELECT (read-only)' };
  if (!/\bFROM\b/i.test(scrubbed)) return { ok: false, error: 'Query wajib mengandung klausa FROM' };

  const words = tokens(scrubbed);
  for (const w of words) {
    const up = w.toUpperCase();
    if (DENY_KEYWORDS.includes(up)) return { ok: false, error: `Keyword terlarang pada query read-only: ${up}` };
    if (/^SP_|^XP_/i.test(w)) return { ok: false, error: `Pemanggilan prosedur tersimpan tidak diizinkan: ${w}` };
  }

  const used = new Set<string>();
  for (const m of sqlText.matchAll(PARAM_RE)) used.add(m[1]);
  const declared = new Set(declaredParams);
  for (const name of used) {
    if (!declared.has(name)) return { ok: false, error: `Parameter @${name} tidak dideklarasikan di daftar parameter` };
  }

  return { ok: true };
}