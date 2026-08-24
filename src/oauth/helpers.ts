import crypto from 'node:crypto';
import type express from 'express';
import { sha256 } from '../db/storage.js';

const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randToken(prefix: string, bytes = 32): string {
  return `${prefix}${b64url(crypto.randomBytes(bytes))}`;
}

export function randId(bytes = 16): string {
  const b = crypto.randomBytes(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += URLSAFE[b[i] % URLSAFE.length];
  return s;
}

export function sha256Hex(input: string): string {
  return sha256(input);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function hasLoopbackHost(uri: string): boolean {
  try {
    const u = new URL(uri);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * RFC 8252 section 7.3 port-agnostic matching untuk loopback redirect URI.
 * Claude Code mendeklarasikan http://localhost/callback dan
 * http://127.0.0.1/callback TANPA port — harus cocok dengan port apa pun.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  if (!hasLoopbackHost(registered) || !hasLoopbackHost(presented)) return false;
  try {
    const r = new URL(registered);
    const p = new URL(presented);
    const sameBase =
      r.protocol === p.protocol && r.hostname.replace(/^\[|\]$/g, '').toLowerCase() === p.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!sameBase) return false;
    const rPath = r.pathname.replace(/\/+$/, '');
    const pPath = p.pathname.replace(/\/+$/, '');
    if (rPath !== pPath) return false;
    return r.search === p.search && r.hash === p.hash;
  } catch {
    return false;
  }
}

export function isAllowedRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  if (uri.startsWith('https://')) return true;
  if (uri.startsWith('http://') && hasLoopbackHost(uri)) return true;
  return false;
}

/* ---------------- rate limit in-memory (per IP per menit) ---------------- */

const rateHits = new Map<string, number[]>();
setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of rateHits) {
    const f = hits.filter((t) => now - t < 60_000);
    if (f.length) rateHits.set(id, f);
    else rateHits.delete(id);
  }
}, 60_000).unref();

export function hitLimit(ip: string, key: string, max: number): boolean {
  const id = `${ip}:${key}`;
  const now = Date.now();
  const hits = rateHits.get(id) ?? [];
  const filtered = hits.filter((t) => now - t < 60_000);
  if (filtered.length >= max) return true;
  filtered.push(now);
  rateHits.set(id, filtered);
  return false;
}

export function clientIpOf(req: express.Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function originOf(req: express.Request): string {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:4000';
  return `${proto}://${String(host)}`;
}