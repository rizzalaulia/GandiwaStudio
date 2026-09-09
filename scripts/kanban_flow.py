#!/usr/bin/env python3
"""Reconcile GitHub Project #2 status from issues, branches, and pull requests.

This script is deliberately dependency-free so it can be executed in a locked-down
GitHub Actions runner. The policy is pure in ``compute_plan``; GitHub GraphQL is
only an adapter around that policy.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

PROJECT_OWNER = "rizzalaulia"
PROJECT_NUMBER = 2
REPOSITORY_OWNER = "rizzalaulia"
REPOSITORY_NAME = "GandiwaStudio"
HOLD_LABEL = "flow:hold"
BRANCH_ISSUE_PATTERN = re.compile(
    r"^(?:feat|fix|docs|refactor|test|ci|chore)/issue-(\d+)(?:[-/].*)?$"
)

JsonObject = dict[str, Any]
Plan = dict[int, dict[str, str]]


def load_dependencies(path: Path) -> dict[str, list[int]]:
    """Load the versioned, explicit dependency graph from a JSON file."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1:
        raise ValueError("dependency graph requires schema_version 1")
    raw_issues = payload.get("issues")
    if not isinstance(raw_issues, dict):
        raise ValueError("dependency graph requires an issues object")

    dependencies: dict[str, list[int]] = {}
    for issue_number, raw_dependencies in raw_issues.items():
        if not isinstance(issue_number, str) or not issue_number.isdecimal():
            raise ValueError("dependency graph issue keys must be decimal strings")
        if not isinstance(raw_dependencies, list) or not all(
            isinstance(value, int) and value > 0 for value in raw_dependencies
        ):
            raise ValueError(f"dependency graph for #{issue_number} must be positive integers")
        if len(raw_dependencies) != len(set(raw_dependencies)):
            raise ValueError(f"dependency graph for #{issue_number} contains duplicates")
        dependencies[issue_number] = raw_dependencies
    return dependencies


def validate_dependencies(dependencies: Mapping[str, Sequence[int]], issue_numbers: set[int]) -> None:
    """Fail before writing when the graph is incomplete or cyclic."""
    dependency_keys = {int(issue_number) for issue_number in dependencies}
    if dependency_keys != issue_numbers:
        missing = sorted(issue_numbers - dependency_keys)
        extra = sorted(dependency_keys - issue_numbers)
        raise ValueError(f"dependency graph issue set mismatch: missing={missing}, extra={extra}")

    for issue_number, predecessors in dependencies.items():
        for predecessor in predecessors:
            if predecessor not in issue_numbers:
                raise ValueError(f"dependency graph for #{issue_number} references missing issue #{predecessor}")

    visiting: set[int] = set()
    visited: set[int] = set()

    def visit(issue_number: int) -> None:
        if issue_number in visiting:
            raise ValueError(f"dependency graph cycle includes #{issue_number}")
        if issue_number in visited:
            return
        visiting.add(issue_number)
        for predecessor in dependencies[str(issue_number)]:
            visit(predecessor)
        visiting.remove(issue_number)
        visited.add(issue_number)

    for issue_number in sorted(issue_numbers):
        visit(issue_number)


def issue_number_from_branch(ref_name: str | None) -> int | None:
    """Return the issue number only for the documented, unambiguous branch format."""
    if not ref_name:
        return None
    match = BRANCH_ISSUE_PATTERN.fullmatch(ref_name)
    return int(match.group(1)) if match else None


def validate_pr_reference(branch: str, body: str) -> int:
    """Require one closing reference that matches the documented issue branch."""
    issue_number = issue_number_from_branch(branch)
    if issue_number is None:
        raise ValueError("PR branch must use <type>/issue-<number>-<slug>")
    references = {
        int(value)
        for value in re.findall(
            r"(?im)^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b",
            body,
        )
    }
    if references != {issue_number}:
        raise ValueError(
            f"PR body must contain exactly one closing reference: Fixes #{issue_number}"
        )
    return issue_number


def _lowest_open_stage(issues: Sequence[JsonObject]) -> int | None:
    open_stages = [issue["stage"] for issue in issues if issue["state"] == "OPEN"]
    return min(open_stages) if open_stages else None


def _status_for_pr(pr: JsonObject) -> tuple[str, str]:
    if pr.get("draft"):
        return "In Progress", "draft-pr"
    if pr.get("mergeable") == "CONFLICTING":
        return "Blocked", "pr-conflict"
    if pr.get("check_state") in {"FAILURE", "ERROR"}:
        return "Blocked", "checks-failed"
    if pr.get("check_state") not in {"SUCCESS", "NEUTRAL", "SKIPPED"}:
        return "In Progress", "checks-pending"
    return "In Review", "open-pr"


def compute_plan(
    issues: Sequence[JsonObject],
    dependencies: Mapping[str, Sequence[int]],
    pull_requests: Sequence[JsonObject],
    *,
    pushed_issue_numbers: set[int] | None = None,
) -> Plan:
    """Derive a complete status plan without any network or mutation side effect.

    Precedence: closed > manual hold > dependency/stage block > active PR > branch
    push > ready. A bad PR is explicitly Blocked instead of pretending to be ready
    for review.
    """
    pushed_issue_numbers = pushed_issue_numbers or set()
    issue_by_number = {int(issue["number"]): issue for issue in issues}
    validate_dependencies(dependencies, set(issue_by_number))
    active_stage = _lowest_open_stage(issues)
    prs_by_issue: dict[int, JsonObject] = {}
    for pull_request in pull_requests:
        issue_number = issue_number_from_branch(pull_request.get("head_ref"))
        if issue_number in issue_by_number:
            existing = prs_by_issue.get(issue_number)
            if existing is not None:
                raise ValueError(f"multiple open pull requests map to issue #{issue_number}")
            prs_by_issue[issue_number] = pull_request

    plan: Plan = {}
    for issue_number in sorted(issue_by_number):
        issue = issue_by_number[issue_number]
        labels = set(issue.get("labels", []))
        unmet = [
            predecessor
            for predecessor in dependencies[str(issue_number)]
            if issue_by_number[predecessor]["state"] != "CLOSED"
        ]

        if issue["state"] == "CLOSED":
            plan[issue_number] = {"status": "Done", "reason": "issue-closed"}
        elif HOLD_LABEL in labels:
            plan[issue_number] = {"status": "Blocked", "reason": "manual-hold"}
        elif issue["stage"] != active_stage:
            plan[issue_number] = {"status": "Blocked", "reason": "waiting-for-active-stage"}
        elif unmet:
            plan[issue_number] = {
                "status": "Blocked",
                "reason": "waiting-for-dependencies:" + ",".join(str(value) for value in unmet),
            }
        elif issue_number in prs_by_issue:
            status, reason = _status_for_pr(prs_by_issue[issue_number])
            plan[issue_number] = {"status": status, "reason": reason}
        elif issue_number in pushed_issue_numbers:
            plan[issue_number] = {"status": "In Progress", "reason": "branch-pushed"}
        else:
            plan[issue_number] = {"status": "Ready", "reason": "dependencies-satisfied"}
    return plan


def _run_gh_graphql(query: str, variables: Mapping[str, Any]) -> JsonObject:
    """Run GraphQL without JSON-quoting scalar string variables for the gh CLI."""
    command = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if isinstance(value, int):
            command.extend(["-F", f"{key}={value}"])
        elif isinstance(value, str):
            command.extend(["-f", f"{key}={value}"])
        else:
            raise TypeError(f"unsupported GraphQL variable type for {key}: {type(value).__name__}")
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    payload = json.loads(completed.stdout)
    if "errors" in payload:
        raise RuntimeError(f"GitHub GraphQL error: {payload['errors']}")
    return payload["data"]


def require_complete_page(page_info: Mapping[str, Any], connection_name: str) -> None:
    """Refuse status mutation when GitHub returned only a partial connection."""
    if page_info.get("hasNextPage"):
        raise RuntimeError(
            f"GitHub pagination incomplete for {connection_name}; refusing reconciliation"
        )


def fetch_live_state() -> tuple[list[JsonObject], list[JsonObject], dict[int, str], dict[str, str]]:
    """Fetch project items, open PRs, and dynamically resolve status option IDs."""
    query = """
    query($owner: String!, $project: Int!, $repoOwner: String!, $repo: String!) {
      user(login: $owner) {
        projectV2(number: $project) {
          items(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              id
              content {
                ... on Issue { number state labels(first: 50) { nodes { name } } }
              }
              stage: fieldValueByName(name: "Stage") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              status: fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
      repository(owner: $repoOwner, name: $repo) {
        pullRequests(first: 100, states: OPEN) {
          pageInfo { hasNextPage }
          nodes {
            number
            headRefName
            isDraft
            mergeable
            commits(last: 1) {
              nodes { commit { statusCheckRollup { state } } }
            }
          }
        }
      }
    }
    """
    data = _run_gh_graphql(
        query,
        {
            "owner": PROJECT_OWNER,
            "project": PROJECT_NUMBER,
            "repoOwner": REPOSITORY_OWNER,
            "repo": REPOSITORY_NAME,
        },
    )
    project = data["user"]["projectV2"]
    if project is None:
        raise RuntimeError("GitHub Project #2 was not found")

    require_complete_page(project["items"]["pageInfo"], "project items")
    require_complete_page(
        data["repository"]["pullRequests"]["pageInfo"], "open pull requests"
    )

    project_items: list[JsonObject] = []
    for node in project["items"]["nodes"]:
        content = node.get("content")
        stage_name = (node.get("stage") or {}).get("name")
        if not content or not content.get("number") or not stage_name:
            continue
        stage_match = re.fullmatch(r"Tahap ([1-7])", stage_name)
        if stage_match is None:
            raise RuntimeError(f"invalid Project Stage value: {stage_name!r}")
        project_items.append(
            {
                "project_item_id": node["id"],
                "number": content["number"],
                "state": content["state"],
                "stage": int(stage_match.group(1)),
                "status": (node.get("status") or {}).get("name", ""),
                "labels": [label["name"] for label in content["labels"]["nodes"]],
            }
        )

    pull_requests: list[JsonObject] = []
    for node in data["repository"]["pullRequests"]["nodes"]:
        commits = node["commits"]["nodes"]
        check_state = None
        if commits:
            check_rollup = commits[0]["commit"].get("statusCheckRollup")
            if check_rollup:
                check_state = check_rollup.get("state")
        pull_requests.append(
            {
                "number": node["number"],
                "head_ref": node["headRefName"],
                "draft": node["isDraft"],
                "mergeable": node["mergeable"],
                "check_state": check_state,
            }
        )

    status_field = next(
        (
            field
            for field in project["fields"]["nodes"]
            if field and field.get("name") == "Status" and field.get("options") is not None
        ),
        None,
    )
    if status_field is None:
        raise RuntimeError("Project #2 has no single-select Status field")
    status_option_ids = {option["name"]: option["id"] for option in status_field["options"]}
    required_statuses = {"Blocked", "Ready", "In Progress", "In Review", "Done"}
    missing_statuses = required_statuses - status_option_ids.keys()
    if missing_statuses:
        raise RuntimeError(f"Project Status is missing options: {sorted(missing_statuses)}")
    return project_items, pull_requests, {item["number"]: item["project_item_id"] for item in project_items}, status_option_ids


def apply_plan(
    plan: Plan,
    project_item_ids: Mapping[int, str],
    status_option_ids: Mapping[str, str],
    current_statuses: Mapping[int, str],
) -> int:
    """Apply only status changes and return their count."""
    mutation = """
    mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project,
        itemId: $item,
        fieldId: $field,
        value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }
    """
    project_query = """
    query($owner: String!, $project: Int!) {
      user(login: $owner) {
        projectV2(number: $project) {
          id
          fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name } } }
        }
      }
    }
    """
    project_data = _run_gh_graphql(project_query, {"owner": PROJECT_OWNER, "project": PROJECT_NUMBER})
    project = project_data["user"]["projectV2"]
    status_field_id = next(
        field["id"] for field in project["fields"]["nodes"] if field and field.get("name") == "Status"
    )
    changes = 0
    for issue_number, decision in plan.items():
        if current_statuses.get(issue_number) == decision["status"]:
            continue
        _run_gh_graphql(
            mutation,
            {
                "project": project["id"],
                "item": project_item_ids[issue_number],
                "field": status_field_id,
                "option": status_option_ids[decision["status"]],
            },
        )
        changes += 1
    return changes


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dependencies",
        type=Path,
        default=Path(".github/gandiwa-dependencies.json"),
        help="versioned dependency graph",
    )
    parser.add_argument("--apply", action="store_true", help="write Project status changes")
    parser.add_argument("--pushed-ref", help="branch ref for the current push event")
    args = parser.parse_args(argv)

    dependencies = load_dependencies(args.dependencies)
    issues, pull_requests, project_item_ids, status_option_ids = fetch_live_state()
    pushed_issue_number = issue_number_from_branch(args.pushed_ref)
    pushed = {pushed_issue_number} if pushed_issue_number is not None else set()
    plan = compute_plan(issues, dependencies, pull_requests, pushed_issue_numbers=pushed)
    current_statuses = {issue["number"]: issue.get("status", "") for issue in issues}

    if args.apply:
        changes = apply_plan(plan, project_item_ids, status_option_ids, current_statuses)
        print(f"Applied {changes} Project status change(s).")
    else:
        print(json.dumps(plan, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
