import sql from 'mssql';
import { limits } from '../config.js';
import { sanitizeIdentifier } from './metadata.js';

export type WhereOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'like'
  | 'startsWith'
  | 'endsWith'
  | 'in'
  | 'between'
  | 'isNull'
  | 'isNotNull';

export interface WhereClause {
  column: string;
  op: WhereOp;
  value?: unknown;
  value2?: unknown;
}

export interface OrderByClause {
  column: string;
  dir: 'asc' | 'desc';
}

export interface SelectSpec {
  table: string;
  columns?: string[];
  where?: WhereClause[];
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
}

export interface BuiltStatement {
  sql: string;
  params: { name: string; value: unknown }[];
}

const OP_SQL: Record<Exclude<WhereOp, 'in' | 'between'>, string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  like: 'LIKE',
  startsWith: 'LIKE',
  endsWith: 'LIKE',
  isNull: 'IS NULL',
  isNotNull: 'IS NOT NULL',
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildWhere(where: WhereClause[], startIdx = 0): { clause: string; params: { name: string; value: unknown }[]; count: number } {
  if (where.length > limits.maxWhereClauses) {
    throw new Error(`Maksimal ${limits.maxWhereClauses} kondisi filter per query`);
  }
  const parts: string[] = [];
  const params: { name: string; value: unknown }[] = [];
  let idx = startIdx;

  for (const w of where) {
    const col = sanitizeIdentifier(w.column);
    const p1 = `@p${idx++}`;

    switch (w.op) {
      case 'isNull':
      case 'isNotNull':
        parts.push(`[${col}] ${OP_SQL[w.op]}`);
        break;
      case 'in': {
        const values = Array.isArray(w.value) ? w.value : [w.value];
        if (values.length === 0) throw new Error(`Operator "in" butuh minimal 1 nilai`);
        if (values.length > limits.maxInValues) throw new Error(`Maksimal ${limits.maxInValues} nilai untuk operator "in"`);
        const names = values.map((v, i) => {
          const n = `@p${idx++}`;
          params.push({ name: n, value: v });
          return n;
        });
        parts.push(`[${col}] IN (${names.join(', ')})`);
        break;
      }
      case 'between': {
        const p2 = `@p${idx++}`;
        params.push({ name: p1, value: w.value }, { name: p2, value: w.value2 });
        parts.push(`[${col}] BETWEEN ${p1} AND ${p2}`);
        break;
      }
      case 'like':
      case 'startsWith':
      case 'endsWith': {
        const raw = String(w.value ?? '');
        let pattern: string;
        if (w.op === 'like') pattern = `%${escapeLike(raw)}%`;
        else if (w.op === 'startsWith') pattern = `${escapeLike(raw)}%`;
        else pattern = `%${escapeLike(raw)}`;
        params.push({ name: p1, value: pattern });
        parts.push(`[${col}] LIKE ${p1} ESCAPE '\\'`);
        break;
      }
      default: {
        params.push({ name: p1, value: w.value });
        parts.push(`[${col}] ${OP_SQL[w.op]} ${p1}`);
      }
    }
  }

  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params, count: idx };
}

/**
 * Bangun SELECT read-only. SEMUA nilai lewat bind parameter, SEMUA identifier divalidasi
 * regex + diverifikasi terhadap metadata di layer atas. Tidak ada jalur SQL mentah.
 */
export interface BuiltSelect extends BuiltStatement {
  limit: number;
  offset: number;
}

export function buildSelect(spec: SelectSpec): BuiltSelect {
  const table = sanitizeIdentifier(spec.table);
  const limit = Math.max(1, Math.min(Math.round(spec.limit ?? 100), limits.maxRows));
  const offset = Math.max(0, Math.round(spec.offset ?? 0));

  const cols =
    spec.columns && spec.columns.length
      ? spec.columns.map((c) => `[${sanitizeIdentifier(c)}]`).join(', ')
      : '*';

  const where = buildWhere(spec.where ?? []);
  const params = [...where.params];

  let orderBy = '';
  if (spec.orderBy && spec.orderBy.length) {
    orderBy =
      'ORDER BY ' +
      spec.orderBy
        .map((o) => {
          const col = sanitizeIdentifier(o.column);
          const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
          return `[${col}] ${dir}`;
        })
        .join(', ');
  }

  let sql: string;
  if (offset > 0) {
    if (!orderBy) throw new Error('offset > 0 membutuhkan order_by agar hasil deterministik');
    sql = `SELECT ${cols} FROM [dbo].[${table}] ${where.clause} ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  } else if (orderBy) {
    sql = `SELECT TOP (${limit}) ${cols} FROM [dbo].[${table}] ${where.clause} ${orderBy}`;
  } else {
    sql = `SELECT TOP (${limit}) ${cols} FROM [dbo].[${table}] ${where.clause}`;
  }

  return { sql, params, limit, offset };
}

export function buildCount(table: string, where: WhereClause[] = []): BuiltStatement {
  const t = sanitizeIdentifier(table);
  const w = buildWhere(where);
  return {
    sql: `SELECT COUNT_BIG(*) AS total FROM [dbo].[${t}] ${w.clause}`,
    params: w.params,
  };
}

export function buildGetByPk(table: string, keys: { column: string; value: unknown }[]): BuiltStatement {
  const t = sanitizeIdentifier(table);
  if (!keys.length) throw new Error('Minimal 1 kolom primary key');
  const params: { name: string; value: unknown }[] = [];
  const conds = keys.map((k, i) => {
    const col = sanitizeIdentifier(k.column);
    const n = `@p${i}`;
    params.push({ name: n, value: k.value });
    return `[${col}] = ${n}`;
  });
  return {
    sql: `SELECT TOP (1) * FROM [dbo].[${t}] WHERE ${conds.join(' AND ')}`,
    params,
  };
}

// ---------------- Custom tools (builder mode) ----------------

export type JoinType = 'inner' | 'left' | 'right' | 'full';

export interface CustomJoin {
  type: JoinType;
  table: string;
  alias: string;
  on: { left: string; right: string; op?: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' };
}

export interface CustomWhere {
  ref: string;
  op: WhereOp;
  value?: unknown;
  value2?: unknown;
  param?: string;
}

export interface CustomOrderBy {
  ref: string;
  dir: 'asc' | 'desc';
}

export interface CustomSelectSpec {
  baseTable: string;
  alias?: string;
  columns?: { name: string; alias?: string }[];
  joins: CustomJoin[];
  where: CustomWhere[];
  orderBy: CustomOrderBy[];
  limit?: number;
  offset?: number;
  paramValues: Record<string, unknown>;
}

const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_@$#]*$/;

export function splitRef(ref: string): { alias: string | null; column: string } {
  const parts = ref.split('.');
  if (parts.length === 1) return { alias: null, column: parts[0] };
  if (parts.length === 2) return { alias: parts[0], column: parts[1] };
  throw new Error(`Referensi kolom tidak valid: "${ref}"`);
}

function sqlRef(ref: string): string {
  const { alias, column } = splitRef(ref);
  if (!COLUMN_RE.test(column) || column.length > 128) {
    throw new Error(`Nama kolom tidak valid: "${column}"`);
  }
  if (alias) {
    if (!COLUMN_RE.test(alias) || alias.length > 128) throw new Error(`Alias tidak valid: "${alias}"`);
    return `[${alias}].[${column}]`;
  }
  return `[${column}]`;
}

function resolveWhereValue(w: CustomWhere, paramValues: Record<string, unknown>): unknown {
  if (w.param) {
    if (!(w.param in paramValues)) throw new Error(`Parameter wajib @${w.param} tidak diisi`);
    return paramValues[w.param];
  }
  return w.value;
}

function buildCustomWhere(where: CustomWhere[], paramValues: Record<string, unknown>): { clause: string; params: { name: string; value: unknown }[] } {
  if (where.length > limits.maxWhereClauses) {
    throw new Error(`Maksimal ${limits.maxWhereClauses} kondisi filter per query`);
  }
  const parts: string[] = [];
  const params: { name: string; value: unknown }[] = [];
  where.forEach((w, i) => {
    const ref = sqlRef(w.ref);
    const p1 = `@p${i}`;
    switch (w.op) {
      case 'isNull':
      case 'isNotNull':
        parts.push(`${ref} ${OP_SQL[w.op]}`);
        break;
      case 'in': {
        const raw = w.param ? resolveWhereValue(w, paramValues) : w.value;
        const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',').map((s) => s.trim());
        if (values.length === 0 || (values.length === 1 && values[0] === '')) throw new Error('Operator "in" butuh minimal 1 nilai');
        if (values.length > limits.maxInValues) throw new Error(`Maksimal ${limits.maxInValues} nilai untuk operator "in"`);
        const names = values.map((v, j) => {
          const n = `@p${i}_${j}`;
          params.push({ name: n, value: v });
          return n;
        });
        parts.push(`${ref} IN (${names.join(', ')})`);
        break;
      }
      case 'between': {
        const v1 = resolveWhereValue(w, paramValues);
        const v2 = w.param ? paramValues[w.param] : w.value2;
        params.push({ name: p1, value: v1 }, { name: `@p${i}_2`, value: v2 });
        parts.push(`${ref} BETWEEN ${p1} AND @p${i}_2`);
        break;
      }
      case 'like':
      case 'startsWith':
      case 'endsWith': {
        const raw = String(w.param ? resolveWhereValue(w, paramValues) : w.value ?? '');
        const pattern = w.op === 'like' ? `%${escapeLike(raw)}%` : w.op === 'startsWith' ? `${escapeLike(raw)}%` : `%${escapeLike(raw)}`;
        params.push({ name: p1, value: pattern });
        parts.push(`${ref} LIKE ${p1} ESCAPE '\\'`);
        break;
      }
      default: {
        params.push({ name: p1, value: resolveWhereValue(w, paramValues) });
        parts.push(`${ref} ${OP_SQL[w.op]} ${p1}`);
      }
    }
  });
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

export interface BuiltCustomSelect extends BuiltStatement {
  limit: number;
  offset: number;
}

/**
 * Bangun SELECT untuk custom tool mode builder: dukungan JOIN + alias + parameter
 * runtime (@nama). SEMUA nilai lewat bind parameter, SEMUA identifier divalidasi.
 */
export function buildCustomSelect(spec: CustomSelectSpec): BuiltCustomSelect {
  const base = sanitizeIdentifier(spec.baseTable);
  const baseAlias = spec.alias ? sanitizeIdentifier(spec.alias) : base;
  const limit = Math.max(1, Math.min(Math.round(spec.limit ?? 100), limits.maxRows));
  const offset = Math.max(0, Math.round(spec.offset ?? 0));
  const paramValues = spec.paramValues ?? {};

  const cols =
    spec.columns && spec.columns.length
      ? spec.columns
          .map((c) => (c.name.includes('.') ? sqlRef(c.name) : `${sqlRef(c.name)}`) + (c.alias ? ` AS [${sanitizeIdentifier(c.alias)}]` : ''))
          .join(', ')
      : `${sqlRef(baseAlias)}.*`;

  const from = `FROM [dbo].[${base}]${spec.alias ? ` AS [${baseAlias}]` : ''}`;

  const joins = spec.joins
    .map((j) => {
      const t = sanitizeIdentifier(j.table);
      const a = sanitizeIdentifier(j.alias);
      const op = j.on.op ?? 'eq';
      const left = sqlRef(j.on.left);
      const right = sqlRef(j.on.right);
      return `${j.type.toUpperCase()} JOIN [dbo].[${t}] AS [${a}] ON ${left} ${OP_SQL[op]} ${right}`;
    })
    .join(' ');

  const where = buildCustomWhere(spec.where ?? [], paramValues);
  const params = [...where.params];

  let orderBy = '';
  if (spec.orderBy && spec.orderBy.length) {
    orderBy =
      'ORDER BY ' +
      spec.orderBy
        .map((o) => {
          const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
          return `${sqlRef(o.ref)} ${dir}`;
        })
        .join(', ');
  }

  let sql: string;
  if (offset > 0) {
    if (!orderBy) throw new Error('offset > 0 membutuhkan order_by agar hasil deterministik');
    sql = `SELECT ${cols} ${from} ${joins} ${where.clause} ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  } else if (orderBy) {
    sql = `SELECT TOP (${limit}) ${cols} ${from} ${joins} ${where.clause} ${orderBy}`;
  } else {
    sql = `SELECT TOP (${limit}) ${cols} ${from} ${joins} ${where.clause}`;
  }

  return { sql: sql.replace(/\s+/g, ' ').trim(), params, limit, offset };
}

export function stripAt(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name;
}

export async function executeQuery(pool: sql.ConnectionPool, built: BuiltStatement): Promise<Record<string, unknown>[]> {
  const request = new sql.Request(pool);
  for (const p of built.params) request.input(stripAt(p.name), p.value);
  const r = await request.query(built.sql);
  return r.recordset;
}

export async function executeScalar(pool: sql.ConnectionPool, sqlText: string, params: { name: string; value: unknown }[]): Promise<number | null> {
  const request = new sql.Request(pool);
  for (const p of params) request.input(stripAt(p.name), p.value);
  const r = await request.query(sqlText);
  const first = r.recordset[0];
  return first ? Number(first.total ?? first[Object.keys(first)[0]]) : null;
}