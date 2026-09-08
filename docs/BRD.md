# Business Requirements Document — Gandiwa Studio

**Status:** Draft v1.0  
**Produk:** Gandiwa Studio  
**Pemilik:** Master Peng / Padepokan Digital  
**Tahap:** MVP pribadi, single-user

## 1. Ringkasan Bisnis

Gandiwa Studio adalah aplikasi web privat untuk merancang, menghasilkan, menyunting ringan, memeriksa, dan menyiapkan aset **Photo, Illustration, atau Vector** bagi workflow Adobe Stock Contributor. Jenis konten dipilih sejak awal agar jalur generasi, pemeriksaan, format ekspor, dan metadata mengikuti persyaratan tipe aset tersebut.

Aplikasi menggunakan pola konektor API/BYOK. Pengguna memilih provider dan model secara eksplisit untuk setiap pekerjaan. Backend dapat memanggil API model langsung—seperti OpenAI, Anthropic, atau fal.ai—atau memanggil endpoint 9Router melalui Tailscale. Gandiwa tidak melakukan routing, load balancing, maupun fallback antar-provider; bila endpoint yang dipilih adalah 9Router, seluruh perilaku routing merupakan tanggung jawab 9Router.

## 2. Latar Belakang dan Masalah

Workflow produksi stock saat ini tersebar antara generator AI, editor gambar/vector, pemeriksa kualitas, penyusun metadata, dan penyimpanan file. Akibatnya:

- pilihan tipe aset dan format sering baru dipikirkan setelah generasi;
- prompt, hasil, metadata, serta riwayat revisi tidak tersimpan sebagai satu proyek;
- hasil vector dapat tampak benar tetapi secara teknis sulit diedit atau mengandung raster;
- audit legal, kualitas, dan kemiripan batch tidak konsisten;
- pergantian provider AI membutuhkan perubahan workflow;
- API key berisiko tersebar jika koneksi dilakukan langsung dari frontend.

## 3. Tujuan Bisnis

1. Mengurangi pekerjaan manual berulang dari ide sampai paket siap unggah.
2. Menjaga klasifikasi Photo, Illustration, atau Vector sejak awal produksi.
3. Memanfaatkan subscription AI yang sudah dimiliki tanpa terkunci pada satu provider.
4. Meningkatkan konsistensi pemeriksaan teknis, visual, legal, dan metadata.
5. Mengumpulkan data hasil moderasi Adobe Stock sebagai dasar peningkatan prompt, workflow, dan kemungkinan fine-tuning di masa depan.

## 4. Sasaran Pengguna

### Pengguna MVP

Satu pengguna: Master Peng sebagai Adobe Stock Contributor sekaligus operator aplikasi.

### Kebutuhan utama

- memilih jenis konten sebelum generate;
- memilih provider/model sesuai tugas;
- menyimpan hasil ke folder laptop;
- membandingkan beberapa kandidat;
- melakukan edit vector ringan;
- memperoleh laporan preflight yang transparan;
- mengekspor aset dan metadata secara terorganisasi.

## 5. Ruang Lingkup Bisnis MVP

### Termasuk

- pembuatan dan pembukaan proyek melalui File System Access API;
- klasifikasi awal: **Photo**, **Illustration**, atau **Vector**;
- output generasi: PNG, JPEG, atau SVG sesuai matriks tipe konten;
- koneksi privat ke backend Gandiwa;
- konektor 9Router/Tailscale, OpenAI, Anthropic, fal.ai, dan OpenAI-compatible;
- profil model berdasarkan peran: art director, generator, auditor, metadata writer;
- brief terstruktur, prompt, negative prompt, dan riwayat generasi;
- galeri kandidat dan perbandingan hasil;
- editor SVG ringan: warna, posisi, ukuran, layer, hapus objek, dan preview;
- audit teknis deterministik serta audit berbantuan AI;
- metadata: judul, keyword, kategori, dan label generative AI;
- paket export siap ditinjau sebelum upload manual;
- pencatatan hasil moderasi Adobe Stock secara manual.

### Tidak termasuk

- editor node/path penuh sekelas Adobe Illustrator;
- training atau fine-tuning model pada MVP;
- inference model AI lokal yang membutuhkan GPU;
- kolaborasi dan multi-user;
- cloud sync bawaan;
- upload otomatis ke Adobe Stock;
- ekspor AI/EPS native;
- jaminan bahwa aset pasti diterima moderator.

## 6. Pemangku Kepentingan

| Pihak | Peran | Kepentingan |
|---|---|---|
| Master Peng | Pemilik produk dan pengguna | Efisiensi, kualitas aset, fleksibilitas provider |
| Padepokan Digital | Pengembang/operator | Arsitektur aman, terpelihara, dan dapat dikembangkan |
| Provider AI | Pemasok kemampuan model | Request sesuai kontrak API dan subscription |
| Adobe Stock | Marketplace tujuan | Aset mematuhi persyaratan teknis, legal, dan metadata |

## 7. Aturan Bisnis

1. Content type wajib dipilih sebelum generation job dibuat.
2. Kombinasi content type dan format harus valid: Photo memakai PNG/JPEG; Vector memakai SVG; Illustration dapat memakai PNG/JPEG atau SVG jika jalurnya native vector.
3. Content type hasil yang sudah dibuat tidak boleh diganti diam-diam; perubahan membuat job baru.
4. API key hanya disimpan dan digunakan oleh backend.
5. AI review bersifat rekomendasi; pemeriksaan deterministik dan persetujuan pengguna menjadi quality gate.
6. Aset dengan blocking FAIL tidak boleh berstatus Ready for Export.
7. Source asli tidak boleh ditimpa oleh edit atau cleanup.
8. Upload ke Adobe Stock tetap manual pada MVP.
9. Sistem tidak boleh menjanjikan kelulusan moderasi.
10. Hasil yang dibuat menggunakan generative AI harus memiliki disclosure pada metadata.

## 8. Kebutuhan Bisnis Utama

| ID | Kebutuhan | Prioritas |
|---|---|---|
| BR-01 | Membuat proyek berbasis folder milik pengguna | Must |
| BR-02 | Memilih Photo, Illustration, atau Vector sejak awal | Must |
| BR-03 | Menghasilkan PNG, JPEG, atau SVG sesuai aturan | Must |
| BR-04 | Mengganti provider/model tanpa merombak aplikasi | Must |
| BR-05 | Menyimpan secret di backend dan meredaksi log | Must |
| BR-06 | Membandingkan kandidat dan menetapkan master | Must |
| BR-07 | Menyunting SVG secara ringan dan non-destruktif | Must |
| BR-08 | Menjalankan preflight teknis dan audit berbantuan AI | Must |
| BR-09 | Menyiapkan metadata dan paket export | Must |
| BR-10 | Mencatat hasil moderasi untuk pembelajaran | Should |

## 9. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Perbedaan kemampuan provider | Job gagal atau format salah | Registry capability dan validasi sebelum request |
| SVG berisi script/external resource | Risiko keamanan browser | Sanitasi server-side dan CSP ketat |
| SVG hasil tracing terlalu kompleks | Editor tersendat | Ambang node, worker, dan preview-only |
| API key bocor | Kerugian akun/biaya | Backend-only secret, redaksi log, rotasi key |
| File System Access API tidak didukung | Project tidak dapat dibuka | Target Chrome/Edge dan export/import package |
| Audit AI memberi keyakinan palsu | Aset buruk tetap diekspor | Label rekomendasi dan human approval wajib |
| Provider atau Tailscale tidak tersedia | Generasi terhenti | Health check, retry terbatas, provider alternatif |

## 10. Indikator Keberhasilan

- satu workflow lengkap dari brief sampai export dapat dilakukan dalam satu aplikasi;
- seluruh aset memiliki content type dan format yang valid;
- tidak ada secret pada frontend, project manifest, atau log;
- technical FAIL teruji selalu memblokir export;
- waktu produksi turun minimal 30% dibanding baseline manual setelah masa uji;
- hasil moderasi dapat dilacak kembali ke provider, model, prompt, dan audit yang digunakan.

## 11. Kontrak Adobe dan Quality Gate

Setiap generation job wajib membawa snapshot ruleset Adobe yang aktif. Format generasi/working/master dipisahkan dari submission format. Aturan prompt, pemeriksaan deterministik, AI review, konfirmasi manusia, audit invalidation, dan status `ADOBE_READY` mengikuti `ADOBE-RULESET.md`.

PNG adalah format kerja/master yang diizinkan, tetapi bukan submission raster Adobe-ready. Photo dan Illustration raster diekspor sebagai JPEG; Vector dan Illustration vector diekspor sebagai SVG pada MVP.

## 12. MVP LOCK — Persetujuan dan Batas Keputusan

**Baseline terkunci:** `mvp-1.0`, ruleset `adobe-stock-2026-09-08-v1`.

Dokumen ini menjadi fondasi kebutuhan bisnis MVP. Detail implementasi mengikuti `PRD.md`, model data mengikuti `ERD.md`, identitas antarmuka mengikuti `DESIGN.md`, dan kontrak Adobe mengikuti `ADOBE-RULESET.md`.

Ruang lingkup yang dikunci:

- single-user, web desktop-first, Chrome/Edge;
- folder proyek laptop dimiliki browser melalui File System Access API;
- pengguna memilih Photo/Illustration/Vector, creation method, endpoint, dan model secara eksplisit;
- Gandiwa hanya API client/orchestrator, bukan router;
- konektor MVP wajib: 9Router dan fal.ai; konektor langsung lain mengikuti kontrak yang sama tetapi tidak memblokir rilis MVP;
- output kerja PNG/JPEG/SVG; submission MVP JPEG atau SVG sesuai ruleset;
- editor SVG ringan, preflight, AI risk screening, metadata, approval, dan export package;
- upload Adobe Stock tetap manual.

Perubahan yang menambah multi-user, cloud sync, fine-tuning, inference lokal berat, editor vector penuh, AI/EPS native, routing/fallback, atau upload otomatis merupakan change request pasca-MVP. Perubahan baseline memerlukan revisi BRD/PRD/ERD/ruleset dan persetujuan pemilik produk; fitur tidak boleh masuk hanya karena mudah dibuat.
