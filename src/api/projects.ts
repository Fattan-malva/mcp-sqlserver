import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { storage, closeProjectStorage } from '../db/storage.js';
import { closePoolForProject } from '../sqlserver/connection.js';
import { dropProjectSessions } from '../mcp/server.js';

const COOKIE = 'mcp_project';

function projectDir(id: string): string {
  return path.join(config.dataDir, 'projects', id);
}

function sanitize(p: { id: string; name: string; created_at: string }) {
  return { id: p.id, name: p.name, createdAt: p.created_at };
}

export function projectsRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({ projects: storage.listProjects().map(sanitize) });
  });

  router.get('/current', (req, res) => {
    const cookie = String(req.cookies?.[COOKIE] ?? '');
    const project = cookie ? storage.getProject(cookie) : undefined;
    res.json({ project: project ? sanitize(project) : null });
  });

  router.put('/current', (req, res) => {
    const id = String(req.body?.projectId ?? '').trim();
    const project = storage.getProject(id);
    if (!project) return res.status(404).json({ error: 'Project tidak ditemukan' });
    res.cookie(COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.json({ ok: true, project: sanitize(project) });
  });

  router.post('/', (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: 'Nama project tidak boleh kosong' });
    const project = storage.createProject(name);
    res.json({ project: sanitize(project) });
  });

  router.put('/:id', (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: 'Nama project tidak boleh kosong' });
    const ok = storage.renameProject(req.params.id, name);
    if (!ok) return res.status(404).json({ error: 'Project tidak ditemukan' });
    res.json({ ok });
  });

  router.delete('/:id', async (req, res) => {
    const project = storage.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project tidak ditemukan' });

    // tutup resource runtime dulu, baru hapus data
    await closePoolForProject(project.id);
    dropProjectSessions(project.id);
    closeProjectStorage(project.id);
    storage.deleteProject(project.id);

    const dir = projectDir(project.id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* data dir sudah tidak ada — tidak fatal */
    }
    res.json({ ok: true });
  });

  return router;
}