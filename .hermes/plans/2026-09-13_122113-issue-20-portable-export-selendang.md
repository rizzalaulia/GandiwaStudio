# Issue #20 — Portable Export Package Implementation Plan

> **For Hermes / coding agent:** Execute this plan in small TDD slices. Do not improvise scope, do not weaken Issue #19 gate semantics, and do not open/merge a PR without Master Peng’s explicit instruction.

**Issue:** [#20 — Implement portable export package](https://github.com/rizzalaulia/GandiwaStudio/issues/20)

**Goal:** Let the browser write a deterministic, integrity-verifiable Adobe-ready export package for the current approved asset revision into the user-owned project folder, without altering source/master bytes or `gandiwa-project.json`.

**Base commit:** `093cf728f6ccf128450c9a8012753c19111ab7b4` (`Feat/issue 19 approval queue (#54)`) on `origin/main`.

**Architecture:** Export is a **browser-local File System Access API operation**, not a backend API, ZIP generator, browser download, cloud upload, Adobe uploader, or manifest schema migration. The exporter must freshly resolve the exact submission bytes and all durable evidence; independently recompute the approval gate; then create a new create-exclusive export directory below the project’s existing `exports/` directory. It copies immutable bytes/snapshots and emits an `export-manifest.json` that lists safe relative filenames and SHA-256 checksums.

**Tech stack:** React 19, TypeScript strict, Vitest + Testing Library, File System Access API interfaces/mocks, Web Crypto SHA-256. Existing durable sidecars: `metadata/`, `reports/audits/`, `reports/approvals/`.

---

## 1. Locked scope and non-goals

### Must deliver

Issue #20 acceptance criteria:

1. Export the **final asset**, **metadata**, **durable audit report**, and **project manifest** to the browser-owned folder.
2. Use safe deterministic filenames and include checksums.
3. Raster output must be valid JPEG; vector output must be valid SVG.
4. Export must be blocked unless the current revision-bound approval gate passes.
5. Source/master must remain unchanged.

### Explicitly out of scope

Do **not** add any of the following in this issue:

- ZIP/archive generation;
- browser download of an archive or individual package;
- Adobe Stock upload, login, API, scraper, or provider connector;
- backend/API route, worker job, database migration, artifact storage, secret, provider routing, or fallbacks;
- modification of `gandiwa-project.json` schema v1;
- source/master conversion, resize, raster preparation, or a new revision;
- a claim that `ADOBE_READY` guarantees Adobe acceptance;
- raw SVG preview/serving changes.

`exports/` is intentionally a **project-folder path**. It must never be confused with repository-root `exports/`, which `.gitignore` excludes as user-generated content.

### Source of truth and relevant existing contracts

Read these before writing production code:

- `docs/DEVELOPMENT-SEQUENCE.md` — Stage 4 export gate.
- `docs/PRD.md` — GS-016 export package.
- `docs/ADOBE-RULESET.md` sections 9–10 — audit immediately before export and `ADOBE_READY` semantics.
- `docs/PROJECT-MANIFEST.md` — manifest v1, browser ownership, immutable source/revisions.
- `docs/APPROVAL-GATE.md` — durable evidence locations and fail-closed approval semantics.
- `apps/web/src/approval-gate.ts` — authoritative `evaluateApprovalGate()` result.
- `apps/web/src/approval-submission.ts` — actual-byte resolver and JPEG/SVG signature checks.
- `apps/web/src/approval-store.ts`, `apps/web/src/durable-audit-store.ts`, `apps/web/src/stock-metadata-store.ts` — snapshot/checksum patterns.
- `apps/web/src/raster-preparation.ts` — create-exclusive directory/file discipline.

---

## 2. Branch topology and agent coordination

### Branches already created locally

All start from the exact base commit above:

```text
feat/issue-20-portable-export             # integration branch / only future PR branch
feat/issue-20-export-contract             # slice A
feat/issue-20-export-writer               # slice B
feat/issue-20-export-ui                   # slice C
feat/issue-20-export-final-audit          # slice D, audit-only/checklist branch
```

### Critical GitHub/Kanban constraint

The repository branch policy maps every branch matching `feat/issue-20-*` to Issue #20 and requires the PR body to contain exactly one real closing reference, `Fixes #20`. The Kanban policy also refuses multiple open PRs mapping to the same issue.

Therefore:

1. **No sub-branch may open a PR.** Do not push/open a draft PR merely for review.
2. Each coding agent works only on the assigned local sub-branch, runs its focused tests, and stops for Master Peng.
3. Master Peng (or a designated integrator) reviews and integrates each approved sub-branch into `feat/issue-20-portable-export` locally, preferably with `git merge --no-ff` or an explicitly audited cherry-pick.
4. Resolve test conflicts immediately after each integration; do not batch unresolved conflicts until the end.
5. Only when all slices and final audit pass may Master Peng order a commit/push/PR from the **single integration branch**.
6. Only that final PR uses this body line, once and outside HTML comments:

   ```md
   Fixes #20
   ```

Do not include `Fixes #20`, `Closes #20`, or `Resolves #20` in any sub-branch commit message if there is a possibility its commits will be part of another PR body/automation later. Keep closing syntax in the final PR body only.

### Sub-branch order

```text
A contract  →  B writer  →  C UI  →  D final independent audit
```

- **A must merge into the integration branch before B begins.**
- **B must merge before C begins.**
- **D changes no production behavior unless it finds a defect; it audits the exact final integration working tree.**

This intentionally serializes the write-boundary work. Parallel coding here is a Jurus Mabuk: all slices touch the same evidence and FSA abstractions, so parallel changes will make race-safety harder to review.

---

## 3. Proposed package contract (must be implemented or explicitly revised before code)

Issue #20 does not prescribe exact filenames. This plan proposes a minimal deterministic contract that satisfies the issue without ZIP/download scope.

### Export directory identity

For the current asset and revision:

```text
exports/<asset-id>-r<revision>-<submission-checksum-16>/
```

Example:

```text
exports/123e4567-e89b-12d3-a456-426614174000-r2-32461d5bd1773012/
```

Rules:

- `asset-id` is canonical lowercase UUID from manifest.
- `revision` is a positive integer.
- checksum prefix is first 16 lowercase hex characters of the exact actual submission bytes.
- No user-controlled title, project name, source filename, absolute path, `.`/`..`, slash, backslash, or unvalidated extension enters a filename.
- Naming is deterministic for a given exact eligible evidence set.
- The directory is create-exclusive. If it already exists, **do not overwrite or delete it**. Fail with an actionable “export package already exists; inspect it or change the revision/evidence” message. Idempotent reuse can be a later issue only after a full package-verification design; do not silently accept a pre-existing directory.

### Files inside the package

Minimum package contents:

```text
exports/<package-id>/
├── final.jpeg | final.svg
├── metadata.json
├── audit-report.json
├── approval.json
├── gandiwa-project.json
└── export-manifest.json
```

Why include `approval.json`: it is the durable human-evidence record that makes the exported gate decision traceable. It does not alter the Issue #20 minimum; it supports its checksum and approval requirements.

Do not include original source/master revision 1, `preparation.json`, arbitrary project files, previews, provider responses, absolute paths, credentials, or raw user-selected filenames.

### `export-manifest.json` schema proposal

Create a new frontend-local runtime validator. Do **not** modify portable project manifest v1.

Exact, strict schema shape:

```json
{
  "schemaVersion": 1,
  "packageKind": "gandiwa-portable-export",
  "assetId": "lowercase canonical UUID",
  "revision": 2,
  "submissionFormat": "jpeg",
  "rulesetId": "adobe-stock-2026-09-08-v1",
  "rulesetVersion": "adobe-stock-2026-09-08-v1",
  "submissionChecksum": "64-lowercase-hex",
  "metadataChecksum": "64-lowercase-hex",
  "auditChecksum": "64-lowercase-hex",
  "approvalChecksum": "64-lowercase-hex",
  "files": [
    { "path": "final.jpeg", "sha256": "64-lowercase-hex", "bytes": 12345 },
    { "path": "metadata.json", "sha256": "64-lowercase-hex", "bytes": 678 },
    { "path": "audit-report.json", "sha256": "64-lowercase-hex", "bytes": 901 },
    { "path": "approval.json", "sha256": "64-lowercase-hex", "bytes": 234 },
    { "path": "gandiwa-project.json", "sha256": "64-lowercase-hex", "bytes": 567 }
  ]
}
```

Rules:

- `files` ordering is fixed exactly as shown; canonical JSON formatting uses `JSON.stringify(value, null, 2) + '\n'`.
- `files` does **not** list `export-manifest.json` itself; self-hashing requires a separate canonicalization protocol and is outside scope.
- `final.jpeg` SHA-256 must equal `submissionChecksum` exactly.
- The snapshot checksums for metadata, audit, and approval must equal both their copy bytes and their bindings in the approval/gate evidence.
- `gandiwa-project.json` copy SHA-256 is in `files`, while its source snapshot must match the opened project snapshot exactly.
- The export manifest must not contain absolute paths, source file names, browser handle internals, provider data, raw bytes, credential material, user-supplied title, or an Adobe acceptance claim.

### Format verification

Never trust MIME, filename, or the manifest extension alone.

- For `submissionFormat: "jpeg"`, validate actual bytes begin `FF D8 FF` and end `FF D9`, and export only `final.jpeg`.
- For `submissionFormat: "svg"`, do not reintroduce unsafe SVG handling. The package may export only the exact revision bytes already accepted by the current SVG preflight/durable audit and whose declared submission format is `svg`; verify the lightweight signature as existing `resolveApprovalSubmission()` does. Export only `final.svg`.
- A raster PNG, malformed JPEG, mismatched extension, or a vector/raster modality mismatch fails before any package write.

---

## 4. Mandatory export safety protocol

The File System Access API does not offer portable locks, atomic directories, or multi-file transactions. The implementation must honestly fail closed and leave recovery data rather than overwrite anything.

### Read/validate before asking for write permission

From an explicit user click:

1. Capture the active project object and an `exportOperationSequence` token.
2. Re-resolve the intended latest asset/latest revision using the active manifest snapshot.
3. Call `resolveApprovalSubmission()` to read actual revision bytes, actual submission checksum, and current metadata checksum.
4. Read durable audit using `loadDurableAudit()` and approval using `loadApproval()`.
5. Validate metadata via its provenance-aware loader, not just an in-memory form.
6. Independently call `evaluateApprovalGate()` with fresh evidence. Continue only if:
   - `status === 'APPROVED / ADOBE-READY'`
   - `adobeReady === true`
   - `exportGate === 'CLEAR'`
7. Read exact current byte snapshots for manifest, metadata, audit, approval, and final submission needed for package copies.
8. Validate all format signatures before write permission.

The UI’s old in-memory `approvalGate` is only a display hint. It must **never** be the authority for a write.

### Permission and final revalidation

9. Request `{ mode: 'readwrite' }` directly from the export button’s user gesture using existing `requestProjectWritePermission()`.
10. After permission resolves, verify the operation token/project identity is still current.
11. Re-resolve all evidence again: manifest, submission, metadata, durable audit, approval, gate, and byte/checksum values. If any current value differs from the pre-permission snapshot, abort with no export directory created.
12. Create the exact package directory only after the final evidence pass. First check it is absent with `{ create: false }`; then create it with `{ create: true }`. Never use an existing directory.
13. Before each file write, prove the target filename is absent. Use `getFileHandle(name, { create: false })` and reject if found, then `{ create: true }` to create/write.
14. Immediately before the first write and immediately before `export-manifest.json`, run a final evidence verifier that reads current manifest/sidecars/submission again. If changed, abort.
15. Write copies in fixed order: `final.*`, metadata, audit, approval, manifest, then `export-manifest.json` **last** as package completion marker.
16. Never remove the new package directory automatically when a partial write fails; deletion may destroy user recovery evidence. Report the exact package directory identifier (not an absolute path) and say it is incomplete/not usable because its final manifest was not written.
17. Only after `export-manifest.json` is closed, update UI status to `EXPORTED`/success. No change to the project manifest is required.

### Residual boundary to document

After the final recheck but before/while browser file streams commit, an external process can still alter files because FSA has no CAS/lock. Do not claim perfect atomicity. The final marker and checksums make an incomplete/tampered package detectable; recovery is user inspection and a fresh export to a different identity/revision, not automatic overwrite.

---

## 5. Slice A — Export contract and read-only preflight

**Branch:** `feat/issue-20-export-contract`

**Purpose:** Build pure contract/types and a read-only resolver that assembles a fail-closed export candidate. This slice must not write any directory/file and must not touch `App.tsx`.

### Expected files

- Create: `apps/web/src/export-package.ts`
- Create: `apps/web/src/export-package.test.ts`
- Possibly modify: `apps/web/src/approval-submission.ts` only if a small exported helper is genuinely needed. Prefer not to widen it.
- No `App.tsx` change in this slice.

### Required API shape

Define narrow interfaces compatible with existing FSA mocks. Suggested names:

```ts
export type ExportPackageCandidate = Readonly<{
  assetId: string
  revision: number
  submissionFormat: 'jpeg' | 'svg'
  packageName: string
  finalFileName: 'final.jpeg' | 'final.svg'
  manifestSnapshot: string
  metadataSnapshot: string
  metadataChecksum: string
  auditSnapshot: string
  auditChecksum: string
  approvalSnapshot: string
  approvalChecksum: string
  submissionBytes: Uint8Array
  submissionChecksum: string
  gate: ApprovalGateResult
}>

export async function resolveExportPackageCandidate(...): Promise<ExportPackageCandidate>
export function buildExportManifest(candidate: ExportPackageCandidate, copiedFiles: ...): ExportManifest
export function validateExportManifest(value: unknown): ExportManifest
```

Do not export reusable helpers that accept arbitrary directory paths or arbitrary filenames. Keep asset/revision inputs explicit and validated.

### TDD tasks

1. **Write failing tests for safe naming and exact schema.**
   - canonical UUID/revision/checksum yields the exact deterministic package name;
   - unsafe ID/checksum/revision is rejected;
   - `final.jpeg`/`final.svg` selected solely from submission format;
   - `validateExportManifest()` rejects extra keys, missing keys, invalid SHA, duplicate paths, unsafe paths, wrong order, `final.png`, and self-entry.
2. Run focused test and confirm it fails for the intended missing API/behavior—not merely an import error.
3. Implement minimal validators and canonical serializer.
4. **Write failing resolver tests** with in-memory FSA fixtures:
   - exact valid approved JPEG resolves;
   - exact valid approved SVG resolves;
   - missing metadata/audit/approval rejects;
   - stale approval checksum rejects;
   - blocking durable audit rejects;
   - changed manifest snapshot rejects;
   - malformed JPEG or SVG signature rejects;
   - approval record whose binding does not match audit/metadata/submission rejects;
   - no directories/files are created during a failed or successful resolver call.
5. Implement only read-only composition using existing `resolveApprovalSubmission`, `loadDurableAudit`, `loadApproval`, `loadStockMetadata`, and `evaluateApprovalGate`.
6. Run focused suite after every logical slice.

### Definition of done for Slice A

```bash
corepack pnpm --filter @gandiwa/web test -- export-package.test.ts
corepack pnpm --filter @gandiwa/web lint
corepack pnpm --filter @gandiwa/web typecheck
git diff --check
```

Agent must report: RED evidence, GREEN evidence, exact changed files, and explicitly state that no write/UI/export was implemented yet.

---

## 6. Slice B — Create-exclusive package writer and recovery semantics

**Branch:** `feat/issue-20-export-writer`

**Prerequisite:** first update this branch from the integration branch after Slice A is reviewed/integrated. Do not reimplement contract types independently.

**Purpose:** Add the browser-local writer only. No UI wiring yet.

### Expected files

- Modify: `apps/web/src/export-package.ts`
- Modify: `apps/web/src/export-package.test.ts`
- If mocks become unwieldy, create: `apps/web/src/export-package.test-helpers.ts` only if it contains test-only FSA utilities.
- Do not alter manifest schema or backend.

### Required writer API

Suggested narrow operation:

```ts
export async function writeExportPackage(input: Readonly<{
  directory: ExportDirectory
  candidate: ExportPackageCandidate
  verifyCurrentEvidence: () => Promise<void>
}>): Promise<Readonly<{
  packageName: string
  exportManifest: ExportManifest
  exportManifestSnapshot: string
}>>
```

The caller owns permission and supplies a verifier. The writer must call the verifier:

- before creating the package directory;
- after asserting directory absence and before first file write;
- before the final `export-manifest.json` completion marker.

The writer must not receive a callback that merely returns cached/in-memory state. Later UI wiring must make this callback re-read current evidence.

### TDD tasks

1. Write a failing test for a successful JPEG package:
   - exactly one new directory below `exports/`;
   - exactly six expected files;
   - `final.jpeg` exact bytes match source submission;
   - copied sidecars/manfiest text match snapshots byte-for-byte;
   - checksums in `export-manifest.json` are real SHA-256 values;
   - final asset checksum equals `submissionChecksum`;
   - no source revision or sidecar source file is mutated.
2. Run RED, then implement minimal fixed-order writer.
3. Write a failing SVG equivalent. Verify output file is exactly `final.svg`, no raster re-encode occurs.
4. Write failing security/recovery tests:
   - existing package directory refuses before modifying anything;
   - existing target file causes rejection/no overwrite;
   - verifier rejects before directory creation → no package directory;
   - verifier rejects after directory creation/before first write → directory may exist but no completion marker;
   - verifier rejects before completion marker → partial files may exist but **no** `export-manifest.json`;
   - a stream write failure leaves no completion marker and never mutates source;
   - unsafe package/file name never reaches handle API;
   - all package writes occur only inside `exports/<package-id>/` mock node.
5. Implement `export-manifest.json` **last**. Do not add cleanup that deletes an incomplete package.
6. Test that an already created package directory cannot be reused/repaired by a second call.

### Required rationale in code/docs

Add concise comments only at the non-obvious boundary:

- why `export-manifest.json` is written last;
- why failure does not delete partial user folder;
- why final revalidation exists despite the no-lock residual race.

### Definition of done for Slice B

```bash
corepack pnpm --filter @gandiwa/web test -- export-package.test.ts approval-gate.test.ts approval-store.test.ts durable-audit-store.test.ts approval-submission.test.ts
corepack pnpm --filter @gandiwa/web lint
corepack pnpm --filter @gandiwa/web typecheck
git diff --check
```

Agent must stop after local test evidence. No push/PR.

---

## 7. Slice C — UI wiring and lifecycle safety

**Branch:** `feat/issue-20-export-ui`

**Prerequisite:** update this branch from the reviewed/integrated Slice B. This branch owns only user action/UI plus tests; do not fork writer logic in `App.tsx`.

### Expected files

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify/create: `apps/web/src/export-package-panel.test.tsx` (preferred focused UI test file)
- Possibly modify a CSS file only if existing classes cannot express the state accessibly.
- Modify: `docs/APPROVAL-GATE.md` only to remove obsolete “in progress” wording if still present after merge.
- Create: `docs/EXPORT-PACKAGE.md`
- Modify: `README.md` only if status claims are stale; avoid broad product rewriting.

### UI behavior contract

Place an **Export portable package** panel beside/after the approval gate.

Show, as text (not color only):

- `Export gate: CLEAR` or `Export gate: BLOCKED`;
- exact target: asset ID, revision, declared final format;
- package directory identifier that will be created (not absolute path);
- status: `Not exported`, `Exporting…`, `Exported locally`, or failure/recovery message;
- explicit notice: “ADOBE_READY is Gandiwa’s evidence gate, not an Adobe acceptance guarantee.”

Button rules:

- disabled unless the displayed current gate is `APPROVED / ADOBE-READY` and no export action is running;
- disabled/removed with no active project or no durable evidence;
- on click, the action must fresh-resolve evidence before and after write permission; it must not trust only render-state gate;
- request `readwrite` permission directly from the button click;
- after project close, open/switch, reload external manifest, metadata save, or preparation revision change, invalidate/cancel the export operation via a dedicated `exportOperationSequence` and clear transient export status;
- if an old export async operation resolves after project switch, it must not update the new project’s UI.

### Suggested `App.tsx` safety pattern

Use a separate sequence ref, not reuse only preflight/approval state:

```ts
const exportOperationSequence = useRef(0)

const isCurrentExport = () =>
  operationId === exportOperationSequence.current &&
  activeProjectRef.current === project
```

Increment it on every lifecycle event already invalidating approval context:

- successful open/reopen;
- Close project;
- Reload external manifest;
- successful metadata save;
- successful raster preparation;
- unmount cleanup if applicable.

After each `await` in `exportCurrentRevision()`, verify `isCurrentExport()` before writing state or continuing. Permission prompt itself is an async race boundary; re-resolve afterwards.

### TDD tasks

1. Write UI RED test: blocked gate visibly states blocked and Export button is disabled.
2. Write UI RED test: approved gate renders correct target/package name and enabled button.
3. Mock resolver/writer/permission so a click proves ordering:
   - fresh resolver invoked before permission;
   - permission requested from click;
   - fresh resolver invoked again after permission;
   - writer receives a final read callback, not stale cached values.
4. Write UI RED test: permission denied gives a truthful non-success message and writer is never called.
5. Write UI RED test: writer error mentions incomplete package recovery if final marker was not written; UI does not claim export success.
6. Write UI RED test: close/switch/reload during an unresolved export prevents late success state.
7. Implement minimal UI and sequence guard to make each test green.
8. Add an integration-style test that starts with approved evidence, changes metadata/submission at the post-permission resolver, and proves writer is never called.

### Documentation requirements (`docs/EXPORT-PACKAGE.md`)

Document exactly:

- package location and file tree;
- checksum semantics and how a human can inspect `export-manifest.json`;
- final marker meaning;
- what failure/partial package means;
- no overwrite behavior;
- residual FSA no-lock/TOCTOU limitation;
- manual Adobe upload remains outside Gandiwa;
- `ADOBE_READY` is not Adobe acceptance.

Do not claim ZIP/download/upload or a preview file unless actually implemented and tested.

### Definition of done for Slice C

```bash
corepack pnpm --filter @gandiwa/web test -- export-package.test.ts export-package-panel.test.tsx App.test.tsx approval-gate-panel.test.tsx
corepack pnpm --filter @gandiwa/web lint
corepack pnpm --filter @gandiwa/web typecheck
corepack pnpm --filter @gandiwa/web build
git diff --check
```

Again: stop, report, wait. Do not commit/push/PR without Master Peng’s explicit order.

---

## 8. Slice D — Final integration audit (no coding by default)

**Branch:** `feat/issue-20-export-final-audit`

**Prerequisite:** reset/rebase this branch onto the exact final integration branch commit, not merely `origin/main`.

**Purpose:** independent adversarial review of the exact working tree. The auditor must not accept previous audit results or previous green tests as proof after another slice was merged.

### Audit checklist

#### Gate and evidence integrity

- Export action calls `evaluateApprovalGate()` on fresh durable data—not only `approvalGate` React state.
- Approval binds asset ID, revision, actual submission SHA-256, metadata SHA-256, durable audit SHA-256, and ruleset ID/version exactly.
- Any missing, malformed, changed, stale, or unknown-rule evidence blocks export.
- Metadata loader receives immutable provenance and cannot accept invalid AI disclosure.
- Audit has no blocking FAIL; warning-only findings remain visible but may proceed.
- Manifest, metadata, audit, approval, and final bytes are read again after permission and again at the writer’s final boundary.

#### File integrity and filesystem confinement

- Only `exports/<safe package id>/...` is written.
- Project manifest is copied but never written/changed in place.
- Revision final bytes are copied as-is; original `revisions/` entries are untouched.
- `final.jpeg`/`final.svg` are fixed names derived from declared format; no user filename leaks.
- Actual byte signatures are checked, not MIME/extension.
- `export-manifest.json` uses strict schema and real SHA-256 checksums.
- The manifest is the last completion marker; any exception beforehand cannot yield a manifest.
- Existing directory/file causes refusal, not overwrite, deletion, or silent repair.
- No raw source/master, secrets, paths, provider details, or browser-handle implementation data are included.

#### Async and UI lifecycle

- Project close/switch/reload/metadata save/revision creation invalidate in-flight export.
- No late async operation can show success on a new project.
- Permission denial and partial writer failures remain non-success states.
- Button state is accessible and does not depend only on color.

#### Scope containment

- No backend/API/DB migration/provider/ZIP/download/Adobe upload appears in the diff.
- `gandiwa-project.json` schema v1 and its TypeScript/Python conformance fixtures remain unchanged unless Master Peng separately approved a schema change (not approved in this plan).
- Documentation makes no acceptance guarantee.

### Required final quality gate

From the integration branch after all audit fixes:

```bash
corepack pnpm --filter @gandiwa/web test
uv run --project apps/api pytest
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm check
python3 scripts/verify_repository.py
git diff --check
git status --short
```

If any command fails, report real output and repair it before declaring completion. Do not call a failure flaky without the exact failing log.

### Manual smoke-test handoff (after automation, before PR)

A human on Chrome/Edge should verify with a disposable project folder:

1. Create/open project and prepare a valid raster JPEG or approved SVG revision.
2. Save valid metadata, run durable audit, explicitly approve.
3. Export package.
4. Inspect that the `exports/<package-id>/` directory contains the expected six files.
5. Confirm `final.jpeg` or `final.svg` is present, originals in `revisions/` did not change, and `export-manifest.json` lists checksums.
6. Modify metadata externally; confirm export becomes blocked until fresh audit/approval.
7. Pre-create the expected export directory; confirm Gandiwa refuses without changing it.

Do not test using a real production asset unless Master Peng deliberately chooses it; use a copied/disposable project.

---

## 9. Integration, commit, and PR procedure for Master Peng

This is intentionally **not authorized by this plan**; execute only after Master Peng explicitly asks.

1. Inspect each sub-branch diff independently against its slice scope.
2. Merge/cherry-pick into `feat/issue-20-portable-export`, resolving tests immediately.
3. Run the full gate and final independent audit on exact integrated tree.
4. Stage explicit allowlist only. Never `git add -A`; keep local handoff files excluded.
5. Commit with a truthful message, e.g.:

   ```text
   feat(issue-20): add portable approved export package
   ```

6. Push only with explicit permission; afterward compare local SHA with `origin/feat/issue-20-portable-export` exactly.
7. Open one PR only when ordered. PR branch must remain `feat/issue-20-portable-export`; body must contain exactly one actual line:

   ```md
   Fixes #20
   ```

8. Inspect every CI check. If any check fails, read its exact log and correct the root cause; never assume it is a GitHub flake.
9. Master Peng retains merge control.

---

## 10. Agent handoff prompt template

Give a fresh agent only one slice at a time. Replace placeholders before sending.

```text
You are implementing exactly Slice <A|B|C|D> of Gandiwa Studio Issue #20.

Repository: /home/ubuntu/GandiwaStudio
Branch: <branch name>
Base/integration prerequisite: <exact commit>
Plan: .hermes/plans/2026-09-13_122113-issue-20-portable-export-selendang.md

Read the plan, Issue #20, docs/APPROVAL-GATE.md, docs/PROJECT-MANIFEST.md,
docs/ADOBE-RULESET.md, and the existing Issue #19 files before coding.

Hard boundaries:
- Browser-owned File System Access API only. No backend/API/database/provider work.
- No ZIP/download/upload Adobe feature.
- Do not alter gandiwa-project.json schema v1.
- Do not overwrite source/master, sidecars, or any existing export package.
- Export must freshly fail closed unless evaluateApprovalGate() returns current
  APPROVED / ADOBE-READY with exportGate CLEAR.
- Use TDD: show intended RED before minimal GREEN, then regression tests.
- Do not commit, push, open a PR, merge, close an issue, or alter GitHub state.
- Do not open a sub-branch PR: the repository allows only one PR for Issue #20.

Perform only Slice <X> tasks. Run the exact focused gates listed in that slice.
At the end, report: changed files; RED/GREEN evidence; commands and real outputs;
security/race cases tested; remaining risks; git diff --check; git status --short.
Stop for human review.
```

---

## 11. Plan review checklist

Before handing any slice to an agent, verify:

- [x] Issue #19 is closed and its merged commit is in `origin/main`.
- [x] Issue #20 is open and its only dependency (#19) is satisfied.
- [x] Integration branch and four local sub-branches exist at `093cf72`.
- [x] No code was written by this planning session.
- [x] Only the integration branch may eventually become a PR.
- [x] Export scope is browser-local package writing, not archive/download/upload.
- [x] Writer design has no overwrite path and has explicit recovery behavior.
- [x] Fresh evidence checks occur before permission, after permission, and before completion marker.
- [x] Final audit is applied to the actual integrated tree, not an earlier slice snapshot.
