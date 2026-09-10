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

## Batas Rebuild

Manifest dapat dipakai untuk membangun ulang **creative cache/index**: `asset_id`, `content_type`, nomor revision, dan path revision. Ini adalah satu-satunya hasil rebuild yang disediakan kontrak saat ini.

Manifest tidak memuat dan tidak dapat memulihkan state durable backend, termasuk konfigurasi backend, session/secret, queue dan priority/FIFO, lease/heartbeat, attempt/remote dispatch outcome, event, temporary artifact/expiry, ataupun moderation feedback. State tersebut tetap menjadi tanggung jawab backup SQLite/backend sesuai ADR-0001 dan ADR-0002.

## Konformansi TypeScript–Python

Corpus bersama ada di `tests/fixtures/project-manifest/`:

- `conformance.json` mendaftarkan setiap fixture beserta verdict-nya;
- validator TypeScript di `@gandiwa/contracts` menjalankan corpus dengan Node built-in test runner;
- validator Python di `gandiwa_api.project_manifest` menjalankan corpus yang sama melalui pytest.

Tambahkan fixture dahulu saat mengubah schema. Kedua validator harus berubah bersama dan lulus terhadap corpus identik. CI menjalankan sisi TypeScript; backend-quality menjalankan sisi Python.

## Non-goal Issue #9

Issue #9 menetapkan kontrak dan validator. Issue #10 mengimplementasikan Create Project untuk folder baru, dan Issue #11 mengimplementasikan Open, Close, Reopen, serta deteksi perubahan manifest eksternal. Rebuild index ke SQLite tetap menjadi tahap berikutnya.
