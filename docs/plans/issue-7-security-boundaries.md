# Implementation Plan - Issue #7: Harden Connector URL, Session, CSRF, and Artifact Boundaries

Mengimplementasikan fondasi keamanan (security baseline) untuk Gandiwa Studio API sesuai spesifikasi Issue #7 dan dokumen arsitektur `docs/ARCHITECTURE.md` serta `docs/TECHNOLOGY.md`.

## User Review Required

> [!IMPORTANT]
> Pekerjaan dilakukan pada branch lokal `feat/issue-7-security-boundaries`. Setiap commit dan push dijalankan hanya atas perintah eksplisit pemegang keputusan.

> [!NOTE]
> **Pengecualian sempit 9Router Tailscale:** Tailscale memakai CGNAT
> `100.64.0.0/10`. Hanya base URL backend `NINEROUTER_BASE_URL` yang memakai
> HTTP, tepat pada path `/v1`, dan seluruh resolusi DNS-nya berada pada rentang
> itu yang dapat dianggap valid. Tidak ada target lokal/private yang diberi
> pengecualian. Semua `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
> loopback, link-local, dan metadata cloud ditolak.

> [!NOTE]
> Issue ini belum memiliki provider dispatch/outbound request. Karena itu
> validasi di sini adalah fondasi konfigurasi connector, bukan klaim bahwa
> request provider sudah berjalan. Issue yang menambahkan dispatch wajib
> menggunakan validator connector ini sebelum membuka koneksi.

---

## Proposed Changes

### Backend Security Foundation (`apps/api/src/gandiwa_api/security/`)

#### [NEW] ssrf.py
- **URL & Scheme Validation**: hanya `https` untuk fal; `http` hanya untuk 9Router Tailscale yang tepat pada base path `/v1`. Tidak ada pengecualian host lokal/private. Menolak `file://`, `gopher://`, `ftp://`, dsb.
- **Userinfo Rejection**: Menolak URL yang mengandung kredensial (`http://user:pass@host`).
- **IP & DNS Resolution Guard**:
  - Resolve domain ke daftar IP via DNS.
  - Memblokir loopback (`127.0.0.0/8`, `::1`, `localhost`).
  - Memblokir link-local (`169.254.0.0/16`, `fe80::/10`).
  - Memblokir cloud metadata service (`169.254.169.254`, `metadata.google.internal`).
  - Memblokir private CIDR (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`).
  - Pengecualian sempit (Narrow Tailscale Exception): Hanya mengizinkan alamat IP Tailscale (`100.64.0.0/10`) jika dan hanya jika host/IP tersebut cocok dengan backend-configured `NINEROUTER_BASE_URL`.
- **Redirect Boundary**: Redirect lintas-origin ditolak pada helper validasi. Tidak ada HTTP client atau provider dispatch pada Issue ini; saat dispatch ditambahkan, ia wajib menonaktifkan redirect otomatis serta memvalidasi target sebelum koneksi.

#### [NEW] csrf.py
- **CSRF Protection & Token Contract**:
  - Metode aman (`GET`, `HEAD`, `OPTIONS`) tidak memerlukan CSRF token.
  - Metode pengubah status (*state-changing*: `POST`, `PUT`, `PATCH`, `DELETE`) mewajibkan token CSRF yang valid (via header `X-CSRF-Token` yang dicocokkan dengan cookie terenkripsi/HMAC `gandiwa_csrf`).
  - Request tanpa token atau dengan token yang tidak cocok ditolak dengan `403 Forbidden`.
- **Session & Cookie Hardening**:
  - Konfigurasi cookie flag: `HttpOnly=True` untuk session cookie, `SameSite=Lax`, dan `Secure` dikontrol via setting `GANDIWA_SECURE_COOKIES`.
  - Endpoint utilitas `/api/v1/auth/csrf` untuk inisialisasi cookie/token frontend.

#### [NEW] artifacts.py
- **Artifact Boundary & Isolation**:
  - Mencegah Path Traversal: Path file dipastikan berada di dalam `ARTIFACT_DIR` melalui `Path.resolve()`.
  - Penolakan Inline SVG: File SVG mentah **tidak pernah** disajikan dengan `Content-Disposition: inline`.
  - Download aman mewajibkan header:
    - `Content-Disposition: attachment; filename="..."`
    - `X-Content-Type-Options: nosniff`

---

### Configuration & Main Application Integration

#### [MODIFY] config.py
- Menambahkan konfigurasi keamanan:
  - `GANDIWA_ENV: str = "development"`
  - `GANDIWA_SESSION_SECRET: str = "change-me-for-local-development"`
  - `GANDIWA_SECURE_COOKIES: bool = False`
  - `GANDIWA_ALLOWED_ORIGINS: list[str] = ["http://localhost:5173"]`
  - `NINEROUTER_BASE_URL: str | None = None`
  - `FAL_BASE_URL: str = "https://queue.fal.run"`

#### [MODIFY] main.py
- Mendaftarkan middleware CSRF dan security headers ke FastAPI application.
- Menambahkan route `/api/v1/providers`:
  - Mengembalikan daftar provider yang aktif/terkonfigurasi (`id`, `name`, `configured`).
  - Tidak mengekspos API key / secrets ke browser.
  - Browser tidak dapat mengirim arbitrary target URL (hanya memilih provider yang ada di backend).
- Menambahkan route `/api/v1/artifacts/{filename}/download`:
  - Menolak anonymous request (`401`) sampai bootstrap identity/session resmi tersedia.
  - Untuk sesi yang valid, mengunduh artifact dengan proteksi traversal, header `attachment`, dan `nosniff`.

---

### Executable Test Suites (`apps/api/tests/`)

#### [NEW] test_ssrf_boundary.py
- Uji penolakan scheme ilegal (`file://`, `ftp://`).
- Uji penolakan userinfo (`http://admin:secret@host`).
- Uji penolakan loopback (`127.0.0.1`, `localhost`, `::1`).
- Uji penolakan link-local dan metadata (`169.254.169.254`).
- Uji penolakan unsafe private CIDRs (`10.x`, `192.168.x`, `172.16.x`).
- Uji penerimaan target Tailscale yang dikonfigurasi di `100.64.0.0/10` untuk 9Router.
- Uji penolakan cross-origin redirect.
- Uji bahwa API provider menolak URL sembarang dari client.

#### [NEW] test_csrf_session.py
- Uji metode `GET` lolos tanpa token CSRF.
- Uji `POST`/`PUT`/`DELETE` tanpa token CSRF menghasilkan `403 Forbidden`.
- Uji `POST` dengan token CSRF valid berhasil.
- Uji flags cookie session (`HttpOnly`, `SameSite`, `Secure`).

#### [NEW] test_artifact_boundary.py
- Uji percobaan path traversal (misal: `../../etc/passwd` atau `..\..\windows`) menghasilkan `404` atau `400`.
- Uji unduhan file SVG menyertakan `Content-Disposition: attachment` dan `X-Content-Type-Options: nosniff`.
- Uji bahwa SVG tidak pernah disajikan inline.

---

## Verification Plan

### Automated Tests
1. Menjalankan seluruh test suite API:
   ```powershell
   uv run pytest
   ```
2. Menjalankan linter dan typechecker:
   ```powershell
   uv run ruff check .
   uv run mypy src
   ```

### Manual / Sanity Checks
- Memastikan test baseline sebelumnya (35 passed, 1 skipped on Windows) tetap lulus 100%.
- Memastikan tidak ada file secret atau credential yang ter-expose.
- Melaporkan `git status` dan `git diff --stat` ke pengguna tanpa melakukan commit/push yang tidak diinstruksikan.
