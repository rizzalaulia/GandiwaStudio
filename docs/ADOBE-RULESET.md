# Adobe Stock Ruleset — Gandiwa Studio

**Ruleset ID:** `adobe-stock-2026-09-08-v1`  
**Status:** Dikunci untuk MVP  
**Tanggal verifikasi sumber:** 8 September 2026  
**Tujuan:** Kontrak generation, audit, dan export; bukan jaminan penerimaan moderator.

## 1. Sumber Resmi

- Upload guidelines: https://helpx.adobe.com/stock/contributor/content-policies-guidelines/content-policies/content-upload-guidelines.html
- Generative AI guidelines: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html
- Generative AI FAQ: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/adobe-stock-generative-ai-faq.html
- Vector technical requirements: https://helpx.adobe.com/stock/contributor/submit-your-content/submit-vectors/technical-requirements-for-vector-submissions.html

Aturan dapat berubah. MVP tidak memperbarui ruleset secara otomatis. Perubahan hanya melalui ruleset baru, test fixture baru, dan persetujuan pemilik produk.

## 2. Istilah Format

- **Generation format:** format mentah yang dikembalikan provider.
- **Working format:** format selama proses edit/audit.
- **Master format:** salinan kualitas tertinggi yang dipertahankan.
- **Submission format:** file final yang disiapkan untuk unggah Adobe Stock.

| Content type | Generation/working | Master | Submission MVP |
|---|---|---|---|
| Photo | PNG atau JPEG | PNG lossless atau JPEG sumber | JPEG |
| Illustration raster | PNG atau JPEG | PNG lossless atau JPEG sumber | JPEG |
| Illustration vector | SVG | SVG | SVG |
| Vector | SVG | SVG | SVG |

AI/EPS diterima Adobe untuk jalur yang sesuai, tetapi ekspor native AI/EPS berada di luar MVP.

## 3. Klasifikasi dan Provenance

`content_type` wajib dipilih sebelum generate: `photo`, `illustration`, atau `vector`.

`creation_method` wajib dicatat terpisah:

- `camera`
- `manual_digital`
- `generative_ai`
- `mixed`

Gambar generative AI photorealistic yang secara wajar dapat tampak seperti tangkapan kamera diklasifikasikan sebagai Photo. Hasil generative AI lainnya diklasifikasikan sebagai Illustration, kecuali hasilnya merupakan vector native yang mengikuti jalur Vector.

Setiap job menyimpan snapshot: ruleset ID, provider, endpoint type, model ID/revision jika tersedia, adapter version, prompt final, seed jika tersedia, parameter, waktu, content type, creation method, dan format.

## 4. Aturan Universal

### Generation constraints

- Tidak meminta logo, merek, nama perusahaan, karakter terlindungi, atau peniruan gaya artis tertentu.
- Tidak meminta readable text kecuali workflow memang memerlukan teks dan legalitasnya ditinjau; default stock generation adalah tanpa huruf/kata.
- Brief harus menetapkan tujuan komersial, subjek, komposisi, dan batasan content type.
- Provider/model harus memiliki capability yang sesuai format/tugas.

### Post-generation checks

- File dapat dibaca dan MIME cocok dengan format.
- Tidak ada logo/merek, karakter terlindungi, nama artis, gibberish text, artifact berat, atau cacat visual nyata.
- Similarity/recolor adalah warning dan membutuhkan keputusan manusia.
- AI legal review hanyalah risk screening, bukan legal clearance.
- Hasil AI wajib memiliki `generated_with_ai=true` dan disclosure pada metadata.

## 5. Ruleset Photo

### Blocking technical rules

- Submission format harus JPEG.
- Resolusi minimum 4 megapiksel (`width × height >= 4,000,000`).
- File dapat didekode dan tidak rusak.
- Tidak ada alpha channel pada JPEG final.
- Metadata content type dan creation method tersedia.

### Human/AI review

- Photorealism masuk akal untuk kategori Photo.
- Focus, exposure, noise, compression, warna, anatomi, refleksi, bayangan, dan geometri ditinjau.
- Logo, merek, tulisan, wajah/properti yang memerlukan release, serta artifact generatif ditinjau.

PNG dari provider hanya working/master; proses export mengonversinya ke JPEG lalu menjalankan ulang seluruh blocking rules.

## 6. Ruleset Illustration

### Illustration raster

- Submission format harus JPEG.
- Resolusi minimum MVP: 4 megapiksel sebagai quality gate internal.
- File dapat didekode, tidak rusak, dan tidak memiliki alpha pada JPEG final.
- Style, garis, fill, anatomi, perspektif, komposisi, serta artifact ditinjau.

### Illustration vector

- Submission format MVP harus SVG.
- Wajib lulus seluruh Vector technical rules.

## 7. Ruleset Vector

### Blocking technical rules

- Submission format MVP harus SVG.
- Document color intent RGB.
- XML dan SVG valid; `viewBox`, width/height, serta artboard valid.
- Tidak ada embedded/linked raster (`image`), external resource, script, event handler, atau executable content.
- Tidak ada unresolved live text/font dependency pada submission final.
- Tidak ada empty path, invalid geometry, atau artwork tak sengaja di luar artboard.
- Semua referenced ID, clipping path, mask, gradient, dan filter terselesaikan.
- File hasil sanitasi dapat dirender.
- Render sebelum dan sesudah cleanup berada dalam ambang parity yang ditetapkan fixture.

### Warning rules

- Node/object count melewati ambang performa.
- Stray point atau objek mikro terdeteksi.
- Filter/blend mode berpotensi berbeda antar-renderer.
- Kandidat terlalu mirip atau hanya recolor.

## 8. Injection Contract pada Setiap Job

Setiap request dibentuk dari:

```text
brief pengguna
+ immutable universal constraints
+ content-type constraints
+ format/capability constraints
+ parameter provider
= resolved request
```

Constraint immutable tidak boleh dihapus dari UI. Gandiwa tidak harus menjejalkan seluruh checklist audit ke negative prompt; rule ditandai sebagai salah satu dari `prompt`, `deterministic_postcheck`, `ai_review`, atau `human_confirmation`.

Sebelum request dikirim, sistem memvalidasi:

1. content type dan creation method dipilih;
2. format generasi valid;
3. provider/model dipilih eksplisit;
4. capability cocok;
5. snapshot ruleset dibuat.

## 9. Audit Lifecycle dan Invalidation

Audit wajib berjalan:

1. setelah artifact diterima;
2. setelah sanitasi/normalisasi;
3. setelah setiap edit yang mengubah pixel/path/metadata relevan;
4. setelah konversi submission format;
5. tepat sebelum export package dibuat.

Setiap audit dan approval terikat pada `asset_revision_id`, `ruleset_id`, dan checksum. Edit atau perubahan metadata setelah approval membuat audit/approval terkait menjadi `stale`; status `ADOBE_READY` dicabut otomatis.

## 10. Final Export Gate

Status workflow:

`GENERATED → WORKING → NEEDS_REVIEW → TECHNICALLY_VALID → ADOBE_READY → EXPORTED`

`ADOBE_READY` hanya diberikan jika:

- klasifikasi dan provenance lengkap;
- submission format valid;
- seluruh blocking deterministic rule PASS;
- AI review selesai dan ditampilkan sebagai rekomendasi;
- legal/release checklist dikonfirmasi pengguna;
- metadata lengkap dan AI disclosure benar;
- approval manusia terikat pada revisi, audit, ruleset, dan checksum terkini.

`ADOBE_READY` berarti siap berdasarkan ruleset Gandiwa, bukan dijamin diterima Adobe Stock.

## 11. Metadata Minimum

- Title deskriptif dan relevan.
- Keywords relevan, dapat diurutkan, tanpa spam atau nama merek/artis terlarang.
- Content type.
- Category.
- Creation method.
- Generated-with-AI disclosure bila berlaku.
- Release status: `not_required`, `attached`, atau `needs_review`.

## 12. Test Fixtures Minimum

Ruleset dianggap terimplementasi hanya bila fixture berikut lulus:

- Photo JPEG tepat di bawah dan di atas 4 MP.
- PNG Photo yang harus dikonversi sebelum Adobe-ready.
- JPEG rusak dan MIME/extension mismatch.
- SVG valid sederhana.
- SVG dengan embedded raster, script, event handler, external URL, live text, broken reference, invalid viewBox, dan empty path.
- Revisi setelah approval yang harus mencabut Adobe-ready.
- Metadata AI tanpa disclosure yang harus memblokir export.
- Illustration SVG yang wajib menjalani vector rules.
