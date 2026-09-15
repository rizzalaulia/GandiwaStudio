# Canonical Hybrid — Keputusan UI/UX Issue #56

**Status:** Disetujui Master Peng pada 14 September 2026 sebagai arah desain sebelum implementasi frontend.

**Artefak interaktif:** [`canonical-hybrid.html`](./canonical-hybrid.html)
**Bukti viewport:** [`1150×917`](./screenshots/canonical-hybrid-1150x917.png) · [`1366×768`](./screenshots/canonical-hybrid-1366x768.png)

## Keputusan

Gandiwa menggunakan **guided three-area production workspace**, bukan tumpukan panel form.

- **Default experience:** task runway — satu pekerjaan durable, satu CTA utama, dan alasan blocker yang jelas.
- **Desktop besar:** project/sidebar gelap + workspace netral terang + contextual inspector.
- **Detail advanced:** evidence, revision tree, audit report, metadata detail, dan timeline dibuka dari Inspect Details/history; tidak mendominasi default flow.

Alur Stage 3–4 tetap:

```text
Prepare revision → Metadata → Audit → Human approval → Export package
```

## Kontrak komposisi

1. Active Project menampilkan paling banyak **satu heavy work form** pada saat yang sama.
2. Setiap state memiliki **tepat satu primary CTA**. CTA tersebut tinggal di task surface; inspector menjelaskan alasan, dampak, dan blocker—bukan menduplikasi aksi.
3. Evidence teknis tersedia lewat disclosure/detail view. Ia tidak boleh menghalangi tindakan berikutnya.
4. Future workflow Stage 5/6 tidak boleh disimulasikan sebagai fitur selesai. Hanya ruang navigasi/ekstensi yang jujur boleh ditampilkan.
5. Tidak ada perubahan pada local-first ownership, manifest v1, validasi evidence, approval, maupun export fail-closed.

## Kontrak responsif

| Lebar viewport | Susunan wajib |
|---|---|
| `≥ 1280px` | Sidebar + workspace + inspector tiga area. |
| `1024–1279px` | Sidebar + workspace; inspector hanya melalui drawer/sheet. |
| `< 1024px` | Navigation collapsible; inspector drawer; CTA penting tetap di workspace. |

Tiga area tidak boleh dipaksa di viewport `1150×917`: minimum 240px sidebar + 620px workspace + 320px inspector, dua gap 24px, dan padding luar sudah melebihi ruang yang tersedia.

## Kontrak visual

```css
--color-primary: #18212F;       /* sidebar/high-hierarchy chrome */
--color-neutral: #F7F8FA;       /* workspace */
--color-surface: #FFFFFF;       /* task surface */
--color-border: #D8DEE8;
--color-accent: #B45309;        /* single workspace CTA */
--color-accent-hover: #92400E;
--color-focus: #2563EB;
--color-success: #166534;       /* verified state only */
```

- Sidebar gelap dipakai untuk navigasi dan project/system context.
- Workspace terang dipakai untuk scanning form, metadata, dan penilaian asset.
- Amber adalah CTA di workspace terang; jangan jadikan teks/action utama pada chrome gelap.
- Status selalu memakai teks/ikon selain warna.
- Hindari gradient dekoratif, kartu bersarang tanpa fungsi, dan panel yang memiliki bobot visual setara.

## State pembuktian mockup

Mockup merepresentasikan keadaan nyata Stage 4:

```text
revision r002 prepared/current
→ metadata incomplete/current task
→ audit, approval, export blocked secara fail-closed
```

Klik `Complete metadata →` memperlihatkan transisi presentasi ke `Run audit →`; ini **bukan** implementasi persistence production dan tidak mengklaim metadata telah ditulis ke project pengguna.

## Handoff implementasi

1. Bangun shell, token, header, stepper, task outlet, dan inspector/drawer sesuai breakpoint di atas.
2. Tambahkan pure `GuidedWorkflowPresentation` dari domain state yang sudah authoritative; jangan memindahkan validasi domain ke UI.
3. Pindahkan preparation, metadata, audit, approval, dan export menjadi satu task aktif per state.
4. Buat evidence detail sebagai surface terpisah lewat Inspect Details/history.
5. Tambahkan UI/accessibility regression untuk state no project, empty, revision required, metadata required, audit states, stale, approval, exporting, dan exported.
6. Manual QA wajib pada 1150×917 dan 1366×768 sebelum #56 dinyatakan selesai.
