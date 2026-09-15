# Tahap 4 Browser Manual-Test Plan

> **Untuk Hermes:** Ini adalah selendang eksekusi manual melalui browser laptop Guru. Jangan mengubah kode, membuka PR, atau menyentuh folder karya asli. Jalankan hanya setelah Guru memberi titah mulai manual test.

**Goal:** Membuktikan alur Tahap 4 pada folder yang benar-benar dimiliki browser laptop Guru: raster master → JPEG revision → metadata → audit → approval manusia → portable export package, lalu membuktikan penolakan/recovery yang penting.

**Arsitektur:** Aplikasi berjalan di VM `bejo1-oracle`, API hanya loopback dan diproxy oleh Vite. Browser laptop Guru mengakses origin HTTPS Tailscale `https://bejo1-oracle.taile0be3c.ts.net`; File System Access API di browser Guru yang membaca/menulis folder lokal Guru. Tidak ada upload asset ke backend dan tidak ada Adobe upload.

**Scope build yang diuji:** `origin/main` commit `82b2231eed3ef6ac7d2d75be9d7babcf4a354a86` (PR #55 merged).

---

## 0. Kriteria kelulusan dan selendang keselamatan

### Definisi lulus manual

1. Folder uji dibuat dari browser pada laptop Guru tanpa menyentuh folder karya nyata.
2. Raster master >= 4 MP menghasilkan revision JPEG lokal non-destruktif.
3. Metadata valid tersimpan di sidecar lokal.
4. Audit durable dan approval manusia tersimpan dan gate menjadi `APPROVED / ADOBE-READY` + `CLEAR`.
5. Export membuat satu package lengkap di `exports/` dengan marker terakhir `export-manifest.json`.
6. Package kedua dengan evidence sama ditolak sebagai collision; package pertama tetap tidak berubah.
7. Perubahan metadata membuat approval/export stale dan tombol export terkunci.
8. Close/reopen tidak menganggap state React lama sebagai approval baru; gate dihitung kembali dari sidecar/durable evidence.

### Larangan

- Jangan memilih folder kerja Adobe Stock, source produksi, atau folder repo GandiwaStudio sebagai folder proyek browser.
- Jangan memilih asset berlisensi/privat yang tidak boleh berada di screenshot test.
- Jangan upload ke Adobe Stock, membuat ZIP, atau mencoba provider generation; itu di luar scope ini.
- Jangan membuka project folder yang sama di dua tab browser bersamaan. File System Access API tidak menyediakan lock/CAS lintas tab.
- Jangan menghapus package partial atau package collision selama test berlangsung; itu adalah evidence recovery.

### Bahan uji yang Guru siapkan

| Bahan | Syarat | Untuk |
|---|---|---|
| `master.png` atau `master.jpg` | Milik Guru/berhak pakai, PNG/JPEG valid, minimal 4,000,000 pixel (mis. 2400×1800), bukan konten sensitif | Happy path raster |
| Folder kosong 1 | `Gandiwa-Manual-01-Happy` di laptop Guru | Proyek happy path |
| Folder kosong 2 | `Gandiwa-Manual-02-Blocked` di laptop Guru | Negative/recovery test |
| Opsional SVG | Hanya bila sudah ada project vector yang *telah* punya revision SVG durable + metadata/audit/approval valid | Cakupan SVG export |

> Rekomendasi nama proyek: `Stage4 Manual Raster <tanggal>`. Buat folder lokal baru via File Explorer terlebih dahulu dan pastikan benar-benar kosong.

---

## 1. Persiapan layanan VM — operator/Bejo

**Tujuan:** Browser laptop Guru memperoleh aplikasi HTTPS dan API proxy yang hidup, tanpa mengekspos API loopback ke jaringan.

### 1.1 Sinkronkan source yang sudah merged

Di `/home/ubuntu/GandiwaStudio`:

```bash
git fetch origin --prune
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

**Harus menghasilkan:** `82b2231eed3ef6ac7d2d75be9d7babcf4a354a86` atau descendant yang Guru setujui.

### 1.2 Siapkan environment manual-test terisolasi

Gunakan database/artifact khusus, jangan memakai database dev/produksi lama:

```bash
export GANDIWA_DATABASE_URL='sqlite:////home/ubuntu/GandiwaStudio/var/manual-test/gandiwa.sqlite3'
export GANDIWA_ARTIFACT_DIR='/home/ubuntu/GandiwaStudio/var/manual-test/artifacts'
export GANDIWA_ALLOWED_ORIGINS='https://bejo1-oracle.taile0be3c.ts.net,http://localhost:5173'
export GANDIWA_PUBLIC_ORIGIN='https://bejo1-oracle.taile0be3c.ts.net'
export GANDIWA_TRUSTED_HOSTS='bejo1-oracle.taile0be3c.ts.net,localhost,127.0.0.1'
export GANDIWA_SESSION_SECRET='<unique-manual-test-secret>'
export GANDIWA_SECURE_COOKIES=true
export GANDIWA_API_PROXY_TARGET='http://127.0.0.1:8000'
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='bejo1-oracle.taile0be3c.ts.net'
```

Buat direktori dan migration:

```bash
mkdir -p var/manual-test/artifacts
corepack pnpm migrate
```

### 1.3 Start dan buktikan service

Terminal A — API hanya loopback:

```bash
uv run --project apps/api uvicorn gandiwa_api.main:app --host 127.0.0.1 --port 8000
```

Terminal B — Vite untuk browser laptop Guru:

```bash
corepack pnpm --filter @gandiwa/web dev --host 0.0.0.0
```

Verifikasi dari VM sebelum memberi URL ke Guru:

```bash
curl -fsS http://127.0.0.1:8000/api/v1/health
curl -fsS https://bejo1-oracle.taile0be3c.ts.net/api/v1/status
```

**Kelulusan:** status API sehat; origin HTTPS dapat dibuka dari laptop Guru; UI menampilkan `Backend connected`. Worker boleh `unavailable`/`idle`, karena alur prepare/audit/export ini tidak membutuhkan generation worker.

**Stop condition:** Jika URL HTTPS, API proxy, permission folder browser, atau host header gagal, berhenti dan catat pesan tepatnya. Jangan mengganti ke URL loopback VM pada browser laptop Guru.

---

## 2. Happy path raster end-to-end — Guru di laptop

**Tujuan:** Membuktikan seluruh rantai durable Stage 4 menggunakan folder browser-owned nyata.

### 2.1 Buat proyek kosong

1. Buka Chrome/Edge terbaru pada laptop Guru:
   `https://bejo1-oracle.taile0be3c.ts.net`
2. Pastikan tulisan `Backend connected` terlihat.
3. Klik **Create Project**.
4. Isi:
   - Project name: `Stage4 Manual Raster <tanggal>`
   - Content type: `Photo` bila master foto; `Illustration` bila ilustrasi raster.
   - Creation method: `Manual digital` untuk master manual; pilih provenance yang benar bila berbeda.
5. Saat folder picker muncul, pilih `Gandiwa-Manual-01-Happy` yang benar-benar kosong.
6. Catat/screenshot pesan `Project ... created locally`.

**Bukti folder:** harus terbentuk `gandiwa-project.json`, `sources/`, `generated/`, `revisions/`, `previews/`, `metadata/`, `reports/`, dan `exports/`.

### 2.2 Preflight sementara

1. Pada **RASTER TECHNICAL PREFLIGHT**, pilih content type tepat.
2. Pilih `master.png`/`master.jpg` pada input **Raster file to preflight**.
3. Catat dimensi, MP, verdict, rule IDs bila ada.

**Kelulusan:** bytes dideteksi sebagai PNG/JPEG yang benar dan dimensi >= 4 MP. Tidak ada write durable yang diklaim pada tahap preflight ini.

### 2.3 Buat JPEG submission revision non-destruktif

1. Pada **JPEG SUBMISSION PREPARATION**, pilih file master yang sama.
2. Setujui permission `readwrite` hanya untuk folder test tersebut.
3. Tunggu pesan revision JPEG disimpan.
4. Di File Explorer, inspeksi `revisions/<asset-id>/`.

**Kelulusan folder:**

```text
revisions/<asset-id>/1/master.png|master.jpeg
revisions/<asset-id>/2/master.jpeg
revisions/<asset-id>/2/preparation.json
```

**Bukti yang dicatat:**

- master revision 1 masih ada dan byte/file asal tidak ditimpa;
- revision 2 adalah JPEG;
- `preparation.json` mencatat `source_checksum`, `submission_checksum`, quality `0.92`, width/height, megapixels, alpha handling, dan color conversion;
- bila input <4 MP, ini harus gagal tanpa membuat revision baru. Uji ini boleh dijalankan di folder `Gandiwa-Manual-02-Blocked`, bukan di happy path.

### 2.4 Isi dan simpan metadata

Pada **STOCK METADATA & AI DISCLOSURE** isi data non-produksi tetapi valid:

- Title: `Manual test coastal landscape`;
- Keywords: minimal lima, contoh `coast, sea, landscape, daylight, test`;
- Category: kategori yang relevan;
- Release status: `Not required` hanya jika memang tidak ada orang/properti yang memerlukan release;
- Creation method, checkbox AI, dan AI disclosure harus konsisten dengan provenance proyek.

Klik **Save metadata locally** dan setujui permission bila diminta.

**Kelulusan:**

```text
metadata/<asset-id>.json
```

ada, valid, dan manifest tidak berubah schema-nya. Screenshot checksum metadata yang tampil pada panel approval.

### 2.5 Audit durable

1. Pada **APPROVAL & ADOBE-READY**, pastikan asset/revision/checksum dan ruleset terlihat.
2. Klik **Audit prepared revision**.
3. Catat finding/rule ID dan verdict.

**Kelulusan:** audit harus tanpa finding `FAIL`; warning boleh ada bila panel tetap mengizinkan approval. Bukti durable:

```text
reports/audits/<asset-id>-r2.json
```

### 2.6 Approval manusia eksplisit

1. Pastikan gate berubah menjadi `READY FOR HUMAN APPROVAL`.
2. Guru sendiri klik:
   **I confirm this revision for manual Adobe Stock submission**.
3. Pastikan gate berubah menjadi:

```text
APPROVED / ADOBE-READY
Export gate: CLEAR
```

**Kelulusan folder:**

```text
reports/approvals/<asset-id>-r2.json
```

ada. Catat bahwa `ADOBE-READY` adalah readiness Gandiwa untuk submission manual, bukan janji Adobe menerima asset.

### 2.7 Export package

1. Pastikan **Export approved package** aktif.
2. Klik satu kali dan setujui permission folder bila diminta.
3. Tunggu pesan sukses yang menyebut package name dan completion marker.
4. Jangan klik ulang.
5. Di File Explorer buka `exports/` dan catat package name.

**Kelulusan folder package:**

```text
exports/<asset-id>-r2-<checksum-16>/
├── final.jpeg
├── metadata.json
├── audit-report.json
├── approval.json
├── gandiwa-project.json
└── export-manifest.json
```

Periksa:

- hanya enam file tersebut yang diperlukan (tidak ada original source, secret, path absolut, provider output, ZIP);
- `final.jpeg` ada dan dapat dibuka sebagai JPEG;
- `export-manifest.json` ada dan JSON valid;
- field manifest mencatat asset/revision/format/ruleset/checksum dan daftar file;
- `final.jpeg` hash sama dengan `submissionChecksum` di export manifest.

**Opsional hash lokal laptop:**

PowerShell:

```powershell
Get-FileHash .\final.jpeg -Algorithm SHA256
Get-Content .\export-manifest.json
```

Bandingkan `Hash` final JPEG dengan `submissionChecksum`.

---

## 3. Negative dan recovery tests — folder kedua

**Tujuan:** Membuktikan selendang fail-closed tanpa merusak happy-path evidence.

### 3.1 Input <4 MP ditolak

1. Buat proyek baru dalam `Gandiwa-Manual-02-Blocked`.
2. Pada JPEG preparation pilih PNG/JPEG yang kurang dari 4 MP.

**Harus terjadi:** pesan minimal-4-MP / tidak ada deceptive upscale; tidak muncul revision 2 atau manifest revision baru.

### 3.2 Metadata invalid mengunci chain

Pada project happy path **setelah package pertama sudah dibuktikan**, ubah metadata jadi sengaja invalid, misalnya kurang dari lima keyword, lalu coba save.

**Harus terjadi:** save ditolak atau tombol disabled; approval/export tidak memperoleh status baru yang salah.

Untuk stale valid-save test (opsional, karena akan mengubah evidence): ubah title menjadi valid, simpan, lalu pastikan:

```text
Export gate: BLOCKED
```

Tombol export disabled sampai audit dan approval dijalankan ulang. Package lama harus tetap utuh; tidak boleh ada overwrite.

### 3.3 Existing deterministic package collision

Sesudah export sukses pertama, tanpa mengubah revision/evidence, klik **Export approved package** sekali lagi.

**Harus terjadi:** export ditolak dengan pesan package sudah ada/refusing overwrite. Inspeksi package pertama: file dan `export-manifest.json` lama tetap ada/tidak berubah.

### 3.4 Close/reopen recompute

1. Klik **Close project**.
2. Pastikan panel approval/export menghilang atau kembali blocked.
3. Klik **Open Project**, pilih kembali folder happy path.
4. Izinkan read permission saat browser meminta.

**Harus terjadi:** project dibuka dari bukti durable. UI tidak boleh memakai state lama; gate dihitung ulang dari manifest, metadata, audit, dan approval. Bila semua evidence masih cocok, status approved dapat kembali. Bila evidence diubah, harus blocked/stale.

### 3.5 External manifest change dialog (opsional, hati-hati)

Hanya bila Guru siap membuat copy folder ketiga. Jangan edit `gandiwa-project.json` pada satu-satunya happy-path evidence.

1. Copy keseluruhan project happy path menjadi `Gandiwa-Manual-03-External-Change`.
2. Buka copy tersebut di app.
3. Dari File Explorer/text editor, ubah satu field project manifest secara valid JSON.
4. Kembali ke app dan klik **Check for external changes**.

**Harus terjadi:** dialog menawarkan Reload / Save current manifest as copy / Cancel; aplikasi tidak menimpa manifest luar otomatis.

---

## 4. Cakupan SVG: status dan batasan manual

Issue #20 writer dan resolver memiliki test otomatis JPEG dan SVG. Namun UI Tahap 4 yang tersedia sekarang menyediakan **SVG security preflight sementara + PNG preview**, bukan tombol untuk membangun revision SVG durable dari nol seperti raster preparation.

Karena itu:

- uji SVG preflight manual dapat dilakukan dengan SVG statis aman dan cukup membuktikan PNG preview, rule IDs, serta raw SVG tidak dipreview langsung;
- uji export SVG manual **hanya** dilakukan jika Guru sudah mempunyai folder test vector yang valid dan berisi revision SVG durable, metadata, durable audit, dan approval yang semuanya sesuai checksum;
- jangan memalsukan folder/evidence hanya agar tombol export SVG menyala. Jika belum ada workflow pembentukan vector durable, catat cakupan SVG browser manual sebagai **belum dapat dieksekusi dari UI saat ini**, sementara automated resolver/writer coverage tetap lulus.

---

## 5. Artefak bukti yang Guru simpan

Simpan di folder catatan terpisah, bukan di dalam package export:

1. Screenshot URL HTTPS dengan `Backend connected`.
2. Screenshot preflight dimensi/MP.
3. Screenshot panel approval: asset ID, revision, checksums, ruleset, `CLEAR`.
4. Screenshot pesan export sukses.
5. Screenshot/File Explorer struktur package lengkap.
6. Salinan teks `export-manifest.json` (boleh sensor bila asset sensitif).
7. Screenshot collision export yang ditolak.
8. Screenshot stale/blocked setelah metadata berubah (jika skenario dijalankan).
9. Catatan browser/version/OS laptop dan waktu test.

Template ringkas hasil:

```text
Tanggal/waktu:
Browser + versi:
Origin HTTPS:
Commit main:
Folder happy path:
Master format + pixel:
Preparation result:
Audit verdict/findings:
Approval gate:
Export package path:
Checksum final vs manifest:
Collision result:
Close/reopen result:
SVG manual status: executed / not applicable (reason)
Bug/observasi:
```

---

## 6. Exit criteria dan tindak lanjut

### Lulus operasional

Berikan status `MANUAL BROWSER PROOF PASS` hanya bila seluruh bagian 2.1–2.7 dan 3.3–3.4 lulus, serta bukti dicatat.

### Bila gagal

- Jangan menghapus partial package atau mengulang di folder yang sama.
- Catat pesan UI lengkap, screenshot, struktur folder saat gagal, browser/version, dan langkah reproduksi.
- Bila terjadi export error sesudah package folder tercipta tetapi tanpa marker valid, klasifikasikan sebagai **recovery artifact**, bukan export sukses.
- Buat folder test baru untuk percobaan ulang agar collision evidence tidak tertimpa.

### Setelah selesai

Operator menghentikan tepat proses API/Vite manual-test dan memverifikasi port 8000/5173 sudah tidak listen. Jangan hapus folder browser test sampai Guru menyatakan evidence sudah tidak dibutuhkan.
