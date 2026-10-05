from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "deploy" / "bejo2" / "Dockerfile"
FRONTEND_DOCKERFILE = ROOT / "deploy" / "bejo2" / "Dockerfile.frontend"
COMPOSE = ROOT / "deploy" / "bejo2" / "compose.yaml"
NGINX = ROOT / "deploy" / "bejo2" / "nginx-gandiwa.conf.example"
VALIDATOR = ROOT / "deploy" / "bejo2" / "validate-production.py"
ENVIRONMENT = ROOT / ".env.production.example"


class Bejo2ProductionArtifactsContract(unittest.TestCase):
    def test_required_artifacts_exist(self) -> None:
        for path in (DOCKERFILE, FRONTEND_DOCKERFILE, COMPOSE, NGINX, VALIDATOR, ENVIRONMENT):
            self.assertTrue(path.is_file(), path.relative_to(ROOT))

    def test_api_image_is_pinned_non_root_and_has_no_frontend_runtime(self) -> None:
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertRegex(text, r"(?m)^FROM python:3\.12\.[0-9]+-slim-bookworm@sha256:[a-f0-9]{64}", msg=text)
        self.assertIn("uv sync --locked --no-dev --no-editable", text)
        self.assertIn("USER 10001:10001", text)
        self.assertNotRegex(text, r"(?im)^\s*(FROM|RUN|CMD|ENTRYPOINT).*\bnode\b")
        self.assertNotIn("curl |", text)

    def test_frontend_builder_is_pinned_and_non_root(self) -> None:
        text = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"(?m)^FROM node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64}$",
        )
        self.assertIn("pnpm@12.3.4", text)
        self.assertIn("USER 10001:10001", text)

    def _rendered_compose(self) -> dict[str, dict[str, dict[str, object]]]:
        with tempfile.NamedTemporaryFile() as environment_file:
            env = dict(
                os.environ,
                GANDIWA_IMAGE="gandiwa-api:test",
                GANDIWA_FRONTEND_BUILDER_IMAGE="gandiwa-frontend-builder:test",
                GANDIWA_ENV_FILE=environment_file.name,
                GANDIWA_UID="10001",
                GANDIWA_GID="10001",
            )
            compose = ["docker-compose"] if shutil.which("docker-compose") else ["docker", "compose"]
            result = subprocess.run(
                [*compose, "-f", str(COMPOSE), "--profile", "migration", "--profile", "release", "config", "--no-env-resolution", "--format", "json"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_compose_is_arm64_loopback_only_and_hardened(self) -> None:
        text = COMPOSE.read_text(encoding="utf-8")
        config = self._rendered_compose()
        services = config["services"]
        self.assertIsInstance(services, dict)
        runtime = [services[name] for name in ("api", "worker", "migrate")]
        self.assertTrue(all(service["platform"] == "linux/arm64" for service in runtime))
        self.assertIn("127.0.0.1", json.dumps(services["api"]["ports"]))
        self.assertIn("8010", json.dumps(services["api"]["ports"]))
        self.assertFalse(services["worker"].get("ports"))
        self.assertNotIn("3000:", text)
        self.assertNotIn("/var/run/docker.sock", text)
        self.assertIn("/srv/gandiwa/data:/var/lib/gandiwa", text)
        self.assertIn("/srv/gandiwa/artifacts:/var/cache/gandiwa", text)
        self.assertIn('"--forwarded-allow-ips", "*"', text)
        for service in runtime:
            self.assertEqual(str(service["user"]), "10001:10001")
            self.assertTrue(bool(service["read_only"]))
            self.assertIn("no-new-privileges:true", list(service["security_opt"]))
            self.assertEqual(list(service["cap_drop"]), ["ALL"])
            self.assertGreater(int(service["pids_limit"]), 0)
            self.assertTrue(list(service["tmpfs"]))
            self.assertGreater(float(service["cpus"]), 0)
            self.assertGreater(int(service["mem_limit"]), 0)
        self.assertEqual(services["migrate"]["restart"], "no")
        self.assertNotIn("alembic", json.dumps(services["api"]))
        self.assertNotIn("alembic", json.dumps(services["worker"]))

    def test_nginx_is_placeholder_scoped_and_preserves_existing_host(self) -> None:
        text = NGINX.read_text(encoding="utf-8")
        self.assertIn("server_name GANDIWA_HOSTNAME;", text)
        self.assertIn("proxy_pass http://127.0.0.1:8010;", text)
        self.assertIn("root /var/www/gandiwa/current;", text)
        self.assertIn("try_files $uri $uri/ /index.html;", text)
        self.assertNotIn("komputermu.my.id", text)
        self.assertNotIn(":3000", text)
        self.assertIn("X-Content-Type-Options", text)
        self.assertIn("Content-Security-Policy", text)

    def test_environment_template_has_container_paths_and_no_real_secret(self) -> None:
        text = ENVIRONMENT.read_text(encoding="utf-8")
        self.assertIn("GANDIWA_DATABASE_URL=sqlite:////var/lib/gandiwa/gandiwa.sqlite3", text)
        self.assertIn("GANDIWA_ARTIFACT_DIR=/var/cache/gandiwa/artifacts", text)
        self.assertIn("GANDIWA_SVG_QUARANTINE_DIR=/var/cache/gandiwa/svg-quarantine", text)
        self.assertIn("GANDIWA_PROVIDER_KEY_STORE=/var/lib/gandiwa/provider-keys.json", text)
        self.assertIn("GANDIWA_SESSION_SECRET=CHANGE_ME", text)
        assignments = dict(
            line.split("=", 1)
            for line in text.splitlines()
            if line and not line.startswith("#") and "=" in line
        )
        self.assertEqual(assignments["FAL_KEY"], "")
        self.assertEqual(assignments["NINEROUTER_API_KEY"], "")
        self.assertEqual(assignments["GANDIWA_SESSION_SECRET"], "CHANGE_ME")

    def test_validator_reports_machine_readable_fresh_environment_contract(self) -> None:
        text = VALIDATOR.read_text(encoding="utf-8")
        self.assertIn("--json", text)
        self.assertIn("--frontend-image", text)
        self.assertIn("--existing-vhost", text)
        self.assertIn("--allow-local-tags", text)
        self.assertIn("immutable image references", text)
        self.assertIn("host port 8010 available", text)
        self.assertIn("Docker socket absent", text)
        self.assertIn("docker image inspect", text)
        self.assertIn("frontend image inspect linux/arm64", text)
        self.assertIn("linux/arm64", text)
        self.assertIn("127.0.0.1:8010", text)
        self.assertIn("nginx -t", text)
        self.assertIn("existing vhost present", text)
        self.assertIn("docker compose", text)

    def test_compose_does_not_interpolate_unapproved_environment_names(self) -> None:
        text = COMPOSE.read_text(encoding="utf-8")
        names = set(re.findall(r"\$\{([A-Z0-9_]+)(?::[-?][^}]*)?\}", text))
        self.assertEqual(
            names,
            {
                "GANDIWA_IMAGE",
                "GANDIWA_FRONTEND_BUILDER_IMAGE",
                "GANDIWA_ENV_FILE",
                "GANDIWA_UID",
                "GANDIWA_GID",
            },
        )


if __name__ == "__main__":
    unittest.main()
