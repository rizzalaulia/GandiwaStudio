# Audit Sinkronisasi Dokumen — Gandiwa Studio

**Tanggal:** 8 September 2026

**Baseline:** `mvp-1.0`

**Putusan:** **Documentation-ready; implementation belum dimulai**

## Tujuan Audit

Dokumen awal pernah memiliki gap pada format submission, boundary filesystem, source of truth, antrean, scope provider, autentikasi, dan target deployment. Audit ini mencatat status setelah kesepakatan produk/arsitektur disinkronkan.

## Keputusan yang Kini Konsisten

1. **Local-first browser app.** Browser Chrome/Edge memiliki directory handle dan menulis folder proyek pengguna.
2. **Tidak ada cloud sync bawaan.** Sinkronisasi folder antarperangkat adalah urusan pengguna di luar Gandiwa.
3. **Manifest portabel sebagai source of truth.** SQLite adalah konfigurasi/cache/index/runtime queue, bukan permanent creative storage.
4. **Gandiwa bukan router.** User memilih connector dan model per job; 9Router hanyalah satu connector.
5. **Provider wajib MVP hanya 9Router dan fal.ai.** Connector lain ditunda sampai dua vertical slice lulus.
6. **Format dipisah.** Generation, working, master, dan submission format bukan field yang sama.
7. **Final Adobe-ready gate wajib.** Blocking deterministic checks, metadata/disclosure, checksum-bound approval, dan current ruleset harus valid.
8. **Durable job execution.** SQLite queue + proses worker tunggal + priority/FIFO + lease/heartbeat/recovery + safe retry.
9. **REST polling untuk MVP.** SSE/WebSocket ditunda.
10. **Development dan production dipisah.** Development/review pada `bejo1-oracle`; production pada `bejo2-vnic`.
11. **Production stack ringan.** Static frontend melalui host Nginx; FastAPI dan worker via Docker Compose; tanpa Redis/Celery/Node production server/local AI.
12. **Upload ke Adobe Stock tetap manual.** Adobe-ready bukan jaminan moderator menerima.

## Closure atas Temuan Audit Lama

| Temuan | Status | Penutupan |
|---|---|---|
| Format kerja bercampur submission | Closed | Empat format dipisahkan di PRD/ERD/ruleset |
| Browser/backend filesystem ambigu | Closed | Browser owns handle; backend temporary only; ADR-0002 |
| Auth belum punya baseline | Partially closed | Same-origin HTTPS + secure session + CSRF dikunci; identity/bootstrap mechanism wajib diputuskan sebelum production |
| MVP terlalu lebar | Closed | Urutan 7 tahap; dua vertical slice; provider wajib dibatasi |
| Ruleset belum berversi | Closed | `adobe-stock-2026-09-08-v1` + source/evidence/fixtures |
| Creation method bercampur content type | Closed | Field dipisahkan |
| Provenance tidak lengkap | Closed pada model kontrak | provider/model/adapter/revision/seed/request ID dipertahankan |
| Approval bukan entitas | Closed | APPROVAL terikat revision/audit/ruleset/checksum |
| Candidate master ambigu | Closed | GENERATION_BATCH dan master invariant |
| Manifest vs SQLite ambigu | Closed | Manifest source of truth; SQLite runtime/cache |
| AI legal review terlalu pasti | Closed | Disebut risk screening + human confirmation |
| Job restart/duplikasi belum ditangani | Closed | ADR-0001 + queue fields + `needs_review` + remote request ID |
| Raster preparation tidak punya acceptance criteria | Closed | GS-010A memisahkan conversion/resize dari retouching eksternal |
| Deployment target salah/ambigu | Closed | ADR-0003 + `DEPLOYMENT-BEJO2.md` |

## Kekuatan Produk

- Pembeda terletak pada compliance-aware workflow, provenance, non-destructive revisions, dan export gate—bukan sekadar generate.
- Local-first mengurangi kebutuhan permanent server asset storage dan menjaga portabilitas.
- Explicit provider selection menghormati subscription pengguna tanpa membuat router baru.
- Durable queue memberi backpressure dan recovery yang cocok untuk bejo2 1 vCPU.
- Outcome moderasi dapat membangun feedback loop tanpa fine-tuning dini.

## Risiko yang Tetap Terbuka

### P0 sebelum production

- Aplikasi belum diimplementasikan atau diuji end-to-end.
- Dedicated Gandiwa HTTPS hostname/access mode belum dipilih.
- Session bootstrap, CSRF implementation, dan recovery flow belum dibuktikan dengan test.
- bejo2 belum memiliki swap.
- Identity/bootstrap mechanism masih perlu diputuskan sebelum production.
- Provider URL/SSRF, untrusted artifact delivery, dan container hardening sudah menjadi kontrak, tetapi belum dibuktikan test.
- Compose, Nginx, backup, restore, rollback, dan migration belum menjadi artifact yang dieksekusi.
- Adobe ruleset harus diverifikasi ulang terhadap sumber resmi saat implementasi rule dan sebelum release.

### P1 saat implementasi

- File System Access permission dapat hilang dan perlu recovery UI.
- Browser ditutup setelah job selesai: artifact harus dapat diambil ulang sebelum expiry.
- Unknown provider dispatch outcome berisiko menimbulkan biaya ganda jika di-retry buta.
- SVG kompleks dapat membebani browser dan worker; threshold harus dibuktikan fixture/benchmark.
- SQLite contention, WAL growth, backup consistency, dan restore reconciliation harus diukur; jangan migrasi ke Redis/PostgreSQL hanya karena asumsi.
- External edits/concurrent synced-folder writes dapat membuat manifest berubah; perlu conflict detection, bukan sync engine.

### P2 pasca-MVP

- Connector tambahan.
- Similarity lintas project/portfolio.
- Team/multi-user, hosted workspace, atau built-in sync.
- Native AI/EPS export dan editor path penuh.

## Consistency Checks Required Before Commit

- Semua tautan Markdown lokal valid.
- `DESIGN.md` tetap lulus design lint.
- Tidak ada referensi stale yang menyebut `bejo1-oracle` sebagai production.
- Tidak ada klaim bahwa layanan sinkronisasi pihak ketiga/cloud sync adalah fitur MVP.
- Tidak ada Redis/Celery/BackgroundTasks sebagai queue MVP.
- Tidak ada auto-route/fallback/provider selection.
- ERD, PRD, Architecture, Technology, dan ADR memakai state job yang sama.
- `.env` templates hanya placeholder dan tidak berisi secret nyata.
- `git diff --check` bersih.

## Putusan

Dokumentasi layak menjadi kontrak implementasi setelah consistency checks di atas lulus. Putusan ini **bukan** klaim bahwa aplikasi, container, deployment, migration, atau smoke test sudah tersedia. Pekerjaan kode tetap dimulai dari Tahap 1 di `DEVELOPMENT-SEQUENCE.md`.

## Referensi Internal

- `BRD.md`
- `PRD.md`
- `ERD.md`
- `DESIGN.md`
- `ADOBE-RULESET.md`
- `DEVELOPMENT-SEQUENCE.md`
- `TECHNOLOGY.md`
- `ARCHITECTURE.md`
- `DEPLOYMENT-BEJO2.md`
- `OPERATIONS.md`
- `adr/0001-sqlite-durable-job-queue.md`
- `adr/0002-local-first-browser-filesystem.md`
- `adr/0003-bejo2-production-topology.md`

## Referensi Resmi Adobe

- https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html
- https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/adobe-stock-generative-ai-faq.html
- https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html
- https://helpx.adobe.com/stock/contributor/submit-your-content/submit-vectors/technical-requirements-for-vector-submissions.html