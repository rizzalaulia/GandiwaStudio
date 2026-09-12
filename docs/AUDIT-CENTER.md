# Audit Center

Issue #16 menambahkan tampilan audit deterministik untuk hasil pemeriksaan raster dan SVG pada workspace aktif.

## Kontrak tampilan

Audit Center selalu menampilkan:

- status teks `PASS`, `WARNING`, `FAIL`, atau `STALE`;
- export gate `CLEAR` atau `BLOCKED`;
- ruleset ID dan versi ruleset;
- asset revision ID dan checksum;
- setiap finding: rule ID, verdict, evidence, dan remediation.

Warna hanya pelengkap. Status juga tersedia melalui teks, `role="status"`, dan label aksesibilitas sehingga makna tidak bergantung pada persepsi warna.

## Gate dan stale state

Finding `FAIL` dari rule blocking membuat export gate `BLOCKED`. Warning tetap ditampilkan dan tidak memblokir gate bila tidak ada blocking failure.

Audit menjadi `STALE` apabila revision atau checksum aset saat ini berbeda dari konteks audit. Audit stale selalu memblokir gate dan harus dijalankan ulang. Ruleset ID dan versinya ikut ditampilkan agar hasil dapat ditelusuri.

## Batas Issue #16

Implementasi ini menyajikan hasil technical preflight secara ephemeral di browser. Ia belum membuat asset/revision durable, belum menjalankan approval manusia, dan belum memberikan status `ADOBE_READY`. Itu adalah pekerjaan tahap berikutnya; tampilan Audit Center tidak boleh dianggap sebagai jaminan penerimaan Adobe Stock.

Sumber rule dan definisi ruleset tetap mengikuti [`ADOBE-RULESET.md`](ADOBE-RULESET.md). Preflight raster dan SVG tetap mengikuti kontrak masing-masing, termasuk boundary CSRF, preview PNG sementara, dan larangan membocorkan source bytes.

## Verifikasi

```bash
corepack pnpm --filter @gandiwa/web exec vitest run src/audit-center.test.ts src/App.test.tsx
corepack pnpm check
```
