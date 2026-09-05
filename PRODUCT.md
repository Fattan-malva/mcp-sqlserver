# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase: Node.js + TypeScript + Express (MCP Streamable HTTP + REST admin) with vanilla JS single-page UI. `[inferred: keep incumbent stack — user said “lanjut” without stack preference; the project already runs this stack in production]`

## Users

Admin / developer self-hosting **mcp-sqlserv** — operator yang mengelola MCP server SQL Server read-only untuk dipakai AI agent lain (misal project AI chat berbasis Ollama di masa depan). Durasi: sesi singkat; pekerjaan: konfigurasi koneksi DB, buat/revoke API key, atur izin tabel, pantau audit, uji agent langsung dari web UI. `[confirmed: user built this tool sendiri untuk dipakai AI agent lain; stated in original request]`

## Product Purpose

Memberi AI agent akses **baca** yang aman & terkontrol ke database SQL Server lewat MCP, dengan web UI sebagai pusat kontrol: konfigurasi koneksi, kredensial API key, izin per-tabel (default deny), audit penuh, dan — baru — mode **Agent Test**: chat langsung dengan model Ollama Cloud (API key dari ollama.com/settings/keys diinput user) yang memakai tool MCP yang sama untuk membuktikan agent bisa menjawab dari data nyata.

## Positioning

Satu-satunya jalur baca database SQL Server untuk AI yang benar-benar **anti-injection by construction**: zero raw SQL, identifier allowlist terhadap metadata asli DB, bind parameter penuh — dikelola lewat panel web sederhana, dan bisa dibuktikan lewat chat agent bawaan.

## Operating Context

- Server di Docker Compose di `~/MCP/mcp-sqlserv`, port 4000, jaringan `app-network` bersama nginx; subdomain `mcp-sqlserv.mallvaa.xyz` (Cloudflare + wildcard SSL).
- SQL Server 2022 di `host.docker.internal:1433` (container), DB produksi lokal: POS_DB dll.
- Admin login: `ADMIN_USER`/`ADMIN_PASSWORD` dari env; password DB disimpan terenkripsi AES-256-GCM di SQLite (`data/app.db`).
- MCP endpoint publik `/mcp` butuh `Authorization: Bearer <api-key>`; 60 req/menit per key; audit semua request.
- Agent Test: key Ollama Cloud disimpan **in-memory server (per sesi admin), tidak dipersist** — hilang saat server restart. `[inferred: pilihan keamanan paling konservatif; sebutkan di UI]`

## Capabilities and Constraints

- 6 tool MCP: list_tables, get_table_schema, read_records, count_records, get_record_by_pk, server_info.
- Izin tabel per tabel (allow_read / allow_schema), default deny.
- Batas keras: 1000 baris/query, 20 filter, 50 nilai IN, timeout 30s, rate limit.
- Agent Test: model Ollama Cloud (nama model cloud diinput user, default gpt-oss:120b, host https://ollama.com), streaming SSE, function calling memakai tool yang sama seperti MCP, max 12 iterasi tool per putaran, history per sesi admin.
- Konstrain teknis: SPA vanilla tanpa build step; tidak ada token Cloudflare untuk purge cache (pakai cache-busting `?v=`); audit log wajib untuk semua akses data.

## Brand Commitments

Nama produk: **mcp-sqlserv**. Tidak ada aset brand lain yang mengikat. Bahasa UI: Indonesia (copy admin), kecuali label teknis Inggris.

## Evidence on Hand

- 29/29 test keamanan lulus (`test/security.mjs`).
- Produksi live: `https://mcp-sqlserv.mallvaa.xyz` (UI, /mcp, API) — verifikasi end-to-end via curl + MCP client SDK + headless browser.
- Data nyata: POS_DB (Category, Item, Supplier, Purchase diizinkan; AuditLog metadata-only).

## Product Principles

1. **Security is the product** — every surface (MCP, UI, Agent Test) must hold the same read-only, default-deny, parameterized-standard.
2. **One tool path** — agent chat, MCP client, dan curl mengeksekusi kode tool yang sama; tidak ada jalur bypass.
3. **Everything visible** — koneksi, key, izin, dan setiap query yang AI lakukan tercatat dan terlihat di UI.
4. **Operator gets proof** — fitur harus menunjukkan cara kerja yang nyata (test connection, audit, agent test) bukan klaim.
5. **Standalone by design** — tool ini tidak terikat ke satu MCP client; URL + API key cukup untuk integrasi apa pun.

## Accessibility & Inclusion

- UI operasi admin berbahasa Indonesia; kontras tinggi (dark theme), fokus yang jelas, navigasi keyboard untuk form. `[inferred: standar praktik umum; tidak ada kebutuhan khusus yang dilaporkan]`