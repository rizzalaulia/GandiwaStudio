# Kontrak Project Manifest Portabel

Status: berlaku untuk Issue #9, schema version `1`.

`gandiwa-project.json` adalah sumber kebenaran kreatif yang tinggal di folder proyek milik pengguna. Browser Chrome/Edge memegang directory handle dan satu-satunya pihak yang menulis folder ini. Backend tidak menerima path lokal absolut dan tidak memakai manifest untuk menyimpan credential atau state runtime.

## Struktur v1

```json
{
  "schema_version": 1,
  "project_id": "lowercase canonical UUID",
  "project_name": "Nama yang ditampilkan pengguna",
  "assets": [
    {
      "asset_id": "lowercase canonical UUID",
      "content_type": "photo | illustration | vector",
      "creation_method": "camera | manual_digital | generative_ai | mixed",
      "revisions": [
        {
          "revision": 1,
          "generation_format": "png | jpeg | svg",
          "working_format": "png | jpeg | svg",
          "master_format": "png | jpeg | svg",
          "submission_format": "jpeg | svg",
          "relative_path": "revisions/<asset-id>/<revision>/master.<master_format>"
        }
      ]
    }
  ]
}
```

Schema bersifat allowlist ketat. Field yang tidak dikenal ditolak, termasuk `api_key`, token, absolute path, atau container queue. Tidak ada normalisasi diam-diam saat validasi: input valid dikembalikan sebagai nilai yang sama.

## Aturan Integritas

- UUID menggunakan bentuk canonical lowercase untuk `project_id` dan `asset_id`.
- `content_type` hanya `photo`, `illustration`, atau `vector`; nilainya melekat pada asset dan tidak diganti diam-diam.
- `creation_method` hanya `camera`, `manual_digital`, `generative_ai`, atau `mixed`, sesuai `ADOBE-RULESET.md`.
- Nomor revision positif dan unik di dalam asset. `asset_id` dan `relative_path` unik pada proyek.
- Semua path memakai `/`, relatif, normal (`.` dan `..` ditolak), tidak boleh Windows drive/UNC/absolute, dan wajib berada di bawah `revisions/`.
- Path master wajib memiliki extension yang sama dengan `master_format`.
- Empat field format tidak boleh digabungkan. Vector selalu SVG. Photo dan Illustration raster memakai kerja raster serta submission JPEG. Illustration native-vector selalu SVG.

## Proyek Baru (Issue #10)

Create Project membuat `gandiwa-project.json` valid dengan `assets: []`. Pilihan `content_type` dan `creation_method` diminta di form sebagai intent asset pertama, tetapi **tidak** ditulis sebagai metadata proyek: schema v1 hanya mengizinkan kedua nilai itu pada asset, sementara asset tanpa revision tidak valid.

Pengguna memilih **folder proyek kosong** sebagai workspace final. Browser memeriksa folder tersebut sebelum menulis; folder yang sudah memuat file atau subfolder pada saat inspeksi ditolak tanpa write maupun delete. File System Access API tidak menyediakan transaksi create-exclusive/lock lintas tab atau proses; pengguna tidak boleh membiarkan proses lain mengubah folder yang sedang diinisialisasi. Nama yang ditampilkan pengguna tetap berada pada `project_name` di manifest. Browser lalu membuat `sources/`, `generated/{photo,illustration,vector}/`, `revisions/`, `previews/`, `metadata/`, `reports/`, dan `exports/` langsung pada folder yang dipilih. Semua detail divalidasi sebelum picker dibuka. Nama proyek tidak boleh kosong, `.`/`..`, slash/backslash, null byte, atau lebih dari 80 karakter.

File System Access API melakukan commit isi file saat stream ditutup (`close()`), tetapi tidak menyediakan operasi rename atau create-exclusive directory yang portabel. Untuk folder kosong baru, implementasi menulis temporary manifest, lalu manifest final sebagai commit marker terakhir; temporary file wajib dibersihkan. Bila temporary cleanup tidak dapat dipastikan atau struktur/write manifest gagal, browser **tidak** menghapus folder pilihan otomatis. UI menyuruh pengguna memeriksa folder pilihan sebelum menghapus atau memakainya kembali. Tidak ada janji atomic replace lintas-browser untuk proyek yang sudah ada; Open Project dan save/reopen merupakan tahap terpisah.

## Buka, Tutup, dan Reopen Proyek (Issue #11)

Browser menyimpan satu directory handle proyek terakhir secara browser-local melalui IndexedDB, bukan path absolut, asset proyek, secret, atau mekanisme sync. Saat halaman dibuka, handle hanya dipreload tanpa query/request permission. Saat pengguna menekan **Reopen remembered project**, aplikasi memanggil `requestPermission({ mode: 'read' })` langsung dari aksi klik sebelum operasi async lain, lalu membaca dan memvalidasi manifest. Ini menjaga transient user activation yang diwajibkan browser; tidak ada prompt permission otomatis ketika halaman dibuka. Handle hanya diingat setelah manifest valid dibaca. Bila penyimpanan handle lokal gagal, proyek yang sudah valid tetap terbuka/terbuat pada sesi ini dan UI memberi warning jujur bahwa Reopen lintas sesi belum tersedia.

Open/reopen hanya membaca `gandiwa-project.json` dengan `{ create: false }`, lalu memvalidasinya melalui kontrak schema v1. JSON invalid atau schema lebih baru ditolak tanpa rewrite/destructive migration. Close Project hanya melepas state workspace di layar; folder dan handle browser-local tidak dihapus.

Snapshot byte manifest dicatat saat open. Pemeriksaan perubahan eksternal membaca manifest kembali; bila berbeda, Gandiwa tidak menimpa salah satu versi. Pengguna harus memilih **Reload external manifest**, **Save current manifest as copy** (download browser, bukan write ke folder proyek), atau **Cancel**. Ini bukan built-in sync engine dan tidak melakukan merge otomatis.

## Persiapan Raster JPEG (Issue #17)

Untuk asset raster yang belum memiliki revision durable, pengguna memilih PNG/JPEG melalui aksi **JPEG Submission Preparation** pada project yang terbuka. Browser, bukan backend, melakukan seluruh operasi berikut:

1. membaca snapshot `gandiwa-project.json` yang dibuka dan menolak operasi bila byte manifest berubah dari luar;
2. menyimpan bytes source apa adanya sebagai `revisions/<asset-id>/1/master.png` atau `master.jpeg`;
3. menggambar source ke canvas browser pada dimensi asli, dengan latar putih saat JPEG tidak mendukung alpha, tanpa resize/upscale;
4. menulis JPEG hasil sebagai `revisions/<asset-id>/2/master.jpeg` serta `preparation.json` yang mencatat revision sumber, SHA-256 source dan hasil, quality, dimensi, megapixel, alpha handling, dan color space;
5. menulis manifest v1 yang valid hanya setelah semua artifact revision selesai ditulis.

Operasi gagal sebelum write bila JPEG hasil kurang dari 4 MP atau encoder tidak menghasilkan struktur JPEG yang valid. Source/master tidak pernah ditimpa. Perubahan revision/checksum membuat hasil Audit Center sebelumnya tidak berlaku; UI membersihkan audit lama dan meminta preflight ulang. Ini hanya menyiapkan kandidat teknis, **bukan** approval manusia, metadata lengkap, export package, atau status `ADOBE_READY`.

Jika folder berubah setelah snapshot dibaca, browser menolak sebelum menulis artifact. File System Access API tidak menyediakan transaksi lintas-proses untuk keseluruhan folder; bila write manifest akhir gagal setelah artifact revision ditulis, artifact tersebut adalah recovery data lokal yang harus diperiksa pengguna, dan manifest lama tetap menjadi source of truth.

## Metadata Stock dan AI Disclosure (Issue #18)

Metadata submission disimpan browser-local sebagai sidecar berversi `metadata/<asset-id>.json`, bukan sebagai field tambahan dalam `gandiwa-project.json` schema v1. Sidecar memuat `schemaVersion`, title, daftar keyword berurutan, category, deklarasi submission `contentType`/`creationMethod`, flag `generated_with_ai`, disclosure AI, dan status release (`not_required`, `attached`, atau `needs_review`). Penyimpanan hanya terjadi setelah pengguna memberi permission `readwrite` dari aksi tombol dan browser memastikan snapshot manifest tidak berubah. Manifest tidak dimutasi oleh editor metadata.

Saat membuka proyek, browser membaca dan memvalidasi sidecar asset terakhir tanpa write, termasuk terhadap provenance immutable asset. Sidecar yang secara struktur valid tetapi mengosongkan disclosure untuk asset `generative_ai` juga ditolak tanpa ditulis ulang. Snapshot byte sidecar disimpan pada editor; sebelum save, browser memeriksa ulang manifest dan sidecar. Bila sidecar muncul atau berubah dari tab/proses lain, save ditolak dan pengguna harus reload—tidak ada overwrite diam-diam. File sidecar korup juga ditolak tanpa ditulis ulang.

Editor menampilkan `content_type` dan `creation_method` dari asset sebagai provenance read-only. Sidecar memiliki deklarasi submission `contentType` dan `creationMethod` yang dapat diedit tanpa mengubah sejarah asset di manifest; keduanya bukan pengganti provenance asset. Jika declaration berbeda dari provenance, UI menampilkan warning eksplisit untuk ditinjau sebelum submission. Title, category, dan sedikitnya lima keyword diperlukan. Bila flag AI aktif, `creationMethod` submission adalah `generative_ai`, **atau provenance asset** adalah `generative_ai`, disclosure AI non-kosong tetap wajib. Indikasi keyword brand/trademark atau nama artis hanya warning yang dapat ditinjau manusia; aplikasi tidak menyimpulkan hak atau kelayakan Adobe dari kata semata.

Issue ini belum mengimplementasikan approval/release uploader. Audit Center yang ada masih file-bound dan belum membawa binding durable `asset_id`; karena itu setiap metadata save membuat audit aktif menjadi stale dan export tetap blocked sampai audit baru selesai (fail-closed, bukan menebak kecocokan asset). Sidecar metadata bukan bukti bahwa model/property release sudah diverifikasi atau dilampirkan.

## Batas Rebuild

Manifest dapat dipakai untuk membangun ulang **creative cache/index**: `asset_id`, `content_type`, nomor revision, dan path revision. Ini adalah satu-satunya hasil rebuild yang disediakan kontrak saat ini.

Manifest tidak memuat dan tidak dapat memulihkan state durable backend, termasuk konfigurasi backend, session/secret, queue dan priority/FIFO, lease/heartbeat, attempt/remote dispatch outcome, event, temporary artifact/expiry, ataupun moderation feedback. State tersebut tetap menjadi tanggung jawab backup SQLite/backend sesuai ADR-0001 dan ADR-0002.

Issue #12 menyediakan rebuild SQLite disposable yang mengganti atomik baris index untuk `project_id` manifest setelah seluruh manifest lolos validasi. Index hanya menyimpan `project_id`, `asset_id`, `content_type`, nomor revision, dan `relative_path`; rebuild yang sama idempotent dan tidak menghapus index proyek lain. Manifest/reference korup menghasilkan finding `invalid_manifest_reference` yang actionable dan meninggalkan index lama apa adanya. Karena backend tidak memegang directory handle atau path absolut folder browser, pemeriksaan apakah file fisik hilang dilakukan browser pada tahap import, bukan oleh rebuild backend.

## Konformansi TypeScript–Python

Corpus bersama ada di `tests/fixtures/project-manifest/`:

- `conformance.json` mendaftarkan setiap fixture beserta verdict-nya;
- validator TypeScript di `@gandiwa/contracts` menjalankan corpus dengan Node built-in test runner;
- validator Python di `gandiwa_api.project_manifest` menjalankan corpus yang sama melalui pytest.

Tambahkan fixture dahulu saat mengubah schema. Kedua validator harus berubah bersama dan lulus terhadap corpus identik. CI menjalankan sisi TypeScript; backend-quality menjalankan sisi Python.

## Non-goal Issue #9

Issue #9 menetapkan kontrak dan validator. Issue #10 mengimplementasikan Create Project untuk folder baru, dan Issue #11 mengimplementasikan Open, Close, Reopen, serta deteksi perubahan manifest eksternal. Rebuild index ke SQLite tetap menjadi tahap berikutnya.
