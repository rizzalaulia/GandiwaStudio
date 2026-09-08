# Technology Contract — Gandiwa Studio

**Baseline:** `mvp-1.0`  
**Status:** LOCKED  
**Owner:** Master Peng  
**Last synchronized:** 8 September 2026

## Purpose

Dokumen ini adalah kontrak teknologi implementasi MVP. Pergantian framework, database, model antrean, atau batas browser/backend membutuhkan ADR dan persetujuan pemilik produk.

## Runtime Boundary

Gandiwa adalah aplikasi web local-first yang dibantu backend:

```text
Browser pengguna
├── React UI
├── File System Access API
├── preview dan editor SVG ringan
└── menulis project/artifact ke folder lokal
          │ HTTPS
          ▼
FastAPI pada bejo2-vnic
├── autentikasi dan secret
├── SQLite durable job queue
├── ruleset, sanitasi, audit, dan konversi
└── konektor API eksplisit
          ├── 9Router melalui Tailscale
          └── fal.ai melalui internet
```

Aplikasi tidak memiliki cloud sync bawaan. Cara pengguna menyinkronkan folder antarperangkat berada di luar produk dan di luar MVP.

## Frontend

| Area | Pilihan | Peran |
|---|---|---|
| Language | TypeScript strict | Kontrak tipe dan maintainability |
| UI runtime | React | Workspace dan komponen interaktif |
| Build | Vite | Development dan static production build |
| Routing | React Router | Navigasi client-side |
| Server state | TanStack Query | Health, provider, job, audit, dan artifact state |
| UI state | Zustand | Selected project/asset, panel, canvas, draft lokal |
| Styling | Tailwind CSS + CSS variables | Implementasi token `DESIGN.md` |
| Unit/component test | Vitest + Testing Library | Perilaku komponen dan hooks |
| Browser E2E | Playwright | File flow, job polling, dan export gate |

### Frontend Rules

- Production frontend adalah static asset; tidak ada Node server permanen.
- File System Access API ditargetkan untuk Chrome/Edge desktop terbaru.
- Path absolut tidak disimpan dalam manifest; hanya path relatif.
- Zustand tidak boleh menjadi cache data backend.
- Browser tidak boleh menerima provider API key.
- SVG tidak tepercaya tidak boleh dirender sebelum hasil sanitasi backend diterima.
- Browser adalah satu-satunya komponen yang boleh menulis ke directory handle pengguna.

## Backend

| Area | Pilihan | Peran |
|---|---|---|
| Language | Python 3.12 | Runtime API/worker |
| API | FastAPI | REST API dan schema OpenAPI |
| ASGI | Uvicorn | Proses API, satu worker process pada MVP |
| Validation | Pydantic v2 | Request/response/config contracts |
| Persistence | SQLAlchemy 2 | Akses SQLite eksplisit |
| Migration | Alembic | Schema migration terkontrol |
| HTTP client | httpx | 9Router/fal.ai/provider calls |
| Raster | Pillow | Decode, inspect, convert, dan export JPEG |
| SVG/XML | defusedxml + lxml | Parse dan sanitasi defensif |
| Test | pytest | Unit, integration, queue recovery, API tests |
| Quality | Ruff + mypy | Lint, format, dan static typing |

SVGO, Inkscape CLI, atau VTracer bukan dependency wajib awal. Penambahannya harus dibuktikan oleh fixture/acceptance test dan kompatibel ARM64.

## API Baseline

Seluruh route berversi di bawah `/api/v1`.

```text
GET  /api/v1/health
GET  /api/v1/ready
POST /api/v1/session
DELETE /api/v1/session
POST /api/v1/jobs
GET  /api/v1/jobs/{job_id}
POST /api/v1/jobs/{job_id}/cancel
GET  /api/v1/jobs/{job_id}/artifact
POST /api/v1/preflight
POST /api/v1/providers/{provider_id}/test
GET  /api/v1/providers/{provider_id}/models
POST /api/v1/export/validate
```

Kontrak rinci dibuat bersama test pada tahap implementasi terkait; daftar ini bukan janji endpoint yang sudah tersedia.

## Persistence

### Portable project data

`gandiwa-project.json` dan file relatif di folder proyek adalah source of truth data kreatif portabel:

```text
project/
├── gandiwa-project.json
├── sources/
├── generated/
├── revisions/
├── previews/
├── metadata/
├── reports/
└── exports/
```

### Backend state

SQLite menyimpan konfigurasi backend, capability cache, job runtime, ruleset runtime, audit execution, temporary artifact metadata, dan moderation feedback yang belum/harus direkonsiliasi.

Production database:

```text
/var/lib/gandiwa/gandiwa.sqlite3
```

Pragma minimum:

```text
foreign_keys = ON
journal_mode = WAL
busy_timeout = configured
```

SQLite tidak diletakkan di folder sinkronisasi pengguna dan tidak dijalankan melalui network filesystem.

## Durable Queue and Worker

Keputusan lengkap mengikuti [ADR-0001](adr/0001-sqlite-durable-job-queue.md).

- Queue: tabel SQLite durable.
- Worker: satu proses Python terpisah dari API.
- Concurrency: satu job aktif.
- Ordering: prioritas tertinggi, lalu FIFO berdasarkan `created_at`.
- Recovery: lease + heartbeat; unknown provider dispatch masuk `needs_review`, bukan retry otomatis.
- Progress transport MVP: REST polling melalui TanStack Query.
- Cancellation: cooperative cancellation pada safe checkpoint.
- Retry: hanya operasi aman/idempotent; generation dispatch tidak diulang buta.
- Provider request ID disimpan segera untuk mencegah biaya/generasi ganda.
- Redis, Celery, RabbitMQ, Kafka, SSE, dan WebSocket berada di luar baseline MVP.

## Provider Contract

Konektor wajib MVP:

1. 9Router connector yang endpoint-nya dikonfigurasi operator; pengguna memilih connector dan model/combo secara eksplisit.
2. fal.ai untuk generation workflow yang dipilih eksplisit pengguna.

Gandiwa tidak memilih provider secara otomatis, tidak melakukan fallback, load balancing, cost routing, atau combo ordering. Jika 9Router melakukan routing internal, perilaku tersebut tetap berada di luar Gandiwa.

### Endpoint and SSRF policy

- Endpoint provider dikonfigurasi hanya oleh pemilik deployment pada backend, bukan oleh request/browser umum.
- fal.ai memakai origin HTTPS resmi yang di-allowlist.
- 9Router mendapat pengecualian sempit untuk hostname/IP Tailscale dan port yang ditetapkan operator.
- Tolak scheme non-HTTP(S), userinfo pada URL, loopback, link-local, multicast, cloud metadata, Unix socket, serta private CIDR lain secara default.
- Resolve dan validasi alamat tujuan sebelum koneksi; redirect lintas-origin dinonaktifkan. Authorization/secret terikat pada connector + origin dan tidak pernah diteruskan ke host hasil redirect.
- Setiap job membekukan `provider_id` (configured connector), `model_id`, dan origin tervalidasi; UI preference hanya prefill yang harus dikonfirmasi pengguna.

CI menggunakan fake provider server dan fixture sintetis. Test nyata provider adalah smoke test manual yang memerlukan credential backend serta tidak dijalankan pada pull request publik.

## Authentication and Secrets

- Deployment non-local menggunakan same-origin HTTPS dan secure server-side session.
- Tailscale dan CORS adalah lapisan jaringan/origin, bukan pengganti autentikasi aplikasi.
- State-changing request wajib memiliki perlindungan CSRF yang sesuai.
- BYOK pada MVP berarti pemilik deployment memasang provider key pada backend secret file/environment.
- Browser tidak menyediakan form key, tidak menerima key dari backend, dan tidak menyimpan key dalam storage apa pun.
- API hanya mengembalikan status konfigurasi/capability yang tidak dapat dipakai untuk merekonstruksi secret.
- Log meredaksi Authorization, cookie, token, key, prompt/asset sensitif sesuai kebijakan.
- Production secret file: `/etc/gandiwa/gandiwa.env`, placeholder saja di repository.

## Production Processes

```text
Nginx host
├── static frontend
└── /api/ → 127.0.0.1:8010

Docker Compose
├── api      (same application image)
└── worker   (same application image, concurrency 1)

Persistent host paths
├── /var/lib/gandiwa
└── /var/cache/gandiwa/artifacts
```

## Explicit Non-Choices for MVP

- PostgreSQL or MySQL;
- Redis/Celery;
- Kubernetes;
- Node production server;
- model AI lokal/GPU inference;
- multi-user tenancy;
- built-in cloud storage or sync;
- automatic Adobe upload;
- Gandiwa-owned AI routing/fallback.

## Quality Gates

Minimum sebelum merge:

```text
Frontend: typecheck + lint + unit/component tests + production build
Backend : Ruff + mypy + pytest + Alembic migration check
Repo    : verify_repository.py + Markdown links + secret scan + git diff --check
E2E     : Playwright untuk acceptance flow yang berubah
```

Tidak boleh mengklaim runtime atau deployment berhasil hanya karena dokumen/CI lint lulus.