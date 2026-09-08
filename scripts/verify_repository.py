#!/usr/bin/env python3
"""Verify the documentation-first repository without third-party packages."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md", "LICENSE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
    "SECURITY.md", "SUPPORT.md", "GOVERNANCE.md", "CHANGELOG.md",
    "docs/BRD.md", "docs/PRD.md", "docs/ERD.md", "docs/DESIGN.md",
    "docs/ADOBE-RULESET.md", "docs/ARCHITECTURE.md",
    "docs/DEVELOPMENT-SEQUENCE.md", "docs/TECHNOLOGY.md",
    "docs/DEPLOYMENT-BEJO2.md", "docs/OPERATIONS.md",
    "docs/adr/0001-sqlite-durable-job-queue.md",
    "docs/adr/0002-local-first-browser-filesystem.md",
    "docs/adr/0003-bejo2-production-topology.md",
    ".env.example", ".env.production.example",
]
errors = []
for item in REQUIRED:
    if not (ROOT / item).is_file():
        errors.append(f"missing required file: {item}")

link_re = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)")
for md in ROOT.rglob("*.md"):
    text = md.read_text(encoding="utf-8")
    for target in link_re.findall(text):
        target = target.split("#", 1)[0]
        if not target or target.startswith(("http://", "https://", "mailto:")):
            continue
        if not (md.parent / target).resolve().exists():
            errors.append(f"broken local link: {md.relative_to(ROOT)} -> {target}")

for path in ROOT.rglob("*"):
    if path.is_file() and path.name not in {"verify_repository.py"}:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if re.search(r"(?:ghp_|github_pat_|sk-[A-Za-z0-9]{16,}|FAL_KEY=\S+)", text):
            errors.append(f"possible secret in {path.relative_to(ROOT)}")

if errors:
    print("Repository verification FAILED")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)
print(f"Repository verification PASSED ({len(REQUIRED)} required files)")
