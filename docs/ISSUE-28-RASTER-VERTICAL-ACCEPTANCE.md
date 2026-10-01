# Issue #28 — Raster vertical-slice acceptance evidence

## Scope

Issue #28 proves that raster candidates travel through the durable Gandiwa
workflow without confusing **candidate retrieval** with **Adobe-ready export**.
It covers imported Photo and provider-originated generative-AI Illustration
artifacts. It does not add an upscaler; that work is tracked separately in
#68.

## Contract proved by automated scenarios

1. A valid raster source is preserved as an immutable candidate revision.
2. A prepared JPEG submission must be at least 4 MP; the preparation writer
   rejects a smaller output and never creates a partial revision.
3. Raster metadata is durable, provenance-bound, and requires an explicit AI
   disclosure for a `generative_ai` asset.
4. Audit, approval, master selection, and export are fail-closed. Missing,
   failed, or stale evidence cannot produce an Adobe-ready package.
5. A failed audit does **not** delete, encrypt, or otherwise block the original
   candidate bytes. The restriction is limited to approval/export-ready state.
6. A successful approval is bound to exact submission bytes, metadata,
   audit evidence, ruleset identity/version, and selected master revision.

## Provider boundary

The generated-raster path is exercised with deterministic artifacts and mocked
preflight responses. It does **not** submit a live fal.ai generation request:
a real provider smoke requires an explicitly approved, billed credential and
must record only redacted operational evidence. No result is fabricated here.

## Commands executed for this change

```bash
corepack pnpm --filter @gandiwa/contracts build
corepack pnpm --filter @gandiwa/adobe-rules build
corepack pnpm --filter @gandiwa/web test -- --run src/issue-28-raster-vertical.test.ts
corepack pnpm --filter @gandiwa/web test
corepack pnpm --filter @gandiwa/web exec tsc --noEmit
```

The first two builds are an explicit prerequisite: web tests consume the shared
packages' generated `dist` declarations in a clean checkout.
