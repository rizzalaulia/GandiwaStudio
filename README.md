# Gandiwa Studio

> An open-source, compliance-aware workspace for producing stock photos, illustrations, and vectors with user-selected AI APIs.

[![CI](https://github.com/rizzalaulia/GandiwaStudio/actions/workflows/ci.yml/badge.svg)](https://github.com/rizzalaulia/GandiwaStudio/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Status

**Pre-development / documentation-first.** The MVP contract is locked as `mvp-1.0`. No production application is claimed yet.

## Vision

Gandiwa Studio helps a contributor move from brief to an audited export package. The user explicitly selects `Photo`, `Illustration`, or `Vector`, the API endpoint, and the model. Gandiwa is an API client/orchestrator—not an AI router. A selected 9Router endpoint remains responsible for its own routing behavior.

## Locked MVP

- Single-user desktop-first web app for current Chrome/Edge.
- Local project folders through the File System Access API.
- Explicit content type, creation method, endpoint, and model selection.
- Required connectors: 9Router and fal.ai.
- Raster path to Adobe-ready JPEG and vector path to Adobe-ready SVG.
- Lightweight SVG editing, deterministic preflight, AI risk screening, metadata, approval, and export package.
- Manual Adobe Stock upload.

See [PRD](docs/PRD.md), [BRD](docs/BRD.md), [ERD](docs/ERD.md), [Design system](docs/DESIGN.md), and [Adobe ruleset](docs/ADOBE-RULESET.md).

## Planned Architecture

```text
apps/web       React + TypeScript browser workspace
apps/api       FastAPI processing and provider connectors
packages/*     Shared schemas, rules, provider contracts, and UI
project folder Portable manifest and user-owned artifacts
SQLite         Rebuildable cache/index/runtime state
```

The directories are contracts for future implementation and intentionally contain no fabricated application code.

## Repository Layout

```text
apps/                 Deployable web and API applications
packages/             Reusable contracts and components
docs/                 Product and architecture documents
tests/fixtures/        Safe deterministic validation fixtures
scripts/               Repository verification utilities
.github/               CI, issue forms, and contribution templates
```

## Development

Implementation has not started. Before adding code, read:

1. [CONTRIBUTING.md](CONTRIBUTING.md)
2. [docs/PRD.md](docs/PRD.md)
3. [docs/ADOBE-RULESET.md](docs/ADOBE-RULESET.md)
4. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Run the current documentation quality gate:

```bash
python3 scripts/verify_repository.py
```

## Security

Never commit provider keys, project assets, generated submissions, or personal releases. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. The MVP scope is locked; scope-expanding changes require a written proposal. See [CONTRIBUTING.md](CONTRIBUTING.md) and [GOVERNANCE.md](GOVERNANCE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE). Documentation and code contributions are submitted under the same license unless explicitly stated otherwise.

## Disclaimer

“Adobe” and “Adobe Stock” are trademarks of Adobe. This independent project is not affiliated with or endorsed by Adobe. An `ADOBE_READY` result means only that configured Gandiwa checks passed; it never guarantees marketplace acceptance.
