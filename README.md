<div align="center">

# mcp-sqlserv

**MCP Server untuk akses read-only database SQL Server — anti SQL-injection by construction, dikelola lewat Web Admin UI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-black)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-29%20security%20%2B%2046%20OAuth-brightgreen)](#testing)

*Zero raw SQL · Default deny · Bind parameter 100% · Audit penuh*

</div>

---

## Tentang

**mcp-sqlserv** memungkinkan AI agent (Claude, Cursor, Claude Code, client MCP apa pun) **membaca** database SQL Server secara aman dan terkontrol:

- Semua query dibangun terstruktur oleh server — AI tidak pernah menulis SQL mentah.
- Identifier (tabel/kolom) divalidasi terhadap metadata asli database (`sys.tables`, `sys.columns`).
- Nilai selalu *bind parameter* → **SQL injection mustahil by construction**.
- Izin per-tabel bersifat **default deny**: tanpa izin eksplisit, tabel tidak bisa disentuh.
- Setiap request tercatat di audit log, lengkap dengan key, tool, filter, jumlah baris, dan durasi.

## Fitur

| Fitur | Keterangan |
|---|---|
| MCP Streamable HTTP | Endpoint `/mcp`, kompatibel dengan semua MCP client via HTTP |
| Multi-project | URL per project `/mcp/<projectId>`, storage & izin terpisah |
| API Key | Buat / revoke key per konsumen AI |
| OAuth 2.1 | Authorization Code + PKCE, DCR (RFC 7591), refresh rotation, revoke |
| Koneksi SQL Server | Host/port/user/pass (terenkripsi AES-256-GCM), TLS opsional |
| Izin granular | Per tabel: baca data dan/atau lihat metadata. Default = DENY |
| Audit log | Semua request AI tercatat: key, tool, tabel, filter, baris, durasi, status |
| Rate limit | 60 req/menit per API key (dapat dikonfigurasi) |
| Read-only total | Tool hanya menghasilkan `SELECT`; tidak ada jalur tulis sama sekali |
| Agent Test | Chat langsung dengan model Ollama Cloud dari Web UI untuk uji end-to-end |

## Arsitektur

```
┌──────────────┐   HTTPS    ┌─────────────┐          ┌──────────────────────────────┐
│  AI Agent    ├───────────►│    nginx    ├─────────►│  mcp-sqlserv (Docker)        │
│  (MCP client)│  Bearer    │  reverse    │ app-net  │  Express + MCP + OAuth       │
└──────────────┘  token     │  proxy+SSL  │  work    │      │            │          │
                            └─────────────┘          │      ▼            ▼          │
┌──────────────┐   HTTPS                              │  SQLite         mssql pool   │
│ Web Admin UI ├─────────────────────────────────────►│  (data/, keys,   │           │
│  (browser)   │            REST /api/*               │   audit, izin)   ▼           │
└──────────────┘                                      │              ┌──────────┐    │
                                                      │              │ SQL Srvr │    │
                                                      └──────────────┴──────────┴────┘
```

## Quick Start

```bash
# 1. Clone & siapkan environment
git clone https://github.com/<username>/mcp-sqlserv.git
cd mcp-sqlserv
cp .env.example .env            # isi ADMIN_USER / ADMIN_PASSWORD (min 8 karakter)

# 2. Build & jalankan
docker compose up -d --build

# 3. Verifikasi
curl http://localhost:4000/healthz
```

Server jalan di `http://localhost:4000` — Web UI admin di `/`, MCP endpoint di `/mcp`.

### Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `4000` | Port server |
| `DATA_DIR` | `./data` | Folder SQLite (di-mount ke volume di compose) |
| `ADMIN_USER` | `admin` | User web UI admin |
| `ADMIN_PASSWORD` | wajib | Password web UI admin (min 8 karakter) |
| `SESSION_SECRET` | auto | Secret JWT/enkripsi (auto-generate & persist jika kosong) |
| `QUERY_TIMEOUT_MS` | `30000` | Timeout query SQL |
| `RATE_LIMIT_PER_MIN` | `60` | Rate limit per API key |
| `OAUTH_ENABLED` | `1` | Nonaktifkan OAuth dengan `0` |
| `OAUTH_CODE_TTL_S` | `600` | Umur authorization code (detik) |
| `OAUTH_ACCESS_TTL_S` | `3600` | Umur access token (detik) |
| `OAUTH_REFRESH_TTL_S` | `2592000` | Umur refresh token (detik, 30 hari) |

## Alur Pakai

1. Login Web UI → menu **Koneksi DB** → isi host/port/user/pass/database + **Test Connection**.
   > Untuk container Docker, SQL Server di host bisa dipakai via `host.docker.internal`.
2. Menu **API Keys** → buat key (**tampil sekali**, simpan!).
3. Menu **Izin Tabel** → centang tabel yang boleh dibaca AI → **Simpan Izin**. Default deny.
4. Hubungkan AI agent ke `https://<domain>/mcp` + header `Authorization: Bearer <api-key>`.

### Menghubungkan MCP Client Generik

```json
{
  "mcpServers": {
    "sql-server": {
      "url": "https://<domain>/mcp",
      "headers": { "Authorization": "Bearer sk-xxxx" }
    }
  }
}
```

Test cepat dengan curl:

```bash
curl -X POST https://<domain>/mcp \
  -H "Authorization: Bearer sk-xxxx" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### Claude Custom Connector (claude.ai / Desktop)

1. Buka **Customize → Connectors → Add custom connector**.
2. **Remote MCP server URL**: `https://<domain>/mcp`.
3. **Advanced settings** → isi **OAuth Client ID + Secret** dari menu **OAuth Clients**
   (redirect URI: `https://claude.ai/api/mcp/auth_callback`).
   > Boleh dikosongkan — Claude otomatis mendaftar via *Dynamic Client Registration* (RFC 7591).
4. Klik **Add → Connect** → browser membuka halaman login operator → **Izinkan Akses**.
5. Claude menyimpan refresh token dan memanggil tool MCP dengan bearer token.

Claude Code (CLI):

```bash
claude mcp add mcp-sqlserv https://<domain>/mcp --transport http \
  ... # bila client pre-registered: --client-id <id> --client-secret --callback-port
```

### Endpoint OAuth

| Endpoint | Standard |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| `POST /oauth/register` | RFC 7591 (DCR, public + confidential) |
| `GET /oauth/authorize` (login operator + consent) | RFC 6749 + PKCE S256 |
| `POST /oauth/token` (code exchange + refresh rotation) | RFC 6749 / 7636 |
| `POST /oauth/revoke` | RFC 7009 |

Identitas OAuth = sesi operator. Access token memetakan ke API key internal `oauth:<client_id>` — seluruh izin tabel, rate limit, dan audit berlaku juga untuk koneksi Claude. Revoke client langsung mematikan semua token client tersebut.

## Tools MCP

| Tool | Fungsi |
|---|---|
| `list_tables` | Daftar tabel yang diizinkan + perkiraan jumlah baris |
| `get_table_schema` | Kolom, tipe, nullable, identity, primary key, indeks |
| `read_records` | Baca baris dengan filter terstruktur, order, pagination |
| `count_records` | Hitung baris dengan filter opsional |
| `get_record_by_pk` | Ambil 1 baris via primary key |
| `server_info` | Info server / database |

Nama tabel wajib **tanpa** prefix schema (`users`, bukan `dbo.users`). Kolom divalidasi terhadap `sys.columns`; nilai 100% bind parameter.

Filter terstruktur yang didukung: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `like`, `startsWith`, `endsWith`, `in`, `between`, `isNull`, `isNotNull`.

## Keamanan

- **Zero raw SQL** dari AI — hanya builder query terstruktur
- **Identifier allowlist** — regex + verifikasi metadata DB asli
- **Default deny** — tabel tanpa izin tidak bisa diakses
- **Limit keras** — maks 1000 baris/query, 20 filter, 50 nilai IN, timeout 30s
- **API key + rate limit** per key + audit log semua request
- **Read-only** — saran: user SQL Server cukup dengan `GRANT SELECT`
- Password DB tersimpan **terenkripsi AES-256-GCM** di SQLite

## Deployment

Deploy dengan Docker Compose di jaringan `app-network` bersama nginx sebagai reverse proxy (SSL wildcard, SSE non-buffered, CORS untuk MCP client web).

### Migrasi antar VPS

Kode dan Docker akan jalan otomatis di VPS mana pun, tetapi dua hal berikut **tidak ikut ke Git** (ada di `.gitignore`) dan harus dimigrasikan manual:

| Yang dipindahkan | Isinya | Cara |
|---|---|---|
| `.env` | Kredensial admin & secret | Salin file dari VPS lama, atau buat baru dari `.env.example` |
| `data/` | SQLite (API keys, izin, audit, koneksi DB) | `rsync` / salin folder dari VPS lama |

```bash
# Di VPS baru
git clone https://github.com/<username>/mcp-sqlserv.git && cd mcp-sqlserv

# Migrasi state dari VPS lama (opsional)
rsync -av vps-lama:/path/mcp-sqlserv/.env .env
rsync -av vps-lama:/path/mcp-sqlserv/data ./data

# Network eksternal harus ada dulu (dipakai docker-compose.yaml)
docker network create app-network   # abaikan jika sudah ada

docker compose up -d --build
```

> Tanpa migrasi `data/`, server tetap jalan — Anda hanya perlu setup ulang koneksi DB, API key, dan izin tabel dari Web UI.

## Struktur Proyek

```
mcp-sqlserv/
├── src/
│   ├── index.ts            # Bootstrap Express + routing
│   ├── config.ts           # Env config
│   ├── db/storage.ts       # SQLite: api_keys, db_config, permissions, audit_log
│   ├── sqlserver/          # Connection pool, metadata (sys.tables), query builder
│   ├── mcp/                # MCP server (per-session) + tools
│   ├── oauth/              # OAuth 2.1: router, PKCE, discovery
│   ├── api/                # REST admin (auth, config, keys, permissions, audit)
│   └── ui/                 # SPA vanilla JS (public/)
├── public/                 # Web UI admin (tanpa build step)
├── test/                   # Test suite keamanan + OAuth + smoke
├── Dockerfile              # Multi-stage build (node:20-alpine)
├── docker-compose.yaml     # Attach ke app-network, host.docker.internal
└── LICENSE                 # MIT
```

## API REST Admin

| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/auth/login` | Login admin (cookie httpOnly) |
| GET | `/api/status` | Status DB, key, permission |
| GET/PUT | `/api/config` | Baca / simpan konfigurasi DB |
| POST | `/api/config/test` | Test koneksi |
| GET/POST | `/api/keys` | List / buat API key |
| PUT/DELETE | `/api/keys/:id` | Rename / revoke |
| GET/PUT | `/api/permissions` | List / simpan izin tabel |
| GET | `/api/audit` | Audit log |
| GET | `/api/connect` | Info URL MCP + contoh config |
| GET | `/healthz` | Health check (tanpa auth) |

## Testing

```bash
npm run test:smoke      # smoke test dasar
npm run test:security   # 29 test: injection, permission, limit, pagination, auth
npm run test:oauth      # 46 test: discovery, DCR, PKCE, consent, token, refresh, revoke
```

`test/oauth.mjs` me-spawn server sendiri di port 4100 (data dir `oauth-test-data/`) — tidak butuh konfigurasi tambahan.

## Kontribusi

Kontribusi dipersilakan! Silakan buka issue atau pull request. Untuk perubahan besar, diskusikan dulu melalui issue agar sesuai dengan prinsip produk: *security is the product* — setiap permukaan (MCP, UI, Agent Test) harus mempertahankan standar yang sama: read-only, default-deny, parameterized.

## Lisensi

Proyek ini dilisensikan di bawah [MIT License](./LICENSE).
