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

Missing, malformed, changed, or mismatched evidence fails closed. A warning-only audit can proceed to explicit human approval, but blocking findings cannot. Metadata provenance validation remains mandatory, including AI disclosure for generative-AI assets. A finding whose authoritative ruleset rule is marked `blocks_export` never presents as a non-blocking warning even when the transport report keeps a softer aggregate verdict; the JPEG submission-format check on the actual revision bytes stays authoritative over the report envelope. When previously written audit evidence can no longer be revalidated (for example the metadata sidecar disappeared or changed), reopen still returns the old snapshot but only as an explicit `STALE` status — never as a valid gate — so a repaired re-audit can replace the sidecar under its snapshot-comparison write guard.

`ADOBE_READY` means the Gandiwa evidence gate passed for manual submission. It is not a guarantee that Adobe Stock will accept the content.

The File System Access API has no portable cross-tab compare-and-swap lock. Implementations re-read manifest and sidecar snapshots immediately before writes and must report residual TOCTOU limitations honestly. No raw source bytes, absolute paths, provider credentials, or API responses belong in approval sidecars.

Residual TOCTOU boundary (documented limitation): the audit save path re-reads `gandiwa-project.json` and the existing sidecar immediately before writing, and re-verifies revision/metadata checksums at the final-evidence boundary, but the FSA write stream has no portable atomic file replacement. If another tab or process replaces the manifest or the same `reports/audits/<asset-id>-r<revision>.json` sidecar in the window between that last verification and stream close, the last writer wins silently. Gandiwa treats this as documented, not solved: no cross-tab lock is claimed, an externally replaced sidecar is detected as a changed snapshot on the next audit/approval run (fail-closed), and the sidecar remains just stale evidence, not a valid gate. Users must not run concurrent audits/approvals of the same project/revision from multiple tabs or processes.

Approval is additionally master-bound: `saveApproval` accepts the master-selection snapshot the human saw and stores it only when the byte-identical snapshot is still on disk at `reports/master-selection.json` and the selected master record still names the target asset/revision; drift or mismatch fails closed before any approval byte is written. Re-selection of a different master never retroactively invalidates an existing approval record — approvals remain bound to their own revision bytes, audit, and metadata checksums, and the master pointer alone is not evidence.

Export is master-bound too: `resolveExportPackageCandidate` re-reads `reports/master-selection.json` on every resolution and blocks the package when no master exists, when the master names a different asset/revision, when the recorded relative path does not match the exported manifest revision, or when the master revision bytes no longer hash to the recorded checksum. Because the resolver runs again inside every `verifyCurrentEvidence` checkpoint (double resolve, post-permission, and each marker-boundary call), a master re-selection or revision-byte mutation at any point aborts the export before or at the completion marker, never after it.
