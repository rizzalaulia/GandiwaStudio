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

Issue ini menetapkan kontrak dan validator saja. Create/Open Project, File System Access API, penulisan atomic, deteksi perubahan eksternal, dan rebuild index ke SQLite diimplementasikan oleh issue tahap berikutnya.
