# Contracts

Versioned contracts shared by browser TypeScript and backend Python.

## Portable project manifest v1

`src/project-manifest.ts` validates `gandiwa-project.json` for browser-owned project folders. The Python counterpart is `gandiwa_api.project_manifest`. Both consume the same synthetic corpus under `tests/fixtures/project-manifest/` so incompatible changes cannot drift silently.

Run the TypeScript conformance gate:

```text
corepack pnpm --filter @gandiwa/contracts test
```

Schema, path rules, format matrix, provenance enum, and the explicit boundary between rebuildable creative index and durable backend state are documented in `docs/PROJECT-MANIFEST.md`.

This package stores no provider secret and implements no routing, fallback, load balancing, or provider selection.
