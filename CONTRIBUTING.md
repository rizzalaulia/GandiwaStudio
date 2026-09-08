# Contributing to Gandiwa Studio

Thank you for helping build Gandiwa Studio.

## Before You Start

- Read `docs/DEVELOPMENT-SEQUENCE.md`, `docs/TECHNOLOGY.md`, `docs/ARCHITECTURE.md`, and the locked scope in `docs/PRD.md`/`docs/BRD.md`.
- Search existing issues before opening another.
- Discuss large features in an issue before implementation.
- Never include real API keys, private assets, model/property releases, or copyrighted test material.

## Development Workflow

1. Fork the repository and create a focused branch: `feat/<topic>`, `fix/<topic>`, or `docs/<topic>`.
2. Keep changes small and add tests for behavior.
3. Run `python3 scripts/verify_repository.py` and the relevant application tests.
4. Use Conventional Commits, for example `feat(web): add content type selector`.
5. Open a pull request using the template and link its issue.

## Definition of Done

- Requirements and acceptance criteria are satisfied.
- Tests and static checks pass.
- Security and privacy impacts are documented.
- No secret or personal asset is included.
- User-facing behavior and docs are updated.
- Adobe rule changes include official source URL, retrieval date, version, and fixtures.

## Scope Control

`mvp-1.0` excludes multi-user, built-in cloud sync, fine-tuning, all local AI inference, full vector editing, native AI/EPS export, Gandiwa-owned routing/fallback, and automatic Adobe upload. Propose these separately; do not hide them in unrelated pull requests.

## Code Style

- Frontend: React + TypeScript strict + Vite; Zustand only for UI state and TanStack Query for backend/job state.
- Backend: Python 3.12 + FastAPI; SQLAlchemy/Alembic persistence and a separate single-worker command.
- Queue behavior must preserve priority+FIFO, lease/heartbeat, cooperative cancel, and idempotency-safe retry from ADR-0001.
- Provider adapters must never add cross-provider routing/fallback or put real credentials in tests.
- Use synthetic fixtures/fake provider servers in CI; live-provider tests remain manual and credential-local.
- User-visible errors must be actionable and must never expose secrets.

## Review

Maintainers may request changes or close contributions that conflict with the product boundary, security posture, licensing, or Adobe ruleset evidence. See `GOVERNANCE.md`.
