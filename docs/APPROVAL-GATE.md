# Issue #19 — Approval Gate

Issue #19 defines a browser-local, revision-bound human approval gate. It does not upload to Adobe Stock or create an export package; those behaviors belong to Issue #20.

> **Implementation checkpoint — not complete:** the current branch contains the initial pure gate, sidecar-store foundations, submission resolver draft, and a fail-closed UI panel. The durable audit action, human approval write flow, complete store/resolver tests, and stale/reopen integration are still pending. This checkpoint must not be described as a completed Issue #19 implementation or as `ADOBE_READY` functionality.


An approval is valid only when the current project revision, actual submission-byte SHA-256, metadata sidecar SHA-256, durable audit snapshot SHA-256, and ruleset ID/version all match the approval record. The portable `gandiwa-project.json` manifest v1 remains unchanged.

Durable evidence is stored below the user-owned project folder:

- `reports/audits/<asset-id>-r<revision>.json`
- `reports/approvals/<asset-id>-r<revision>.json`

Missing, malformed, changed, or mismatched evidence fails closed. A warning-only audit can proceed to explicit human approval, but blocking findings cannot. Metadata provenance validation remains mandatory, including AI disclosure for generative-AI assets.

`ADOBE_READY` means the Gandiwa evidence gate passed for manual submission. It is not a guarantee that Adobe Stock will accept the content.

The File System Access API has no portable cross-tab compare-and-swap lock. Implementations re-read manifest and sidecar snapshots immediately before writes and must report residual TOCTOU limitations honestly. No raw source bytes, absolute paths, provider credentials, or API responses belong in approval sidecars.
