# Kanban Automation

GitHub Project #2 (`Gandiwa Studio MVP`) is reconciled by
`.github/workflows/kanban-flow.yml`. The workflow is deterministic: it reads
issue state, the versioned dependency graph, branch names, and open pull
requests, then changes only the Project `Status` field when its calculated
value differs from the existing value.

## Status policy

The only source of truth for dependencies is
`.github/gandiwa-dependencies.json`. Every implementation issue #2–#32 must
appear exactly once. The script rejects missing nodes, missing predecessors,
duplicate edges, cycles, or incomplete GitHub pagination before it writes
anything.

Status precedence is deliberately strict:

1. A closed issue is `Done`.
2. An open issue with label `flow:hold` is `Blocked`.
3. An open issue outside the earliest stage that still has open work is
   `Blocked`.
4. An issue with an open dependency is `Blocked`.
5. An active-stage issue with a conflicting PR or failed/error checks is
   `Blocked`.
6. A draft PR or a PR whose checks are pending remains `In Progress`.
7. A non-draft, conflict-free PR with successful/neutral/skipped checks is
   `In Review`.
8. A recognized branch push without an open PR is `In Progress`.
9. An open active-stage issue with all dependencies closed is `Ready`.

`Blocked` is intentionally used for CI failures and merge conflicts because
Project #2 does not currently have a separate `Changes Requested` option.
The workflow log gives the concrete reason (`checks-failed`, `pr-conflict`,
or dependency/stage reason). Do not move a card by hand to bypass these
conditions; add `flow:hold` for an intentional business or product hold.

## Required branch and PR contract

Use one of these branch shapes:

```text
feat/issue-8-expand-ci
fix/issue-15-svg-sanitizer
ci/issue-8-expand-ci
```

A pull request must contain exactly one closing reference matching that branch:

```text
Fixes #8
```

The `Pull request contract` workflow rejects mismatches. This makes GitHub
close the issue at merge time, which is the signal for `Done`.

## Safe event flow

CI runs on pushes to documented `*/issue-*` feature branches. Feature CI has
only read permission and no Project credential. Once CI completes, the
`workflow_run` trigger runs `Kanban flow` from the trusted default branch. It
receives only the source branch name and does not check out or execute feature
branch code. This is what permits a branch push to set `In Progress` while
preventing a feature branch from exfiltrating the Project credential.

A `workflow_run` from a fork is rejected before any token-bearing step. The
reconciler also runs after issue lifecycle changes, after pushes to `main`,
hourly at minute 17, and on manual dispatch. The scheduled run repairs missed
events. All `actions/checkout` references are pinned to a reviewed commit SHA;
update the SHA deliberately and review its release notes before changing it.

## Credential boundary for this personal Project

Project #2 is owned by the personal account `rizzalaulia`, not an organization.
A fine-grained PAT cannot be given a personal-account Projects permission for
this ProjectV2 mutation. Do not follow a fine-grained-token recipe claiming
otherwise; it will not authorize the workflow.

The current supported credential is a **dedicated classic PAT** carrying only
the `project` scope. This scope is broader than a repository-scoped token: it
can manage Projects accessible to its issuing user. Treat it as a high-value
credential.

1. In GitHub, open Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate new token (classic).
2. Give it a descriptive name such as `gandiwa-project-automation`, set the
   shortest practical expiration (recommended: 30 days), and select only the
   `project` scope. Do not select `repo`, `workflow`, `gist`, or organization
   scopes for this token.
3. Copy the token once, then open this repository's Settings → Secrets and
   variables → Actions → New repository secret.
4. Name it exactly `GANDIWA_PROJECT_TOKEN` and paste the token value.
5. First use the Actions page to run `Kanban flow` manually with `apply=false`.
   This prints the full calculated plan without changing the board.
6. Review the preview. Initial reconciliation is expected to update every
   tracked item whose current Status differs from policy, not only one card.
   With the current board state the expected plan is #2–#7 `Done`, #8 `Ready`,
   and #9–#32 `Blocked`.
7. If the preview is correct, run it again with `apply=true`. Thereafter normal
   events reconcile automatically.
8. Rotate the token before expiration and immediately revoke/replace it if it
   is pasted into an issue, PR, terminal transcript, or any file.

The secret name may appear in logs; its value must never appear in logs,
repository files, shell history, issue text, or PR text. A future migration of
Project #2 to an organization with a GitHub App or suitable organization Project
permission should replace this classic PAT boundary.

## Local policy check

```text
python3 -m unittest tests/kanban/test_kanban_flow.py -v
python3 scripts/kanban_flow.py
```

The second command is read-only: it prints the calculated plan and performs no
Project mutation. `--apply` is reserved for the trusted Actions workflow or a
conscious operator using the dedicated Project token.
