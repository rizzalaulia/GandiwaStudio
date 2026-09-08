# Urutan Pengembangan Terkunci — Gandiwa Studio

**Baseline:** `mvp-1.0`  
**Status:** ACUAN WAJIB / LOCKED  
**Pemilik keputusan:** Master Peng  
**Terakhir ditetapkan:** 8 September 2026

## 1. Tujuan Dokumen

Dokumen ini menetapkan urutan kerja resmi Gandiwa Studio. Ia menjawab pertanyaan: **fitur mana yang harus diselesaikan lebih dahulu sebelum fitur berikutnya boleh dimulai?**

Urutan ini tidak boleh dilompati hanya karena fitur tahap berikutnya lebih menarik atau mudah dibuat. Perubahan urutan memerlukan change request tertulis, alasan, dampak, pembaruan dokumen terkait, dan persetujuan pemilik produk.

## 2. Prinsip Gerbang

- Dokumen produk, repository open-source, dan baseline MVP sudah tersedia.
- Pekerjaan berjalan per tahap, bukan membangun semua modul secara paralel.
- Tahap berikutnya dimulai hanya setelah acceptance gate tahap sebelumnya lulus.
- Setiap perilaku baru mengikuti TDD: failing test → implementasi minimum → seluruh test lulus.
- Source asli tidak ditimpa dan secret tidak pernah masuk frontend, manifest, artifact, atau log.
- Gandiwa adalah API client/orchestrator. Ia tidak membuat router, fallback, load balancing, atau pemilihan provider otomatis.
- Commit, push, PR, dan merge mengikuti gerbang persetujuan manusia yang berlaku.

## 3. Urutan Pengembangan Resmi

```text
TAHAP 1 — Aplikasi bisa dibuka
TAHAP 2 — Bisa membuat dan membuka proyek
TAHAP 3 — Bisa mengimpor dan memeriksa file
TAHAP 4 — Bisa menyiapkan dan mengekspor file Adobe-ready
TAHAP 5 — Bisa generate melalui API pilihan pengguna
TAHAP 6 — Bisa mengedit vector secara ringan
TAHAP 7 — Uji MVP end-to-end
```

## 4. Tahap dan Acceptance Gate

### Tahap 1 — Aplikasi Dasar Hidup

**Tujuan:** menyediakan fondasi frontend–backend yang benar-benar dapat dijalankan dan dilihat pengguna.

**Cakupan:**

- scaffold monorepo untuk `apps/web`, `apps/api`, dan shared packages;
- React + TypeScript + Vite;
- Python 3.12 + FastAPI dan SQLite/Alembic foundation;
- proses API dan worker terpisah dengan health/readiness nyata;
- koneksi frontend ke health endpoint backend;
- konfigurasi development tanpa secret;
- kontrak security foundation: session/CSRF boundary, connector allowlist/SSRF guard, dan artifact download isolation;
- perintah development dan test yang terdokumentasi;
- CI frontend/backend dasar.

**Hasil terlihat:** halaman Gandiwa Studio menampilkan Create Project, Open Project, versi MVP, dan status backend.

**Gate lulus:**

- web app dapat dibuka melalui port forwarding VS Code Remote SSH;
- health dan readiness endpoint menjawab berdasarkan kondisi nyata;
- proses worker dapat dijalankan terpisah dan statusnya terlihat tanpa menjalankan job provider;
- UI menampilkan status backend/worker berdasarkan request nyata, bukan hard-coded;
- test, lint, build, dan repository verification lulus;
- tidak ada fitur generate palsu.

### Tahap 2 — Pengelolaan Proyek

**Tujuan:** semua artifact memiliki rumah dan identitas yang stabil sebelum audit atau generasi dibuat.

**Cakupan:**

- Create Project dan Open Project;
- File System Access API;
- nama proyek;
- pilihan `Photo`, `Illustration`, atau `Vector`;
- pilihan creation method;
- struktur folder proyek;
- manifest `gandiwa-project.json` sebagai source of truth;
- validasi, save, close, dan reopen project.

**Gate lulus:**

- proyek dapat dibuat pada folder pilihan pengguna;
- manifest valid dapat ditulis dan dibaca kembali secara identik;
- pembatalan/penolakan izin folder ditangani tanpa project parsial;
- content type tidak dapat diubah diam-diam setelah asset dibuat;
- SQLite dapat dibangun ulang sebagai cache/index dari manifest.

### Tahap 3 — Import dan Pemeriksaan Adobe

**Tujuan:** membuktikan kesaktian inti Gandiwa tanpa bergantung API berbayar.

**Cakupan:**

- import PNG, JPEG, dan SVG;
- MIME/extension validation;
- ruleset snapshot;
- raster checks: decode, dimensi, megapiksel, alpha, dan submission eligibility;
- SVG sanitization dan checks untuk raster embedded, active content, external resource, live text, viewBox, broken reference, serta empty path;
- tampilan PASS/WARNING/FAIL beserta rule ID dan evidence.

**Gate lulus:**

- seluruh fixture minimum `ADOBE-RULESET.md` lulus;
- blocking FAIL mencegah kelanjutan ke Adobe-ready;
- SVG berbahaya ditolak sebelum preview;
- PNG Photo dikenali sebagai working/master, bukan submission final;
- hasil audit terikat pada revision, ruleset, dan checksum.

### Tahap 4 — Persiapan, Metadata, Approval, dan Export

**Tujuan:** menghasilkan paket yang dapat ditinjau dan diunggah manual.

**Cakupan:**

- konversi raster working/master ke JPEG submission;
- minimum 4 MP gate;
- title, keywords, category, content type, creation method, AI disclosure, dan release status;
- human confirmation;
- approval terikat revision/audit/ruleset/checksum;
- status `ADOBE_READY`;
- export package berisi final asset, metadata, audit report, dan manifest.

**Gate lulus:**

- export diblokir jika syarat belum lengkap;
- edit artwork atau metadata relevan mencabut approval dan `ADOBE_READY`;
- paket dapat diekspor dan diperiksa ulang;
- `ADOBE_READY` ditampilkan sebagai hasil checks, bukan jaminan diterima Adobe.

### Tahap 5 — Generasi melalui API

**Tujuan:** memasukkan hasil AI ke pipeline yang sudah terbukti, bukan membuat pipeline bergantung kepada AI.

**Cakupan:**

- konektor wajib 9Router dan fal.ai;
- pengguna memilih connector backend yang sudah dikonfigurasi dan model secara eksplisit;
- test connection dan capability validation;
- brief dan immutable ruleset constraints;
- provenance: provider, model/revision jika tersedia, adapter version, prompt, seed, parameter, dan ruleset snapshot;
- artifact hasil generate otomatis masuk ke revision/audit pipeline.

**Gate lulus:**

- satu job 9Router dan satu job fal.ai berhasil end-to-end dengan credential backend yang tidak pernah dikomit atau dikirim ke browser;
- kegagalan auth, quota, timeout, dan hasil invalid ditangani;
- Gandiwa tidak menjalankan routing/fallback lintas-provider;
- generate tidak dapat dijalankan tanpa content type, creation method, connector/model eksplisit, capability match, dan ruleset snapshot;
- hasil tidak dapat melewati audit/export gate.

### Tahap 6 — Editor SVG Ringan

**Tujuan:** memperbaiki vector sederhana tanpa mencoba menggantikan Illustrator/Inkscape.

**Cakupan:**

- select, move, resize, recolor;
- reorder, hide/show, delete;
- zoom, pan, checkerboard;
- undo/redo;
- revisi non-destruktif;
- preview-only untuk dokumen melewati ambang aman;
- export ke editor eksternal untuk operasi di luar cakupan.

**Gate lulus:**

- operasi editor memiliki regression test;
- source tidak ditimpa;
- setiap perubahan menghasilkan revision/checksum baru;
- audit dan approval lama otomatis stale;
- file setelah edit dapat disanitasi, dirender, dan diaudit ulang.

### Tahap 7 — Verifikasi MVP End-to-End

**Tujuan:** membuktikan seluruh kontrak `mvp-1.0` pada alur nyata.

**Skenario wajib:**

- satu Photo dari generate/import sampai JPEG Adobe-ready dan export;
- satu Illustration raster sampai JPEG Adobe-ready dan export;
- satu Vector sampai SVG Adobe-ready, edit ringan, audit ulang, dan export;
- failure scenarios untuk folder permission, provider failure, invalid file, blocking rule, stale approval, dan interrupted job.

**Gate lulus:**

- seluruh Definition of Done PRD lulus;
- test, lint, type-check, build, dan security/secret scan lulus;
- project dapat ditutup dan dibuka kembali tanpa kehilangan state;
- dokumentasi install, development, operasi, dan keterbatasan sesuai perilaku nyata;
- belum ada klaim fitur yang tidak berhasil dijalankan.

## 5. Pekerjaan Pertama yang Diizinkan

Pekerjaan implementasi pertama adalah **Tahap 1 — Aplikasi Dasar Hidup**. Tahap 2 boleh mulai setelah gate Tahap 1 lulus. Integrasi AI dan editor tidak boleh dimulai sebelum gate tahap pendahulunya selesai.

## 6. Status Tahap

| Tahap | Status awal | Syarat pindah |
|---|---|---|
| 1. Aplikasi dasar | NEXT | Gate Tahap 1 lulus |
| 2. Pengelolaan proyek | BLOCKED | Tahap 1 lulus |
| 3. Import dan pemeriksaan | BLOCKED | Tahap 2 lulus |
| 4. Persiapan dan export | BLOCKED | Tahap 3 lulus |
| 5. Generasi API | BLOCKED | Tahap 4 lulus |
| 6. Editor SVG ringan | BLOCKED | Tahap 5 lulus |
| 7. Verifikasi MVP | BLOCKED | Tahap 6 lulus |

## 7. Change Control

Perubahan urutan atau scope harus mencatat:

1. masalah yang tidak dapat diselesaikan dalam baseline;
2. perubahan yang diusulkan;
3. alternatif yang dipertimbangkan;
4. dampak terhadap keamanan, data, UX, jadwal, dan testing;
5. dokumen yang perlu disinkronkan;
6. persetujuan eksplisit pemilik produk.

Tanpa enam hal tersebut, urutan dalam dokumen ini tetap berlaku.