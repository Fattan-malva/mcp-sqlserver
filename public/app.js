'use strict';

/* ============================================================
   MCP-SQLSERV — konsol "Slide Spekimen"
   Agent Test = Ollama Cloud memakai tool yang sama
   persis dengan MCP endpoint (/mcp), lewat /api/agent.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const views = ['projects', 'dashboard', 'agent', 'koneksi', 'apikey', 'izin', 'audit', 'oauth', 'playground', 'info'];
const titles = {
  projects: 'Projects',
  dashboard: 'Dashboard',
  agent: 'Agent Test',
  koneksi: 'DB Connection',
  apikey: 'API Keys',
  izin: 'Table Permissions',
  audit: 'Audit Log',
  oauth: 'OAuth Clients',
  playground: 'Tools Playground',
  info: 'How to Connect',
};

let keyPlain = null;
const agentState = { busy: false };
let currentProject = null;

/* ---------------- helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401 && path !== '/api/auth/login') {
    window.location.hash = '#/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !opts.silent) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString('id-ID');
}

function setMsg(el, type, text) {
  el.className = `msg msg-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideMsg(el) {
  el.classList.add('hidden');
}

function setError(el, text) {
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* noop */
    }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => {
      btn.textContent = old;
    }, 1600);
  }
}

function dangerConfirm(btn, run, opts = {}) {
  if (btn.dataset.confirming) {
    clearTimeout(btn._confirmT);
    btn.dataset.confirming = '';
    btn.classList.remove('btn--confirm');
    btn.textContent = btn.dataset.label;
    run();
    return;
  }
  if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
  btn.dataset.confirming = '1';
  btn.classList.add('btn--confirm');
  btn.textContent = opts.yes || 'Sure?';
  btn._confirmT = setTimeout(() => {
    btn.dataset.confirming = '';
    btn.classList.remove('btn--confirm');
    btn.textContent = btn.dataset.label;
  }, opts.revertMs ?? 4000);
}

function emptyState(icon, text, cta) {
  return `<div class="empty"><i class="ph ${icon} empty-ico"></i><span>${esc(text)}</span>${
    cta ? `<button type="button" class="empty-cta" data-focus="${cta.focus}">${esc(cta.label)}</button>` : ''
  }</div>`;
}

/* ---------------- auth ---------------- */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError($('#login-error'));
  const btn = $('#login-form button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'VERIFIKASI…';
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ user: $('#login-user').value, password: $('#login-pass').value }),
    });
    enterApp();
  } catch (err) {
    setError($('#login-error'), err.message);
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('.skip-link').addEventListener('click', (e) => {
  e.preventDefault();
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  window.location.hash = '#/login';
  window.location.reload();
});

async function enterApp() {
  $('#login-view').classList.add('hidden');
  const me = await api('/api/auth/me');
  $('#admin-user').textContent = me.user || 'admin';
  $('#pj-user').textContent = me.user || 'operator';
  await refreshCurrentProject();
  if (currentProject) openShell();
  else openProjectScene();
}

async function refreshCurrentProject() {
  const r = await api('/api/projects/current', { silent: true }).catch(() => ({ project: null }));
  currentProject = r.project || null;
  refreshRackProject();
  return currentProject;
}

function openShell() {
  $('#project-view').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  if (window.location.hash === '#/login') window.location.hash = '#/dashboard';
  route();
  pullConnChip();
}

function openProjectScene() {
  $('#shell').classList.add('hidden');
  $('#project-view').classList.remove('hidden');
  renderProjectGate();
}

async function selectProject(id) {
  const r = await api('/api/projects/current', { method: 'PUT', body: JSON.stringify({ projectId: id }) });
  currentProject = r.project || null;
  refreshRackProject();
  openShell();
}

async function refreshRackProject() {
  const el = $('#rack-project-name');
  const chip = $('#project-chip-name');
  if (el) el.textContent = currentProject ? currentProject.name : '—';
  if (chip) chip.textContent = currentProject ? currentProject.name.toUpperCase() : '—';
}

/* ---------------- projects gate + manager ---------------- */

const PROJ_ACTIONS = (p) => `
  ${p.id !== currentProject?.id ? `<button class="btn btn--primary btn--small" data-open="${esc(p.id)}"><i class="ph ph-arrow-square-out"></i>Open</button>` : '<span class="badge badge-ok">CURRENT</span>'}
  <button class="btn btn--danger btn--small" data-delete="${esc(p.id)}"><i class="ph ph-trash"></i>Delete</button>`;

async function renderProjectGate() {
  const wrap = $('#project-list');
  const { projects } = await api('/api/projects');
  if (!projects.length) {
    wrap.innerHTML = emptyState('ph-folder', 'No projects yet. Create the first one above.');
    return;
  }
  wrap.innerHTML = projects
    .map(
      (p) => `
      <div class="proj-card">
        <div class="proj-main">
          <div class="proj-glyph"><i class="ph ph-folder-duotone"></i></div>
          <div class="proj-info">
            <div class="proj-name">${esc(p.name)}</div>
            <div class="proj-meta mono">${esc(p.id)} · created ${fmtDate(p.createdAt)}</div>
          </div>
        </div>
        <div class="proj-actions">${PROJ_ACTIONS(p)}</div>
      </div>`,
    )
    .join('');
  bindProjectActions(wrap);
}

async function loadProjectView() {
  $('#view-proj-count').textContent = 'LOADING…';
  $('#view-proj-list').innerHTML = ROWS_SKELETON;
  const { projects } = await api('/api/projects');
  $('#view-proj-count').textContent = projects.length + ' REGISTERED';
  const wrap = $('#view-proj-list');
  if (!projects.length) {
    wrap.innerHTML = emptyState('ph-folder', 'No projects yet. Create one above.');
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Nama</th><th>ID</th><th>Dibuat</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${projects
          .map(
            (p) => `
          <tr>
            <td><input type="text" value="${esc(p.name)}" data-rename="${esc(p.id)}" class="key-name-input" aria-label="Project name" maxlength="64" /></td>
            <td class="mono">${esc(p.id)}</td>
            <td>${fmtDate(p.createdAt)}</td>
            <td>${p.id === currentProject?.id ? '<span class="badge badge-ok">AKTIF</span>' : '<span class="badge badge-warn">IDLE</span>'}</td>
            <td class="row-actions">${PROJ_ACTIONS(p)}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('[data-rename]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      await api('/api/projects/' + inp.dataset.rename, { method: 'PUT', body: JSON.stringify({ name: inp.value }) });
      if (currentProject?.id === inp.dataset.rename) {
        currentProject = { ...currentProject, name: inp.value };
        refreshRackProject();
      }
    }),
  );
  bindProjectActions(wrap);
}

function bindProjectActions(wrap) {
  wrap.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', async () => {
      await selectProject(b.dataset.open);
      route();
    }),
  );
  wrap.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => {
      dangerConfirm(b, async () => {
        await api('/api/projects/' + b.dataset.delete, { method: 'DELETE' });
        if (currentProject?.id === b.dataset.delete) {
          currentProject = null;
          refreshRackProject();
          openProjectScene();
        } else {
          loadProjectView();
        }
      }, { yes: 'Delete?' });
    }),
  );
}

$('#create-project-btn').addEventListener('click', () => createProject('#project-name', '#project-error', '#create-project-btn'));
$('#project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createProject('#project-name', '#project-error', '#create-project-btn');
});
$('#view-create-project-btn').addEventListener('click', () => createProject('#view-project-name', '#view-project-error', '#view-create-project-btn'));
$('#view-project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createProject('#view-project-name', '#view-project-error', '#view-create-project-btn');
});

async function createProject(nameSel, errSel, btnSel) {
  const name = $(nameSel).value.trim();
  const box = $(errSel);
  hideError(box);
  if (!name) {
    setError(box, 'Nama project tidak boleh kosong.');
    return;
  }
  const btn = $(btnSel);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'CREATING…';
  try {
    const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
    $(nameSel).value = '';
    await selectProject(r.project.id);
    window.location.hash = '#/koneksi';
    route();
    pullConnChip();
  } catch (err) {
    setError(box, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function pullConnChip() {
  try {
    const s = await api('/api/status');
    const led = $('#conn-chip .led');
    const lbl = $('#conn-chip span:last-child');
    if (!s.dbConfigured) {
      led.className = 'led led--warn';
      lbl.textContent = 'DB NOT CONFIGURED';
    } else if (s.dbConnected === true) {
      led.className = 'led led--ok';
      lbl.textContent = 'DB ONLINE';
    } else {
      led.className = 'led led--bad';
      lbl.textContent = 'DB OFFLINE';
    }
  } catch {
    /* konsol tetap bisa dipakai */
  }
}

/* ---------------- router ---------------- */

function route() {
  clearInterval(dashTimer);
  closeDrawer();
  const hash = window.location.hash.replace(/^#\//, '');
  if (hash === 'login') {
    $('#shell').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    return;
  }
  const name = views.includes(hash) ? hash : 'dashboard';
  for (const v of views) $('#view-' + v).classList.toggle('hidden', v !== name);
  document.querySelectorAll('#nav a, #nav-proj a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  $('#topbar-title').textContent = (titles[name] || '').toUpperCase();
  document.querySelector('.scroll').scrollTop = 0;
  window.scrollTo(0, 0);
  ({
    projects: () => loadProjectView(),
    dashboard: () => loadDashboard(),
    agent: () => loadAgentView(),
    koneksi: () => loadConfigForm(),
    apikey: () => loadKeys(),
    izin: () => loadPermissions(),
    audit: () => loadAudit(),
    oauth: () => loadOauthClients(),
    playground: () => loadPlayground(),
    info: () => loadConnectInfo(),
  })[name]?.();
}

window.addEventListener('hashchange', route);

/* ---------------- drawer mobile (sidebar iOS) ---------------- */

const rackEl = $('#rack');
const scrimEl = $('#scrim');
const navToggle = $('#nav-toggle');
const mqMobile = window.matchMedia('(max-width: 720px)');

function isDrawerOpen() {
  return rackEl.classList.contains('open');
}

function openDrawer() {
  if (!mqMobile.matches || isDrawerOpen()) return;
  rackEl.classList.add('open');
  scrimEl.classList.add('show');
  document.body.classList.add('nav-open');
  navToggle.setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  if (!rackEl || !isDrawerOpen()) return;
  rackEl.classList.remove('open');
  scrimEl.classList.remove('show');
  document.body.classList.remove('nav-open');
  navToggle.setAttribute('aria-expanded', 'false');
}

navToggle.addEventListener('click', () => (isDrawerOpen() ? closeDrawer() : openDrawer()));
$('#rack-close').addEventListener('click', closeDrawer);
scrimEl.addEventListener('click', closeDrawer);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDrawerOpen()) {
    closeDrawer();
    navToggle.focus();
  }
});

document.querySelectorAll('#nav a, #nav-proj a').forEach((a) => a.addEventListener('click', closeDrawer));

if (mqMobile.addEventListener) mqMobile.addEventListener('change', (e) => { if (!e.matches) closeDrawer(); });
else mqMobile.addListener((e) => { if (!e.matches) closeDrawer(); });

let swipeX = null;
let swipeY = null;
rackEl.addEventListener('touchstart', (e) => {
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
}, { passive: true });
rackEl.addEventListener('touchmove', (e) => {
  if (swipeX === null) return;
  const dx = e.touches[0].clientX - swipeX;
  const dy = e.touches[0].clientY - swipeY;
  if (Math.abs(dx) > Math.abs(dy) && dx < -56) {
    closeDrawer();
    swipeX = null;
  }
}, { passive: true });
rackEl.addEventListener('touchend', () => { swipeX = null; });
rackEl.addEventListener('touchcancel', () => { swipeX = null; });

/* ---------------- dashboard ---------------- */

let dashTimer = null;

function dashCards(s) {
  const dbCls = !s.dbConfigured ? 'c-warn' : s.dbConnected === true ? 'c-ok' : 'c-bad';
  const dbLed = !s.dbConfigured ? 'led--warn' : s.dbConnected === true ? 'led--ok' : 'led--bad';
  const dbVal = !s.dbConfigured ? '—' : s.dbConnected === true ? 'ONLINE' : 'OFFLINE';
  const dbSub = s.dbConfigured
    ? s.dbConnected === true
      ? 'Engine reads and responds'
      : 'Check config & network'
    : 'Save connection parameters first';
  return `
    <a class="card card--link ${dbCls}" href="#/koneksi">
      <span class="card-go"><i class="ph ph-arrow-right"></i></span>
      <div class="c-lab c-left"><i class="led ${dbLed}"></i>DATABASE</div>
      <div class="c-val">${dbVal}</div>
      <div class="c-sub">${esc(dbSub)}</div>
    </a>
    <a class="card card--link c-ok" href="#/apikey">
      <span class="card-go"><i class="ph ph-arrow-right"></i></span>
      <div class="c-lab c-left"><i class="led led--ok"></i>API KEYS ACTIVE</div>
      <div class="c-val">${s.keysActive}<small> / ${s.keysTotal} total</small></div>
      <div class="c-sub">Each key: 60 req/min · full audit</div>
    </a>
    <a class="card card--link" href="#/izin">
      <span class="card-go"><i class="ph ph-arrow-right"></i></span>
      <div class="c-lab c-left"><i class="led led--on"></i>TABLE PERMISSIONS</div>
      <div class="c-val">${s.permissionCount}</div>
      <div class="c-sub">Default deny — everything else blocked</div>
    </a>
    <a class="card card--link c-ok" href="#/agent">
      <span class="card-go"><i class="ph ph-arrow-right"></i></span>
      <div class="c-lab c-left"><i class="led led--on"></i>AGENT TEST</div>
      <div class="c-val">${s.dbConnected === true ? 'READY' : 'WAIT'}<small>${s.dbConnected === true ? ' probe' : ' db'}</small></div>
      <div class="c-sub">Chat with Ollama Cloud using the same tools</div>
    </a>`;
}

function renderActivity(rows) {
  const now = Date.now();
  const buckets = new Array(24).fill(0);
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t) || t < now - 24 * 3600e3) continue;
    buckets[23 - Math.floor((now - t) / 3600e3)]++;
  }
  const max = Math.max(...buckets, 1);
  $('#activity-total').textContent = buckets.reduce((a, b) => a + b, 0) + ' REQUEST';
  $('#activity-bars').innerHTML = buckets
    .map((c, i) => {
      const hour = new Date(now - (23 - i) * 3600e3).getHours();
      const tip = `${c} req · hour ${String(hour).padStart(2, '0')}:00${i === 23 ? ' (now)' : ''}`;
      return `<div class="abar ${c ? '' : 'empty'} ${i === 23 ? 'today' : ''}" data-tip="${esc(tip)}" style="height:${c ? Math.max(14, Math.round((c / max) * 100)) : 8}%"></div>`;
    })
    .join('');
}

async function loadDashboard() {
  const wrap = $('#status-cards');
  wrap.innerHTML = `<div class="skel skel-card"><div class="sk-line w30"></div><div class="sk-line w60"></div><div class="sk-line w40"></div><div class="sk-line w80"></div></div>`.repeat(4);
  $('#activity-total').textContent = 'LOADING…';
  $('#activity-bars').innerHTML = '';
  try {
    const s = await api('/api/status');
    wrap.innerHTML = dashCards(s);
    if (s.dbError) {
      wrap.insertAdjacentHTML('beforeend', `<div class="msg msg-err" style="grid-column:1/-1">Koneksi DB error: ${esc(s.dbError)}</div>`);
    }
    const [audit, activity] = await Promise.all([
      api('/api/audit?limit=8'),
      api('/api/audit?limit=500'),
    ]);
    renderAuditTable($('#dashboard-audit'), audit.rows);
    renderActivity(activity.rows);
  } catch (err) {
    wrap.innerHTML = `<div class="msg msg-err" style="grid-column:1/-1">${esc(err.message)}</div>`;
  }
  clearInterval(dashTimer);
  dashTimer = setInterval(() => {
    api('/api/status').then((s) => {
      let html = dashCards(s);
      if (s.dbError) html += `<div class="msg msg-err" style="grid-column:1/-1">Koneksi DB error: ${esc(s.dbError)}</div>`;
      $('#status-cards').innerHTML = html;
      pullConnChip();
    }).catch(() => undefined);
    api('/api/audit?limit=500').then((activity) => renderActivity(activity.rows)).catch(() => undefined);
  }, 30000);
}

/* ---------------- config DB ---------------- */

async function loadConfigForm() {
  const cfg = await api('/api/config');
  if (cfg.configured && cfg.config) {
    $('#cfg-host').value = cfg.config.host;
    $('#cfg-port').value = cfg.config.port;
    $('#cfg-user').value = cfg.config.username;
    $('#cfg-pass').value = '';
    $('#cfg-db').value = cfg.config.database;
    $('#cfg-encrypt').checked = cfg.config.encrypt;
    $('#cfg-trust').checked = cfg.config.trustServerCert;
  }
}

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#config-msg');
  hideError(msg);
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        host: $('#cfg-host').value.trim(),
        port: Number($('#cfg-port').value),
        username: $('#cfg-user').value.trim(),
        password: $('#cfg-pass').value,
        database: $('#cfg-db').value.trim(),
        encrypt: $('#cfg-encrypt').checked,
        trustServerCert: $('#cfg-trust').checked,
      }),
    });
    setMsg(msg, 'ok', 'Configuration saved. The new connection is used automatically.');
    loadConfigForm();
    pullConnChip();
  } catch (err) {
    setMsg(msg, 'err', err.message);
  }
});

$('#test-btn').addEventListener('click', async () => {
  const btn = $('#test-btn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  const msg = $('#config-msg');
  hideError(msg);
  try {
    const r = await api('/api/config/test', {
      method: 'POST',
      body: JSON.stringify({
        host: $('#cfg-host').value.trim(),
        port: Number($('#cfg-port').value),
        username: $('#cfg-user').value.trim(),
        password: $('#cfg-pass').value,
        database: $('#cfg-db').value.trim(),
        encrypt: $('#cfg-encrypt').checked,
        trustServerCert: $('#cfg-trust').checked,
      }),
    });
    setMsg(msg, r.ok ? 'ok' : 'err', r.message);
  } catch (err) {
    setMsg(msg, 'err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
});

/* ---------------- api keys ---------------- */

const ROWS_SKELETON = `<div class="skel skel-rows">${'<div class="skel skel-row"></div>'.repeat(4)}</div>`;

async function loadKeys() {
  $('#key-count').textContent = 'LOADING…';
  $('#key-list').innerHTML = ROWS_SKELETON;
  const { keys } = await api('/api/keys');
  $('#key-count').textContent = keys.length + ' REGISTERED';
  const wrap = $('#key-list');
  if (!keys.length) {
    wrap.innerHTML = emptyState('ph-key', 'No API keys yet. Issue the first key above.', { label: 'Create API Key', focus: 'key-name' });
    wrap.querySelector('.empty-cta')?.addEventListener('click', () => $('#key-name').focus());
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Key (prefix)</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${keys.map((k) => `
          <tr>
            <td><input type="text" value="${esc(k.name)}" data-rename="${esc(k.id)}" class="key-name-input" aria-label="Key name" /></td>
            <td class="mono">${esc(k.prefix)}…</td>
            <td>${fmtDate(k.createdAt)}</td>
            <td>${fmtDate(k.lastUsedAt)}</td>
            <td>${k.revoked ? '<span class="badge badge-bad">REVOKED</span>' : '<span class="badge badge-ok">ACTIVE</span>'}</td>
            <td class="row-actions">
              ${k.revoked ? '' : `<button class="btn btn--danger btn--small" data-revoke="${esc(k.id)}">Revoke</button>`}
              <button class="btn btn--danger btn--small" data-delete="${esc(k.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () => {
      dangerConfirm(b, async () => { await api('/api/keys/' + b.dataset.revoke, { method: 'DELETE' }); loadKeys(); });
    }),
  );
  wrap.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => {
      dangerConfirm(b, async () => {
        await api('/api/keys/' + b.dataset.delete + '?permanent=1', { method: 'DELETE' });
        loadKeys();
      }, { yes: 'Delete?' });
    }),
  );
  wrap.querySelectorAll('.key-name-input').forEach((inp) =>
    inp.addEventListener('change', async () => {
      await api('/api/keys/' + inp.dataset.rename, { method: 'PUT', body: JSON.stringify({ name: inp.value }) });
    }),
  );
}

$('#create-key-btn').addEventListener('click', async () => {
  const name = $('#key-name').value.trim() || 'API Key';
  const btn = $('#create-key-btn');
  btn.disabled = true;
  const box = $('#key-result');
  box.className = 'hidden';
  try {
    const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    box.innerHTML = `
      <div class="key-pill">${esc(r.plainKey)}
        <button class="btn btn--primary btn--small" id="copy-plain">Copy</button>
      </div>
      <p class="new-key-note">⚠ The key is shown only once — copy it now. It can't be viewed again.</p>`;
    box.classList.remove('hidden');
    $('#copy-plain').addEventListener('click', () => copyText(r.plainKey, $('#copy-plain')));
    $('#key-name').value = '';
    loadKeys();
  } catch (err) {
    box.innerHTML = `<div class="msg msg-err">${esc(err.message)}</div>`;
    box.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- oauth clients ---------------- */

async function loadOauthClients() {
  $('#oauth-count').textContent = 'LOADING…';
  $('#oauth-list').innerHTML = ROWS_SKELETON;
  try {
    const info = await api('/api/connect');
    $('#oauth-connect-url').textContent = info.mcpUrl;
  } catch {
    /* tidak fatal */
  }
  const { clients } = await api('/api/oauth-clients');
  $('#oauth-count').textContent = clients.length + ' REGISTERED';
  const wrap = $('#oauth-list');
  if (!clients.length) {
    wrap.innerHTML = emptyState('ph-lock-key', 'No OAuth clients yet. Create one above — or leave the Claude form empty (Dynamic Client Registration creates it automatically).');
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Nama</th><th>Client ID</th><th>Redirect URIs</th><th>Auth</th><th>Dibuat</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${clients.map((c) => `
          <tr>
            <td>${esc(c.name)}${c.dynamic ? ' <span class="badge badge-warn">DCR</span>' : '<span class="badge badge-ok">PRE-REGISTERED</span>'}</td>
            <td class="mono">${esc(c.clientId)}</td>
            <td class="mono small">${esc(c.redirectUris.join(', '))}</td>
            <td class="mono">${esc(c.authMethod)}</td>
            <td>${fmtDate(c.createdAt)}</td>
            <td>${c.revoked ? '<span class="badge badge-bad">REVOKED</span>' : '<span class="badge badge-ok">AKTIF</span>'}</td>
            <td class="row-actions">
              ${c.revoked ? '' : `<button class="btn btn--danger btn--small" data-revoke="${esc(c.clientId)}">Revoke</button>`}
              <button class="btn btn--danger btn--small" data-delete="${esc(c.clientId)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  wrap.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () => {
      dangerConfirm(b, async () => { await api('/api/oauth-clients/' + b.dataset.revoke, { method: 'DELETE' }); loadOauthClients(); });
    }),
  );
  wrap.querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', () => {
      dangerConfirm(b, async () => {
        await api('/api/oauth-clients/' + b.dataset.delete + '?permanent=1', { method: 'DELETE' });
        loadOauthClients();
      }, { yes: 'Delete?' });
    }),
  );
}

$('#create-oauth-btn').addEventListener('click', async () => {
  const name = $('#oauth-name').value.trim();
  const box = $('#oauth-msg');
  hideError(box);
  if (!name) {
    setError(box, 'Client name is required.');
    return;
  }
  const redirectUris = $('#oauth-uris').value
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
  const btn = $('#create-oauth-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/oauth-clients', {
      method: 'POST',
      body: JSON.stringify({ name, redirectUris, confidential: $('#oauth-conf').checked }),
    });
    const c = r.client;
    let html = `
      <div class="plate" style="margin-top:14px">
        <div class="plate-cap"><span>CLIENT CREATED — COPY NOW</span><i class="led led--ok"></i></div>
        <div class="kv">
          <div class="kv-row"><span>CLIENT ID</span><b class="mono">${esc(c.clientId)} <button class="btn btn--small" data-copy="${esc(c.clientId)}">Copy</button></b></div>
          ${r.plainSecret ? `<div class="kv-row"><span>CLIENT SECRET</span><b class="mono">${esc(r.plainSecret)} <button class="btn btn--small" data-copy="${esc(r.plainSecret)}">Copy</button></b></div>` : ''}
        </div>
        <p class="new-key-note">⚠ The Client Secret is shown only ONCE. Once this panel is closed it can't be retrieved again (create a new client if you lose it).</p>
      </div>`;
    box.innerHTML = html;
    box.classList.remove('hidden');
    box.querySelectorAll('[data-copy]').forEach((bt) => bt.addEventListener('click', () => copyText(bt.dataset.copy, bt)));
    $('#oauth-name').value = '';
    loadOauthClients();
  } catch (err) {
    setError(box, err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- permissions ---------------- */

async function loadPermissions() {
  const wrap = $('#perm-list');
  const msg = $('#perm-msg');
  hideError(msg);
  wrap.innerHTML = ROWS_SKELETON;
  try {
    const data = await api('/api/permissions');
    if (data.configError) {
      wrap.innerHTML = `<div class="msg msg-warn">${esc(data.configError)} — configure the DB connection first.</div>`;
      return;
    }
    if (!data.tables.length) {
      wrap.innerHTML = emptyState('ph-database', 'No tables in this database.');
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Table</th><th>Schema</th><th>Est. rows</th><th>Read data</th><th>View metadata</th><th>Status</th></tr></thead>
        <tbody>
          ${data.tables.map((t) => `
            <tr>
              <td class="mono">${esc(t.table)}</td>
              <td>${esc(t.schema)}</td>
              <td class="mono num">${fmtNum(t.rowCount)}</td>
              <td><input type="checkbox" class="toggle ${t.allowRead ? 'on' : ''}" data-table="${esc(t.table)}" data-kind="allowRead" aria-label="Izinkan baca ${esc(t.table)}" /></td>
              <td><input type="checkbox" class="toggle ${t.allowSchema ? 'on' : ''}" data-table="${esc(t.table)}" data-kind="allowSchema" aria-label="Izinkan metadata ${esc(t.table)}" /></td>
              <td>${t.registered ? (t.allowRead ? '<span class="badge badge-ok">GRANTED</span>' : '<span class="badge badge-warn">METADATA ONLY</span>') : '<span class="badge badge-bad">DENIED</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    wrap.querySelectorAll('.toggle').forEach((tg) =>
      tg.addEventListener('click', () => tg.classList.toggle('on')),
    );
  } catch (err) {
    wrap.innerHTML = `<div class="msg msg-err">${esc(err.message)}</div>`;
  }
}

$('#save-perm-btn').addEventListener('click', async () => {
  const msg = $('#perm-msg');
  const rows = [...document.querySelectorAll('#perm-list tbody tr')].map((tr) => ({
    table: tr.querySelector('.toggle[data-kind="allowRead"]').dataset.table,
    schema: tr.querySelector('td:nth-child(2)').textContent.trim(),
    allowRead: tr.querySelector('.toggle[data-kind="allowRead"]').classList.contains('on'),
    allowSchema: tr.querySelector('.toggle[data-kind="allowSchema"]').classList.contains('on'),
  }));
  try {
    const r = await api('/api/permissions', { method: 'PUT', body: JSON.stringify({ tables: rows }) });
    setMsg(msg, 'ok', `Permissions saved for ${r.updated} tables.`);
    loadPermissions();
  } catch (err) {
    setMsg(msg, 'err', err.message);
  }
});

$('#refresh-tables-btn').addEventListener('click', () => loadPermissions());
$('#select-all-btn').addEventListener('click', () => {
  document.querySelectorAll('#perm-list .toggle[data-kind="allowRead"]').forEach((t) => t.classList.add('on'));
  document.querySelectorAll('#perm-list .toggle[data-kind="allowSchema"]').forEach((t) => t.classList.add('on'));
});
$('#clear-all-btn').addEventListener('click', () => {
  document.querySelectorAll('#perm-list .toggle').forEach((t) => t.classList.remove('on'));
});

/* ---------------- audit ---------------- */

function renderAuditTable(wrap, rows) {
  if (!rows.length) {
    wrap.innerHTML = emptyState('ph-binoculars', 'No AI activity recorded yet.');
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Time</th><th>API Key</th><th>Tool</th><th>Table</th><th>Rows</th><th>Duration</th><th>Status</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr title="${esc(r.params || '')}">
            <td>${fmtDate(r.ts)}</td>
            <td>${esc(r.key_name || '—')}</td>
            <td class="mono">${esc(r.tool)}</td>
            <td class="mono">${esc(r.table_name || '—')}</td>
            <td class="mono num">${fmtNum(r.row_count)}</td>
            <td class="mono num">${r.duration_ms == null ? '—' : r.duration_ms + ' ms'}</td>
            <td>${r.status === 200 ? '<span class="badge badge-ok">OK</span>' : '<span class="badge badge-bad">ERROR</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function loadAudit() {
  const tool = $('#audit-tool').value.trim();
  const table = $('#audit-table').value.trim();
  const params = new URLSearchParams({ limit: '100' });
  if (tool) params.set('tool', tool);
  if (table) params.set('table', table);
  $('#audit-list').innerHTML = ROWS_SKELETON;
  const { rows } = await api('/api/audit?' + params);
  renderAuditTable($('#audit-list'), rows);
}

$('#audit-refresh').addEventListener('click', loadAudit);
$('#audit-tool').addEventListener('keydown', (e) => e.key === 'Enter' && loadAudit());
$('#audit-table').addEventListener('keydown', (e) => e.key === 'Enter' && loadAudit());/* ---------------- Agent Test ---------------- */

function mdLite(text) {
  const blocks = [];
  let code = 0;
  let idx = 0;
  let buf = '';
  let i = 0;
  const parts = [];
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      if (buf) parts.push({ type: 't', text: buf });
      buf = '';
      const end = text.indexOf('```', i + 3);
      if (end < 0) {
        parts.push({ type: 'c', text: text.slice(i + 3) });
        i = text.length;
      } else {
        parts.push({ type: 'c', text: text.slice(i + 3, end) });
        i = end + 3;
      }
      continue;
    }
    buf += text[i];
    i++;
  }
  if (buf) parts.push({ type: 't', text: buf });

  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>');

  const html = parts
    .map((p) => {
      if (p.type === 'c') return '<pre><code>' + esc(p.text) + '</code></pre>';
      const lines = p.text.split('\n');
      const out = [];
      i = 0;
      let list = null;
      while (i < lines.length) {
        const line = lines[i];
        if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
          const ordered = /^\s*\d/.test(line);
          const tag = ordered ? 'ol' : 'ul';
          if (list !== tag) {
            if (list) out.push(`</${list}>`);
            out.push(`<${tag}>`);
            list = tag;
          }
          out.push(`<li>${inline(line.replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`);
          i++;
          continue;
        }
        if (list) {
          out.push(`</${list}>`);
          list = null;
        }
        if (/^\s*#{1,4}\s+/.test(line)) {
          out.push(`<h3>${inline(line.replace(/^\s*#{1,4}\s+/, ''))}</h3>`);
          i++;
          continue;
        }
        if (/^\|.*\|\s*$/.test(line)) {
          const table = [];
          const isSep = (l) => /^\|?[\s:|-]+\|?$/.test(l) && l.includes('-');
          let j = i;
          if (j + 1 < lines.length && isSep(lines[j + 1])) {
            const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
            const head = cells(lines[j]);
            const rows = [];
            j += 2;
            while (j < lines.length && /^\|.*\|\s*$/.test(lines[j])) {
              rows.push(cells(lines[j]));
              j++;
            }
            table.push('<div class="table-scroll"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
            for (const r of rows) table.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
            table.push('</tbody></table></div>');
            out.push(table.join(''));
            i = j;
            continue;
          }
        }
        if (!line.trim()) {
          i++;
          continue;
        }
        out.push(`<p>${inline(line)}</p>`);
        i++;
      }
      if (list) out.push(`</${list}>`);
      return out.join('');
    })
    .join('');
  return html;
}

function agentTime() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function threadScroll() {
  const t = $('#agent-thread');
  t.scrollTop = t.scrollHeight;
}

function addChatPlate(kind, bodyHtml) {
  const plate = document.createElement('div');
  plate.className = 'thread-plate ' + kind;
  plate.innerHTML = `
    <div class="thread-tag"><span>${kind === 'me' ? 'ANDA' : kind === 'err' ? 'PROBE ERROR' : 'AGENT'}</span><time>${agentTime()}</time></div>
    <div class="thread-body"></div>`;
  plate.querySelector('.thread-body').innerHTML = bodyHtml;
  $('#agent-thread').appendChild(plate);
  threadScroll();
  return plate;
}

function startAgentBubble() {
  const plate = document.createElement('div');
  plate.className = 'thread-plate ai';
  plate.innerHTML = `
    <div class="thread-tag"><span>AGENT</span><time>${agentTime()}</time></div>
    <div class="thread-body"><span class="caret"></span></div>`;
  $('#agent-thread').appendChild(plate);
  threadScroll();
  return plate;
}

function addToolchip(bubble, run) {
  const chips = bubble.querySelector('.toolchips') || (() => {
    const c = document.createElement('div');
    c.className = 'toolchips';
    bubble.querySelector('.thread-body').appendChild(c);
    return c;
  })();
  const chip = document.createElement('span');
  chip.className = 'toolchip ' + (run.ok ? 'ok' : 'err');
  const rows = run.ok ? (run.rows != null ? run.rows + ' rows' : 'ok')  : 'FAIL';
  const args = JSON.stringify(run.args);
  chip.title = args.length > 200 ? args.slice(0, 200) + '…' : args;
  chip.innerHTML = `${run.ok ? '✓' : '✕'} ${esc(run.name)} <span class="tc-d">· ${rows} · ${run.durationMs} ms</span>`;
  chips.appendChild(chip);
  threadScroll();
}

let probeCount = 0;

function addProbeItem(run) {
  probeCount++;
  const log = $('#agent-probe-log');
  log.querySelector('.probe-empty')?.remove();
  const item = document.createElement('div');
  item.className = 'probe-item ' + (run.ok ? 'ok' : 'err');
  const args = JSON.stringify(run.args);
  item.innerHTML = `
    <div class="probe-top">
      <span class="pn">#${String(probeCount).padStart(2, '0')}</span>
      <span class="pt">${esc(run.name)}</span>
      <span class="pd">${run.ok ? (run.rows != null ? run.rows + ' rows' : 'ok') : 'FAIL'} · ${run.durationMs}ms</span>
    </div>
    <div class="probe-args" title="${esc(args)}">${esc(args.slice(0, 90))}</div>`;
  log.prepend(item);
}

function renderAgentStatus(s) {
  const led = $('#agent-status-led');
  const model = $('#agent-status-model');
  const key = $('#agent-status-key');
  const text = $('#agent-status-text');
  const configPanel = $('#agent-config-panel');
  if (!s.configured) {
    led.className = 'led led--warn';
    configPanel.classList.remove('hidden');
    text.textContent = 'KEY NOT SAVED';
  } else {
    led.className = s.busy ? 'led led--ok' : 'led led--on';
    configPanel.classList.add('hidden');
    text.textContent = s.busy ? 'RESPONDING' : 'READY';
  }
  model.textContent = s.model || '—';
  key.textContent = s.configured ? '••••' + esc(s.keyLast4) : '—';
  if (s.model) document.getElementById('agent-model-input').value = s.model;
}

async function loadAgentView() {
  try {
    const s = await api('/api/agent/status');
    window.agentToolNames = (s.tools || []).map((t) => t.name);
    renderAgentStatus(s);
    if (s.configured && !$('#agent-thread').children.length) welcomeMessage();
  } catch {
    /* tetap bisa melihat UI di bawah */
  }
}

$('#agent-change-key').addEventListener('click', () => $('#agent-config-panel').classList.remove('hidden'));
$('#agent-cancel-config').addEventListener('click', async () => {
  $('#agent-config-panel').classList.add('hidden');
  try {
    const s = await api('/api/agent/status');
    if (s.configured) renderAgentStatus(s);
  } catch { /* noop */ }
});

$('#agent-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#agent-config-msg');
  hideError(msg);
  const btn = $('#agent-save-config');
  btn.disabled = true;
  btn.textContent = 'Verifikasi…';
  try {
    const r = await api('/api/agent/config', {
      method: 'POST',
      body: JSON.stringify({ apiKey: $('#agent-key-input').value.trim(), model: $('#agent-model-input').value.trim() }),
    });
    setMsg(msg, 'ok', `Key saved. Active model: ${r.model}.`);
    renderAgentStatus(await api('/api/agent/status'));
    $('#agent-key-input').value = '';
    if (!$('#agent-thread').children.length) welcomeMessage();
  } catch (err) {
    setMsg(msg, 'err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Verify';
  }
});

$('#agent-clear-key').addEventListener('click', () => {
  dangerConfirm($('#agent-clear-key'), async () => {
    await api('/api/agent/config', { method: 'DELETE' });
    $('#agent-thread').innerHTML = '';
    $('#agent-probe-log').innerHTML = '<div class="probe-empty">Agent belum memanggil tool apa pun.</div>';
    probeCount = 0;
    $('#agent-input').disabled = false;
    renderAgentStatus(await api('/api/agent/status'));
    $('#agent-config-panel').classList.remove('hidden');
    welcomeMessage('Key cleared. Save an Ollama Cloud API key to re-enable the probe.');
  }, { yes: 'Sure to clear?', revertMs: 5000 });
});

$('#agent-reset-chat').addEventListener('click', () => {
  dangerConfirm($('#agent-reset-chat'), async () => {
    await api('/api/agent/reset', { method: 'POST' });
    $('#agent-thread').innerHTML = '';
    $('#agent-probe-log').innerHTML = '<div class="probe-empty">Agent belum memanggil tool apa pun.</div>';
    probeCount = 0;
    welcomeMessage();
  }, { yes: 'Clear?', revertMs: 4000 });
});

function welcomeMessage(note) {
  if ($('#agent-thread').children.length) return;
  const plate = addChatPlate('ai', '');
  const body = plate.querySelector('.thread-body');
  const tools =
    window.agentToolNames && window.agentToolNames.length
      ? window.agentToolNames.join(', ')
      : 'list_tables, get_table_schema, read_records, count_records, get_record_by_pk, server_info';
  body.innerHTML =
    (note ? `<p><strong>${esc(note)}</strong></p>` : '') +
    `<p>Probe ready. I'm <strong>agent MCP-SQLSERV</strong> — I answer by calling the same tools used by any other MCP client (${esc(tools)}).</p>
     <p>Examples: <em>"Which tables are readable?"</em>, <em>"Show the top 5 best sellers."</em>, or <em>"Count total purchases this year."</em></p>
     <p>Every tool call I make is recorded in the <a href="#/audit">Audit Log</a>.</p>`;
}

$('#agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#agent-input');
  const text = input.value.trim();
  if (!text || agentState.busy) return;
  input.value = '';
  input.style.height = 'auto';
  addChatPlate('me', `<p>${esc(text)}</p>`);
  sendAgentMessage(text, input);
});

$('#agent-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#agent-form').dispatchEvent(new Event('submit'));
  }
  inputGrow(e.target);
});

function inputGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

$('#agent-input').addEventListener('input', (e) => inputGrow(e.target));
$('#agent-input').addEventListener('paste', (e) => setTimeout(() => inputGrow(e.target), 0));
document.querySelectorAll('.snip').forEach((s) =>
  s.addEventListener('click', () => {
    $('#agent-input').value = s.dataset.p;
    inputGrow($('#agent-input'));
    $('#agent-input').focus();
  }),
);

async function sendAgentMessage(text, inputEl) {
  agentState.busy = true;
  const sendBtn = $('#agent-send');
  if (inputEl) inputEl.disabled = true;
  sendBtn.disabled = true;
  const bubble = startAgentBubble();
  const body = bubble.querySelector('.thread-body');
  body.querySelector('.caret')?.remove();
  body.textContent = '';
  let full = '';

  try {
    const res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: text }),
    });
    if (res.status === 409) {
      const d = await res.json().catch(() => ({}));
      bubble.classList.add('err');
      body.innerHTML = `<p>${esc(d.error || 'Agent is busy.')}</p>`;
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'delta' && typeof payload.text === 'string') {
          full += payload.text;
          body.innerHTML = mdLite(full) + '<span class="caret"></span>';
          threadScroll();
        } else if (event === 'tool' && payload.run) {
          addToolchip(bubble, payload.run);
          addProbeItem(payload.run);
        } else if (event === 'error') {
          bubble.classList.add('err');
          body.innerHTML = `<p>${esc(payload.message || 'Failed to reach Ollama Cloud.')}</p>`;
        } else if (event === 'done') {
          if (payload.text) body.innerHTML = mdLite(payload.text);
          else body.innerHTML = '<p><em>(agent tidak menghasilkan teks)</em></p>';
        } else if (event === 'end') {
          break;
        }
      }
    }
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      renderAgentStatus(await api('/api/agent/status'));
    }
  } catch (err) {
    bubble.classList.add('err');
    body.innerHTML = `<p>${esc(err.message)}</p>`;
  } finally {
    agentState.busy = false;
    if (inputEl) inputEl.disabled = false;
    sendBtn.disabled = false;
    threadScroll();
  }
}

/* ---------------- connect info ---------------- */

async function loadConnectInfo() {
  const info = await api('/api/connect');
  const keys = info.activeKeys.length
    ? `<p>${info.activeKeys.map((k) => `• <code>${esc(k.prefix)}…</code> (${esc(k.name)})`).join('<br>')}</p>`
    : '<p>No active keys — create one in the API Keys menu.</p>';
  $('#connect-info').innerHTML = `
    <div class="plate">
      <div class="plate-cap"><span>MCP ENDPOINT</span><i class="led led--on"></i></div>
      <div class="key-pill">${esc(info.mcpUrl)} <button class="btn btn--primary btn--small" id="copy-url">Copy</button></div>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>AUTHENTICATION</span><i class="led led--idle"></i></div>
      <p>Create a key in the <b>API Keys</b> menu, then send it as a header:</p>
      <pre class="code">Authorization: Bearer sk-xxxxxxxxxxxxxxxx</pre>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>CLAUDE CUSTOM CONNECTOR (OAUTH)</span><i class="led led--ok"></i></div>
      <p>Claude → <b>Customize → Connectors → Add custom connector</b> → enter the URL above. OAuth Client ID / Secret from the <b>OAuth Clients</b> menu (can be left empty — automatic registration). After <b>Add</b>, click <b>Connect</b> and approve on the console login page.</p>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>EXAMPLE MCP CLIENT CONFIG</span><i class="led led--idle"></i></div>
      <p>This server can be connected to <b>any AI agent</b> that supports remote MCP Streamable HTTP — including Ollama-based chat projects.</p>
      <pre>${esc(JSON.stringify(info.exampleConfig, null, 2))}</pre>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>QUICK TEST WITH CURL</span><i class="led led--idle"></i></div>
      <pre>curl -X POST ${esc(info.mcpUrl)} \\
  -H "Authorization: Bearer sk-XXXX" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'</pre>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>AVAILABLE TOOLS</span><i class="led led--idle"></i></div>
      <p class="mono" style="color:var(--bone)">${info.tools.map((t) => esc(t)).join(' · ')}</p>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>SECURITY</span><i class="led led--ok"></i></div>
      <p>Fully read-only: structured SELECT queries, all values bound as parameters, identifiers validated against real DB metadata, 1000-row per-query limit, per-key rate limiting, and a full audit log.</p>
    </div>
    <div class="plate">
      <div class="plate-cap"><span>ACTIVE API KEYS</span><i class="led led--idle"></i></div>
      ${keys}
    </div>`;
  $('#copy-url').addEventListener('click', () => copyText(info.mcpUrl, $('#copy-url')));
}

/* ---------------- tools playground ---------------- */

const pg = { builtin: [], custom: [], tables: [], editing: null };

const PG_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'startsWith', 'endsWith', 'in', 'between', 'isNull', 'isNotNull'];
const PG_JOIN_TYPES = ['inner', 'left', 'right', 'full'];
const PG_PARAM_TYPES = ['string', 'number', 'boolean', 'date'];

function pgFlash(msg) {
  const el = $('#pg-flash');
  if (!msg) { el.textContent = ''; return; }
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 5000);
}

function tableOptions(sel) {
  return `<option value="">— table —</option>` + pg.tables.map((t) => `<option value="${esc(t.table)}">${esc(t.table)}</option>`).join('');
}

function paramOptions(sel, placeholder = '—') {
  const names = pgDefParams().map((p) => p.name);
  const cur = sel === undefined ? undefined : document.querySelector(sel)?.value;
  return '<option value="">' + placeholder + '</option>' + names.map((n) => `<option value="${esc(n)}">@${esc(n)}</option>`).join('');
}

function pgDefParams() {
  return [...document.querySelectorAll('#t-params .dynrow')].map((r) => ({
    name: r.querySelector('.p-name')?.value.trim() || '',
    type: r.querySelector('.p-type')?.value || 'string',
    required: !!r.querySelector('.p-req')?.checked,
    default: r.querySelector('.p-def')?.value.trim() || undefined,
  })).filter((p) => p.name);
}

async function loadPlayground() {
  const data = await api('/api/tools');
  pg.builtin = data.builtin;
  pg.custom = data.custom;
  try {
    const perm = await api('/api/permissions');
    pg.tables = (perm.tables ?? []).filter((t) => t.allowRead);
  } catch { pg.tables = []; }
  renderBuiltinTools();
  renderCustomTools();
}

function renderBuiltinTools() {
  $('#builtin-tools').innerHTML = pg.builtin.map((t) => `
    <div class="toolgrid-row">
      <i class="ph ph-wrench toolgrid-ico"></i>
      <div class="toolgrid-main">
        <b class="mono">${esc(t.name)}</b>
        <span>${esc(t.title)}</span>
      </div>
      <label class="toggleswitch" title="Enable / disable tool"><input type="checkbox" class="pg-toggle" data-name="${esc(t.name)}" ${t.enabled ? 'checked' : ''} /><span class="knob"></span></label>
    </div>`).join('');
  $('#builtin-tools').querySelectorAll('.pg-toggle').forEach((tg) =>
    tg.addEventListener('change', async () => {
      const name = tg.dataset.name;
      const enabled = tg.checked;
      tg.disabled = true;
      try {
        await api('/api/tools/builtin', { method: 'PUT', body: JSON.stringify({ tools: [{ name, enabled }] }) });
        const t = pg.builtin.find((x) => x.name === name);
        if (t) t.enabled = enabled;
        pgFlash(enabled ? `${name} enabled` : `${name} disabled`);
      } catch (err) {
        tg.checked = !enabled;
        pgFlash(err.message);
      }
      tg.disabled = false;
    }),
  );
}

function renderCustomTools() {
  $('#custom-tools-count').textContent = pg.custom.length + ' REGISTERED';
  const wrap = $('#custom-tools-list');
  if (!pg.custom.length) {
    wrap.innerHTML = emptyState('ph-wrench', 'No custom tools yet. Build your first one — structured builder or pasted SQL.', { label: 'Create Tool', focus: 't-name' });
    wrap.querySelector('.empty-cta')?.addEventListener('click', () => openToolEditor(null));
    wrap.classList.remove('rows');
    return;
  }
  wrap.classList.add('rows');
  wrap.innerHTML = pg.custom
    .map((c) => {
      const params = (c.definition.params || []).length;
      return `
      <div class="toolgrid-row pg-row ${c.enabled ? '' : 'off'}" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="Edit tool ${esc(c.name)}">
        <i class="ph ph-wrench toolgrid-ico"></i>
        <div class="toolgrid-main">
          <b class="mono">${esc(c.name)}</b>
          <span>${esc(c.title)} ·
            <span class="badge ${c.mode === 'sql' ? 'badge-warn' : 'badge-ok'}">${c.mode === 'sql' ? 'SQL' : 'BUILDER'}</span>
            · ${params} param${params === 1 ? '' : 's'}
            ${c.enabled ? '' : '<span class="badge badge-bad">DISABLED</span>'}</span>
        </div>
        <div class="pg-actions">
          <button type="button" class="btn btn--small" data-test="${esc(c.id)}">Test</button>
          <button type="button" class="btn btn--small" data-edit="${esc(c.id)}">Edit</button>
          <button type="button" class="btn btn--danger btn--small" data-del="${esc(c.id)}">Delete</button>
        </div>
        <label class="toggleswitch" title="Enable / disable tool"><input type="checkbox" class="pg-enable" data-id="${esc(c.id)}" data-name="${esc(c.name)}" ${c.enabled ? 'checked' : ''} /><span class="knob"></span></label>
      </div>`;
    })
    .join('');

  wrap.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = pg.custom.find((x) => x.id === b.dataset.test);
    if (c) openRunModal(c);
  }));
  wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = pg.custom.find((x) => x.id === b.dataset.edit);
    if (c) openToolEditor(c);
  }));
  wrap.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      dangerConfirm(b, async () => {
        await api('/api/tools/' + b.dataset.del, { method: 'DELETE' });
        loadPlayground();
      }, { yes: 'Sure?' });
    }),
  );
  wrap.querySelectorAll('.pg-enable').forEach((tg) =>
    tg.addEventListener('change', (e) => {
      e.stopPropagation();
      tg.disabled = true;
      api('/api/tools/' + tg.dataset.id, { method: 'PATCH', body: JSON.stringify({ enabled: tg.checked }) })
        .then(() => loadPlayground())
        .catch((err) => { pgFlash(err.message); tg.disabled = false; });
    }),
  );
  wrap.querySelectorAll('.pg-row').forEach((row) => {
    const open = () => {
      const c = pg.custom.find((x) => x.id === row.dataset.id);
      if (c) openToolEditor(c);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, .toggleswitch')) return;
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!e.target.closest('button, .toggleswitch')) open();
      }
    });
  });
}

$('#create-tool-btn').addEventListener('click', () => openToolEditor(null));
$('#t-cancel').addEventListener('click', () => $('#tool-editor').classList.add('hidden'));

function openToolEditor(custom) {
  pg.editing = custom ?? null;
  $('#editor-msg').classList.add('hidden');
  $('#tester').classList.add('hidden');
  $('#editor-title').textContent = custom ? `EDIT TOOL · ${esc(custom.name)}` : 'CREATE CUSTOM TOOL';
  $('#t-save').textContent = custom ? 'Save Changes' : 'Save Tool';
  $('#tool-form').reset();
  $('#t-joins').innerHTML = '';
  $('#t-where').innerHTML = '';
  $('#t-order').innerHTML = '';
  $('#t-params').innerHTML = '';
  $('#t-basetable').innerHTML = tableOptions();
  setSeg(custom ? (custom.definition.mode ?? 'builder') : 'builder');
  if (custom) {
    fillToolEditor(custom);
  } else {
    addParamRow();
    addWhereRow(undefined);
    addOrderRow(undefined);
  }
  refreshWhereParamSelects();
  $('#tool-editor').classList.remove('hidden');
  $('#tool-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fillToolEditor(custom) {
  $('#t-name').value = custom.name;
  $('#t-title').value = custom.title;
  $('#t-save').textContent = 'Save Changes';
  const d = custom.definition;
  const b = d.builder;
  if (d.mode === 'sql') {
    $('#t-sql').value = d.sql || '';
  } else if (b) {
    $('#t-basetable').value = b.baseTable || '';
    $('#t-basealias').value = b.alias || '';
    $('#t-cols').value = (b.columns || []).map((c) => (c.alias ? c.name + ' AS ' + c.alias : c.name)).join(', ');
    $('#t-limit').value = b.limit ?? 100;
    (b.joins || []).forEach((j) => addJoinRow(j));
    (b.where || []).forEach((w) => addWhereRow(w));
    (b.orderBy || []).forEach((o) => addOrderRow(o));
  }
  (d.params || []).forEach((p) => addParamRow(p));
  if (!(d.params || []).length) addParamRow();
  if (!(b?.where || []).length) addWhereRow(undefined);
  if (!(b?.orderBy || []).length) addOrderRow(undefined);
  refreshWhereParamSelects();
}

function setSeg(mode) {
  $('#seg-builder').classList.toggle('seg-on', mode === 'builder');
  $('#seg-sql').classList.toggle('seg-on', mode === 'sql');
  $('#builder-panel').classList.toggle('hidden', mode !== 'builder');
  $('#sql-panel').classList.toggle('hidden', mode !== 'sql');
}

$('#seg-builder').addEventListener('click', () => { setSeg('builder'); refreshWhereParamSelects(); });
$('#seg-sql').addEventListener('click', () => { setSeg('sql'); });

/* ---- dynamic row editors ---- */

function addJoinRow(pre) {
  const row = document.createElement('div');
  row.className = 'dynrow';
  row.innerHTML = `
    <select class="j-type">${PG_JOIN_TYPES.map((t) => `<option ${pre && pre.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <select class="j-table">${tableOptions()}</select>
    <input class="j-alias" placeholder="alias" value="${esc(pre?.alias || '')}" spellcheck="false" />
    <span class="dynlab">ON</span>
    <input class="j-left" placeholder="alias.col" value="${esc(pre?.on?.left || '')}" spellcheck="false" />
    <select class="j-op">${['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].map((o) => `<option ${pre?.on?.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <input class="j-right" placeholder="alias.col" value="${esc(pre?.on?.right || '')}" spellcheck="false" />
    <button type="button" class="btn btn--small btn--danger dyndel" title="Remove">✕</button>`;
  if (pre) row.querySelector('.j-table').value = pre.table || '';
  $('#t-joins').appendChild(row);
}
$('#t-join-add').addEventListener('click', () => addJoinRow(undefined));

function addWhereRow(pre) {
  const row = document.createElement('div');
  row.className = 'dynrow';
  const kind = pre?.param ? 'param' : 'lit';
  const noVal = pre && (pre.op === 'isNull' || pre.op === 'isNotNull');
  row.innerHTML = `
    <input class="w-ref" placeholder="col or alias.col" value="${esc(pre?.ref || '')}" spellcheck="false" />
    <select class="w-op">${PG_OPS.map((o) => `<option ${pre && pre.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <span class="w-src">
      <select class="w-kind"><option value="lit" ${kind === 'lit' ? 'selected' : ''}>literal</option><option value="param" ${kind === 'param' ? 'selected' : ''}>@param</option></select>
      <input class="w-val hidden" placeholder="value" value="${esc(Array.isArray(pre?.value) ? pre.value.join(',') : (pre?.value ?? ''))}" spellcheck="false" />
      <select class="w-param hidden"></select>
      <input class="w-val2 hidden" placeholder="value2 (between)" value="${esc(pre?.value2 ?? '')}" spellcheck="false" />
    </span>
    <button type="button" class="btn btn--small btn--danger dyndel" title="Remove">✕</button>`;
  const op = row.querySelector('.w-op');
  const sync = () => {
    const o = op.value;
    row.querySelector('.w-kind').classList.toggle('hidden', noVal || o === 'isNull' || o === 'isNotNull');
    row.querySelector('.w-val').classList.toggle('hidden', noVal || o === 'isNull' || o === 'isNotNull' || o === 'between');
    row.querySelector('.w-param').classList.toggle('hidden', row.querySelector('.w-kind').value !== 'param' || o === 'isNull' || o === 'isNotNull');
    row.querySelector('.w-val2').classList.toggle('hidden', o !== 'between');
    if (kind === 'param' && o !== 'between' && !(o === 'isNull' || o === 'isNotNull')) {
      row.querySelector('.w-param').value = pre?.param || '';
    }
  };
  op.addEventListener('change', sync);
  row.querySelector('.w-kind').addEventListener('change', sync);
  $('#t-where').appendChild(row);
  sync();
  void noVal;
}

$('#t-where-add').addEventListener('click', () => addWhereRow(undefined));

function addOrderRow(pre) {
  const row = document.createElement('div');
  row.className = 'dynrow';
  row.innerHTML = `
    <input class="o-ref" placeholder="col or alias.col" value="${esc(pre?.ref || '')}" spellcheck="false" />
    <select class="o-dir"><option value="asc" ${pre?.dir !== 'desc' ? 'selected' : ''}>asc</option><option value="desc" ${pre?.dir === 'desc' ? 'selected' : ''}>desc</option></select>
    <button type="button" class="btn btn--small btn--danger dyndel" title="Remove">✕</button>`;
  $('#t-order').appendChild(row);
}
$('#t-order-add').addEventListener('click', () => addOrderRow(undefined));

function addParamRow(pre) {
  const row = document.createElement('div');
  row.className = 'dynrow';
  row.innerHTML = `
    <input class="p-name" placeholder="name (no @)" value="${esc(pre?.name || '')}" spellcheck="false" />
    <select class="p-type">${PG_PARAM_TYPES.map((t) => `<option ${pre?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" class="p-req" ${pre?.required ? 'checked' : ''} /><span>required</span></label>
    <input class="p-def" placeholder="default (optional)" value="${esc(pre?.default ?? '')}" spellcheck="false" />
    <button type="button" class="btn btn--small btn--danger dyndel" title="Remove">✕</button>`;
  row.querySelector('.p-name').addEventListener('input', () => refreshWhereParamSelects());
  $('#t-params').appendChild(row);
}
$('#t-param-add').addEventListener('click', () => addParamRow(undefined));

document.querySelectorAll('.dynrows').forEach((box) =>
  box.addEventListener('click', (e) => {
    if (e.target.classList.contains('dyndel')) e.target.closest('.dynrow').remove();
  }),
);

function refreshWhereParamSelects() {
  const names = pgDefParams().map((p) => p.name);
  document.querySelectorAll('#t-where .w-param').forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— @param —</option>' + names.map((n) => `<option value="${esc(n)}">@${esc(n)}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  });
}

/* ---- collect + save ---- */

function coerceLit(raw) {
  const s = String(raw ?? '').trim();
  if (s === 'null') return null;
  return s;
}

function collectDef() {
  const name = $('#t-name').value.trim();
  const title = $('#t-title').value.trim();
  const description = $('#t-desc').value.trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
    setError($('#editor-msg'), 'Tool name: lowercase a-z, digits, underscore, max 64 (e.g. best_sellers).');
    return null;
  }
  if (!title || !description) {
    setError($('#editor-msg'), 'Title and description are required.');
    return null;
  }
  const params = pgDefParams().map((p) => ({ name: p.name, type: p.type, required: p.required, default: p.default || undefined }));
  const mode = $('#seg-builder').classList.contains('seg-on') ? 'builder' : 'sql';
  const payload = { name, title, description, mode, params };
  if (mode === 'sql') {
    payload.sql = { sql: $('#t-sql').value.trim() };
    if (!payload.sql.sql) { setError($('#editor-msg'), 'SQL query is required.'); return null; }
  } else {
    const b = {
      baseTable: $('#t-basetable').value,
      alias: $('#t-basealias').value.trim() || undefined,
      columns: undefined,
      joins: [],
      where: [],
      orderBy: [],
      limit: Math.max(1, Math.min(Number($('#t-limit').value) || 100, 1000)),
    };
    const cols = $('#t-cols').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (cols.length) {
      b.columns = cols.map((c) => {
        const m = c.match(/^(.+?)\s+AS\s+(.+)$/i);
        return m ? { name: m[1].trim(), alias: m[2].trim() } : { name: c};
      });
    }
    for (const r of document.querySelectorAll('#t-joins .dynrow')) {
      const j = {
        type: r.querySelector('.j-type').value,
        table: r.querySelector('.j-table').value,
        alias: r.querySelector('.j-alias').value.trim(),
        on: {
          left: r.querySelector('.j-left').value.trim(),
          right: r.querySelector('.j-right').value.trim(),
          op: r.querySelector('.j-op').value,
        },
      };
      if (j.table && j.alias && j.on.left && j.on.right) b.joins.push(j);
    }
    for (const r of document.querySelectorAll('#t-where .dynrow')) {
      const op = r.querySelector('.w-op').value;
      const w = { ref: r.querySelector('.w-ref').value.trim(), op };
      const useParam = r.querySelector('.w-kind').value === 'param';
      const pSel = r.querySelector('.w-param');
      if (useParam && pSel.value) {
        w.param = pSel.value;
        w.value = undefined;
      } else if (op !== 'isNull' && op !== 'isNotNull') {
        const val = r.querySelector('.w-val').value;
        if (op === 'in') w.value = val.split(',').map((s) => s.trim()).filter(Boolean);
        else w.value = coerceLit(val);
        if (op === 'between') w.value2 = coerceLit(r.querySelector('.w-val2').value);
      }
      if (w.ref) b.where.push(w);
    }
    for (const r of document.querySelectorAll('#t-order .dynrow')) {
      const ref = r.querySelector('.o-ref').value.trim();
      if (ref) b.orderBy.push({ ref, dir: r.querySelector('.o-dir').value });
    }
    payload.builder = b;
  }
  return payload;
}

$('#tool-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = collectDef();
  if (!payload) return;
  hideError($('#editor-msg'));
  const btn = $('#t-save');
  btn.disabled = true;
  try {
    if (pg.editing) {
      await api('/api/tools/' + pg.editing.id, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/tools', { method: 'POST', body: JSON.stringify(payload) });
    }
    $('#tool-editor').classList.add('hidden');
    await loadPlayground();
  } catch (err) {
    setError($('#editor-msg'), err.message);
  }
  btn.disabled = false;
});

/* ---- test / run ---- */

function parseParamValue(p, inp) {
  const raw = inp ? inp.value.trim() : '';
  if (raw === '') return undefined;
  switch (p.type) {
    case 'number': { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
    case 'boolean': return inp.type === 'checkbox' ? inp.checked : raw === 'true' || raw === '1';
    case 'date': return raw;
    default: return raw;
  }
}

function renderRunResult(target, r, errMsg) {
  if (errMsg) {
    target.innerHTML = `<div class="msg msg-err mono">${esc(errMsg)}</div>`;
    return;
  }
  const headers = r.rows.length ? Object.keys(r.rows[0]) : [];
  target.innerHTML = `
    <div class="kv run-stats">
      <div class="kv-row"><span>ROWS</span><b class="mono">${fmtNum(r.rowCount)}</b></div>
      <div class="kv-row"><span>DURATION</span><b class="mono">${fmtNum(r.durationMs)} ms</b></div>
      ${r.previewTruncated ? '<div class="kv-row"><span>PREVIEW</span><b class="mono">first 200 rows</b></div>' : ''}
      ${r.testMode ? '<div class="kv-row"><span>MODE</span><b class="mono">TEST (audited)</b></div>' : ''}
    </div>
    <pre class="sql-preview mono">${esc(r.sql || '')}</pre>
    ${r.rows.length ? `
      <div class="table-wrap run-table">
        <table>
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${r.rows.map((row) => `<tr>${headers.map((h) => `<td class="mono">${esc(row[h] == null ? '—' : typeof row[h] === 'object' ? JSON.stringify(row[h]) : row[h])}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="hint">0 rows returned.</p>'}
    <button type="button" class="btn btn--small" data-copy-sql>Copy SQL</button>`;
  target.querySelector('[data-copy-sql]')?.addEventListener('click', (ev) => copyText(r.sql || '', ev.target));
}

function paramInputsHTML(params) {
  if (!params.length) return '<p class="hint">No runtime parameters — executes directly.</p>';
  return params.map((p) => `
    <div class="run-param">
      <label class="mono">@${esc(p.name)} <i>${esc(p.type)}${p.required ? ' · required' : ''}${p.default !== undefined ? ' · default ' + esc(JSON.stringify(p.default)) : ''}</i></label>
      ${p.type === 'boolean'
        ? `<label class="check"><input type="checkbox" data-param="${esc(p.name)}" ${p.default === 'true' ? 'checked' : ''} /><span>true</span></label>`
        : `<input type="${p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'}" data-param="${esc(p.name)}" class="field" ${p.default !== undefined ? `value="${esc(p.default)}"` : ''} spellcheck="false" />`}
    </div>`).join('');
}

function runSavedTool(id, values) {
  return api('/api/tools/' + id + '/test', { method: 'POST', body: JSON.stringify({ paramValues: values }) });
}

function openRunModal(custom) {
  const params = custom.definition.params || [];
  $('#run-modal-title').innerHTML = `RUN TOOL · <span class="mono">${esc(custom.name)}</span>`;
  $('#run-modal-params').innerHTML = paramInputsHTML(params);
  $('#run-modal-result').innerHTML = '';
  $('#run-modal').classList.remove('hidden');
  $('#run-modal-exec').onclick = async () => {
    const btn = $('#run-modal-exec');
    btn.disabled = true;
    const values = {};
    params.forEach((p, i) => {
      const inp = document.querySelectorAll('#run-modal-params input[data-param]')[i];
      const v = parseParamValue(p, inp);
      if (v !== undefined) values[p.name] = v;
    });
    try {
      const r = await runSavedTool(custom.id, values);
      renderRunResult($('#run-modal-result'), r, null);
    } catch (err) {
      renderRunResult($('#run-modal-result'), null, err.message);
    }
    btn.disabled = false;
  };
}

$('#run-modal-close').addEventListener('click', () => $('#run-modal').classList.add('hidden'));
$('#run-modal').addEventListener('click', (e) => { if (e.target === $('#run-modal')) $('#run-modal').classList.add('hidden'); });

/* draft test (pre-save) */
$('#t-test').addEventListener('click', async () => {
  const payload = collectDef();
  if (!payload) return;
  hideError($('#editor-msg'));
  const tester = $('#tester');
  tester.classList.remove('hidden');
  tester.innerHTML = `
    <div class="plate plate--inner">
      <div class="plate-cap"><span>TEST BEFORE SAVE · <span class="mono">${esc(payload.name)}</span></span><i class="led led--idle"></i></div>
      <div id="tester-params">${paramInputsHTML(payload.params)}</div>
      <div class="row" style="margin-top:12px">
        <span class="grow"></span>
        <button type="button" class="btn btn--primary" id="tester-exec"><i class="ph ph-play"></i>&nbsp;Execute</button>
      </div>
      <div id="tester-result" class="hidden"></div>
    </div>`;
  $('#tester-exec').addEventListener('click', async () => {
    const btn = $('#tester-exec');
    btn.disabled = true;
    const values = {};
    payload.params.forEach((p, i) => {
      const inp = document.querySelectorAll('#tester-params input[data-param]')[i];
      const v = parseParamValue(p, inp);
      if (v !== undefined) values[p.name] = v;
    });
    const tbody = { ...payload, paramValues: values };
    try {
      const r = await api('/api/tools/test-query', { method: 'POST', body: JSON.stringify(tbody) });
      renderRunResult($('#tester-result'), r, null);
    } catch (err) {
      renderRunResult($('#tester-result'), null, err.message);
    }
    $('#tester-result').classList.remove('hidden');
    btn.disabled = false;
  });
});

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    await api('/api/auth/me');
    enterApp();
  } catch {
    window.location.hash = '#/login';
    route();
  }
})();