# Issue #19 — Revision-Bound Approval & Adobe-Ready Gate Implementation Plan

> **For Hermes:** Implement this plan task-by-task with strict TDD. Do not commit, push, open a PR, merge, or close an issue unless Master Peng gives explicit approval for that exact remote action.

**Goal:** Implement a browser-local human approval gate that can mark one prepared asset revision `ADOBE_READY` only when its durable audit, metadata/disclosure, ruleset, revision, and checksums are all current; invalidate it fail-closed after relevant change.

**Architecture:** Keep `gandiwa-project.json` schema v1 unchanged because it is strict and portable. Introduce versioned browser-local sidecars below the existing project folders: a durable audit snapshot under `reports/` and an approval record under `reports/approvals/`. The approval record binds the immutable asset ID, revision number, submission checksum, audit snapshot checksum/ruleset, and metadata sidecar checksum. Browser File System Access API remains the only writer. The UI computes an explicit gate state; it never asserts that Adobe will accept the submission.

**Tech Stack:** React + TypeScript strict + Vitest/Testing Library, File System Access API mocks, Web Crypto SHA-256, existing `@gandiwa/contracts`, existing locked `@gandiwa/adobe-rules`.

---

## 0. Confirmed live context

- Working branch created locally from current `origin/main`: `feat/issue-19-approval-queue`.
- GitHub Issue #19 is OPEN; it has no comments.
- Dependencies #17 and #18 are CLOSED/COMPLETED; no existing/duplicate PR for #19 was found.
- Issue #20 is still OPEN. **Do not create an export package, download package, archive, or uploader in #19.** #19 only exposes a truthful gate/state that #20 will consume.
- Current manifest v1 (`packages/contracts/src/project-manifest.ts`) rejects extra fields. Do not add approval/audit/metadata fields to it and do not loosen its exact-key validation.
- Current Audit Center (`apps/web/src/audit-center.ts`) is presentation-oriented and identifies preflight candidates as `file-...`; it is not a durable asset-bound audit. It cannot be used directly as approval evidence.
- Current metadata sidecar (`metadata/<asset-id>.json`) is versioned, conflict-protected, checksum-returning, and provenance-aware. Reuse its loading/checksum/conflict discipline rather than bypassing it.
- Current raster preparation yields a manifest asset with revision 1 master and revision 2 JPEG submission plus `revisions/<asset-id>/2/preparation.json`, which contains `submission_checksum`.

## 1. Non-negotiable scope and safety boundaries

### In scope

1. A durable audit snapshot tied to a selected existing asset revision (initially, the latest revision of the latest prepared asset is acceptable only if the UI says this explicitly).
2. Human approval/revocation state tied to:
   - `asset_id`;
   - revision number;
   - current submission file SHA-256;
   - immutable audit snapshot checksum and locked ruleset id/version;
   - current metadata sidecar SHA-256.
3. Deterministic gate reasons for missing/invalid metadata, blocking audit FAIL, stale audit, checksum mismatch, audit/ruleset mismatch, missing approval, stale approval, and approval record corruption.
4. Accessible UI showing `NOT READY`, `READY FOR HUMAN APPROVAL`, `APPROVED / ADOBE-READY`, or `STALE / BLOCKED`, with a visible statement that Adobe-ready is **not** Adobe acceptance/guarantee.
5. Explicit human action to approve; no automatic approval and no provider/API routing.

### Explicitly out of scope

- Export package writing, ZIP generation, package download, or upload to Adobe (#20).
- Backend SQLite approval persistence, provider calls, queue work, secrets, new API endpoints, or Gandiwa provider routing/fallback.
- Editing the creative manifest schema v1.
- Claiming that a release is attached/verified merely because `releaseStatus` says `attached`; that remains a metadata declaration and human review concern.
- Backfilling or silently migrating corrupt/old sidecars; fail closed and request the user to rerun audit or correct metadata.

### Required sidecar placement and schemas

Use new, explicit, versioned sidecars; create directories only after write permission is granted from a user gesture:

- Audit snapshot: `reports/audits/<asset-id>-r<revision>.json`
- Approval record: `reports/approvals/<asset-id>-r<revision>.json`

Suggested audit snapshot shape (exact shape must be runtime validated):

```ts
type DurableAuditSnapshot = Readonly<{
  schemaVersion: 1
  assetId: string
  revision: number
  submissionChecksum: string
  rulesetId: string
  rulesetVersion: string
  findings: readonly {
    ruleId: string
    verdict: 'PASS' | 'WARNING' | 'FAIL'
    message: string
    evidence: Readonly<Record<string, unknown>>
  }[]
  createdAt: string // ISO string generated client-side only for display/audit trail
}>
```

Suggested approval shape:

```ts
type ApprovalRecord = Readonly<{
  schemaVersion: 1
  status: 'APPROVED'
  assetId: string
  revision: number
  submissionChecksum: string
  metadataChecksum: string
  auditChecksum: string
  rulesetId: string
  rulesetVersion: string
  approvedAt: string // ISO string, displayed as local human action time
  statementVersion: 1
}>
```

No arbitrary free-text identity, browser user name, local absolute path, secret, raw source bytes, or provider data belongs in either sidecar. Approval is an explicit local human confirmation, not a legal release or Adobe response.

## 2. Required implementation sequence (agent handoff)

### Task 1 — Freeze the approval contract before UI work

**Objective:** Create a testable pure contract that makes approval eligibility and stale state deterministic.

**Files:**
- Create: `apps/web/src/approval-gate.ts`
- Create: `apps/web/src/approval-gate.test.ts`
- Read: `apps/web/src/audit-center.ts`, `apps/web/src/stock-metadata.ts`, `apps/web/src/stock-metadata-store.ts`, `packages/adobe-rules/src/*`

**Step 1 — RED:** Write pure tests for `evaluateApprovalGate(input)` with a wished-for API. It must return a stable status, `adobeReady: boolean`, `exportGate: 'BLOCKED' | 'CLEAR'`, and an array of actionable reasons.

Required cases:
1. no durable audit => blocked;
2. audit contains a blocking FAIL => blocked;
3. audit is stale/mismatched revision/checksum/ruleset => blocked;
4. metadata missing/invalid => blocked;
5. approval missing but valid audit+metadata => ready for human approval, still blocked;
6. exact matching approval => Adobe-ready and gate clear;
7. changed submission checksum => stale approval and blocked;
8. changed metadata checksum => stale approval and blocked;
9. changed audit checksum or ruleset version/id => stale approval and blocked;
10. malformed approval/snapshot => blocked, never treated as missing valid evidence;
11. WARNING-only audit with no blocking FAIL may be eligible for human approval; keep warnings visible.

**Step 2 — Verify RED:**

```bash
corepack pnpm --filter @gandiwa/web exec vitest run src/approval-gate.test.ts
```

Expected: FAIL because the module/function does not exist.

**Step 3 — GREEN:** Implement the smallest pure evaluator. Derive blocking finding behavior from the existing locked ruleset / `AuditCenterResult` semantics, not from UI color or aggregate text. Do not write files here.

**Step 4 — Verify GREEN:** rerun the focused test. Then run TypeScript strict check.

```bash
corepack pnpm --filter @gandiwa/web exec vitest run src/approval-gate.test.ts
corepack pnpm --filter @gandiwa/web typecheck
```

### Task 2 — Durable audit snapshot validation and save/load discipline

**Objective:** Make an audit durable and asset-bound before it can be approved.

**Files:**
- Create: `apps/web/src/durable-audit-store.ts`
- Create: `apps/web/src/durable-audit-store.test.ts`
- Possibly modify: `apps/web/src/audit-center.ts` only to export a typed finding representation; do not make it persist itself.

**Step 1 — RED:** Write tests for:
- exact runtime schema validation;
- canonical UUID, positive revision, 64-hex checksum requirements;
- locked ruleset id/version requirement;
- write only after explicit manifest snapshot check;
- create/overwrite policy: audit snapshots may be replaced only after the editor loads their exact byte snapshot; first save fails if an audit sidecar appeared externally;
- corrupt snapshot fails closed;
- audit save returns exact snapshot and SHA-256 checksum;
- external sidecar change detected before overwrite leaves prior bytes intact.

**Step 2 — Verify RED:** run only this suite and observe intended missing-module/behavior failure.

**Step 3 — GREEN:** Implement `loadDurableAudit()` and `saveDurableAudit()` using File System Access API mock interfaces. Reuse the metadata store pattern but do not copy it blindly:
- make all filenames derived solely from validated asset ID + positive revision;
- re-read `gandiwa-project.json` snapshot before and immediately before durable write;
- re-read the audit sidecar snapshot before overwrite;
- never use a random UUID as an identity substitute;
- return the immutable byte snapshot and checksum.

**Step 4 — Verify GREEN:** focused tests + typecheck.

### Task 3 — Approval record store with create-exclusive/conflict-safe behavior

**Objective:** Persist explicit human approval only when the exact inputs have passed the pure gate.

**Files:**
- Create: `apps/web/src/approval-store.ts`
- Create: `apps/web/src/approval-store.test.ts`

**Step 1 — RED:** Tests must prove:
- `loadApproval()` rejects corrupt/nonmatching records;
- first approval creates `reports/approvals/<asset>-r<revision>.json` only after user-granted write path;
- an existing approval cannot be overwritten silently; if re-approval is needed, require the record to be loaded and exact snapshot match, or write a deliberate immutable replacement convention documented before implementation;
- approval store does not decide readiness itself: it accepts only an already eligible binding payload from `evaluateApprovalGate`;
- approval binds all five identities: asset, revision, submission checksum, metadata checksum, audit checksum, plus ruleset ID/version;
- attempt to approve after a FAIL/incomplete metadata is rejected with no file write;
- external manifest/approval mutation results in no overwrite;
- a stale approval remains readable as historical evidence but is evaluated blocked by the gate.

**Design decision required before coding:** Prefer append-only approval history or one current file with snapshot-protected replacement. For MVP choose **one current approval record per asset/revision with snapshot-protected replacement** only if a re-approval action is required; do not delete historical evidence automatically. If a simple current record is insufficient for honest history, use append-only dated/UUID records and a deterministic latest-current selection. Document the choice before GREEN.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Implement only the chosen tested scheme. Do not add server persistence.

**Step 4 — Verify GREEN:** focused tests + typecheck/lint.

### Task 4 — Bind current prepared revision to durable checksum and metadata

**Objective:** Supply a real approval input, never the current ephemeral `file-...` preflight identity.

**Files:**
- Create: `apps/web/src/approval-submission.ts`
- Create: `apps/web/src/approval-submission.test.ts`
- Read: `apps/web/src/raster-preparation.ts`, `apps/web/src/project-lifecycle.ts`, `apps/web/src/stock-metadata-store.ts`

**Step 1 — RED:** Test a browser-local resolver that:
- takes `ProjectManifest`, asset ID, and selected revision;
- validates asset/revision exists and resolves only a normalized path below `revisions/`;
- reads the actual submission master file bytes through the project directory handle;
- computes SHA-256 from actual bytes, not `preparation.json` claim alone;
- loads metadata through the provenance-aware metadata store;
- returns a typed identity with `assetId`, revision, content/creation provenance, submission checksum, loaded metadata checksum, and manifest snapshot;
- rejects missing file, missing metadata, invalid metadata, stale/mismatched manifest, vector/raster format mismatches, traversal-like paths, and a preparation checksum that disagrees with actual file where applicable.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Minimal resolver. Do not create revisions, mutate manifest, resize, or export anything.

**Step 4 — Verify GREEN:** focused tests.

### Task 5 — Integrate durable audit action into the UI

**Objective:** Give the user an explicit action to persist an audit for the current prepared asset/revision, then display its durable binding.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify/Test: `apps/web/src/App.test.tsx`
- Possibly modify: app CSS only for existing panel style reuse; avoid a visual redesign.

**Implementation constraints:**
- Do not reinterpret a previously selected arbitrary preflight file as the prepared project asset.
- Add a focused "Audit prepared revision" action that resolves the selected prepared submission, runs/uses the appropriate deterministic audit evidence for that actual asset, converts to a durable snapshot, then saves it under `reports/audits/` only with `readwrite` permission from the click handler.
- If current technical preflight cannot audit browser-local project revision without a backend path, keep the UI fail-closed and state that this action requires the supported audit flow; do not fabricate an audit result.
- The current app tracks latest asset implicitly. Before coding, make asset/revision selection explicit in UI/state, even if MVP exposes only one selectable prepared latest revision. Approval must never silently target a different asset.
- Clear/sequence-guard pending preflight/audit results when selection, metadata, or revision changes.

**Required UI RED tests:**
- no asset/revision selected => approval controls unavailable;
- no durable audit => blocked reason visible;
- blocking FAIL => approve disabled;
- incomplete/missing metadata => approve disabled;
- valid audit + valid metadata => button enabled and requires click;
- UI displays revision/checksum/ruleset context from durable data, not only `file-...`;
- audit save denied permission => no sidecar write / no success state;
- delayed old audit response cannot replace state after selection/metadata change.

### Task 6 — Integrate human approval and Adobe-ready state

**Objective:** Allow an explicit local human approval only when exact prerequisites match; display honest status.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify/Test: `apps/web/src/App.test.tsx`

**UI requirements:**
- Show a dedicated `APPROVAL & ADOBE-READY` panel with all binding fields: asset ID, revision, submission checksum, metadata checksum, audit checksum, ruleset id/version.
- Show all gate reasons; do not hide warnings.
- Approval button text must make the action human: e.g. `I confirm this revision for manual Adobe Stock submission`.
- Before click, render this exact semantic caveat (wording may vary but meaning cannot): **“Adobe-ready means this Gandiwa gate passed; it is not a guarantee that Adobe Stock will accept the submission.”**
- On approval success, store record and render `ADOBE-READY — manual submission eligible` plus the same caveat.
- No "Export" action/button/package output belongs in #19. At most show `Export remains owned by Issue #20` or an intentionally disabled future gate label.
- A checksum/ruleset/metadata/audit mismatch must render `STALE / BLOCKED`; never leave the old approved badge active.

**Required UI RED tests:**
- approve cannot be clicked/does not write with blocking FAIL;
- approve cannot be clicked/does not write with incomplete AI metadata;
- matching exact binding enables approval and produces ready state after explicit click;
- changed metadata checksum revokes ready immediately on next evaluation/open;
- changed submission checksum/revision revokes ready;
- changed audit checksum/ruleset revokes ready;
- approval output visibly contains the non-guarantee caveat;
- a delayed preflight from before approval/metadata write cannot resurrect `CLEAR` or ready state.

### Task 7 — Reopen/recovery and stale lifecycle

**Objective:** Make approval state survive close/reopen truthfully and invalidate without destructive cleanup.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify/Test: `apps/web/src/App.test.tsx`
- Possibly extend tests in `approval-store.test.ts` and `approval-submission.test.ts`

**Required cases:**
- close/reopen loads sidecars and recalculates gate from current bytes; do not restore a cached `ADOBE_READY` string;
- stale approval is shown as stale/blocked rather than deleted or silently re-approved;
- metadata sidecar external mutation => approval stale;
- revision file byte mutation => approval stale;
- audit snapshot external mutation => approval stale or corrupt/blocked;
- manifest external change uses existing reload/copy/cancel discipline; no auto-merge/overwrite;
- permission denied/read failure yields blocked actionable state with no write.

### Task 8 — Documentation and explicit non-goals

**Files:**
- Modify: `docs/PROJECT-MANIFEST.md` (or create a narrowly scoped `docs/APPROVAL-GATE.md` if it becomes clearer)
- Modify: `docs/DEVELOPMENT-SEQUENCE.md` only if it currently overstates implementation
- Consider: `docs/ERD.md` wording only; do not create unrelated backend tables for this browser-local slice.

Document:
- exact sidecar paths/schemas and ownership;
- all approval binding dimensions;
- conflict and stale behavior;
- File System Access API residual TOCTOU limitation and fail-closed checks;
- why audit currently must be durable and asset-bound before approval;
- Adobe-ready caveat;
- #20 boundary: no export package produced here.

### Task 9 — Final review gates and handoff

Before presenting work for approval:

```bash
corepack pnpm check
uv run --project apps/api pytest
git diff --check
git status --short
```

Required evidence:
- focused RED and GREEN logs for every new pure/store behavior;
- full frontend test count and backend test count;
- lint, strict typecheck, production build, repository verification;
- independent read-only audit of the **final** working tree after all fixes;
- no secret/API key/raw source bytes in sidecars, test fixtures, docs, or diff;
- manual browser smoke test handoff using the documented Tailscale hostname only if services are explicitly started and verified; otherwise report automated proof honestly.

Do not commit/push/PR until Master Peng explicitly gives that permission.

## 3. File impact inventory

Expected new files:
- `apps/web/src/approval-gate.ts`
- `apps/web/src/approval-gate.test.ts`
- `apps/web/src/durable-audit-store.ts`
- `apps/web/src/durable-audit-store.test.ts`
- `apps/web/src/approval-store.ts`
- `apps/web/src/approval-store.test.ts`
- `apps/web/src/approval-submission.ts`
- `apps/web/src/approval-submission.test.ts`

Expected modified files:
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- potentially `apps/web/src/audit-center.ts` and tests only for reusable typed audit binding, not as a shortcut around durable persistence
- `docs/PROJECT-MANIFEST.md` and/or a focused approval gate document
- `docs/DEVELOPMENT-SEQUENCE.md` only if implementation status language must be corrected

Files that must **not** be changed for this issue without an explicit new decision:
- `packages/contracts/src/project-manifest.ts` (manifest v1 contract)
- backend queue/provider/configuration code
- API secret/session boundaries
- export package code/folder output (#20 ownership)

## 4. Definition of Done for Issue #19

Issue #19 is ready for review only when all statements are demonstrably true:

1. A human cannot approve/export-gate-clear when audit is missing, stale, corrupt, ruleset-mismatched, or has blocking FAIL.
2. A human cannot approve when metadata is missing, corrupt, checksum-mismatched, or violates immutable generative-AI disclosure.
3. Approval binds exact asset ID, revision, actual submission checksum, metadata checksum, audit checksum, ruleset id/version.
4. Any relevant byte/state change yields stale/blocked on recomputation/reopen; it never preserves an old Adobe-ready badge.
5. Sidecar writes are permission-gated, snapshot-protected, and conflict-safe; no silent overwrite occurs.
6. A late async audit/preflight cannot resurrect a clear/ready state after metadata/revision/audit invalidation.
7. UI has explicit human confirmation and says Adobe-ready is not Adobe acceptance guarantee.
8. No export package/download/upload is implemented or claimed.
9. Full local gates pass and final independent audit reports PASS.
10. Commit/push/PR remain pending Master Peng’s explicit approval.

## 5. Risks and decisions the implementer must not paper over

- **Current audit identity mismatch:** `fileAuditIdentity()` is file-bound. Do not parse a `file-...` string to infer asset identity. The durable audit snapshot must store `assetId` and `revision` directly.
- **Audit source ambiguity:** Audit arbitrary picked files only for ephemeral inspection. Approval may only use audit evidence tied to the actual project revision bytes. If the existing backend preflight API cannot do that path safely, build the missing browser-local/durable evidence path or leave the gate blocked; never copy an arbitrary file audit into an approval record.
- **Metadata declaration vs provenance:** Submission declaration can differ but gets warning; immutable asset provenance still governs generative-AI disclosure on both load and save.
- **TOCTOU:** File System Access API lacks CAS/locking. Recheck manifest and sidecar bytes before writes; document residual limitations. Do not claim atomic cross-tab serialization.
- **Approval history:** Do not overwrite an approval with a different binding silently. Decide the minimal honest record model and test it.
- **Stage ownership:** Export package and manual upload remain #20/later; a clear approval gate is not an export implementation.
