# Audit Produk dan Dokumen — Gandiwa Studio

**Tanggal audit:** 8 September 2026  
**Dokumen diperiksa:** `BRD.md`, `PRD.md`, `ERD.md`, `DESIGN.md`  
**Putusan:** **Layak dilanjutkan setelah revisi fondasi (Conditional Go)**

## 1. Ringkasan Eksekutif

Gandiwa Studio memiliki arah produk yang jelas: workspace produksi stock berbantuan AI yang dimulai dari klasifikasi konten, tidak terkunci pada satu provider, memiliki quality gate, dan tetap memberi keputusan akhir kepada manusia. Nilai paling kuat bukan fitur generate, melainkan orkestrasi workflow, preflight, provenance, dan data feedback moderasi.

Namun, dokumen saat ini belum aman dijadikan kontrak implementasi tanpa revisi. Ada empat gap utama:

1. format kerja/generasi bercampur dengan format final submission Adobe Stock;
2. batas browser–backend–filesystem belum didefinisikan secara teknis;
3. cakupan MVP terlalu lebar untuk satu vertical slice pertama;
4. model data belum menangkap credential ownership, provider request, provenance, approval, dan sinkronisasi manifest secara cukup presisi.

## 2. Kelebihan

### 2.1 Content-type-first adalah fondasi yang benar

Photo, Illustration, dan Vector dipilih sebelum generasi. Ini mencegah klasifikasi ditempelkan belakangan dan memungkinkan sistem memilih format, model, validator, metadata, serta UI yang sesuai.

### 2.2 Multi-provider/BYOK mengurangi vendor lock-in

Konektor 9Router, OpenAI, Anthropic, fal.ai, dan OpenAI-compatible membuat subscription pengguna dapat dimanfaatkan sesuai pilihannya. Registry capability hanya mencegah kombinasi tugas-model yang tidak valid karena tidak semua model mendukung text, vision, image generation, atau SVG; registry ini bukan mesin routing.

### 2.3 Quality gate memisahkan fakta dari opini AI

Dokumen membedakan pemeriksaan deterministik dan AI review. Blocking FAIL, human approval, dan larangan menjanjikan kelulusan Adobe adalah keputusan produk yang sehat.

### 2.4 Keamanan sudah dipikirkan sejak awal

API key berada di backend, log harus diredaksi, SVG dianggap input tidak tepercaya, CORS dibatasi, dan source tidak ditimpa. Ini lebih matang daripada kebanyakan generator kreatif tahap awal.

### 2.5 Workflow non-destruktif dan dapat ditelusuri

Source, kandidat, master, revision, audit run, metadata, export, serta feedback moderasi telah memiliki konsep tersendiri. Ini membuka peluang provenance dan reproduksi job.

### 2.6 Desain antarmuka mendukung pekerjaan serius

DESIGN.md konsisten dengan aplikasi kreatif desktop-first: tiga panel, inspector kontekstual, status eksplisit, dan karya sebagai pusat perhatian. Lint DESIGN.md menghasilkan 0 error dan 0 warning.

## 3. Kekurangan dan Celah

### P0 — Wajib ditutup sebelum implementasi

#### F-01 — Format generasi dan format submission tercampur

PRD/BRD menyebut PNG, JPEG, dan SVG sebagai output, tetapi belum membedakan:

- **working format**: format hasil provider atau format selama editing;
- **master format**: sumber berkualitas tertinggi;
- **submission format**: file final yang akan diunggah.

Panduan upload resmi Adobe yang diperiksa saat audit menyatakan:

- Photo: JPEG, minimum 4 MP;
- Illustration: JPEG, AI, EPS, atau SVG;
- Generative AI: JPEG, AI, EPS, atau SVG dan wajib ditandai sebagai generative AI.

Implikasi: PNG layak sebagai working/master intermediate, tetapi jangan diberi status Adobe-ready untuk Photo/Illustration raster tanpa konversi dan validasi ke JPEG.

**Perbaikan:** tambahkan `working_format`, `master_format`, dan `submission_format`; buat matriks export terpisah dari matriks generation.

#### F-02 — Arsitektur File System Access API belum menutup batas browser–backend

Backend di VPS tidak bisa langsung menulis ke folder laptop yang izinnya dimiliki browser. Dokumen belum menentukan mekanisme:

1. browser membaca file dan mengirim blob ke backend;
2. backend memproses dan mengembalikan blob/stream;
3. browser menulis hasil ke directory handle;
4. handle permission diperiksa ulang setiap sesi.

Tanpa kontrak ini, job runner backend dan penyimpanan folder lokal akan bertabrakan.

**Perbaikan:** definisikan browser sebagai pemilik filesystem; backend hanya menerima upload sementara dan mengembalikan artifact. Tetapkan batas ukuran, streaming, checksum, cleanup temp, serta recovery ketika tab ditutup.

#### F-03 — Autentikasi aplikasi belum didefinisikan

"Single-user" dan "akses Tailscale" belum cukup. Tailscale membatasi jaringan, tetapi endpoint backend masih membutuhkan identitas, session, CSRF posture, dan aturan origin.

**Perbaikan:** pilih salah satu: local-only loopback; Tailscale identity-aware proxy; atau login tunggal dengan secure session cookie. Dokumentasikan threat model dan jangan mengandalkan CORS sebagai autentikasi.

#### F-04 — MVP terlalu lebar

P0 sekarang mencakup project filesystem, lima jenis adapter, capability registry, brief orchestration, image generation, direct SVG, gallery compare, editor SVG, validator raster/vector, audit vision/legal, metadata, dan export. Ini sebenarnya beberapa produk dalam satu MVP.

**Perbaikan:** gunakan vertical slice:

- Photo/Illustration raster: fal.ai + satu auditor;
- Vector: import/direct SVG sederhana melalui 9Router;
- satu project folder;
- preflight minimum;
- metadata + export.

Konektor API tambahan dan editor layer kompleks masuk setelah slice ini terbukti. Penundaan konektor hanyalah pembatasan scope implementasi, bukan rencana membangun router.

#### F-05 — Aturan Adobe belum menjadi ruleset berversi

Adobe dapat memperbarui ketentuan. `AUDIT_RULE.version` ada, tetapi tidak ada sumber, tanggal berlaku, URL referensi, atau mekanisme memperbarui ruleset.

**Perbaikan:** setiap rule menyimpan `source_url`, `source_retrieved_at`, `effective_from`, `ruleset_version`, dan test fixture.

### P1 — Penting setelah fondasi ditutup

#### F-06 — "Photo" perlu definisi produk yang lebih tegas

Adobe menyatakan gambar AI photorealistic yang seolah diambil kamera diajukan sebagai Photo; gambar generative AI lainnya sebagai Illustration. Saat ini "Photo" dapat ditafsirkan sebagai foto kamera asli atau AI photorealistic tanpa field provenance.

**Perbaikan:** pisahkan `content_type` dari `creation_method`: `camera`, `manual_digital`, `generative_ai`, `mixed`. Tambahkan `photorealistic` sebagai karakteristik, bukan provenance.

#### F-07 — Provenance model/provider belum lengkap

Nama provider/model/prompt tersimpan pada job, tetapi belum ada adapter version, seed, endpoint mode, model revision, safety settings, source reference, license/terms snapshot, dan request/response artifact yang sudah direduksi.

**Perbaikan:** tambahkan `PROVIDER_REQUEST` atau `GENERATION_PROVENANCE`.

#### F-08 — Approval hanya aturan teks, belum menjadi entitas

ERD menyatakan pengguna harus menyetujui, tetapi tidak ada `APPROVAL` atau field `approved_at`, `approved_by`, dan `approved_revision_id`. Boolean `acknowledged` pada finding tidak setara dengan persetujuan asset.

**Perbaikan:** tambahkan approval yang terikat pada revision dan audit run tertentu. Edit setelah approval harus membatalkan approval lama.

#### F-09 — Relasi master kandidat ambigu

Aturan menyebut satu master per kelompok kandidat, tetapi tidak ada entitas candidate group/batch. `is_master` sendiri tidak dapat menegakkan keunikan per kelompok.

**Perbaikan:** tambahkan `GENERATION_BATCH` atau gunakan `generation_job_id` sebagai kelompok dengan unique partial constraint untuk master aktif.

#### F-10 — Duplikasi data manifest dan SQLite belum memiliki source of truth

PROJECT, ASSET, job, dan feedback berada dalam model backend, sementara manifest juga menyimpan project/asset state. Konflik akan terjadi ketika proyek dipindahkan, backend berganti, atau manifest diedit di luar aplikasi.

**Perbaikan:** putuskan manifest sebagai source of truth project-portable; SQLite menjadi cache/index dan runtime state. Definisikan import/reindex/conflict rules.

#### F-11 — Audit legal AI berisiko memberi rasa aman palsu

Logo/brand detection dan hak cipta tidak dapat dipastikan hanya oleh model vision. Release juga belum dimodelkan.

**Perbaikan:** sebut sebagai risk screening, bukan legal clearance. Tambahkan checklist manusia serta entitas/attachment untuk model release dan property release bila nanti dibutuhkan.

#### F-12 — Similarity hanya intra-project terlalu sempit

Risiko similar content dapat muncul lintas project dan lintas batch.

**Perbaikan:** fase lanjut membutuhkan fingerprint portfolio lokal, bukan hanya kandidat dalam satu project. Tetap warning, bukan keputusan otomatis.

#### F-13 — Kebutuhan raster editor tidak konsisten

Matriks menyebut crop/resize sederhana untuk Photo, tetapi user stories hanya mendefinisikan editor SVG. Tidak ada acceptance criteria untuk raster crop/resize, quality setting JPEG, color profile, atau megapixel gate.

**Perbaikan:** tambahkan user story raster preparation atau keluarkan crop/resize dari MVP agar kontrak jelas.

#### F-14 — Angka performa belum memiliki dasar pengujian

Ambang 20.000/100.000 node, 30 FPS, dan 200 ms berguna sebagai hipotesis, tetapi belum memiliki perangkat benchmark dan fixture.

**Perbaikan:** label sebagai target awal; definisikan laptop target, koleksi SVG uji, dan metode pengukuran.

### P2 — Perbaikan mutu dokumen

- Terdapat typo `laptop,gist server privat` pada PRD.
- Istilah bercampur: asset/aset, vector/vector, project/proyek, export/ekspor.
- BRD belum memiliki asumsi biaya provider, batas anggaran per asset, atau unit economics.
- Tidak ada alur kegagalan: quota habis, timeout, hasil provider tanpa file, browser kehilangan izin folder, dan checksum mismatch.
- Tidak ada retention/cleanup policy untuk temporary upload backend.
- DESIGN.md belum mendefinisikan dialog izin folder, cost preview, error recovery, responsive narrow desktop, serta dark mode. Dark mode tidak wajib MVP, tetapi keputusan harus eksplisit.

## 4. Potensi Produk

### 4.1 Potensi tertinggi — Stock production operating system

Nilai Gandiwa bukan menjadi generator lain, melainkan menjadi control plane untuk ide, model, prompt, hasil, audit, metadata, export, dan outcome. Jika riwayatnya rapi, pengguna dapat mengetahui workflow mana yang benar-benar menghasilkan accepted asset dan download.

### 4.2 Konektor model yang dipilih pengguna

Capability registry berfungsi untuk memvalidasi apakah model pilihan pengguna cocok dengan pekerjaan, bukan untuk merutekan request secara otomatis. Pengguna tetap memilih endpoint dan model:

- API model langsung untuk brief, keyword, audit, atau generasi;
- fal.ai atau provider gambar lain untuk image generation;
- 9Router sebagai satu endpoint pilihan jika pengguna ingin memakai konfigurasi routing miliknya sendiri;
- endpoint OpenAI-compatible lainnya sesuai subscription pengguna.

Gandiwa tidak membangun fallback, load balancing, pemilihan provider otomatis, atau optimasi biaya lintas-provider. Batas biaya dapat ditampilkan sebagai informasi berdasarkan request, tetapi keputusan endpoint tetap berada pada pengguna.

### 4.3 Ruleset marketplace yang dapat diperluas

Jika validator dibuat modular, Gandiwa dapat mendukung marketplace selain Adobe Stock dengan ruleset export berbeda tanpa merombak pipeline utama.

### 4.4 Feedback loop sebagai moat

Data accepted/rejected/download yang terhubung ke brief, prompt, model, parameter, dan audit dapat menjadi keunggulan terbesar. Ini lebih bernilai daripada fine-tuning terlalu dini. Setelah data cukup, sistem dapat membuat ranking workflow, rekomendasi model, dan eksperimen terkontrol.

### 4.5 Produk komersial masa depan

Setelah workflow pribadi terbukti, jalur bisnis yang mungkin:

- aplikasi self-hosted/BYOK untuk contributor;
- desktop companion untuk Illustrator/Inkscape;
- validator/preflight sebagai produk terpisah;
- metadata dan portfolio intelligence;
- team workflow untuk studio kecil.

### 4.6 Risiko potensi yang perlu dijaga

Pasar generator AI sudah padat. Jika Gandiwa hanya menawarkan prompt + generate, ia tidak punya pertahanan. Diferensiasi harus dijaga pada compliance-aware workflow, provenance, non-destructive project package, model routing, dan outcome analytics.

## 5. Penilaian Dokumen

| Area | Nilai | Catatan |
|---|---:|---|
| Visi dan problem framing | 8/10 | Jelas dan relevan |
| Diferensiasi produk | 8/10 | Kuat jika fokus pada workflow, bukan generator |
| Scope discipline | 5/10 | P0 terlalu luas |
| Kebenaran aturan format | 5/10 | PNG/submission perlu diperbaiki |
| Arsitektur | 6/10 | Komponen benar, boundary filesystem belum selesai |
| Model data | 6/10 | Dasar kuat, provenance/approval/source-of-truth kurang |
| Security posture | 7/10 | Arah baik, autentikasi belum diputuskan |
| UX/design system | 8/10 | Konsisten; lint bersih |
| Testability | 7/10 | Banyak AC terukur, tetapi benchmark/ruleset belum lengkap |
| Potensi bisnis | 8/10 | Tinggi sebagai orchestration + compliance layer |

**Kesimpulan keseluruhan:** 7/10 — konsep kuat, tetapi belum implementation-ready.

## 6. Rekomendasi Keputusan

### Problem

Gandiwa membutuhkan fondasi submission contract dan boundary filesystem yang benar sebelum banyak fitur dibangun.

### Tiga opsi

**A. Bangun semua P0 sekarang**  
Cepat terlihat lengkap, tetapi risiko integrasi dan rework paling tinggi.

**B. Revisi dokumen lalu bangun vertical slice Photo/Illustration raster lebih dahulu**  
Paling cepat menguji nilai komersial, tetapi kemampuan vector yang menjadi identitas produk tertunda.

**C. Revisi dokumen lalu bangun dua jalur tipis: satu raster dan satu vector sederhana**  
Lebih banyak pekerjaan daripada satu jalur, tetapi menguji janji inti Gandiwa tanpa membangun editor/provider lengkap.

### Rekomendasi

Pilih **C**. Bangun satu jalur raster dan satu jalur SVG minimal, masing-masing dari brief sampai export. Batasi provider awal menjadi 9Router untuk reasoning/metadata dan fal.ai untuk image generation; adapter lain mengikuti kontrak yang sama setelah pipeline lulus end-to-end.

### Definition of Done revisi dokumen

- format generation/master/submission dipisahkan;
- aturan Photo AI photorealistic vs Illustration tercatat;
- browser–backend file transfer terdefinisi;
- autentikasi deployment dipilih;
- source of truth manifest vs SQLite diputuskan;
- provenance, approval, dan generation batch masuk ERD;
- raster preparation memiliki acceptance criteria;
- P0 dipersempit menjadi dua vertical slice;
- aturan Adobe memiliki source dan version;
- typo serta istilah diperbaiki;
- DESIGN.md tetap 0 error dan 0 warning setelah revisi.

## 7. Referensi Resmi

- Adobe Stock Contributor content upload guidelines: https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html
- Adobe Stock generative AI FAQ: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/adobe-stock-generative-ai-faq.html
- Adobe Stock generative AI guidelines: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html
- Adobe Stock vector requirements: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-vectors/technical-requirements-for-vector-submissions.html
