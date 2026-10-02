# Issue #28 — Raster vertical-slice acceptance evidence

> **Status: in progress — do not close Issue #28 or open a completion PR from
> this document.**
>
> Evidence below is verified against branch
> `feat/issue-28-raster-vertical` at commit
> `d7f444c5065942301de11bb8ecb53b88ed9faea8`, plus uncommitted acceptance
> evidence in this worktree. The issue remains open pending final independent
> review and full repository-quality gates; no completion PR has been opened.

## Scope

Issue #28 proves that raster candidates travel through the durable Gandiwa
workflow without confusing **candidate retrieval** with **Adobe-ready export**.
It covers imported Photo and provider-originated generative-AI Illustration
artifacts. It does not add an upscaler; that work is tracked separately in
#68.

## Non-negotiable product boundary

A user's candidate is a working file they own. A failed audit, a sub-4 MP
prepared output, missing metadata, stale approval, or any other submission
failure must block only Gandiwa's master/approval/export-package path. It must
never delete, hide, encrypt, or disable retrieval of the original imported or
generated candidate.

A raw provider PNG is therefore not silently relabelled as a submission
master. In the canonical Beranda flow the user selects a candidate and chooses
**"Siapkan JPEG untuk audit"**. The application writes a separate prepared
JPEG revision plus preparation evidence; the source candidate revision remains
unchanged and accessible. Only that prepared JPEG revision can be locked as
the submission master.

## Verified evidence currently in this branch

### Preparation and Beranda durability — commit `d7f444c`

The Beranda fixture now models the full browser-local File System Access write
transaction used by the production flow:

- manifest publication becomes visible only after writable `close()`;
- a later reopen reads the published manifest rather than fixture-start text;
- prepared revision files (`master.jpeg` and `preparation.json`) persist and
  can be read by the real master-selection checksum gate;
- the real `prepareExistingRasterRevision` and real master-selection store run
  in the UI regression; only the non-deterministic browser canvas JPEG encoder
  is stubbed;
- tests assert that reopening preserves the prepared JPEG master and does not
  turn the original raw candidate into the master.

This repairs the former fixture-only false failure:
`project manifest changed externally`. The safeguard itself was not weakened;
the fixture now publishes the same durable state that the production path
expects to read.

### Contract coverage already present

`apps/web/src/beranda/raster-revision-preparation.test.ts` verifies that a
preparation operation:

1. leaves the source candidate bytes untouched;
2. creates a newly numbered JPEG submission revision with `preparation.json`;
3. records source revision, dimensions, and preparation evidence; and
4. rejects a result below 4 MP before creating a revision or changing the
   manifest.

`apps/web/src/issue-28-raster-vertical.test.ts` currently contains two durable
pipeline regressions:

1. an imported/camera Photo reaches prepared JPEG, metadata, durable PASS
   audit, master selection, human approval, and portable export package; and
2. a provider-originated generative-AI Illustration preserves its candidate
   bytes while AI disclosure-backed metadata and a durable failed audit keep
   the approval/export gate blocked.

The second regression proves the ownership boundary for a generated candidate:
the candidate remains retrievable even while audit/export is blocked.

### Generated Illustration success and fail-closed evidence

The same test file now also runs three production-code acceptance scenarios
against a coherent in-memory File System Access fixture. The only upstream
boundary is deterministic local artifact/preflight input; preparation,
metadata, audit persistence, master selection, approval persistence, export
resolution, and package writing are production code.

1. **Generated success:** a generated PNG candidate revision is preserved, then
   production preparation creates a separate JPEG prepared revision. That JPEG
   receives disclosure-backed `generative_ai` metadata, a durable PASS audit,
   selected master, and current human approval. `resolveExportPackageCandidate`
   returns `APPROVED / ADOBE-READY` with `exportGate: CLEAR`;
   `writeExportPackage` writes the package and its `export-manifest.json`
   passes `validateExportManifest`.
2. **Stale approval:** after approval, metadata is changed and a new durable
   audit is recorded. The existing approval no longer matches the evidence and
   the fresh export resolver rejects with `Existing approval is stale`.
3. **Invalid audit:** after approval, the durable audit sidecar is corrupted.
   The export resolver refuses it with `audit snapshot is invalid`; a prior
   approval cannot be used to bypass malformed audit evidence.

## Provider boundary

The generated-raster tests use deterministic local artifact bytes and mocked
raster-preflight responses. They do **not** submit a billed live fal.ai request.
A real provider smoke requires explicit authorization and a billed credential;
any such evidence must be redacted and must not be fabricated.

## Remaining release discipline

These scenarios close the missing automated generated-raster acceptance paths,
but they do not authorize a release on their own. Before presenting Issue #28
as ready for PR, obtain an independent review of the exact final tree and a
clean repository-wide gate. At this checkpoint, root `corepack pnpm check`
stops in the API Ruff phase on three pre-existing, out-of-scope findings in
`apps/api/scripts/paku3_enqueue_local_test.py` (E501 line 33, F841 line 57,
and F401 line 83); this Issue #28 diff does not modify that file. The
web-specific lint, strict typecheck, tests, and production build below pass.
The deterministic artifact fixture is not a billed live fal.ai smoke; live
provider generation remains an explicitly authorized operation outside this
test evidence.

## Commands independently rerun for the current checkpoint

```bash
corepack pnpm --filter @gandiwa/web test -- --run src/issue-28-raster-vertical.test.ts
corepack pnpm --filter @gandiwa/web exec tsc --noEmit
corepack pnpm --filter @gandiwa/web exec eslint \
  src/issue-28-raster-vertical.test.ts \
  src/beranda/raster-revision-preparation.test.ts
corepack pnpm --filter @gandiwa/web test

git diff --check
```

Observed result for the full web suite after the three generated-raster
acceptance tests were added:

```text
Test Files  39 passed (39)
Tests       292 passed (292)
```

The web package consumes generated workspace declarations in a clean checkout;
when executing final full-project gates, build direct workspace dependencies
first and run the repository-wide lint, typecheck, test, build, and relevant
API/verification gates as required by the development workflow.
