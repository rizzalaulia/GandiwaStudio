# Product Requirements Document — Gandiwa Studio

**Versi:** 1.0

**Status:** Locked untuk implementasi

**Platform MVP:** Web app privat, desktop-first, local-first

**Pengguna MVP:** Single-user

**Development:** `bejo1-oracle`

**Production:** `bejo2-vnic`

## 1. Executive Summary

Gandiwa Studio adalah workspace produksi aset Adobe Stock yang menggabungkan brief, generasi AI multi-provider, penyuntingan vector ringan, quality gate, metadata, dan ekspor proyek. Pengguna wajib memilih **Photo**, **Illustration**, atau **Vector** sebelum generasi. Pilihan ini menjadi kontrak workflow: menentukan model yang tersedia, format output, validator, editor, serta metadata yang digunakan.

Produk memecahkan fragmentasi workflow tanpa membangun router AI baru. Pengguna memilih konektor dan model tujuan secara eksplisit. Konektor wajib MVP adalah fal.ai dan API 9Router melalui Tailscale; konektor langsung lain dapat ditambahkan kemudian melalui interface yang sama. BYOK dikonfigurasi pemilik deployment pada backend secret file/environment; frontend tidak menerima, menyimpan, atau menampilkan API key. Gandiwa hanya membentuk request, mengirimkannya ke endpoint pilihan, dan menerima hasil. Routing/fallback internal 9Router berada di luar tanggung jawab Gandiwa.

**Pembeda utama:** content-type-first workflow, konektor API yang dapat dipilih pengguna, preflight transparan, filesystem milik pengguna, dan feedback moderasi sebagai data perbaikan.

## 2. Target Audience & Persona

### Persona utama — Master Peng

- **Peran:** Adobe Stock Contributor dan operator tunggal.
- **Tujuan:** memproduksi aset stock berkualitas secara efisien dengan subscription AI yang tersedia.
- **Masalah:** tool terpisah, hasil tidak konsisten, audit berulang, dan metadata manual.
- **Kemampuan teknis:** mampu mengoperasikan aplikasi kreatif dan konfigurasi AI, tetapi membutuhkan workflow terpadu.

## 3. Platform Scope

- Aplikasi web desktop-first.
- Target utama: Chrome atau Edge terbaru pada Windows.
- Akses folder lokal menggunakan File System Access API.
- Browser memiliki directory handle dan menulis folder proyek lokal; backend tidak dapat menulis langsung ke filesystem pengguna.
- Backend production berjalan pada `bejo2-vnic`; development/review berjalan pada `bejo1-oracle`.
- Koneksi backend ke 9Router dapat menggunakan URL Tailscale berakhiran `/v1`.
- Online diperlukan untuk provider cloud. Project lokal dan SVG yang sudah tersanitasi dapat tetap dibuka selama izin folder tersedia; import/preview SVG baru menunggu backend sanitization.
- Tidak ada cloud sync bawaan; sinkronisasi folder oleh pengguna berada di luar scope dan kontrak produk.
- Firefox/Safari bukan target penuh MVP karena keterbatasan File System Access API.

### Matriks tipe konten

| Tipe | Format generasi MVP | Editor | Quality gate utama |
|---|---|---|---|
| Photo | PNG, JPEG | inspect, konversi, dan resize eksplisit; retouch melalui editor eksternal | resolusi, noise, artefak, anatomi, legal |
| Illustration | PNG, JPEG; SVG jika memang native vector | preparation raster atau editor SVG untuk hasil SVG | style, artefak, teks, anatomi, legal |
| Vector | SVG | editor vector ringan | struktur SVG, raster tertanam, path, artboard, render parity |

Ekspor AI/EPS tidak dijanjikan pada MVP. SVG dapat dibuka di Illustrator/Inkscape untuk konversi bila dibutuhkan.

## 4. Tech Stack & Architecture

### Rekomendasi stack

- **Frontend:** React + TypeScript strict + Vite + React Router.
- **UI:** Tailwind CSS + CSS variables berdasarkan `DESIGN.md`.
- **State:** Zustand untuk UI state; TanStack Query untuk server/job state dan REST polling.
- **Canvas SVG:** SVG DOM native dengan abstraction layer; library tambahan hanya bila fixture membuktikan perlu.
- **Backend:** Python 3.12 + FastAPI + Uvicorn + Pydantic v2.
- **Persistence:** SQLAlchemy 2 + Alembic + SQLite WAL; file kreatif tetap berada di folder proyek pengguna.
- **Job execution:** SQLite durable queue dan satu proses worker terpisah; priority+FIFO, lease/heartbeat, cooperative cancellation, restart recovery, serta retry hanya untuk operasi aman/idempotent mengikuti [ADR-0001](adr/0001-sqlite-durable-job-queue.md).
- **Media:** Pillow untuk raster; defusedxml + lxml untuk SVG/XML. SVGO/Inkscape/VTracer hanya ditambahkan bila dibuktikan perlu dan kompatibel ARM64.
- **AI:** konektor API menuju 9Router dan fal.ai untuk MVP. Satu konektor serta model dipilih eksplisit per job; Gandiwa tidak merutekan request antar-provider.
- **Testing:** Vitest + Testing Library + Playwright pada frontend; pytest + Ruff + mypy pada backend.
- **Production:** Vite static build di host Nginx bejo2-vnic; FastAPI dan satu worker sebagai Docker Compose services. Kontrak rinci mengikuti `TECHNOLOGY.md` dan `DEPLOYMENT-BEJO2.md`.

```text
Browser (React)
  ├─ Project workspace + File System Access API
  ├─ Content type selector
  ├─ Gallery / compare / editor ringan
  └─ Audit + metadata + export
             │ same-origin HTTPS
             ▼
Host Nginx (static UI + /api proxy)
             │ loopback/internal
             ▼
FastAPI backend
  ├─ Session, provider registry, dan server-side secret
  ├─ Model capability registry
  ├─ Prompt/orchestration service
  ├─ SQLite durable queue
  ├─ Deterministic validators
  └─ Audit/metadata adapters
             │
             ▼
Single worker process
       ├─ 9Router via Tailscale
       └─ fal.ai via internet
```

### Prinsip keamanan

- API key tidak pernah dikirim ke bundle frontend atau disimpan di project folder.
- Secret disimpan server-side melalui environment variables atau encrypted secret store.
- URL 9Router dapat memakai alamat Tailscale; akses dibatasi tailnet dan API key.
- SVG diperlakukan sebagai input tidak tepercaya: script, event handler, external URL, dan active content dihapus/ditolak sebelum preview.

## 5. Functional Requirements & User Stories

### Epic A — Proyek dan klasifikasi

**GS-001 — Membuat proyek**
- Sebagai pengguna, saya ingin memilih folder kerja agar seluruh aset dan metadata tersimpan di lokasi yang saya kuasai.
- Acceptance Criteria:
  - [ ] Aplikasi meminta izin folder melalui File System Access API.
  - [ ] Struktur folder proyek dan `gandiwa-project.json` dibuat.
  - [ ] Pembatalan izin tidak membuat project parsial tanpa peringatan.
- Priority: P0

**GS-002 — Memilih tipe konten sebelum generasi**
- Sebagai pengguna, saya ingin memilih Photo, Illustration, atau Vector agar workflow benar sejak awal.
- Acceptance Criteria:
  - [ ] Generate dinonaktifkan sebelum tipe dipilih.
  - [ ] Pilihan tersimpan pada setiap generation job.
  - [ ] Mengubah tipe setelah ada hasil memerlukan konfirmasi dan membuat job baru, bukan menimpa klasifikasi lama.
- Priority: P0

**GS-003 — Memilih format output**
- Sebagai pengguna, saya ingin memilih PNG, JPEG, atau SVG berdasarkan tipe konten.
- Acceptance Criteria:
  - [ ] Vector hanya menawarkan SVG pada jalur native-vector.
  - [ ] Photo menawarkan PNG dan JPEG.
  - [ ] Illustration menawarkan PNG/JPEG dan SVG hanya jika model/workflow mendukung native vector.
  - [ ] Kombinasi tidak valid dijelaskan dan tidak dapat dijalankan.
- Priority: P0

### Epic B — Provider dan model

**GS-004 — Mengelola koneksi provider**
- Sebagai pengguna, saya ingin menggunakan konektor backend yang sudah dikonfigurasi pemilik deployment.
- Acceptance Criteria:
  - [ ] MVP mendukung 9Router dan fal.ai; konektor lain hanya dapat ditambahkan setelah dua vertical slice lulus dan mengikuti interface yang sama.
  - [ ] Credential dipasang hanya melalui backend secret file/environment, bukan form atau storage browser.
  - [ ] UI hanya menampilkan nama konektor, capability/model, status konfigurasi, dan hasil test connection tanpa key.
  - [ ] API tidak pernah mengembalikan secret atau representasi yang dapat dipulihkan.
- Priority: P0

**GS-005 — Registry kemampuan model**
- Sebagai pengguna, saya ingin hanya melihat model yang cocok untuk tugas dan format.
- Acceptance Criteria:
  - [ ] Model memiliki capability text, vision, image-generation, SVG-text, atau audit.
  - [ ] Model tanpa capability terkait tidak dapat dipilih.
  - [ ] Pengguna dapat menyimpan preferensi connector/model sebagai prefill, tetapi setiap job tetap menampilkan dan mewajibkan konfirmasi eksplisit sebelum dispatch; preference tidak pernah memicu pemilihan atau fallback otomatis.
- Priority: P0

**GS-006 — Memanggil API 9Router sebagai konektor pilihan**
- Sebagai pengguna, saya ingin memilih connector 9Router yang telah dikonfigurasi backend beserta model/combo agar Gandiwa dapat memakai konfigurasi 9Router yang sudah saya miliki tanpa menerima URL arbitrer dari browser.
- Acceptance Criteria:
  - [ ] Backend dapat mengambil daftar model/combo yang dipublikasikan oleh `/v1/models`.
  - [ ] Pengguna memilih model/combo secara eksplisit sebelum menjalankan job.
  - [ ] Request memakai endpoint berakhiran `/v1` dan key server-side.
  - [ ] Gandiwa tidak mengatur urutan model, fallback, atau routing internal 9Router.
  - [ ] Error endpoint tercatat tanpa menampilkan secret.
- Priority: P0

### Epic C — Brief dan generasi

**GS-007 — Membuat brief terstruktur**
- Sebagai pengguna, saya ingin mengubah ide menjadi buyer intent, komposisi, style, palette, dan larangan.
- Acceptance Criteria:
  - [ ] Brief dapat diedit sebelum generasi.
  - [ ] Brief terikat pada content type.
  - [ ] Brand, logo, readable text, dan artist-name policy tersedia sebagai guardrail.
- Priority: P0

**GS-008 — Menjalankan generation job**
- Sebagai pengguna, saya ingin menghasilkan beberapa kandidat dari brief.
- Acceptance Criteria:
  - [ ] API membuat ruleset snapshot dan job `queued`, lalu segera mengembalikan `job_id` tanpa menunggu provider.
  - [ ] Job menyimpan provider, model, prompt, parameter, content type, format, priority, attempt, waktu, status, dan remote provider ID bila tersedia.
  - [ ] Satu worker menjalankan satu job; job lain menunggu berdasarkan priority+FIFO.
  - [ ] Job dapat diminta batal dan berhenti pada safe checkpoint; cancel diteruskan bila provider mendukungnya.
  - [ ] Restart worker dapat memulihkan expired lease tanpa redispatch generation berbayar secara buta.
  - [ ] Hasil gagal tidak ditandai sebagai kandidat valid.
- Priority: P0

**GS-009 — Membandingkan kandidat**
- Sebagai pengguna, saya ingin membandingkan hasil sebelum memilih master.
- Acceptance Criteria:
  - [ ] Kandidat dapat ditampilkan berdampingan.
  - [ ] Zoom, background terang/gelap/checkerboard tersedia.
  - [ ] Satu hasil dapat ditandai sebagai master tanpa menghapus kandidat lain.
- Priority: P0

### Epic D — Penyuntingan dan persiapan

**GS-010A — Persiapan raster**
- Sebagai pengguna, saya ingin menyiapkan raster submission tanpa merusak master.
- Acceptance Criteria:
  - [ ] PNG/JPEG working/master dapat diperiksa dan dikonversi menjadi JPEG submission revision.
  - [ ] Resize hanya berjalan setelah aksi eksplisit dan tidak meng-upscale file di bawah 4 MP untuk menyamarkan kekurangan kualitas.
  - [ ] Quality setting, dimensions, megapixels, alpha handling, dan color conversion dicatat pada revision.
  - [ ] Source/master tidak ditimpa; perubahan checksum membuat audit/approval lama stale.
  - [ ] Retouching kompleks diarahkan ke editor eksternal.
- Priority: P0

**GS-010 — Editor SVG ringan**
- Sebagai pengguna, saya ingin memperbaiki vector tanpa editor penuh.
- Acceptance Criteria:
  - [ ] Mendukung select, move, resize, recolor, layer reorder, hide/show, dan delete.
  - [ ] Undo/redo tersedia untuk aksi edit.
  - [ ] Dokumen dengan node melewati ambang aman masuk preview-only.
  - [ ] Setiap penyimpanan menghasilkan revisi, bukan merusak source asli.
- Priority: P0

**GS-011 — Mengirim ke editor eksternal**
- Sebagai pengguna, saya ingin mengekspor source agar dapat dibuka di Illustrator/Inkscape.
- Acceptance Criteria:
  - [ ] SVG dapat diunduh/disimpan tanpa modifikasi tersembunyi.
  - [ ] Aplikasi menjelaskan bahwa AI/EPS memerlukan konversi eksternal pada MVP.
- Priority: P1

### Epic E — Audit dan metadata

**GS-012 — Preflight deterministik**
- Sebagai pengguna, saya ingin mengetahui pelanggaran teknis yang dapat diverifikasi.
- Acceptance Criteria:
  - [ ] Hasil memiliki PASS, WARNING, atau FAIL per rule.
  - [ ] SVG diperiksa untuk raster embedded, external resource, script, live text, invalid viewBox, empty path, objek luar artboard, serta node berlebih.
  - [ ] Raster diperiksa untuk dimensi, format, alpha, dan keterbacaan file.
  - [ ] FAIL memblokir status Ready for Export.
- Priority: P0

**GS-013 — Audit visual dan legal berbantuan AI**
- Sebagai pengguna, saya ingin memperoleh indikasi artefak dan risiko legal.
- Acceptance Criteria:
  - [ ] Temuan AI ditandai sebagai rekomendasi, bukan fakta deterministik.
  - [ ] Audit memeriksa gibberish text, anatomi, logo/merek, karakter terlindungi, dan nama artis.
  - [ ] Pengguna wajib memberi keputusan akhir approve/reject.
- Priority: P0

**GS-014 — Metadata stock**
- Sebagai pengguna, saya ingin mendapatkan title, keywords, category, dan AI disclosure yang relevan.
- Acceptance Criteria:
  - [ ] Metadata mengikuti content type dan isi visual.
  - [ ] Keyword dapat diedit dan diurutkan.
  - [ ] Label generative AI wajib tersedia pada hasil AI.
  - [ ] Nama brand/artis terlarang diperingatkan.
- Priority: P0

**GS-015 — Similarity warning**
- Sebagai pengguna, saya ingin diberi tahu jika kandidat terlalu mirip.
- Acceptance Criteria:
  - [ ] Sistem membandingkan kandidat dalam satu proyek.
  - [ ] Skor hanya menjadi warning, bukan penolakan otomatis.
  - [ ] Recolor sederhana ditandai untuk tinjauan.
- Priority: P1

### Epic F — Ekspor dan pembelajaran

**GS-016 — Export package**
- Sebagai pengguna, saya ingin menghasilkan paket aset yang rapi.
- Acceptance Criteria:
  - [ ] Paket berisi final asset, preview, metadata, audit report, dan manifest.
  - [ ] Nama file aman dan konsisten.
  - [ ] Export hanya berstatus Ready jika tidak ada FAIL dan telah disetujui pengguna.
- Priority: P0

**GS-017 — Feedback moderasi**
- Sebagai pengguna, saya ingin mencatat accepted/rejected dan alasan moderasi.
- Acceptance Criteria:
  - [ ] Status serta alasan dapat dicatat per aset.
  - [ ] Feedback tidak otomatis mengubah rule tanpa persetujuan.
  - [ ] Data dapat diekspor untuk analisis/fine-tuning di masa depan.
- Priority: P1

## 6. Non-Functional Requirements

### Performance

- UI interaktif tetap responsif pada SVG hingga 20.000 node di perangkat target.
- SVG di atas 100.000 node dibuka preview-only secara default.
- Interaksi editor menargetkan 30 FPS atau lebih.
- Respons UI lokal non-AI ditargetkan kurang dari 200 ms.
- Timeout provider dapat dikonfigurasi; job panjang tidak memblokir halaman.

### Security

- Seluruh secret berada di backend.
- Log wajib meredaksi Authorization header dan API key.
- SVG disanitasi sebelum dirender.
- CORS dibatasi ke origin Gandiwa.
- Production memakai same-origin HTTPS; Tailscale/CORS tidak menggantikan secure session authentication dan CSRF protection.
- API production hanya diekspos melalui Nginx, bukan port container publik.
- Tidak ada upload otomatis ke Adobe Stock pada MVP.

### Reliability

- Source asli tidak ditimpa.
- Penulisan manifest menggunakan temp file lalu atomic replace bila filesystem mendukung.
- Job memiliki state `queued`, `running`, `waiting_provider`, `processing`, `needs_review`, `succeeded`, `failed`, atau `cancelled`.
- Antrean durable, lease/heartbeat, dan remote provider ID mencegah job hilang atau dispatch ganda setelah restart.
- Browser memantau status dengan REST polling; job backend tetap berjalan bila tab ditutup.
- Artifact sukses tetap sementara di backend sampai browser mengambilnya atau retention period habis.
- Project tetap dapat dibuka bila backend AI sedang mati; fitur AI ditandai unavailable.

### Accessibility

- Target WCAG 2.1 AA.
- Seluruh aksi penting dapat diakses keyboard.
- Status tidak dibedakan hanya berdasarkan warna.

### Privacy

- Aset dikirim ke provider hanya setelah pengguna menjalankan aksi AI.
- UI menunjukkan provider tujuan sebelum request.
- Project manifest tidak menyimpan API key.

## 7. UI/UX & User Flow

### Layar utama

1. Home/Project Picker
2. Create Project Wizard
3. Workspace
4. Generate Panel
5. Candidate Compare
6. Vector Editor
7. Audit Center
8. Metadata Editor
9. Export Center
10. Provider & Model Settings
11. Moderation Feedback

### Alur utama

```text
Buka/pilih folder
→ pilih Photo / Illustration / Vector
→ pilih format yang valid
→ tulis ide dan bentuk brief
→ pilih provider/model
→ generate kandidat
→ bandingkan dan pilih master
→ edit ringan bila SVG
→ jalankan preflight + audit AI
→ perbaiki atau setujui
→ susun metadata
→ export package
→ upload manual ke Adobe Stock
→ catat hasil moderasi
```

## 8. Out of Scope MVP

- editor Bézier/node sekelas Illustrator;
- training/fine-tuning model;
- seluruh model inference AI lokal;
- kolaborasi atau multi-user;
- cloud sync bawaan;
- pembayaran/subscription management;
- upload otomatis ke Adobe Stock;
- janji bahwa aset pasti diterima moderator;
- ekspor AI/EPS native;
- aplikasi mobile penuh.

## 9. Success Metrics

| Area | Metrik | Target MVP | Pengukuran |
|---|---|---:|---|
| Product | Proyek berhasil dari brief ke export | ≥ 80% sesi uji | event lokal |
| Product | Waktu dari brief ke kandidat master | turun ≥ 30% dari baseline manual | job timestamps |
| Quality | Technical FAIL ditemukan sebelum export | 100% untuk rule deterministik teruji | test fixtures |
| Quality | Aset final punya content type + metadata | 100% | manifest validation |
| Technical | Crash-free project sessions | ≥ 99% | local error log |
| Technical | Secret muncul di log | 0 | automated secret scan |
| Business | Tingkat diterima Adobe Stock | dicatat sebagai baseline, tanpa target palsu pada fase awal | moderation feedback |
| Business | Aset yang terjual/download | dicatat per aset untuk menemukan workflow bernilai | feedback manual |

## 10. Adobe Ruleset Execution

Setiap generation job wajib menyimpan snapshot `ruleset_id` dan membentuk resolved request dari brief pengguna, universal constraints, content-type constraints, serta capability/format constraints. Rule dijalankan sesuai tipe evaluator: prompt constraint, deterministic postcheck, AI review, atau human confirmation.

Format dipisahkan menjadi `generation_format`, `working_format`, `master_format`, dan `submission_format`. PNG dapat menjadi working/master, tetapi Photo dan Illustration raster hanya menjadi Adobe-ready setelah dikonversi serta divalidasi sebagai JPEG. Vector dan Illustration vector menggunakan SVG sebagai submission format MVP.

Audit berjalan setelah generasi, sanitasi/normalisasi, edit, konversi, dan sebelum export. Edit pixel/path atau metadata relevan membatalkan audit serta approval lama. Kontrak lengkap mengikuti `ADOBE-RULESET.md`.

## 11. Definition of Done MVP

MVP selesai jika satu pengguna dapat:

- membuat dan membuka kembali proyek pada folder laptop;
- memilih content type dan creation method sebelum generate;
- memilih connector backend yang telah dikonfigurasi dan model secara eksplisit;
- menjalankan jalur raster melalui fal.ai dan jalur reasoning/SVG/metadata melalui 9Router;
- menghasilkan working artifact PNG/JPEG/SVG;
- memilih master dan mengedit SVG ringan;
- menjalankan ruleset per revisi serta melihat bukti PASS/WARNING/FAIL;
- mengonversi Photo/Illustration raster menjadi JPEG submission minimum 4 MP;
- memvalidasi Vector/Illustration vector sebagai SVG tanpa raster/active content;
- menyusun metadata dan AI disclosure;
- memberi approval final yang terikat checksum, revisi, audit, dan ruleset;
- mengekspor paket hanya setelah status `ADOBE_READY`;
- membuktikan edit setelah approval mencabut status tersebut.

Seluruh acceptance criteria P0 dan fixture minimum `ADOBE-RULESET.md` harus lulus. Tidak boleh ada secret pada frontend, manifest, artifact, atau log.

## 12. MVP LOCK

**Baseline:** `mvp-1.0` — terkunci. Urutan implementasi dan acceptance gate wajib mengikuti [`DEVELOPMENT-SEQUENCE.md`](DEVELOPMENT-SEQUENCE.md). Implementasi wajib mengikuti ruang lingkup berikut:

- single-user, Chrome/Edge desktop-first;
- browser sebagai pemilik directory handle; backend hanya memproses upload sementara dan mengembalikan artifact;
- konektor wajib 9Router dan fal.ai; Gandiwa tidak melakukan routing/fallback;
- dua vertical slice: raster sampai JPEG Adobe-ready dan vector sampai SVG Adobe-ready;
- editor SVG ringan saja;
- upload Adobe Stock manual;
- manifest proyek sebagai source of truth kreatif portabel; SQLite menyimpan cache/index serta state operasional durable, dan hanya bagian cache/index yang boleh dibangun ulang dari manifest.

Out-of-scope pada §8 tidak boleh dimasukkan tanpa change request tertulis dan revisi baseline. Peningkatan provider tambahan boleh dilakukan setelah DoD dua vertical slice lulus dan tidak boleh mengubah kontrak konektor.
