---
version: alpha
name: Gandiwa Studio
description: "Ruang kerja kreatif yang tenang, presisi, dan transparan untuk produksi aset stock berbantuan AI."
colors:
  primary: "#18212F"
  secondary: "#536174"
  accent: "#B45309"
  accent-hover: "#92400E"
  neutral: "#F7F8FA"
  surface: "#FFFFFF"
  border: "#D8DEE8"
  success: "#166534"
  warning: "#854D0E"
  danger: "#B91C1C"
  info: "#1D4ED8"
  text-primary: "#111827"
  text-secondary: "#4B5563"
  focus: "#2563EB"
typography:
  display:
    fontFamily: Inter
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  h1:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  h2:
    fontFamily: Inter
    fontSize: 1.125rem
    fontWeight: 650
    lineHeight: 1.4
  body-md:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.04em"
rounded:
  sm: 4px
  md: 8px
  lg: 12px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: 12px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 12px
  navigation-panel:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 16px
  workspace-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: 16px
  status-pass:
    backgroundColor: "#DCFCE7"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: 8px
  status-warning:
    backgroundColor: "#FEF3C7"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: 8px
  status-fail:
    backgroundColor: "#FEE2E2"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: 8px
  app-shell:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.text-primary}"
    padding: 16px
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  helper-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
  status-info:
    backgroundColor: "#DBEAFE"
    textColor: "{colors.info}"
    rounded: "{rounded.sm}"
    padding: 8px
  focus-indicator:
    backgroundColor: "{colors.focus}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: 4px
---

## Overview

Gandiwa Studio harus terasa seperti meja kerja kreatif yang presisi, bukan generator gambar sekali klik. Identitas visual memadukan warna arang gelap, permukaan netral, dan aksen amber yang terinspirasi dari kayu serta logam pusaka. Tampilan harus tenang agar karya pengguna menjadi pusat perhatian.

Aplikasi desktop-first menggunakan pola tiga area: navigasi proyek, canvas/preview utama, dan inspector kontekstual. Status sistem, provider tujuan, content type, dan format output selalu terlihat sebelum generasi.

## Colors

- **Primary:** navigasi dan area berhierarki tinggi.
- **Accent:** aksi utama seperti Generate dan Export; hanya satu aksi accent dominan per panel.
- **Neutral/Surface:** latar aplikasi serta kartu tanpa bersaing dengan artwork.
- **Success/Warning/Danger:** status preflight. Ikon dan teks wajib mendampingi warna.
- Checkerboard transparansi menggunakan variasi netral, bukan accent.
- Artwork tidak boleh diberi color cast oleh background UI.

## Typography

Inter dipakai untuk seluruh antarmuka agar ringkas dan terbaca pada panel padat. Label metadata dan status memakai `label`, tetapi hindari kapital semua untuk paragraf. Judul panel singkat; penjelasan aturan audit memakai body-sm dengan line-height longgar.

## Layout

- Desktop target minimum: 1280×720.
- Sidebar proyek: 240–280px.
- Inspector kanan: 320–380px dan dapat ditutup.
- Canvas memakai sisa ruang serta mendukung zoom/pan.
- Grid dasar 8px; token 4px hanya untuk jarak mikro.
- Panel Generate menampilkan urutan: content type → format → provider/model → brief → parameters → action.
- Di bawah 1024px, inspector menjadi drawer; editor tetap berfokus pada canvas.

## Elevation & Depth

Gunakan border sebagai pemisah utama. Shadow hanya untuk dialog, menu mengambang, tooltip, dan kandidat yang sedang di-drag. Jangan menumpuk kartu di dalam kartu tanpa kebutuhan hierarki.

## Shapes

Radius sedang mencerminkan tool profesional: tidak tajam, tetapi tidak menyerupai aplikasi anak. Thumbnail boleh memakai radius 8px. Canvas dan checkerboard tidak dipotong berlebihan agar batas artwork tetap jelas.

## Components

### Content Type Selector

Tiga kartu eksklusif: Photo, Illustration, Vector. Setiap kartu memuat ikon, deskripsi satu baris, dan format yang didukung. Setelah job dibuat, tipe ditampilkan sebagai badge terkunci; perubahan memulai job baru.

### Format Selector

Hanya menampilkan format valid bagi content type dan capability model. Opsi disabled wajib menjelaskan alasannya melalui helper text, bukan tooltip saja.

### Provider and Model Selector

Menampilkan konektor API, endpoint, model, capability, dan koneksi tujuan yang dipilih pengguna. Tidak ada mode auto-route. Jika pengguna memilih 9Router, UI memperlakukannya sebagai satu konektor API; combo/fallback di dalamnya tidak dikendalikan Gandiwa. Koneksi yang tidak sehat tetap terlihat dengan status dan tombol Test Connection, tetapi tidak dapat digunakan untuk job baru.

### Candidate Gallery

Thumbnail seragam dengan indikator format, resolusi, content type, dan status audit. Pemilihan master harus eksplisit dan dapat dibatalkan.

### Canvas and Inspector

Canvas mendukung zoom, pan, checkerboard, background putih/gelap, serta fit-to-screen. Inspector SVG memuat transform, fill, opacity, layer order, visibility, dan delete. Operasi yang tidak didukung diarahkan ke editor eksternal.

### Audit Center

Temuan dipisah antara **Deterministic Check**, **AI Review**, dan **Human Confirmation**. PASS/WARNING/FAIL selalu memiliki ikon, label teks, rule ID, versi ruleset, bukti, dan saran tindakan. Temuan AI memakai bahasa probabilistik dan tidak dapat menyamar sebagai kepastian. Banner `Audit stale` wajib muncul setelah artwork atau metadata relevan diedit.

### Adobe-Ready Gate

Panel export menampilkan generation, working/master, dan submission format secara terpisah. Tombol export submission dinonaktifkan sampai revisi terkini lulus blocking checks, metadata/disclosure lengkap, dan disetujui pengguna. Badge `Adobe-ready` wajib disertai keterangan bahwa status bukan jaminan penerimaan moderator.

### Job Status

Job berjalan tetap terlihat saat pengguna berpindah panel. Tampilkan tahap, durasi, provider, tombol cancel bila didukung, dan error yang sudah direduksi tanpa secret.

## Do's and Don'ts

### Do

- Tampilkan content type dan format sebelum tombol Generate.
- Tampilkan provider tujuan sebelum aset dikirim keluar perangkat.
- Bedakan rule deterministik dari opini AI.
- Pertahankan source asli dan tampilkan nomor revisi.
- Gunakan progressive disclosure untuk parameter lanjutan.
- Pastikan fokus keyboard terlihat jelas.
- Sediakan empty state yang mengarahkan tindakan berikutnya.

### Don't

- Jangan menyimpan API key pada browser atau manifest proyek.
- Jangan menjanjikan "pasti diterima Adobe Stock".
- Jangan memakai warna sebagai satu-satunya penanda status.
- Jangan memenuhi workspace dengan gradient dekoratif.
- Jangan mengaktifkan format yang tidak didukung model.
- Jangan merender SVG tidak tepercaya sebelum sanitasi.
- Jangan menyembunyikan kegagalan provider di balik pesan generik tanpa ID job.
