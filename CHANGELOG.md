# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Stage 1 Gandiwa shell backed by `GET /api/v1/status`, with non-sensitive backend readiness and fail-closed worker-heartbeat state.
- Separate packaged `gandiwa-worker` command with SIGINT/SIGTERM shutdown and observable SQLite heartbeat state.
- Same-origin Vite `/api` development proxy and runtime status contract/runbook.
- Reproducible pnpm monorepo and Python 3.12/FastAPI package foundations.
- Strict TypeScript/Vite web shell with Vitest, Testing Library, ESLint, and Tailwind.
- Exact npm/PyPI dependency manifests plus `pnpm-lock.yaml` and `apps/api/uv.lock`.
- Canonical root lint, typecheck, test, build, and repository verification commands.
- FastAPI liveness and dependency-aware readiness probes with rolled-back SQLite write checks, migration/queue validation, and temporary artifact cleanup.

- Documentation-first open-source repository structure.
- Locked `mvp-1.0` product, data, design, and Adobe ruleset contracts.
- Contribution, governance, security, support, and CI foundations.
- Locked seven-stage development sequence.
- Technology contract for React/Vite, FastAPI, SQLite, and the provider boundary.
- ADRs for the SQLite durable queue, local-first browser filesystem, and bejo2 production topology.
- bejo2-vnic deployment and operations contracts.
