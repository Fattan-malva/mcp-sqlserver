import express from 'express';
import { z } from 'zod';
import { GoogleGenAI, type Content, type Part } from '@google/genai';
import { getEffectiveTools, type ToolContext } from '../mcp/tools.js';
import type { ApiKeyRow } from '../db/storage.js';

const MAX_TOOL_ROUNDS = 12;
const AGENT_TIMEOUT_MS = 120_000;
const MAX_TOTAL_TEXT = 60_000;
const MAX_HISTORY_MSGS = 40;

interface AgentSession {
  apiKey: string;
  model: string;
  history: Content[];
  busy: boolean;
}

const sessions = new Map<string, AgentSession>();

const agentKey: ApiKeyRow = {
  id: 'agent-test',
  name: 'Agent Test (UI)',
  key_hash: '',
  key_prefix: 'agent',
  created_at: new Date().toISOString(),
  last_used_at: null,
  revoked: 0,
};

const SYSTEM_PROMPT = (): string => {
  const tools = getEffectiveTools();
  const names = tools.map((t) => `${t.name} (${t.title})`).join(', ');
  return `You are a read-only SQL Server database assistant named agent MCP-SQLSERV.
You use ${tools.length} safe tools to answer user questions. Available tools: ${names}.
Rules:
1. Always use a tool to answer data questions. Never guess numbers.
2. Tools only read; SQL injection is impossible. Follow the provided parameter schema.
3. Use table names without the schema prefix (e.g. "Item", not "dbo.Item").
4. For searches use where with op eq/like/startsWith/endsWith. For ordering use order_by.
5. If a tool refuses (e.g. table not permitted), say so honestly and suggest alternatives.
6. Answer in English. Use Markdown tables for tabular data. Be concise but complete.
7. If the question is outside tool reach, briefly say it is beyond this server's read scope.
8. Never ask for information outside the database (admin names, passwords, etc.) — you only know the data.`;
};

const zToken = z.string().trim().min(1, 'API key must not be empty').max(200);
const zModel = z.string().trim().max(120, 'Model name is too long').optional();

function sessionFor(user: string): AgentSession {
  let s = sessions.get(user);
  if (!s) {
    s = { apiKey: '', model: '', history: [], busy: false };
    sessions.set(user, s);
  }
  return s;
}

const OPENAPI_ALLOW = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'description',
  'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
  'anyOf', 'oneOf', 'allOf', '$ref', 'format', 'title', 'nullable', 'examples',
]);

function sanitizeOpenApi(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) sanitizeOpenApi(item);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  const obj = schema as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!OPENAPI_ALLOW.has(key)) delete obj[key];
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    obj.additionalProperties = true;
  }
  sanitizeOpenApi(obj.items);
  const props = obj.properties;
  if (props && typeof props === 'object') {
    for (const key of Object.keys(props as Record<string, unknown>)) sanitizeOpenApi((props as Record<string, unknown>)[key]);
  }
  for (const comb of ['anyOf', 'oneOf', 'allOf']) sanitizeOpenApi(obj[comb]);
}

function functionDeclarations() {
  return getEffectiveTools().map((t) => {
    const schema = z.toJSONSchema(t.inputSchema) as Record<string, unknown>;
    sanitizeOpenApi(schema);
    return { name: t.name, description: `${t.title}. ${t.description}`, parameters: schema };
  });
}

function parseFunctionDeclarations(parts: Part[]): { name: string; args: Record<string, unknown> }[] | null {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const part of parts) {
    const fc = part.functionCall;
    if (!fc?.name) continue;
    out.push({ name: fc.name, args: (fc.args ?? {}) as Record<string, unknown> });
  }
  return out.length ? out : null;
}

interface ToolRun {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  rows: number | null;
  durationMs: number;
  resultText: string;
  error?: string;
}

async function runToolCall(name: string, args: Record<string, unknown>): Promise<ToolRun> {
  const tool = getEffectiveTools().find((t) => t.name === name);
  const t0 = Date.now();
  if (!tool) {
    return {
      name, args, ok: false, rows: null, durationMs: 0,
      resultText: JSON.stringify({ error: `Unknown tool: ${name}` }),
      error: 'Unknown tool',
    };
  }
  const ctx: ToolContext = { key: agentKey, ip: 'web-ui' };
  try {
    const out = await withDeadline(
      tool.handler(args, ctx),
      30_000,
      'Tool melebihi batas waktu (30 detik).',
    );
    const text = out.content[0]?.text ?? '';
    let rows: number | null = null;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.rowCount === 'number') rows = parsed.rowCount;
      else if (typeof parsed?.total === 'number') rows = parsed.total;
      else if (Array.isArray(parsed?.rows)) rows = parsed.rows.length;
      else if (parsed?.found !== undefined) rows = parsed.found ? 1 : 0;
    } catch {
      /* teks non-JSON (tidak mungkin untuk tool ini) */
    }
    return { name, args, ok: true, rows, durationMs: Date.now() - t0, resultText: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name, args, ok: false, rows: null, durationMs: Date.now() - t0,
      resultText: JSON.stringify({ error: msg }), error: msg,
    };
  }
}

function sse(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function withDeadline<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const RETRY_BACKOFF_MS = [2_000, 5_000, 10_000];

async function* streamWithRetry(
  attempt: () => Promise<AsyncGenerator<unknown>>,
  deadline: number,
): AsyncGenerator<unknown> {
  const state = { consumed: false };
  for (let i = 0; ; i++) {
    if (deadline - Date.now() <= 0) throw new Error('Agent melewati batas waktu (120 detik).');
    try {
      const stream = await attempt();
      for await (const chunk of stream) {
        state.consumed = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const t = (err as { status?: number })?.status;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = t === 429 || t === 503 || /high demand|rate limit|quota|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
      if (!transient || state.consumed || i >= RETRY_BACKOFF_MS.length || deadline - Date.now() <= RETRY_BACKOFF_MS[i]) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[i]));
    }
  }
}

async function* runTurn(session: AgentSession, userText: string) {
  const ai = new GoogleGenAI({ apiKey: session.apiKey });
  const contents: Content[] = [...session.history, { role: 'user', parts: [{ text: userText }] }];
  const deadline = Date.now() + AGENT_TIMEOUT_MS;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const modelParts: Part[] = [];
    let totalChunk = '';
    let finishReason: string | null = null;

    const gen = streamWithRetry(async () => {
      if (Date.now() > deadline) throw new Error('Agent melewati batas waktu (120 detik).');
      return withDeadline(
        ai.models.generateContentStream({
          model: session.model,
          contents,
          config: {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT() }] },
            tools: [{ functionDeclarations: functionDeclarations() }],
            temperature: 0.4,
            maxOutputTokens: 8192,
          },
        }),
        deadline - Date.now(),
        'Agent melewati batas waktu (120 detik).',
      );
    }, deadline);

    for await (const chunk of gen) {
      if (Date.now() > deadline) throw new Error('Agent melewati batas waktu (120 detik).');
      const candidate = (chunk as { candidates?: Array<{ finishReason?: string; content?: { parts?: Part[] } }> }).candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        modelParts.push(part);
        if (part.text?.length) {
          totalChunk += part.text;
          yield { type: 'delta', text: part.text };
        }
      }
      if (totalChunk.length + JSON.stringify(modelParts).length > MAX_TOTAL_TEXT) {
        yield { type: 'delta', text: '\n\n_[Respons terlalu panjang, dihentikan oleh batas keamanan server.]_' };
        throw new Error('Respons melebihi batas keamanan (dipotong).');
      }
    }
    if (!finishReason) finishReason = 'STOP';

    const calls = parseFunctionDeclarations(modelParts);
    if (calls && calls.length && finishReason !== 'SAFETY') {
      const runs: ToolRun[] = [];
      for (const call of calls) {
        const run = await runToolCall(call.name, call.args);
        yield { type: 'tool', run };
        runs.push(run);
      }
      contents.push({ role: 'model', parts: modelParts });
      contents.push({
        role: 'user',
        parts: runs.map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.ok ? { result: JSON.parse(r.resultText) } : { error: r.error },
          },
        })),
      });
      continue;
    }

    contents.push({ role: 'model', parts: modelParts });
    session.history = contents.slice(-MAX_HISTORY_MSGS * 2);
    yield { type: 'done', text: totalChunk, rounds: round + 1 };
    return;
  }
  throw new Error('Agent made too many tool calls (security limit: 12 rounds). Try a more specific question.');
}

function keyErrorToMessage(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 400 && /api key/i.test(message)) {
    return `Invalid Google API key. Check the Gemini token and save it again. (${message})`;
  }
  if (status === 404 || /not found/i.test(message)) {
    return `Model name is not available for this key: ${message}`;
  }
  return `Gemini failed to respond (${status ? 'HTTP ' + status : 'error'}): ${message}`;
}

export function agentRouter(): express.Router {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const s = sessionFor((req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin');
    res.json({
      configured: !!s.apiKey,
      model: s.model || null,
      keyLast4: s.apiKey ? s.apiKey.slice(-4) : null,
      busy: s.busy,
      tools: getEffectiveTools().map((t) => ({ name: t.name, title: t.title })),
    });
  });

  router.post('/config', async (req, res) => {
    const s = sessionFor((req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin');
    const body = (req.body ?? {}) as { apiKey?: string; model?: string };
    const parsedToken = zToken.safeParse(body.apiKey ?? '');
    if (!parsedToken.success) {
      return res.status(400).json({ error: parsedToken.error.issues[0]?.message ?? 'Invalid API key' });
    }
    const parsedModel = zModel.safeParse(body.model ?? '');
    if (!parsedModel.success) {
      return res.status(400).json({ error: parsedModel.error.issues[0]?.message ?? 'Invalid model name' });
    }
    const model = parsedModel.data && parsedModel.data.length ? parsedModel.data : 'gemini-flash-latest';
    s.apiKey = parsedToken.data;
    s.model = model;
    s.history = [];
    res.json({ ok: true, model });
  });

  router.delete('/config', (req, res) => {
    const s = sessionFor((req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin');
    s.apiKey = '';
    s.model = '';
    s.history = [];
    s.busy = false;
    res.json({ ok: true });
  });

  router.post('/reset', (req, res) => {
    const s = sessionFor((req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin');
    s.history = [];
    res.json({ ok: true });
  });

  router.post('/chat', (req, res) => {
    const user = (req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin';
    const s = sessionFor(user);
    const message = String((req.body ?? {})?.message ?? '').trim().slice(0, 4000);
    if (!s.apiKey) {
      res.status(400).json({ error: 'No Gemini API key yet. Save a key from Google AI Studio / Gemini API first.' });
      return;
    }
    if (!message) {
      res.status(400).json({ error: 'Empty message.' });
      return;
    }
    if (s.busy) {
      res.status(409).json({ error: 'Agent is busy answering a previous question. Please wait.' });
      return;
    }
    s.busy = true;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    sse(res, 'meta', { model: s.model });

    (async () => {
      for await (const evt of runTurn(s, message)) {
        if (ac.signal.aborted) return;
        sse(res, evt.type, evt);
      }
      sse(res, 'end', {});
    })().catch((err) => {
      sse(res, 'error', { message: keyErrorToMessage(err) });
    }).finally(() => {
      s.busy = false;
      if (!res.writableEnded) res.end();
    });
  });

  router.post('/probe', async (req, res) => {
    const user = (req as express.Request & { admin?: { user: string } }).admin?.user ?? 'admin';
    const s = sessionFor(user);
    if (!s.apiKey) return res.status(400).json({ error: 'No Gemini API key.' });
    const name = String(req.body?.tool ?? '');
    const tool = getEffectiveTools().find((t) => t.name === name);
    if (!tool) return res.status(400).json({ error: 'Unknown tool' });
    const run = await runToolCall(name, (req.body?.args ?? {}) as Record<string, unknown>);
    res.json({ run });
  });

  return router;
}