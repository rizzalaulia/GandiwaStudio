# Portable export package

Issue #20 writes a browser-local, reviewable package under the user-owned project folder. It does not create a ZIP, browser download, backend endpoint, cloud sync, provider call, or Adobe upload.

## Eligibility and contents

The Export action resolves the current project manifest, final revision bytes, metadata sidecar, durable audit, and approval sidecar afresh. It recomputes the approval gate and proceeds only for:

- `APPROVED / ADOBE-READY`;
- `adobeReady: true`; and
- `exportGate: CLEAR`.

`ADOBE-READY` means only that Gandiwa's local preparation gate is satisfied for a manual submission. It is not an Adobe acceptance guarantee.

A completed package has this exact shape:

```text
exports/<asset-id>-r<revision>-<submission-checksum-16>/
├── final.jpeg | final.svg
├── metadata.json
├── audit-report.json
├── approval.json
├── gandiwa-project.json
└── export-manifest.json
```

The package identifier derives only from canonical asset UUID, positive revision, and the SHA-256 prefix of actual approved submission bytes. It never uses a project title, source filename, absolute path, or browser-handle detail.

`export-manifest.json` is canonical pretty JSON, records the fixed-order copied files with SHA-256 and byte counts, and is written last. It is the completion marker; a directory without it is an incomplete recovery artifact, not a completed export.

## Write and recovery protocol

1. The UI resolves all durable evidence before requesting `readwrite` permission.
2. After permission it resolves and compares every bound identity again.
3. The writer rejects a package directory, payload file, or completion marker that already exists. It never deletes or overwrites an existing object.
4. Evidence is resolved again before the writer starts, before marker-handle creation, before `createWritable`, before marker write, before marker close, and after marker close before the writer returns success.
5. If an error, denial, changed evidence, or superseded project lifecycle is observed at one of those boundaries, no success is shown. Partial directories are deliberately retained for user inspection and have no valid completion marker. If invalidation is observed only after a marker close has already completed, FSA cannot atomically retract that closed file; the caller still receives no success and the artifact must be treated as recovery evidence.

The original revision bytes and the project manifest are read and copied only; export never modifies them.

## Browser File System Access limitation

The File System Access API provides no portable cross-tab/process lock, exclusive directory creation, atomic rename, or compare-and-swap. Therefore an absence check followed by `{ create: true }` still has a residual TOCTOU boundary if another tab/process mutates the same deterministic package directory at exactly that boundary.

Gandiwa fails closed whenever it can observe a pre-existing package/file/marker, and the checksummed final marker makes partial or later-tampered packages detectable. It does **not** claim multi-file atomicity or cross-tab create exclusivity. Users must not concurrently export the same project/revision from another tab or process; inspect any existing deterministic package rather than retrying over it.
