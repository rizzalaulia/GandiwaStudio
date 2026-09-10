"""Structural contract tests for Gandiwa's application-quality CI workflow.

The production workflow syntax is validated by actionlint. These stdlib-only
tests additionally bind commands and action pins to their intended job so the
policy cannot be satisfied by moving text into a comment or unrelated job.
"""

from __future__ import annotations

from pathlib import Path
import re
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"
PINNED_ACTIONS = {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/setup-python": "ece7cb06caefa5fff74198d8649806c4678c61a1",
    "astral-sh/setup-uv": "37802adc94f370d6bfd71619e3f0bf239e1f3b78",
}
JOB_PATTERN = re.compile(r"^  ([a-z][a-z-]+):$", re.MULTILINE)
USES_PATTERN = re.compile(r"^      - uses: (.+)$", re.MULTILINE)
RUN_PATTERN = re.compile(r"^        run: (.+)$", re.MULTILINE)
BLOCK_RUN_PATTERN = re.compile(r"^        run: \|\n((?:          .*\n?)*)", re.MULTILINE)


def job_blocks(workflow: str) -> dict[str, str]:
    """Extract the shallow job structure used by this deliberately simple YAML."""
    matches = list(JOB_PATTERN.finditer(workflow))
    return {
        match.group(1): workflow[match.end() : matches[index + 1].start() if index + 1 < len(matches) else None]
        for index, match in enumerate(matches)
    }


def job_runs(job: str) -> set[str]:
    """Return literal and block-scalar shell commands from a single job block."""
    commands = {match.group(1) for match in RUN_PATTERN.finditer(job)}
    commands.update(
        "\n".join(line.removeprefix("          ") for line in match.group(1).splitlines())
        for match in BLOCK_RUN_PATTERN.finditer(job)
    )
    return commands


class CiWorkflowContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rendered = WORKFLOW.read_text(encoding="utf-8")
        self.jobs = job_blocks(self.rendered)

    def test_runs_frontend_quality_gates_as_a_dedicated_job(self) -> None:
        self.assertTrue(
            {
                "corepack pnpm --filter @gandiwa/web lint",
                "corepack pnpm --filter @gandiwa/web typecheck",
                "corepack pnpm --filter @gandiwa/web test",
                "corepack pnpm --filter @gandiwa/web build",
                "corepack pnpm --filter @gandiwa/contracts test",
            }.issubset(job_runs(self.jobs["frontend-quality"]))
        )

    def test_builds_workspace_contracts_before_frontend_quality_gates(self) -> None:
        frontend_job = self.jobs["frontend-quality"]
        commands = (
            "corepack pnpm --filter @gandiwa/contracts build",
            "corepack pnpm --filter @gandiwa/web lint",
            "corepack pnpm --filter @gandiwa/web typecheck",
            "corepack pnpm --filter @gandiwa/web test",
            "corepack pnpm --filter @gandiwa/web build",
        )
        positions = [frontend_job.index(command) for command in commands]
        self.assertEqual(positions, sorted(positions))

    def test_runs_backend_quality_as_a_dedicated_job(self) -> None:
        self.assertTrue(
            {
                "uv run --project apps/api ruff check apps/api/src apps/api/tests",
                "uv run --project apps/api mypy apps/api/src",
                "uv run --project apps/api pytest apps/api/tests -W error",
            }.issubset(job_runs(self.jobs["backend-quality"]))
        )

    def test_runs_clean_migration_in_its_own_job(self) -> None:
        migration_job = self.jobs["migration-check"]
        migration_runs = job_runs(migration_job)
        self.assertIn(
            "uv run --project apps/api alembic -c apps/api/alembic.ini upgrade head",
            migration_runs,
        )
        self.assertIn(
            "uv run --project apps/api alembic -c apps/api/alembic.ini current "
            "| grep -Fxq '0002 (head)'",
            migration_runs,
        )
        self.assertIn("GANDIWA_DATABASE_URL: sqlite:///${{ runner.temp }}/gandiwa-ci.sqlite3", migration_job)

    def test_ci_runs_its_own_workflow_contract(self) -> None:
        self.assertIn(
            "python3 -m unittest tests/ci/test_ci_workflow_contract.py -v",
            job_runs(self.jobs["ci-workflow-contract"]),
        )

    def test_ci_preserves_repository_verification_and_secret_scan(self) -> None:
        repository_runs = job_runs(self.jobs["repository-contract"])
        self.assertIn("python3 scripts/verify_repository.py", repository_runs)
        self.assertIn("git diff --check", repository_runs)

    def test_ci_uses_exact_reviewed_action_commits(self) -> None:
        found_actions: set[str] = set()
        for job in self.jobs.values():
            for match in USES_PATTERN.finditer(job):
                action, revision = match.group(1).split("@", maxsplit=1)
                found_actions.add(action)
                self.assertEqual(revision.split()[0], PINNED_ACTIONS[action])
        self.assertEqual(found_actions, set(PINNED_ACTIONS))

    def test_provider_and_project_secrets_are_not_required(self) -> None:
        for forbidden in ("FAL_KEY", "NINEROUTER", "GANDIWA_PROJECT_TOKEN", "secrets."):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.rendered)


if __name__ == "__main__":
    unittest.main()
