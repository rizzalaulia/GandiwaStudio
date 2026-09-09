"""Executable contract for issue #2 repository scaffolding."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


class ScaffoldContractTests(unittest.TestCase):
    def load_json(self, relative_path: str) -> dict[str, Any]:
        path = ROOT / relative_path
        self.assertTrue(path.is_file(), f"missing {relative_path}")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_root_declares_pinned_pnpm_workspace_and_canonical_commands(self) -> None:
        package = self.load_json("package.json")

        self.assertTrue(package.get("private"))
        self.assertRegex(str(package.get("packageManager", "")), r"^pnpm@\d+\.\d+\.\d+$")
        scripts = package.get("scripts", {})
        self.assertIsInstance(scripts, dict)
        for command in ("build", "check", "test", "typecheck"):
            self.assertIn(command, scripts)
            self.assertNotRegex(
                scripts[command],
                r"(?:^|&&\s+)pnpm\b",
                f"{command} must work through Corepack without a global pnpm shim",
            )

        workspace = (ROOT / "pnpm-workspace.yaml").read_text(encoding="utf-8")
        self.assertRegex(workspace, r"(?m)^\s*- ['\"]?apps/\*['\"]?$")
        self.assertRegex(workspace, r"(?m)^\s*- ['\"]?packages/\*['\"]?$")
        self.assertTrue((ROOT / "pnpm-lock.yaml").is_file(), "missing pnpm-lock.yaml")

    def test_frontend_is_a_private_react_vite_typescript_workspace(self) -> None:
        package = self.load_json("apps/web/package.json")

        self.assertEqual(package.get("name"), "@gandiwa/web")
        self.assertTrue(package.get("private"))
        dependencies = package.get("dependencies", {})
        dev_dependencies = package.get("devDependencies", {})
        self.assertIn("react", dependencies)
        self.assertIn("react-dom", dependencies)
        self.assertIn("vite", dev_dependencies)
        self.assertIn("typescript", dev_dependencies)

        tsconfig = self.load_json("apps/web/tsconfig.app.json")
        compiler_options = tsconfig.get("compilerOptions", {})
        self.assertIsInstance(compiler_options, dict)
        self.assertIs(compiler_options.get("strict"), True)
        self.assertTrue((ROOT / "apps/web/src/main.tsx").is_file())

    def test_all_shared_package_directories_are_workspace_packages(self) -> None:
        expected = {
            "adobe-rules": "@gandiwa/adobe-rules",
            "contracts": "@gandiwa/contracts",
            "provider-sdk": "@gandiwa/provider-sdk",
            "ui": "@gandiwa/ui",
        }

        for directory, package_name in expected.items():
            with self.subTest(package=package_name):
                package = self.load_json(f"packages/{directory}/package.json")
                self.assertEqual(package.get("name"), package_name)
                self.assertTrue(package.get("private"))

    def test_backend_is_a_python_312_fastapi_project_with_a_lockfile(self) -> None:
        pyproject_path = ROOT / "apps/api/pyproject.toml"
        self.assertTrue(pyproject_path.is_file(), "missing apps/api/pyproject.toml")
        pyproject = pyproject_path.read_text(encoding="utf-8")

        self.assertRegex(pyproject, r'(?m)^requires-python\s*=\s*">=3\.12,<3\.13"$')
        self.assertRegex(pyproject, r'(?m)^\s*"fastapi[^"]*",?$')
        self.assertTrue((ROOT / "apps/api/uv.lock").is_file(), "missing apps/api/uv.lock")
        self.assertTrue((ROOT / "apps/api/src/gandiwa_api/__init__.py").is_file())

    def test_repository_documents_reproducible_setup_without_secrets(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("corepack", readme.lower())
        self.assertIn("uv sync --project apps/api --locked", readme)
        self.assertIn("pnpm install --frozen-lockfile", readme)
        self.assertNotRegex(readme, re.compile(r"(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}"))


if __name__ == "__main__":
    unittest.main()
