# @gandiwa/adobe-rules

Versioned evaluator contracts and synthetic fixture harness for the locked Adobe Stock MVP ruleset.

## Locked ruleset

`ADOBE_STOCK_MVP_RULESET` represents `adobe-stock-2026-09-08-v1` from `docs/ADOBE-RULESET.md`. Every rule carries:

- stable rule ID;
- official Adobe source URL, retrieval date, and ruleset version;
- evaluator type: `prompt`, `deterministic_postcheck`, `ai_review`, or `human_confirmation`;
- severity and explicit export-blocking behavior; and
- one or more synthetic fixture IDs.

Ruleset snapshots reject duplicate rule IDs, absent sources, or a rule whose fixture reference is not included in the same ruleset. `createRulesetSnapshot()` copies and deep-freezes the contract so a later mutable ruleset object cannot change an already bound job/audit.

## Audit contract

`createAuditRun()` binds findings to exactly one `asset_revision_id`, `ruleset_id`/version, and lowercase SHA-256 asset checksum. Each returned finding derives its source, rule version, evaluator type, severity, and blocking flag from the snapshot; callers only provide the rule ID, verdict, and evidence.

The deterministic `export_gate` is `BLOCKED` only when a rule that declares `blocks_export: true` has verdict `FAIL`. Warning-only rules and AI-review recommendations cannot grant or block acceptance on their own. This gate is a Gandiwa ruleset result, not a promise of Adobe acceptance.

## Fixture harness

`fixtures/adobe-stock-mvp.json` is a metadata-only, synthetic corpus. It records expected inputs and verdicts, never real assets, API keys, private artwork, or provider routing state. `evaluateFixtureCorpus()` checks that every fixture has a matching official source/rule and that the corpus exactly covers all fixture IDs required by the snapshot.

This issue deliberately defines contracts and fixture expectations only. Secure raster inspection belongs to Issue #14; hostile-SVG sanitization and structural inspection belong to Issue #15; presentation and stale UI state belong to Issue #16.

Run the package tests:

    corepack pnpm --filter @gandiwa/adobe-rules test
