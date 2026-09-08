# ADR-0001: SQLite Durable Queue dengan Satu Worker

- **Status:** Accepted
- **Date:** 2026-09-08
- **Decision owner:** Master Peng

## Context

Gandiwa menjalankan pekerjaan berdurasi panjang: panggilan 9Router/fal.ai, polling provider, sanitasi SVG, audit, serta konversi raster. Menjalankannya di dalam request FastAPI dapat menyebabkan timeout dan kehilangan state ketika proses restart. MVP bersifat single-user, berjalan pada satu host, dan telah menetapkan SQLite sebagai runtime job store.

## Decision

MVP menggunakan SQLite sebagai durable job queue dan satu proses worker terpisah dari FastAPI.

- API memvalidasi request, membuat ruleset snapshot, menyimpan job `QUEUED`, lalu segera mengembalikan `job_id`.
- Worker mengambil satu job secara FIFO dengan prioritas, memasang lease, dan memperbarui heartbeat.
- State minimum: `QUEUED`, `RUNNING`, `WAITING_PROVIDER`, `PROCESSING`, `NEEDS_REVIEW`, `SUCCEEDED`, `FAILED`, `CANCELLED`. `NEEDS_REVIEW` dipakai ketika provider mungkin telah menerima request tetapi hasil dispatch belum dapat dibuktikan.
- Claim job dilakukan dalam transaksi singkat; transaksi tidak ditahan saat menunggu provider.
- `remote_job_id` disimpan segera agar restart worker melanjutkan polling dan tidak mendispatch job berbayar dua kali.
- Retry hanya dilakukan jika aman/idempotent. Retry buta untuk generation request dilarang.
- Cancel memakai `cancel_requested_at`; worker menghentikan pekerjaan pada safe checkpoint dan meneruskan cancel ke provider jika didukung.
- Browser memperoleh status melalui polling REST pada MVP; WebSocket/SSE ditunda.
- Artifact sementara disimpan backend sampai diambil browser atau melewati retention period. Browser tetap menjadi pemilik folder proyek lokal.

## Queue Record Minimum

`id`, `job_type`, `status`, `priority`, `provider_id`, `model_id`, `ruleset_snapshot_id`, `parameters`, `attempt_count`, `remote_job_id`, `lease_owner`, `lease_expires_at`, `heartbeat_at`, `cancel_requested_at`, timestamps, `error_code`, `redacted_error`, dan `result_manifest`.

## Alternatives Considered

### In-memory FastAPI background task

Ditolak karena job hilang ketika proses restart, tidak memiliki recovery/lease yang andal, dan lifecycle-nya terikat proses API.

### Celery + Redis

Ditunda karena menambah broker, dependency, proses, operasi, dan konsumsi resource yang belum diperlukan oleh MVP single-user. Ini dapat ditinjau ulang bila satu host/satu worker tidak lagi cukup.

### Browser-only queue

Ditolak karena job berhenti ketika tab/browser ditutup, credential tidak boleh berada di browser, dan proses provider berbayar membutuhkan recovery server-side.

## Consequences

### Positive

- Queue bertahan dari restart API/worker.
- Tidak membutuhkan Redis atau layanan eksternal.
- Satu worker mencegah lonjakan RAM, CPU, quota, dan biaya.
- Job dan remote provider request dapat ditelusuri.

### Negative

- Throughput dibatasi satu job aktif.
- SQLite bukan pilihan untuk banyak host atau banyak writer berkonkurensi tinggi.
- Worker memerlukan polling database dengan interval terkontrol.

## Operational Defaults

- Worker concurrency: `1`.
- Claim order: prioritas tertinggi, lalu `created_at` tertua.
- SQLite mode: WAL dengan `busy_timeout`.
- Claim memakai transaksi singkat (`BEGIN IMMEDIATE` atau padanannya).
- Heartbeat dan lease duration menjadi konfigurasi, bukan konstanta tersembunyi.
- Job dengan lease kedaluwarsa masuk recovery; generation request tidak boleh didispatch ulang bila status penerimaan provider belum dapat dibuktikan.
- Artifact sementara memiliki TTL dan pembersihan berkala.

## Revisit Triggers

Keputusan ditinjau ulang jika salah satu terjadi:

- kebutuhan lebih dari satu worker aktif;
- deployment multi-host;
- antrean sustained panjang dan menghambat penggunaan;
- SQLite lock contention terukur;
- kebutuhan scheduled/recurrent jobs kompleks;
- durability atau observability yang diperlukan melampaui kemampuan implementasi ini.

Migrasi kelak harus mempertahankan kontrak job/status/idempotency; pilihan broker baru tidak boleh mengubah perilaku produk tanpa ADR baru.
