# Change Request Tahap 5 — Creative Workflow Terpandu (9Router + fal.ai)

> **Status: DITERAPKAN 2026-09-15** dengan titah Master Peng (“terapkan”).
> Issue kontrak: **#58**. Komentar klarifikasi terpasang di #24, #25, #26,
> #27, #29. Dokumen sinkron: `docs/DEVELOPMENT-SEQUENCE.md`
> (change request 2026-09-15) dan `.github/gandiwa-dependencies.json`.
> Berkas ini adalah rekaman draf perencanaan; sumber resmi kini berada di
> dokumen dan issue tersebut.

## 0. Ringkasan keputusan produk (hasil brainstorming 2026-09-15)

Pemisahan peran AI untuk Tahap 5:

```text
9Router  = otak: brainstorming 3-in-1, penyusun & pengkritik prompt,
           vision analysis hasil generate, penyusun metadata suggestion.
fal.ai   = tangan: satu-satunya mesin generate gambar.
Guru     = keputusan: approve konsep, prompt, hasil visual, metadata.
Gandiwa  = paku bumi: GENERATION_READY gate, provenance, revision,
           preflight/audit/approval/export fail-closed (tidak berubah).
```

Target: **one-shot first, not one-shot guaranteed** — 1 prompt → 1 job → 1 gambar,
kandidat berikutnya hanya lewat regenerate yang membentuk revision baru.

Editor SVG Tahap 6: **ditunda**, tidak dihapus (#27 tetap terbuka, bukan jalur aktif;
#29 scope-nya menunggu penilaian ulang).

## 1. Masalah baseline

- Tahap 5 dalam baseline hanya memandang 9Router sebagai generation connector
  sejajar fal.ai (#21–#25), padahal keputusan produk 2026-09-15 menetapkan
  9Router sebagai assistant reasoning/vision dan fal.ai sebagai generator.
- Alur kreatif (brainstorming → prompt → generate → vision review → metadata)
  belum memiliki rumah kontrak: tidak ada issue untuk creative session,
  pre-generation readiness gate, maupun assistant adapter.
- Prompt mentah yang dikirim ke fal.ai berisiko menghasilkan output di bawah
  4 MP / melanggar stock constraints → pemborosan kuota, billing, dan credits.

## 2. Perubahan yang diusulkan

1. `DEVELOPMENT-SEQUENCE.md` Tahap 5 diperjelas:
   - konektor wajib **fal.ai** (generation) dan **9Router** (assistant);
   - "satu job 9Router end-to-end" dihitung sebagai **assistant job**
     (brainstorm/prompt/vision), bukan generation job;
   - gerbang baru **GENERATION_READY** sebelum pemanggilan fal.ai.
2. Issue baru (draf di bawah): *Creative session, assistant adapter, and
   pre-generation readiness gate* — pekerjaan kontrak/backend Tahap 5,
   paralel dengan #21/#23, dikonsumsi oleh #26.
3. Komentar klarifikasi di #24/#25 (peran masing-masing konektor) dan #26
   (gallery = riwayat revision + queue one-shot, bukan batch kandidat).
4. #27 dan #29 diberi catatan status **deferred** melalui change control ini.

## 3. Alternatif yang dipertimbangkan

- (a) 9Router tetap generation connector sejajar fal.ai — ditolak: tidak
  sesuai keputusan produk dan memaksakan model reasoning untuk tugas gambar.
- (b) Menahan seluruh Tahap 5 sampai desain selesai — ditolak: kontrak
  non-UI (#21–#23) dapat berjalan tanpa memperburuk workspace (preseden
  change request 2026-09-14).
- (c) Membangun brainstorming/gate langsung di dalam #26 — ditolak: mencampur
  kontrak backend dengan UI melanggar pola vertikal repo ini.

## 4. Dampak

- Keamanan: tidak berubah — credential tetap backend-only (#24), tanpa
  routing/fallback (#23), evidence fail-closed tetap.
- Data: tambah **sidecar** `creative-sessions/` & provenance generation
  di luar manifest v1; manifest tidak diubah.
- UX: #26 menjadi workflow terpandu lanjutan dari #56 (satu task + satu CTA).
- Jadwal: Tahap 6 mundur (ditunda); Tahap 5 backend tetap jalan paralel.
- Testing: tambah gate deterministik GENERATION_READY (TDD), schema-validasi
  output assistant, dan failure paths assistant (timeout/schema/auth).

## 5. Dokumen yang disinkronkan

`DEVELOPMENT-SEQUENCE.md`, `.github/gandiwa-dependencies.json`,
issue #24, #25, #26, #27, #29 (komentar), issue baru (dibuat setelah titah).

## 6. Persetujuan pemilik produk

- [ ] Master Peng menyetujui change request ini (tanggal: ____).

---

# DRAFT — Issue baru Tahap 5

**Judul:** Implement creative session, assistant adapter, and GENERATION_READY gate

**Stage:** Tahap 5 — see `docs/DEVELOPMENT-SEQUENCE.md`.

**Dependencies:** none blocking (paralel dengan #21/#23); dikonsumsi oleh #26.

## Scope and acceptance criteria

Implement the product-approved creative workflow contracts (decision 2026-09-15):
9Router = reasoning/vision assistant, fal.ai = image generator, one-shot-first
generation, human approves every creative decision.

Acceptance criteria:
- Creative session sidecar (project-local, versioned, outside manifest v1)
  records: topic, 3-in-1 brainstorm rounds (3 questions + 1 recommendation),
  guru answers, approved concept, prompt snapshot, generation provenance,
  vision review, metadata suggestion, and each human approval.
- Assistant adapter (9Router) exposes bounded operations with schema-validated
  responses: `brainstorm`, `finalize_prompt`, `analyze_image`, `suggest_metadata`;
  malformed/timeout responses fail closed and never reach fal.ai.
- GENERATION_READY is a deterministic pure gate: non-empty prompt+negative
  prompt, explicit provider/model, explicit content type & creation method,
  target resolution ≥ 4 MP with aspect ratio, stock constraints present
  (no logo/brand/watermark/random text/fake UI/unintentional crop/malformed
  anatomy/copyrighted property), no unresolved placeholders, capability match.
- fal.ai is never called unless GENERATION_READY and the human approved the prompt.
- Generated output is stored as a NEW revision (never overwrites source or
  prior revision); prior audit/approval evidence becomes stale/blocked.
- Vision analysis is advisory only: it can never set audit verdict,
  ADOBE_READY, or bypass any deterministic gate.
- Metadata from the assistant is a suggestion; durable sidecar writes only
  after explicit human confirmation (existing metadata contract unchanged).
- Regenerate requires a meaningful prompt change or recorded rejection reason;
  identical re-dispatch is refused with a warning before burning credits.
- CI uses no live provider credential; fake provider fixtures cover
  success/schema-error/timeout for the assistant and generation paths.

## Required engineering discipline

- Follow TDD for new behavior.
- Update relevant documentation and fixtures.
- Do not add Gandiwa-owned provider routing/fallback.
- Do not expose secrets or private assets.
- A PR must include real test/build evidence.

---

# DRAFT — Komentar klarifikasi issue terbuka

## #24 (9Router connector)

> Klarifikasi peran (change request 2026-09-15, menunggu persetujuan):
> 9Router pada Tahap 5 dipakai sebagai **assistant** (reasoning/vision/
> metadata), bukan image generator. Acceptance "satu job 9Router end-to-end"
> pada sequence berarti satu assistant job end-to-end. Kontrak connector
> (#23) tetap berlaku untuk adapter ini.

## #25 (fal.ai connector)

> Klarifikasi peran (change request 2026-09-15): fal.ai adalah satu-satunya
> image generator; pemanggilan hanya boleh terjadi setelah GENERATION_READY
> dan persetujuan prompt oleh manusia (issue creative-session gate).

## #26 (brief/generate/gallery/queue UI)

> Penyesuaian acceptance "candidate compare" (change request 2026-09-15):
> generasi bersifat **one-shot-first** — 1 prompt → 1 job → 1 gambar;
> "candidate compare" dipenuhi sebagai perbandingan antar revision hasil
> regenerate (riwayat revision + status queue), bukan batch kandidat.
> UI juga mengonsumsi creative session + GENERATION_READY gate (issue baru).

## #27 / #29 (editor & verifikasi vector)

> Status **deferred** melalui change control 2026-09-15: kebutuhan perbaikan
> hasil digantikan oleh regenerate-as-new-revision pada Tahap 5; editor
> ringan tetap terbuka sebagai pekerjaan masa depan, bukan jalur aktif MVP.
