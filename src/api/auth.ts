import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { storage } from '../db/storage.js';
import { clientIpOf, constantTimeEqual, hitLimit } from '../oauth/helpers.js';

const COOKIE = 'mcp_sqlserv_session';
const TTL = 7 * 24 * 3600 * 1000;

export interface AdminSession {
  user: string;
}

export function signSession(): string {
  return jwt.sign({ user: config.adminUser }, storage.getSecret(), { expiresIn: '7d' });
}

function verifySession(token: string): AdminSession | null {
  try {
    const payload = jwt.verify(token, storage.getSecret());
    if (typeof payload === 'object' && payload && payload.user === config.adminUser) {
      return { user: config.adminUser };
    }
    return null;
  } catch {
    return null;
  }
}

/** Baca sesi admin dari cookie request (dipakai OAuth login/consent). */
export function readAdminSession(req: express.Request): AdminSession | null {
  const token = req.cookies?.[COOKIE];
  return token ? verifySession(token) : null;
}

/** Pasang cookie sesi admin (dipakai login utama maupun OAuth login). */
export function setAdminSession(res: express.Response, req: express.Request): void {
  res.cookie(COOKIE, signSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: TTL,
  });
}

export function requireAdmin(): express.RequestHandler {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE];
    const session = token ? verifySession(token) : null;
    if (!session) {
      res.status(401).json({ error: 'Invalid session. Please sign in.' });
      return;
    }
    (req as express.Request & { admin?: AdminSession }).admin = session;
    next();
  };
}

export function adminRouter(): express.Router {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { user, password } = (req.body ?? {}) as { user?: string; password?: string };
    const ip = clientIpOf(req);
    if (hitLimit(ip, 'admin-login', 10)) {
      res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
      return;
    }
    if (user === config.adminUser && constantTimeEqual(password ?? '', config.adminPassword)) {
      setAdminSession(res, req);
      res.json({ ok: true, user: config.adminUser });
      return;
    }
    res.status(401).json({ error: 'Invalid user or password.' });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  router.get('/me', requireAdmin(), (req, res) => {
    res.json({ user: (req as express.Request & { admin?: AdminSession }).admin?.user });
  });

  return router;
}

export async function getStatus(): Promise<Record<string, unknown>> {
  const hasConfig = !!storage.getDbConfig();
  const keys = storage.listApiKeys();
  return {
    adminConfigured: !!config.adminPassword,
    dbConfigured: hasConfig,
    keysActive: keys.filter((k) => k.revoked === 0).length,
    keysTotal: keys.length,
    oauthClients: storage.listOauthClients().filter((c) => c.revoked === 0).length,
    permissionCount: storage.listPermissions().length,
    now: new Date().toISOString(),
  };
}