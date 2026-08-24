# Design — mcp-sqlserv "Slide Spekimen"

> Dokumenter dari dunia jadi (build `v=20260818-6`, seed dfe7e427, code-led).
> Ditulis pasca-review dari render asli — ground truth, bukan niat.

## Direction Contract

THESIS: database diperlakukan sebagai spesimen di meja lab — satu plafond gelap benchtop, slide kaca berisi grid pemeriksaan, dan Agent Test adalah probe pertama yang menarik "benang" dari data. Menolak form dashboard SaaS generik (kartu ikon + label).

## Tokens (usable, dihitung dari built world)

- `--ink #0a0d12` (benchtop), `--panel/--panel-2 #10151f/#131a27`, `--plate #111725` (slide kaca asap), `--line #223044`, `--line-2 #2c3c55` (hairline micrometer).
- `--bone #e8edf6` · `--sub #93a1b6` · `--faint #8496b1` (ikon engrave; kontras ≥4.5:1 — dinaikkan dari #5d6c84 saat review).
- Aksen reagent (satu per peran, tidak pernah bercampur tanpa alasan): `--cyan #4ed6ff` = baca/suhu-hidup (primary, focus, toggle on, nav active), `--mint #43f2a5` = sehat/OK, `--amber #ffb45c` = waspada/belum dikonfigurasi, `--rose #ff7d9c` = gagal/revoke, `--violet #b39dff` = agent/probe (idle).
- Warna adalah fungsi status, bukan dekorasi: LED, chip koneksi, badge, border bubble chat, probe item — semua dari peta ini.

## Type

- Display + UI: **IBM Plex Sans** (400/500/600/700). Dipilih setelah detector menolak Space Grotesk/Inter sebagai wajah konvergensi; IBM Plex membawa garis keturunan mainframe—dokumentasi instrumen.
- Data/label/engkau: **IBM Plex Mono** (400/500/600). Mono dipakai untuk data, angka tabular, label kapital 9–11px `letter-spacing .12em–.22em`, timestamp, args probe.
- Body measure ≤62ch; judul display ≤32px (clamp 24–32); tracking heading −0.015em.

## Komponen (dari dunia jadi)

- **Slide/plate**: panel `--plate` + hairline 1px + `box-shadow` offset (0 20px 44px −20px, inset highlight atas) + grid spesimen halus via `::before` (repeating-linear 24px, mask 65%). Pacar tidak pernah kartu-kartu sama-setengahnya: plate dipakai untuk form, thread, rail, table-wrap; dashboards memakai card dengan garis 2px pita status atas.
- **Plate-cap**: kapsul mono kapital 10px + border-bottom hairline — label plak terukir, selalu di puncak plate; index/counter kanan (`cap-led`).
- **LED**: 7px bulat + glow; variasi id Danger OK/WARN/BAD/ON/IDLE; `breathe` 2.6s untuk OK.
- **Button**: primer = cyan flat teks ink `#04131d` + glow 22px; ghost = hairline transparan; danger = rose outline; kecil untuk aksi deret. Radius 9px, no shadow keras.
- **Field**: well `--ink-2` + hairline; focus = border cyan + ring 3px 12% alpha; caret cyan; selection cyan 32%.
- **Toggle izin**: 36×20 track pill, knob 14px; on = cyan + glow; hanya dipakai untuk izin.
- **Badge**: pill mono kapital 9.5px; ok/warn/bad/cyn.
- **Chat**: bubble plate max 86%/660px; user = cyan-border kiri kanan (label ANDA cyan), agent = violet (label AGENT), error = rose; toolchip pill + mono dengan ikon ✓/✕ + rows + ms + args tooltip; caret blink violet saat streaming; composer plate dengan snips prompt; probe rail: session plate (kv-model/key/status + reset/hapus) + probe log plate (item #indeks, tool, rows, ms, args ellipsis).
- **Browser surfaces**: scrollbar 10px thin #26344c on ink; selection cyan; focus ring cyan 2px offset 2; color-scheme dark.

## Layout & Responsive

- Shell: grid `236px 1fr`; rack sticky 100vh: brand (glyph ◈ cyan glow), group INSTRUMEN, nav 7 item (icon glyph mono, index 01–07), footer user + keluar.
- Main: topbar sticky (mono 11px title uppercase + conn-chip LED + v1.0) + scroll area; view max 1120px, padding 30/28/60.
- Dashboard: `repeat(4,1fr)` cards @980→2 kolom @720→1.
- Agent: `minmax(0,1fr) 304px`, tinggi `calc(100dvh − 158px)`; thread flex-1 scroll dalam; @980 → 1 kolom, thread `flex:none; height:62dvh; min-height:320px`, rail stack di bawah (session + log wrap).
- Login: bench 460px, slide tunggal tengah; @720 92% lebar, top-aligned 9vh (+ safe-area).
- @980: sidebar 236→208px; agent 1 kolom (thread 62dvh, rail stack di bawah).
- Mobile ≤720: **rack jadi drawer off-canvas** (pola sidebar iOS) — fixed kiri, lebar `min(304px, 86vw)`, slide-in `cubic-bezier(0.32,0.72,0.25,1)` 0.28s + scrim blur (fade 0.24s); dibuka dari hamburger `.nav-toggle` di topbar, ditutup via tombol ✕ di rack-brand, tap scrim, swipe-left ≥56px di dalam drawer, Escape, atau memilih item nav (route otomatis menutup). Body di-lock (`body.nav-open`) saat terbuka; drawer `visibility:hidden` saat tertutup agar tidak tabbable. Footer user + sign out tetap tampil di dalam drawer; `.nav-idx` dipertahankan.
- iOS: `viewport-fit=cover` + `env(safe-area-inset-*)` pada topbar/view/drawer/login/modal; input & textarea ≥16px di mobile (anti zoom-on-focus); `-webkit-tap-highlight-color: transparent`; momentum scroll di area scroll; modal jadi bottom sheet (radius atas, max-height dvh − notch); fallback `vh` sebelum `dvh`.

## Gerak (satu momen utama)

- `rise` 0.22s ease-out pada bubble & probe item (masuknya pesan = tarikan benang).
- Caret blink steps(1) saat streaming; LED breathe 2.6s; transisi state (hover/press/toggle) 0.13–0.2s ease — tidak ada animasi lain; reduced-motion tidak diperlukan karena tidak ada gerak persisten selain kedua tersebut (LED breathe dihentikan otomatis? belum — catatan perbaikan berikutnya).

## Copy

Bahasa Indonesia; label teknis kapital mono; kesalahan menyebut masalah + perbaikan ("Cek di Google AI Studio lalu simpan ulang"); notifikasi key sekali tampil (amber), semua akses direkam (repeat: "tercatat di audit log").

## Verdict / finish state

- Builder check satu putaran batch: flow 4 card + conn-chip OK, nav 7/7 VISIBLE, agent-flow 12/12 PASS, layout audit D+M zero overflow & thread 523px mobile, detector `[]` (mode degraded, regex) setelah swap font & em-dash, kontras faint 5.95:1 panel.
- Image review: model tanpa input gambar — inspeksi visual digantikan programmatik (metric + DOM + tokens), screenshot disimpan ke `.impeccable/review/` untuk manusia.
- Reviewer agent & documenter agent tidak tersedia di harness ini → jalur degraded; DESIGN.md ini ditulis berdasar render asli.
- Yang belum ditutup: `prefers-reduced-motion` untuk LED breathe; dokumentasi nginx queue max-age 86400 untuk index (sudah no-store); bump versi cache diperlukan tiap ubah aset.