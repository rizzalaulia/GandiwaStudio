# Issue #19 — Approval Gate

Issue #19 defines a browser-local, revision-bound human approval gate. It does not upload to Adobe Stock or create an export package; those behaviors belong to Issue #20.

> **Implementation status — in progress:** the branch now contains the durable audit action, actual revision-byte resolver, explicit human approval write flow, store/resolver regression tests, and stale/reopen state handling. Final independent acceptance audit and any remaining lifecycle gaps must still pass before Issue #19 is called complete. This status must not be described as merged or as a guarantee of Adobe Stock acceptance.

The current UI targets the latest prepared revision of the latest asset explicitly shown in the approval panel. Approval is never inferred from the ephemeral Audit Center `file-...` identity.

The implementation deliberately keeps export packaging, download, and Adobe upload out of scope for Issue #19; those remain Issue #20 work.


An approval is valid only when the current project revision, actual submission-byte SHA-256, metadata sidecar SHA-256, durable audit snapshot SHA-256, and ruleset ID/version all match the approval record. The portable `gandiwa-project.json` manifest v1 remains unchanged.

Durable evidence is stored below the user-owned project folder:

- `reports/audits/<asset-id>-r<revision>.json`
- `reports/approvals/<asset-id>-r<revision>.json`

The MVP keeps **one current approval record per asset/revision**. Re-approval may replace that current record only when the exact existing sidecar snapshot still matches; it is not append-only approval history and it never silently overwrites a concurrent/external change. Durable audits and approvals are separate evidence records.

Missing, malformed, changed, or mismatched evidence fails closed. A warning-only audit can proceed to explicit human approval, but blocking findings cannot. Metadata provenance validation remains mandatory, including AI disclosure for generative-AI assets.

`ADOBE_READY` means the Gandiwa evidence gate passed for manual submission. It is not a guarantee that Adobe Stock will accept the content.

The File System Access API has no portable cross-tab compare-and-swap lock. Implementations re-read manifest and sidecar snapshots immediately before writes and must report residual TOCTOU limitations honestly. No raw source bytes, absolute paths, provider credentials, or API responses belong in approval sidecars.
