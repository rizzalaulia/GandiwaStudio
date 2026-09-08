# ADR-0002: Local-First Browser Filesystem Boundary

- **Status:** Accepted
- **Date:** 2026-09-08
- **Decision owner:** Master Peng

## Context

Gandiwa harus memberi pengguna kepemilikan atas source, revision, metadata, report, dan export. File System Access API memberi directory handle kepada browser, sedangkan backend remote tidak dapat menggunakan handle tersebut. MVP juga tidak akan membangun sinkronisasi cloud.

## Decision

- Browser Chrome/Edge adalah pemilik directory handle dan satu-satunya komponen yang menulis folder proyek pengguna.
- `gandiwa-project.json` dan path relatif menjadi source of truth portabel.
- Backend menerima input yang diperlukan secara temporary, memprosesnya, lalu menyediakan artifact + checksum untuk diambil browser.
- SQLite backend hanya menyimpan konfigurasi/cache/index/runtime queue dan dapat direkonsiliasi atau dibangun ulang dari manifest untuk data kreatif portabel.
- Path absolut dan API key dilarang masuk manifest.
- Penulisan manifest dilakukan melalui temporary file dan atomic replace bila filesystem mendukung.
- Sinkronisasi folder antarperangkat bukan fitur Gandiwa MVP. Pengguna bebas mengelolanya di luar aplikasi.

## Consequences

- Pengguna menguasai dan dapat memindahkan project folder.
- Backend tidak menanggung permanent asset storage.
- Browser harus memperoleh ulang permission bila browser/OS meminta.
- Job backend dapat selesai ketika browser ditutup, tetapi artifact baru masuk folder lokal setelah browser mengambil dan menulisnya.
- Perubahan eksternal atau concurrent write harus dideteksi agar manifest tidak ditimpa buta.

## Revisit Trigger

Perubahan menuju hosted workspace, multi-user collaboration, atau built-in sync memerlukan ADR dan baseline pasca-MVP baru.