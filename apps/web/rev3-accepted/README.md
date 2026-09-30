# Gandiwa Rev3, frontend kanonikal

Direktori ini adalah satu-satunya sumber frontend statis yang dilayani untuk Gandiwa Studio.

- Layanan: `gandiwa-rev3-front.service`
- Direktori layanan: `/home/ubuntu/GandiwaStudio/apps/web/rev3-accepted`
- URL Tailnet: `https://bejo1-oracle.taile0be3c.ts.net/rev3-accepted/`
- Backend API: jalur relatif `/api/v1`, melalui proxy Tailnet yang sama

`apps/web/legacy-frontend/` menyimpan artefak desain dan smoke test yang dipensiunkan sebagai referensi sejarah. Itu bukan frontend aktif dan tidak boleh menjadi target deployment.

## Gate aktif

Jalankan dari direktori ini:

```sh
node --check rev3-api.js
node --check rev3-create.js
for f in smoke-approval-digest-canonical.mjs smoke-backend-wiring.mjs smoke-candidate-gallery.mjs smoke-create-real-wiring.mjs smoke-metadata-real-wiring.mjs smoke-prepare-real-wiring.mjs smoke-queue-status-display.mjs smoke-rev3-polish.mjs smoke-revision-ledger-audit.mjs smoke-revisions-real-wiring.mjs smoke-theme-unification.mjs; do node "$f"; done
```

Saat file yang dilayani berubah, naikkan query versi aset pada halaman HTML agar browser mengambil berkas terbaru.
