"""Behavior tests for the deterministic Gandiwa kanban policy."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "kanban_flow.py"
SPEC = importlib.util.spec_from_file_location("kanban_flow", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
kanban_flow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kanban_flow)


class KanbanFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dependencies = {"2": [], "3": [2], "6": [], "8": [2, 3, 6], "9": [8]}
        self.issues = [
            {"number": 2, "state": "CLOSED", "stage": 1, "labels": []},
            {"number": 3, "state": "CLOSED", "stage": 1, "labels": []},
            {"number": 6, "state": "CLOSED", "stage": 1, "labels": []},
            {"number": 8, "state": "OPEN", "stage": 1, "labels": []},
            {"number": 9, "state": "OPEN", "stage": 2, "labels": []},
        ]

    def test_ready_when_active_stage_dependencies_are_closed(self) -> None:
        plan = kanban_flow.compute_plan(self.issues, self.dependencies, [])

        self.assertEqual(plan[8]["status"], "Ready")
        self.assertEqual(plan[9]["status"], "Blocked")
        self.assertEqual(plan[9]["reason"], "waiting-for-active-stage")

    def test_open_branch_becomes_in_progress(self) -> None:
        plan = kanban_flow.compute_plan(
            self.issues,
            self.dependencies,
            [],
            pushed_issue_numbers={8},
        )

        self.assertEqual(plan[8]["status"], "In Progress")

    def test_open_non_draft_pr_with_passing_checks_becomes_in_review(self) -> None:
        plan = kanban_flow.compute_plan(
            self.issues,
            self.dependencies,
            [
                {
                    "number": 99,
                    "head_ref": "feat/issue-8-expand-ci",
                    "draft": False,
                    "mergeable": "MERGEABLE",
                    "check_state": "SUCCESS",
                }
            ],
        )

        self.assertEqual(plan[8]["status"], "In Review")

    def test_pr_waits_in_progress_until_checks_finish(self) -> None:
        plan = kanban_flow.compute_plan(
            self.issues,
            self.dependencies,
            [
                {
                    "number": 99,
                    "head_ref": "feat/issue-8-expand-ci",
                    "draft": False,
                    "mergeable": "MERGEABLE",
                    "check_state": "PENDING",
                }
            ],
        )

        self.assertEqual(plan[8], {"status": "In Progress", "reason": "checks-pending"})

    def test_conflicting_or_failed_pr_is_blocked_not_in_review(self) -> None:
        for pr in (
            {
                "number": 99,
                "head_ref": "feat/issue-8-expand-ci",
                "draft": False,
                "mergeable": "CONFLICTING",
                "check_state": "SUCCESS",
            },
            {
                "number": 99,
                "head_ref": "feat/issue-8-expand-ci",
                "draft": False,
                "mergeable": "MERGEABLE",
                "check_state": "FAILURE",
            },
        ):
            with self.subTest(pr=pr):
                plan = kanban_flow.compute_plan(self.issues, self.dependencies, [pr])
                self.assertEqual(plan[8]["status"], "Blocked")

    def test_manual_hold_wins_over_ready_or_active_work(self) -> None:
        issues = [
            *self.issues[:3],
            {"number": 8, "state": "OPEN", "stage": 1, "labels": ["flow:hold"]},
            self.issues[4],
        ]

        plan = kanban_flow.compute_plan(issues, self.dependencies, [], pushed_issue_numbers={8})

        self.assertEqual(plan[8], {"status": "Blocked", "reason": "manual-hold"})

    def test_closed_issue_is_done_even_when_a_stale_pr_record_exists(self) -> None:
        plan = kanban_flow.compute_plan(
            self.issues,
            self.dependencies,
            [
                {
                    "number": 99,
                    "head_ref": "feat/issue-6-shell",
                    "draft": False,
                    "mergeable": "MERGEABLE",
                    "check_state": "SUCCESS",
                }
            ],
        )

        self.assertEqual(plan[6], {"status": "Done", "reason": "issue-closed"})

    def test_pr_reference_must_match_branch_issue_number(self) -> None:
        self.assertEqual(
            kanban_flow.validate_pr_reference(
                "feat/issue-8-expand-ci", "Summary.\n\nFixes #8\n"
            ),
            8,
        )
        with self.assertRaisesRegex(ValueError, "Fixes #8"):
            kanban_flow.validate_pr_reference("feat/issue-8-expand-ci", "Fixes #9")

    def test_pr_template_has_no_empty_or_numeric_closing_reference_placeholder(self) -> None:
        template_path = Path(__file__).resolve().parents[2] / ".github" / "PULL_REQUEST_TEMPLATE.md"
        template = template_path.read_text(encoding="utf-8")

        self.assertNotRegex(
            template,
            r"(?im)^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(?:\s*$|\d+\b)",
        )
        self.assertIn("Fixes #<issue-number>", template)
        self.assertIn("WRITE ONE CLOSING REFERENCE HERE", template)

    def test_rejects_missing_or_cyclic_dependency_configuration(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing issue"):
            kanban_flow.validate_dependencies({"8": [404]}, {8})
        with self.assertRaisesRegex(ValueError, "cycle"):
            kanban_flow.validate_dependencies({"8": [9], "9": [8]}, {8, 9})

    def test_committed_dependency_graph_is_complete_and_valid(self) -> None:
        graph_path = Path(__file__).resolve().parents[2] / ".github" / "gandiwa-dependencies.json"
        dependencies = kanban_flow.load_dependencies(graph_path)
        issue_numbers = {int(issue_number) for issue_number in dependencies}

        self.assertEqual(issue_numbers, set(range(2, 33)))
        kanban_flow.validate_dependencies(dependencies, issue_numbers)

    def test_refuses_live_graphql_results_when_any_connection_is_truncated(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "pagination"):
            kanban_flow.require_complete_page({"hasNextPage": True}, "open pull requests")
        kanban_flow.require_complete_page({"hasNextPage": False}, "project items")

    def test_load_dependencies_requires_schema_version_and_integer_edges(self) -> None:
        path = Path(self.id().replace(".", "_"))
        temporary = Path("/tmp") / f"{path.name}.json"
        self.addCleanup(temporary.unlink, missing_ok=True)
        temporary.write_text(json.dumps({"schema_version": 1, "issues": {"8": [2]}}))

        self.assertEqual(kanban_flow.load_dependencies(temporary), {"8": [2]})


if __name__ == "__main__":
    unittest.main()
