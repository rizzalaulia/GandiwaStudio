# Gandiwa Studio

> An open-source, compliance-aware workspace for producing stock photos, illustrations, and vectors with user-selected AI APIs.

[![CI](https://github.com/rizzalaulia/GandiwaStudio/actions/workflows/ci.yml/badge.svg)](https://github.com/rizzalaulia/GandiwaStudio/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Status

**MVP implementation started.** The contract is locked as `mvp-1.0`. The repository currently contains reproducible application foundations only; no production-ready workflow is claimed yet.

## Vision

Gandiwa Studio helps a contributor move from brief to an audited export package. The user explicitly selects `Photo`, `Illustration`, or `Vector`, a backend-configured connector, and its model. Gandiwa is an API client/orchestrator—not an AI router. A selected 9Router endpoint remains responsible for its own routing behavior.

## Locked MVP

- Single-user, local-first, desktop browser app for current Chrome/Edge.
- Browser-owned local project folders through File System Access API; no built-in cloud sync.
- Explicit content type, creation method, connector, and model selection; no Gandiwa-owned routing/fallback.
- Required connectors: 9Router and fal.ai.
- SQLite durable queue with one separate worker, priority+FIFO, lease/heartbeat, recovery, and REST polling.
- Raster path to Adobe-ready JPEG and vector path to Adobe-ready SVG.
- Lightweight SVG editing, deterministic preflight, AI risk screening, metadata, approval, and export package.
- Development on `bejo1-oracle`; production on ARM64 `bejo2-vnic` using host Nginx + Docker Compose.
- Manual Adobe Stock upload.

Core contracts: [development sequence](docs/DEVELOPMENT-SEQUENCE.md), [project manifest](docs/PROJECT-MANIFEST.md), [technology](docs/TECHNOLOGY.md), [architecture](docs/ARCHITECTURE.md), [runtime status](docs/STATUS-CONTRACT.md), [bejo2 deployment](docs/DEPLOYMENT-BEJO2.md), [operations](docs/OPERATIONS.md), [PRD](docs/PRD.md), [BRD](docs/BRD.md), [ERD](docs/ERD.md), [design system](docs/DESIGN.md), and [Adobe ruleset](docs/ADOBE-RULESET.md).

## Planned Architecture

```text
apps/web       React + TypeScript + Vite browser workspace
apps/api       Python 3.12 FastAPI API + separate worker command
packages/*     Shared schemas, rules, provider contracts, and UI
project folder Portable manifest and user-owned artifacts
SQLite         WAL cache/index + durable runtime queue
production     Static frontend + host Nginx + Docker Compose on bejo2-vnic
```

The application directories now contain the reproducible TypeScript and Python foundations. Product workflows remain intentionally absent until their corresponding issues and tests are completed.

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

Before adding behavior, read:

1. [Locked development sequence](docs/DEVELOPMENT-SEQUENCE.md)
2. [Technology contract](docs/TECHNOLOGY.md)
3. [Architecture](docs/ARCHITECTURE.md)
4. [CONTRIBUTING.md](CONTRIBUTING.md)
5. [PRD](docs/PRD.md)
6. [Adobe ruleset](docs/ADOBE-RULESET.md)
7. [bejo2 deployment contract](docs/DEPLOYMENT-BEJO2.md)

### Prerequisites

- Node.js `22.23.2` (see `.node-version`)
- Corepack with pnpm `12.3.4` from `packageManager`
- Python `3.12.3` (see `.python-version`)
- uv `0.12.3` or a compatible newer release

### Reproducible setup

```bash
corepack enable
pnpm install --frozen-lockfile
uv sync --project apps/api --locked
```

### Canonical commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

`pnpm check` runs lint, strict type checks, tests, production builds, and repository verification. Stage 1 exposes `/api/v1/health`, `/api/v1/ready`, and `/api/v1/status`, plus the separate `corepack pnpm worker` command. The web shell deliberately has no project-management or generation behavior until its corresponding stage is implemented.

## Security

Never commit provider keys, project assets, generated submissions, or personal releases. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. The MVP scope is locked; scope-expanding changes require a written proposal. See [CONTRIBUTING.md](CONTRIBUTING.md) and [GOVERNANCE.md](GOVERNANCE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE). Documentation and code contributions are submitted under the same license unless explicitly stated otherwise.

## Disclaimer

“Adobe” and “Adobe Stock” are trademarks of Adobe. This independent project is not affiliated with or endorsed by Adobe. An `ADOBE_READY` result means only that configured Gandiwa checks passed; it never guarantees marketplace acceptance.
