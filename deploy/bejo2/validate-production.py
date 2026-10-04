#!/usr/bin/env python3
"""Validate bejo2 production artifacts without starting Gandiwa services."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "deploy/bejo2/compose.yaml"
NGINX = ROOT / "deploy/bejo2/nginx-gandiwa.conf.example"
RUNTIME_SERVICES = {"api", "worker", "migrate"}


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True, check=False)


def check(name: str, ok: bool, detail: str) -> dict[str, object]:
    return {"name": name, "ok": ok, "detail": detail}


def immutable_reference(reference: str) -> bool:
    marker = "@sha256:"
    if marker not in reference:
        return False
    digest = reference.rsplit(marker, 1)[1]
    return len(digest) == 64 and all(character in "0123456789abcdef" for character in digest)


def port_available(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def validate(
    image: str,
    frontend_image: str,
    hostname: str,
    existing_vhost: Path | None,
    check_host: bool,
    allow_local_tags: bool,
) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    references_ok = allow_local_tags or (
        immutable_reference(image) and immutable_reference(frontend_image)
    )
    results.append(
        check(
            "immutable image references",
            references_ok,
            "digest pinned" if references_ok and not allow_local_tags else "local-tag override",
        )
    )

    inspect = run("docker", "image", "inspect", image, "--format", "{{.Os}}/{{.Architecture}}")
    platform = inspect.stdout.strip()
    results.append(
        check(
            "docker image inspect linux/arm64",
            inspect.returncode == 0 and platform == "linux/arm64",
            platform or inspect.stderr.strip(),
        )
    )
    frontend_inspect = run(
        "docker", "image", "inspect", frontend_image, "--format", "{{.Os}}/{{.Architecture}}"
    )
    frontend_platform = frontend_inspect.stdout.strip()
    results.append(
        check(
            "frontend image inspect linux/arm64",
            frontend_inspect.returncode == 0 and frontend_platform == "linux/arm64",
            frontend_platform or frontend_inspect.stderr.strip(),
        )
    )

    env = dict(
        os.environ,
        GANDIWA_IMAGE=image,
        GANDIWA_FRONTEND_BUILDER_IMAGE=frontend_image,
        GANDIWA_UID="10001",
        GANDIWA_GID="10001",
    )
    compose = ("docker-compose",) if shutil.which("docker-compose") else ("docker", "compose")
    rendered = run(
        *compose,
        "-f",
        str(COMPOSE),
        "--profile",
        "migration",
        "--profile",
        "release",
        "config",
        "--no-env-resolution",
        "--format",
        "json",
        env=env,
    )
    results.append(check("docker compose config", rendered.returncode == 0, rendered.stderr.strip() or "valid"))
    if rendered.returncode == 0:
        config = json.loads(rendered.stdout)
        services = config.get("services", {})
        api = services.get("api", {})
        worker = services.get("worker", {})
        published = json.dumps(api.get("ports", []), sort_keys=True)
        results.append(
            check(
                "API bind 127.0.0.1:8010",
                "127.0.0.1" in published and "8010" in published,
                published,
            )
        )
        results.append(
            check("worker has no ports", not worker.get("ports"), json.dumps(worker.get("ports", [])))
        )
        results.append(check("port 3000 untouched", "3000" not in rendered.stdout, "not declared"))
        runtime = [services[key] for key in RUNTIME_SERVICES if key in services]
        hardened = len(runtime) == len(RUNTIME_SERVICES) and all(
            service.get("read_only")
            and service.get("user") == "10001:10001"
            and service.get("cap_drop") == ["ALL"]
            and "no-new-privileges:true" in service.get("security_opt", [])
            and int(service.get("pids_limit", 0)) > 0
            and int(service.get("mem_limit", 0)) > 0
            and float(service.get("cpus", 0)) > 0
            and bool(service.get("tmpfs"))
            for service in runtime
        )
        results.append(
            check(
                "runtime services hardened",
                hardened,
                "read_only/non-root/cap_drop/no-new-privileges/resource/temp limits",
            )
        )
        mounts = json.dumps([service.get("volumes", []) for service in services.values()])
        results.append(check("Docker socket absent", "/var/run/docker.sock" not in mounts, "not mounted"))
        results.append(
            check(
                "durable host paths",
                "/srv/gandiwa/data" in mounts and "/srv/gandiwa/artifacts" in mounts,
                "data/artifacts bind mounts",
            )
        )

    with tempfile.TemporaryDirectory() as temporary:
        temporary_path = Path(temporary)
        generated = temporary_path / "gandiwa.conf"
        generated.write_text(NGINX.read_text().replace("GANDIWA_HOSTNAME", hostname))
        certificate = temporary_path / "certificate"
        certificate.mkdir()
        certificate_test = run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(certificate / "privkey.pem"),
            "-out",
            str(certificate / "fullchain.pem"),
            "-days",
            "1",
            "-subj",
            f"/CN={hostname}",
        )
        nginx_test = run(
            "docker",
            "run",
            "--rm",
            "-v",
            f"{generated}:/etc/nginx/conf.d/default.conf:ro",
            "-v",
            f"{certificate}:/etc/letsencrypt/live/{hostname}:ro",
            "nginx:1.27.4-alpine@sha256:4ff102c5d78d254a6f0da062b3cf39eaf07f01eec0927fd21e219d0af8bc0591",
            "nginx",
            "-t",
        )
        ok = certificate_test.returncode == 0 and nginx_test.returncode == 0
        detail = certificate_test.stderr.strip() if certificate_test.returncode else nginx_test.stderr.strip()
        results.append(check("nginx -t", ok, detail))

    if existing_vhost is not None:
        results.append(
            check(
                "existing vhost present",
                existing_vhost.is_file() or existing_vhost.is_symlink(),
                str(existing_vhost),
            )
        )
    if check_host:
        available = port_available(8010)
        results.append(
            check(
                "host port 8010 available",
                available,
                "available" if available else "already bound",
            )
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--frontend-image", required=True)
    parser.add_argument("--hostname", default="gandiwa.invalid")
    parser.add_argument("--existing-vhost", type=Path)
    parser.add_argument("--check-host", action="store_true")
    parser.add_argument("--allow-local-tags", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    results = validate(
        args.image,
        args.frontend_image,
        args.hostname,
        args.existing_vhost,
        args.check_host,
        args.allow_local_tags,
    )
    passed = all(item["ok"] for item in results)
    if args.json:
        print(json.dumps({"verdict": "PASS" if passed else "FAIL", "checks": results}, indent=2))
    else:
        for item in results:
            print(f"{'PASS' if item['ok'] else 'FAIL'} {item['name']}: {item['detail']}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
