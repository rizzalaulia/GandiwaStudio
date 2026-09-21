# Issue #24 — 9Router named instances, Slice C: smoke container → Tailnet

Status: **dokumen prosedur manual**; belum ada smoke yang dijalankan.
Bukan klaim selesai Issue #24. Gate Issue #24 tetap: Slice A + B tuntas, lalu
prosedur ini dieksekusi dan hasilnya dicatat di bagian _Rekaman Jalannya Smoke_.

## Tujuan

Membuktikan dari runtime container Gandiwa (host produksi `bejo2-vnic`,
diakses lewat tailnet) bahwa **kedua instance 9Router bernama** dapat
dipanggil end-to-end lewat endpoint OpenAI-compatible (`/v1/models`):

1. `studio-a` — origin `http://<TAILNET_IP_A>:20128/v1`
2. `studio-b` — origin `http://<TAILNET_IP_B>:20128/v1`

Tanpa routing, tanpa fallback antar instance. Pilihan instance selalu manusia;
autorouting adalah urusan 9Router sendiri, bukan Gandiwa.

## Prasyarat

- Backend container Gandiwa sudah berjalan di `bejo2-vnic` mengikuti
  `docs/DEPLOYMENT-BEJO2.md` (layout `/opt/gandiwa`, non-root,
  `no-new-privileges`, tanpa Docker socket).
- File `/etc/gandiwa/gandiwa.env` **di VM (bukan di repo)** memuat env kedua
  instance sesuai mekanisme konfigurasi Slice B pada branch ini (lihat
  `apps/api/src/gandiwa_api/config.py` untuk nama variabel final) — base URL
  + API key per instance. **API key tidak pernah masuk Git, log, atau
  respons browser.** Contoh di dokumen ini memakai `STUDIO_A_*`/`STUDIO_B_*`
  sebagai placeholder; ganti dengan nama env final Slice B saat eksekusi.
- Kedua origin harus lolos `validate_9router_base_url`: host tailnet saja,
  path berakhiran `/v1`.
- Tailscale di kedua sisi aktif; tidak menyentuh Tailscale Serve, Nginx, atau
  sertifikat apa pun selama smoke.

## Langkah smoke (per instance, ulangi untuk A lalu B)

Semua perintah dijalankan di `bejo2-vnic`. Kunci dibaca ke shell variable
dari env file produksi dan **tidak pernah di-echo**; pastikan tidak ada
output yang membawa kunci tersimpan di history terminal.

1. **Reachability dari VM (pra-container):**

   ```bash
   set -a; . /etc/gandiwa/gandiwa.env; set +a
   # Ganti nama variabel di bawah dengan env final Slice B (lihat config.py).
   KEY_A_VAR="STUDIO_A_API_KEY"; URL_A_VAR="STUDIO_A_BASE_URL"
   curl -sS -o /dev/null -w 'studio-a /v1/models HTTP=%{http_code}\n' \
     --max-time 10 "${!URL_A_VAR}/models" \
     -H "Authorization: Bearer ${!KEY_A_VAR}"
   # harap HTTP 200; 401/403 = kunci salah; timeout = tailnet putus
   # ulangi dengan KEY_B_VAR/URL_B_VAR (STUDIO_B_*) untuk studio-b
   ```

2. **Reachability dari dalam container** (bukti jalur container→Tailnet):

   ```bash
   # Jalankan dari host, setelah step 1 melewati 200; KEY_A/URL_A di-parse
   # dari env file (shell variable, tidak pernah di-echo).
   CT=$(docker ps --filter name=gandiwa --format '{{.Names}}' | head -1)
   KEY_A_VAL="${!KEY_A_VAR}"; URL_A_VAL="${!URL_A_VAR}"
   docker exec -e URL_A="$URL_A_VAL" -e KEY_A="$KEY_A_VAL" "$CT" sh -lc '
     curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 "$URL_A/models" \
     -H "Authorization: Bearer $KEY_A"'
   # harap 200, dari container, bukan hanya host
   # (di dalam container kunci hanya hidup di env proses curl, tidak di log)
   ```

3. **Listing provider backend** (kontrak Slice B): kedua instance tampil
   sebagai entry terpisah dan **configured**, tanpa base URL atau kunci di
   payload:

   ```bash
   # GANDIWA_ORIGIN_CONTOH = origin lokal backend, mis. http://127.0.0.1:8000
   curl -sS "$GANDIWA_ORIGIN_CONTOH/api/v1/providers" | tee /tmp/providers.json
   # harap: dua entry 9Router (studio-a, studio-b), masing-masing configured
   # tolak bila payload memuat base_url atau kunci apa pun
   ```

4. **Satu assistant job per instance (opsional, bila alur Tahap 5 sudah
   dipasang):** dari UI, pilih instance eksplisit di picker sebelum prompt,
   jalankan satu job `brainstorm` per instance, harap `succeeded` dengan
   `remote_job_id` tercatat. Bila alur assistant UI belum tersedia, tandai
   langkah ini deferred — gate end-to-end penuh dihitung pada Tahap 5
   (`docs/DEVELOPMENT-SEQUENCE.md`).

## Pembatalan / kegagalan jujur

- HTTP 200 di langkah 1 tapi gagal di langkah 2 → masalah jaringan container
  (cek compose network, bukan kunci).
- 401/403 → kunci env file salah/salah ketik; perbaiki di VM, jangan pernah
  menaruh kunci pada perintah yang tercetak layar (masuk log shell).
- Salah satu instance gagal → **tidak boleh** ditambal lewat instance satunya;
  smoke dinyatakan gagal untuk instance itu tanpa fallback.

## Rekaman Jalannya Smoke

Kosong diisi saat eksekusi manual — tidak boleh diisi sebelum bukti nyata.

| Tanggal | Instance | Langkah | Hasil (HTTP/status) | Eksekutor |
| --- | --- | --- | --- | --- |
| — | studio-a | 1–3 | — | — |
| — | studio-b | 1–3 | — | — |

## Perubahan yang TIDAK dilakukan dokumen ini

- Tidak mengubah origin Nginx, Tailscale Serve, atau sertifikat.
- Tidak menyimpan kunci, base URL tailnet real, atau token ke repo.
- Tidak menambah routing/fallback/kombo antar instance di Gandiwa.
