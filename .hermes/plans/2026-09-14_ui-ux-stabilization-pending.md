# PENDING — UI/UX Stabilization sebelum Workflow UI Ditambah

> Status: **PENDING / belum menjadi GitHub Issue**. Dibuat dari keluhan langsung Master Peng pada manual browser test Tahap 4.
>
> **Keputusan produk:** UI/UX saat ini cukup mengganggu untuk menjadi utang produk prioritas tinggi. Jangan menambah layar/workflow Tahap 5 ke pola halaman yang sama sebelum desain ini disetujui dan diterapkan.

## Bukti dan diagnosis

- Screenshot browser Guru: `/home/ubuntu/.hermes/images/upload_20260914_031655_2.png` (1150×917).
- Runtime yang diuji: `main` pada commit `82b2231eed3ef6ac7d2d75be9d7babcf4a354a86`.
- Implementasi sekarang menaruh semua workflow di satu `Active Project` panel:
  - raster technical preflight,
  - JPEG submission preparation,
  - stock metadata & AI disclosure,
  - audit,
  - approval,
  - portable export.
- Hasilnya adalah halaman form panjang dengan banyak panel sejajar secara visual. Pengguna tidak tahu tindakan utama, posisi dalam alur, alasan gate terkunci, atau bagian mana yang boleh diabaikan.

## Problem yang harus diselesaikan

1. **Hirarki kerja hilang.** Semua blok setara, padahal alur wajib adalah revision → metadata → audit → approval → export.
2. **Tindakan utama tidak jelas.** Tombol/field tersebar dan status gate tidak mengarahkan pengguna ke blocker berikutnya.
3. **Beban visual terlalu tinggi.** Terlalu banyak border, panel gelap, eyebrow monospace, helper text, serta form tampil sekaligus.
4. **Preflight dan preparation tercampur.** Preflight sementara tampak seolah bagian proses wajib/project-durable.
5. **State kosong, blocked, stale, dan ready kurang terbaca sebagai perjalanan.** Pengguna harus menyimpulkan sendiri sebab-akibat antar-section.
6. **Tahap 4 tidak terasa sebagai capaian UI.** Portable export hanya menjadi section bawah, bukan puncak proses yang dapat dipahami.

## Arah solusi — bukan “rapikan CSS”

Bangun ulang pengalaman **Active Project Workspace** sebagai workflow yang terarah, tanpa mengubah kontrak local-first, evidence durability, atau fail-closed gate.

### Struktur yang dituju

- Header project ringkas dan sticky: nama proyek, asset/revision aktif, state keseluruhan, serta satu CTA utama.
- Progress rail/stepper eksplisit:
  1. Prepare revision
  2. Complete metadata
  3. Run audit
  4. Human approval
  5. Export package
- Hanya langkah aktif dan blocker relevan yang terbuka secara dominan.
- Langkah selesai diringkas dan dapat dibuka kembali; bukan tetap memakan layar.
- Preflight ditempatkan sebagai alat bantu di dalam Prepare, tidak bersaing dengan workflow durable.
- Semua gate memuat alasan manusiawi dan satu CTA ke tindakan yang tepat, misalnya:
  - `Metadata belum valid → Lengkapi metadata`
  - `Audit belum ada → Jalankan audit`
  - `Approval belum diberikan → Tinjau lalu setujui`
  - `Evidence berubah → Perbarui audit`
- Export dijadikan final confirmation panel setelah status `ADOBE_READY/CLEAR`, tetap browser-local dan tidak menjanjikan penerimaan Adobe.

### Visual system yang dituju

- Kurangi panel bersarang, border berulang, dan teks teknis yang selalu terlihat.
- Tingkatkan whitespace serta perbedaan ukuran/berat heading yang memperjelas skala informasi.
- Status memakai teks + ikon + warna yang accessible; jangan bergantung pada warna saja.
- Detail teknis (checksum, ruleset ID, evidence path) tetap tersedia melalui disclosure/“lihat detail”, bukan memenuhi tampilan default.
- Responsif laptop 1366×768 dan viewport screenshot 1150×917: tindakan berikutnya dan status workflow harus terlihat tanpa scrolling panjang.

## Acceptance criteria wajib

### UX/browser

- [ ] Setelah project dibuka, pengguna dapat mengetahui langkah berikutnya dalam ≤5 detik tanpa membaca dokumentasi.
- [ ] Dalam viewport 1150×917, header proyek, progres, status gate, dan CTA langkah berikutnya terlihat tanpa perlu mencari ke bawah.
- [ ] Pengguna tidak melihat lebih dari satu form kerja berat terbuka secara default.
- [ ] State no asset, incomplete, blocked, stale, audit pass with warnings, `ADOBE_READY`, dan export sukses punya copy serta tindakan lanjutan yang jelas.
- [ ] Preflight sementara dinyatakan jelas sebagai non-durable dan tidak mengaburkan tombol prepare revision.
- [ ] Detail teknis audit/evidence tetap dapat diakses keyboard dan screen reader.
- [ ] Tidak ada klaim bahwa `ADOBE_READY` berarti diterima Adobe.

### Kontrak/regresi

- [ ] Semua kontrak Tahap 2–4 yang ada tetap fail-closed: metadata, audit, approval, dan export hanya dapat berjalan pada evidence current.
- [ ] Lifecycle invalidation tetap benar pada project switch/close/reload, metadata save, revision creation, dan late async result.
- [ ] Tidak ada source/project folder write baru di backend.
- [ ] Tambahkan test UI untuk stepper/CTA state dan test keyboard/accessibility untuk navigasi penting.
- [ ] Manual browser review wajib memakai screenshot before/after pada viewport 1150×917 serta laptop 1366×768.

## Batas scope

**Masuk:** information architecture, active-project workflow, visual hierarchy, responsive/accessibility remediation, UI tests, manual visual QA.

**Tidak masuk:** provider/generation, queue, Adobe upload, ZIP, perubahan manifest v1, atau pelonggaran approval/export gate.

## Urutan yang aman

1. Audit UX dengan screenshot state nyata: empty, prepared, blocked, stale, ready, exported.
2. Buat wireframe/prototype dan putuskan struktur stepper + CTA bersama Guru.
3. Pecah implementasi menjadi slice kecil: shell/layout → state/CTA mapping → details/accessibility → visual regression/manual QA.
4. TDD dan independent UX/code review.
5. Jangan menumpuk Issue #26 (brief/generation/gallery UI) ke `App.tsx` pola saat ini sebelum shell workflow ini selesai atau ada keputusan eksplisit Guru untuk menanggung utang UX tersebut.

## GitHub tracking

Belum dibuat issue GitHub karena Master belum memberi titah eksplisit untuk perubahan eksternal. Saat diminta, judul yang disarankan:

`Redesign active-project workflow to restore visual hierarchy and guided Stage 4 UX`

Label kandidat: `priority:P0`, `type:task`, `area:frontend`; stage perlu ditentukan Guru karena backlog resmi sekarang melompat dari Stage 4 ke Stage 5.
