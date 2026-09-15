# Issue #56 — Guided Active-Project Workflow Implementation Plan

> **For Hermes:** Implement only after a fresh session receives an explicit user instruction to begin. Follow `gandiwa-studio-development`, `test-driven-development`, `requesting-code-review`, and `hitl-code-change-workflow`. Do **not** commit, push, open a PR, merge, or close the issue without a separate explicit instruction.

**Issue:** [#56 — Restore guided active-project workflow before Stage 5/6 UI](https://github.com/rizzalaulia/GandiwaStudio/issues/56)
**Integration branch:** `feat/issue-56-guided-workflow` (local only at handoff)
**Base:** `origin/main` commit `82b2231eed3ef6ac7d2d75be9d7babcf4a354a86`; branch additionally contains documentation commit `f76d650f1da06e16750d202a9653ed0ad88b10c3`.

## Goal

Replace the Stage 4 stacked Active Project form wall with the approved Canonical Hybrid: a guided, accessible workflow that exposes one durable task and exactly one primary CTA at a time while retaining all existing local-first and fail-closed contracts.

## Approved design contract — do not reopen casually

Canonical artifacts are presently local/uncommitted and must be deliberately staged later:

```text
docs/design/issue-56/canonical-hybrid.html
docs/design/issue-56/canonical-hybrid.md
docs/design/issue-56/screenshots/canonical-hybrid-1150x917.png
docs/design/issue-56/screenshots/canonical-hybrid-1366x768.png
```

The design direction was approved by Master Peng and recorded on #56:

```text
https://github.com/rizzalaulia/GandiwaStudio/issues/56#issuecomment-5659236833
```

### Non-negotiable interaction rules

1. Workflow order remains `Prepare → Metadata → Audit → Approve → Export`.
2. Default workspace opens **one heavy task/form only**.
3. There is exactly **one primary CTA**, in the task surface. The inspector only explains blocker/destination; it must not duplicate that CTA.
4. Evidence/checksums/ruleset/provenance live in an accessible disclosure or advanced detail surface, not the default working path.
5. At `>=1280px`: sidebar + workspace + desktop inspector.
6. At `1024–1279px`: sidebar + workspace; inspector is an accessible drawer/sheet.
7. Below `1024px`: navigation collapses; inspector remains drawer/sheet; the primary CTA stays reachable in workspace.
8. Do not fake Stage 5/6 provider, queue, candidate, or editor state. They may have disabled/absent navigation only.
9. `ADOBE_READY` remains a Gandiwa gate result, never Adobe acceptance.
10. Browser owns project folders. Backend must not write project/source files. Manifest v1 must not change.

### Visual contract

```css
--color-primary: #18212F;  /* dark sidebar/chrome */
--color-neutral: #F7F8FA;  /* workspace */
--color-surface: #FFFFFF;  /* task surface */
--color-border: #D8DEE8;
--color-accent: #B45309;   /* one primary CTA on light workspace */
--color-accent-hover: #92400E;
--color-focus: #2563EB;
--color-success: #166534;  /* only verified state */
```

Do not use amber as the primary text/action color against dark sidebar chrome. Status must never depend only on color.

## Existing domain contracts that must survive

The UI is a presentation layer only. It must retain and call existing authoritative paths rather than reimplement their checks:

- `apps/web/src/project-filesystem.ts` — browser-local project folder/manifest ownership.
- `apps/web/src/raster-preparation.ts` — actual non-destructive raster → JPEG revision.
- `apps/web/src/stock-metadata-store.ts` and `stock-metadata.ts` — sidecar persistence, provenance, snapshot conflicts.
- `apps/web/src/durable-audit-store.ts` and `audit-center.ts` — audit evidence/status.
- `apps/web/src/approval-submission.ts`, `approval-store.ts`, `approval-gate.ts` — current revision/evidence/approval gating.
- `apps/web/src/export-package.ts` — fresh resolution, create-exclusive package, final marker lifecycle.
- Existing async sequences in `apps/web/src/App.tsx` — no late async result may set success/ready state in a switched/invalidated project.

Before each rendering move, read the exact UI handler and existing App test that covers it. Do not infer domain identity by parsing formatted revision text. Preserve all currently tested race guards and invalidation points.

## Current implementation topology

```text
apps/web/src/App.tsx                 # currently owns large stacked markup + orchestration
apps/web/src/App.test.tsx            # integration/UI regression suite
apps/web/src/styles.css              # existing global visual system
apps/web/src/*-store.ts              # durable browser sidecar mechanics
apps/web/src/*-gate.ts               # fail-closed domain gates
```

`App.tsx` presently renders raster preflight, raster preparation, metadata, audit, approval, and export in one `Active Project` block. This is the wall being removed. Existing handlers must be preserved/refactored safely before visual re-composition.

## Worktree safety at handoff

Current branch deliberately has unrelated/untracked local material. Never blanket-stage it:

```text
.hermes/plans/2026-09-14_024352-stage-4-browser-manual-test.md
.hermes/plans/2026-09-14_ui-ux-stabilization-pending.md
sketches/                              # exploratory mockups + render evidence
var/                                   # manual-test runtime data
```

Only design artifacts under `docs/design/issue-56/` are candidates for this issue. Confirm every path through an explicit `git add <allowlist>` before any commit.

---

# Execution slices — perform vertically, TDD first

## Slice 0 — Discover baseline and pin artifacts

**Objective:** Ensure the next agent understands actual App handlers/types, carries the approved artifacts, and starts from a reproducible baseline.

**Read first:**

```text
apps/web/src/App.tsx
apps/web/src/App.test.tsx
apps/web/src/styles.css
docs/design/issue-56/canonical-hybrid.md
docs/design/issue-56/canonical-hybrid.html
.github/gandiwa-dependencies.json
docs/DEVELOPMENT-SEQUENCE.md
```

**Steps:**

1. Run `git status --short --branch`, `git fetch origin --prune`, and confirm `origin/main` has not moved. If it moved, inspect remote-only changes and rebase/merge only with an explicit user instruction.
2. Confirm the four canonical artifacts exist and screenshots have dimensions 1150×917 and 1366×821 (the latter is full-page output from a 1366×768 viewport).
3. Run baseline focused frontend tests and the full project gates as appropriate:

```bash
corepack pnpm --filter @gandiwa/web test
corepack pnpm check
uv run --project apps/api pytest
python3 -m unittest tests/kanban/test_kanban_flow.py -v
git diff --check
```

4. Record baseline failures honestly; do not work around failures by weakening a gate.
5. When the user authorizes a documentation checkpoint, stage only the four approved `docs/design/issue-56/**` artifacts plus any deliberately created design decision documentation. Do not stage `sketches/`, `var/`, or unrelated `.hermes` handoffs.

**Definition of done:** baseline and source mapping are known; design assets are ready but no remote side effect occurs without permission.

---

## Slice 1 — Pure guided-workflow presentation adapter

**Objective:** Create a testable UI presentation adapter that translates already-authoritative domain state into exactly one current task, one primary action target/label, completed steps, and human-readable blockers.

**Likely files:**

```text
Create: apps/web/src/workflow/guided-workflow.ts
Create: apps/web/src/workflow/guided-workflow.test.ts
Modify: apps/web/src/App.tsx
Modify: apps/web/src/App.test.tsx only if integration coverage is required
```

**Important:** First inspect actual existing types for project/asset, loaded metadata, durable audit, approval submission/gate, exporting state, and error state. The adapter input must use explicit data supplied from those types. It must not read filesystem handles, mutate state, or duplicate validation/checksum comparison.

### Required states

```ts
export type GuidedWorkflowState =
  | 'NO_PROJECT'
  | 'PROJECT_EMPTY'
  | 'REVISION_REQUIRED'
  | 'METADATA_REQUIRED'
  | 'AUDIT_REQUIRED'
  | 'AUDIT_RUNNING'
  | 'AUDIT_BLOCKED'
  | 'AUDIT_WARNING'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'EXPORTING'
  | 'EXPORTED'
```

The exact state discriminants may be refined after reading real domain data, but the behavior must cover all above states. Build a `GuidedWorkflowPresentation` with explicit `activeStep`, title, explanation, `primaryActionLabel`, action target/intent, blockers, and completed steps.

### TDD cycle

For one state at a time:

1. Add a pure test for `NO_PROJECT`, run it and prove RED because adapter does not exist.
2. Implement minimum pure adapter shape, rerun green.
3. Add `REVISION_REQUIRED` vs `METADATA_REQUIRED` test proving preflight does not count as durable preparation.
4. Add audit pass/warning/fail/stale cases. A stale/missing/mismatched audit must never expose approval/export as current.
5. Add approval and export cases. `APPROVED` only occurs when existing gate says current/CLEAR; otherwise export stays blocked.
6. Add explicit async/busy display cases only from current operation state; adapter must not create a second source of truth.
7. Run focused test after each RED→GREEN pair, then full frontend test.

**Definition of done:** presentation mapping is pure, small, fully tested, and cannot say ready where authoritative domain logic says blocked/stale.

---

## Slice 2 — Shell and responsive information architecture

**Objective:** Install the Canonical Hybrid shell without changing what existing handlers do.

**Likely files:**

```text
Create: apps/web/src/components/shell/AppShell.tsx
Create: apps/web/src/components/shell/ProjectSidebar.tsx
Create: apps/web/src/components/shell/WorkspaceHeader.tsx
Create: apps/web/src/components/shell/WorkflowStepper.tsx
Create: apps/web/src/components/shell/ContextInspector.tsx
Create: apps/web/src/components/status/StatusBadge.tsx
Modify: apps/web/src/App.tsx
Modify: apps/web/src/styles.css
Create/modify: matching *.test.tsx files
```

Exact decomposition may adapt to existing repo conventions, but do not leave the entire new hierarchy in `App.tsx`.

### TDD behaviors

1. Write a failing render test that, with an active project, expects semantic regions: navigation/sidebar, workspace header, workflow stepper, task outlet, and contextual inspector.
2. Implement the smallest shell with current content still rendered in its old outlet; verify test green.
3. Add test that exactly one `[data-testid="primary-workflow-action"]` or semantically equivalent primary action exists in an active task state. The inspector must contain no duplicate primary action.
4. Add keyboard/ARIA test: current step has a programmatic current indication, blocked step describes why it is unavailable, and inspector drawer button is keyboard-operable.
5. Add responsive browser/component test appropriate to current test tooling. At minimum, no essential primary action is located only in inspector.
6. Render shell at 1150×917 and 1366×768 in Playwright/manual browser QA. At 1150, inspector must be drawer; at 1366, it must be desktop panel.

### CSS guardrails

- Remove/retire old grid/card rules only when no existing route/component uses them.
- Use named design tokens, not arbitrary one-off hex values scattered through components.
- Focus indicators must stay visible.
- Use light workspace, dark sidebar, restrained amber primary CTA.
- Avoid nested cards and the old equal-weight panel stack.

**Definition of done:** visual hierarchy exists before moving workflows; old domain behavior remains accessible; one CTA and breakpoint behavior are proven.

---

## Slice 3 — Guided Stage 4 task outlet

**Objective:** Move existing Stage 4 controls into state-driven task surfaces one vertical workflow stage at a time.

**Likely feature locations:**

```text
Create: apps/web/src/features/preparation/RevisionPreparation.tsx
Create: apps/web/src/features/metadata/MetadataEditor.tsx
Create: apps/web/src/features/audit/AuditCenter.tsx
Create: apps/web/src/features/approval/ApprovalPanel.tsx
Create: apps/web/src/features/export/ExportCenter.tsx
Modify: apps/web/src/App.tsx
Modify: apps/web/src/App.test.tsx
```

Use existing `ApprovalGatePanel`/`AuditCenterPanel` as migration starting points only after reading their props/tests. Preserve behavior before changing presentation.

### 3A — Preparation

1. RED: active asset without durable submission revision shows preparation as the sole heavy task and primary action; raster preflight is available as a clearly labeled secondary inspect tool.
2. GREEN: move existing raster preparation handler/file input into `RevisionPreparation`; preserve source-not-overwritten and async invalidation behavior.
3. RED/GREEN: after revision creation, presentation moves to metadata required and previous audit/approval/export state is visibly stale/blocked per existing contracts.

### 3B — Metadata

1. RED: prepared revision with missing/invalid metadata shows metadata as sole heavy task and one save/complete primary action.
2. GREEN: move existing editor/handler intact; provenance stays immutable and conflict/corrupt sidecar errors remain fail-closed.
3. RED/GREEN: successful metadata save goes to audit required; late preflight/audit cannot resurrect a ready state.

### 3C — Audit

1. RED: valid revision + metadata exposes one `Run audit` action and current evidence summary.
2. GREEN: move current audit invocation/report component; show PASS/WARNING/FAIL/STALE, rule ID, evidence/remediation as required by Issue #16.
3. RED/GREEN: warning is visible without incorrectly clearing a blocking issue; stale/mismatch goes back to recovery task.

### 3D — Approval

1. RED: only current durable audit + metadata exposes human approval task.
2. GREEN: keep existing explicit confirmation and all revision/metadata/audit/ruleset/checksum bindings.
3. RED/GREEN: changed artwork or metadata invalidates approval and returns workflow to appropriate recovery state.

### 3E — Export

1. RED: export surface becomes primary task only where existing `approvalGate.exportGate === 'CLEAR'`; otherwise it stays future/blocked with explanation.
2. GREEN: reuse existing `handleExport`/`writeExportPackage` lifecycle. Do not move writer logic into components.
3. RED/GREEN: permission denial, candidate changes, marker collision, and late operation invalidation retain existing fail-closed behavior and correct contextual recovery copy.

**Definition of done:** the old vertical stack is gone; every Stage 4 action still invokes the same authoritative path and has both integration and pure/domain regression coverage.

---

## Slice 4 — Advanced evidence/detail surface

**Objective:** Make technical evidence inspectable without bloating the default task workspace.

**Likely files:**

```text
Create: apps/web/src/features/evidence/EvidenceDetail.tsx
Create: apps/web/src/features/evidence/EvidenceTimeline.tsx
Create: apps/web/src/components/EvidenceDisclosure.tsx
Modify: shell/inspector components and App state
Add: evidence-detail tests
```

1. RED: clicking `Inspect details` opens an advanced detail surface with Evidence, Metadata, Audit Report, and History tabs (or the smallest accessible equivalent); default task remains present/unchanged.
2. GREEN: use real loaded data only. Never invent a checksum, audit, approval, or history event.
3. RED/GREEN: missing data shows `not available` honestly; stale evidence stays stale/blocked in both default and detail views.
4. Add keyboard test for disclosure/tabs/focus restore; Escape closes non-destructive drawer/dialog.

**Definition of done:** evidence is discoverable for reviewers/power users yet does not reproduce the wall of detail in the guided default view.

---

## Slice 5 — Accessibility, visual QA, and final integration audit

**Objective:** Prove the final working tree satisfies #56 without weakening old safety contracts.

1. Create test coverage for all required presentation states:

```text
no project; empty project; permission denied/remembered handle unavailable;
external manifest changed; revision required; temporary preflight only;
prepared revision; invalid metadata; audit missing/running/pass/warning/fail/stale;
approval required; approved; approval invalidated; export running/complete/mismatch;
backend unavailable; worker stopped.
```

Stage 5 provider/queue states must remain absent/disabled unless their backend issue actually exists and is implemented.

2. Run full frontend suite, API suite, lint/typecheck/build/check, Kanban test, and `git diff --check`:

```bash
corepack pnpm --filter @gandiwa/web test
corepack pnpm check
uv run --project apps/api pytest
python3 -m unittest tests/kanban/test_kanban_flow.py -v
git diff --check
```

3. Serve and test secure Tailscale runtime using existing temporary services only:

```text
https://bejo1-oracle.taile0be3c.ts.net
```

Do not give VM loopback URL to Guru. Verify public page and `/api/v1/status` before handoff.

4. Capture manual/browser evidence at 1150×917 and 1366×768; test all principal workflow states and drawer behavior.
5. Run independent code/design review against the **final working tree**, not an earlier checkpoint. Blocking findings require TDD regression + re-run affected gates + re-review.
6. Prepare a HITL approval packet: exact files, behavior changes, test numbers/output, visual evidence, limits, and explicit statement `not committed / not pushed / no PR`.

---

## Commit/push/PR gate

Master must explicitly authorize each remote/local boundary. When authorized:

1. `git fetch origin --prune` and compare `origin/main`, local branch, and live remote branch.
2. Stage explicit allowlist only. Never `git add .`.
3. Run `git diff --cached --check`, inspect staged names/stat/diff, perform security scan and independent review.
4. Commit with a message that states the actual completed slice; no premature `Fixes #56` claim until feature is complete.
5. Push branch; verify `git rev-parse HEAD` exactly equals `git ls-remote origin refs/heads/feat/issue-56-guided-workflow`.
6. Only when all #56 acceptance and independent audit are complete and the user says `buat PR`, open a PR from `feat/issue-56-guided-workflow` to `main` with exactly one `Fixes #56` reference.
7. Never merge without separate user instruction.

## Known risks / pepeling

- **Highest risk:** visual refactor accidentally bypasses or regresses fail-closed domain/evidence logic. Preserve handlers and write integration tests before moving UI.
- **Highest UX risk:** reintroducing two primary CTAs via inspector + task surface. Assert it in tests.
- **Responsive risk:** three-area grid must not be forced at 1150px.
- **Scope risk:** #56 must not sneak in Stage 5 providers/queue/gallery or Stage 6 editor implementation.
- **Git risk:** current worktree has untracked runtime/mockup/plan files. Explicit allowlist only.
- **Documentation risk:** canonical screenshot 1366×821 is full-page output taken from a 1366×768 viewport; do not call it a 1366×821 viewport test.
