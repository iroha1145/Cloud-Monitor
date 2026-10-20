"""Real Docker CI coverage of the shared Hub's multi-tenant update and recovery.

Run as root in GitHub Actions with --install-dir TASK/install --task-root TASK
--project cm-multi-tenant-e2e. The disposable installation must already be running
on 127.0.0.1:7878, on a clean main branch with a local bare origin inside TASK.
Its .env must define root credentials, explicit Alice/Bob user tenants, the
project name, and CM_UPDATE_RUNTIME_HOST pointing inside TASK. Export that same
runtime path when invoking this script. The workflow tears down the test project.

All HTTP, Git, Docker, self-update, backup and restore operations are real. Only
origin/main is local, so CI can update to its tested code before the PR is merged.
"""

from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request


PROJECT = "cm-multi-tenant-e2e"
DEVICE_ID = "multi-tenant-shared-device"
TOTALS = {"default": 11, "alice": 22, "bob": 33}
PROOF_FILE = "hub/backend/hub/multi_tenant_ci_proof.txt"


def require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key] = value
    return values


class Exercise:
    def __init__(self, args: argparse.Namespace):
        self.install = args.install_dir.resolve(strict=True)
        self.root = args.task_root.resolve(strict=True)
        self.project = args.project
        self.hub = self.install / "hub"
        self.secrets: set[str] = set()
        self.report: dict = {"checks": []}
        self.env = dict(os.environ)
        # Compose process variables take precedence over .env. Always exercise
        # this disposable installation's actual persisted configuration.
        for key in ("ACCESS_TOKEN", "TOKEN_MONITOR_SECRET", "TENANTS_JSON",
                    "COMPOSE_PROJECT_NAME", "CM_VERSION", "CM_GIT_SHA"):
            self.env.pop(key, None)

    def redact(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, "<redacted>")
        return text

    def run(self, *command: str, timeout: int = 120) -> str:
        result = subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(self.redact(
                f"Command failed ({result.returncode}): {' '.join(command)}\n"
                f"{result.stdout[-6000:]}\n{result.stderr[-6000:]}"
            ))
        return result.stdout.strip()

    def git(self, directory: Path, *args: str) -> str:
        return self.run("git", "-c", f"safe.directory={directory}", "-C", str(directory), *args)

    def compose(self, *args: str, timeout: int = 120) -> str:
        return self.run("docker", "compose", "--project-directory", str(self.hub),
                        "-p", self.project, "--env-file", str(self.hub / ".env"),
                        *args, timeout=timeout)

    def containers(self) -> dict[str, dict]:
        ids = self.run("docker", "ps", "-aq", "--filter",
                       f"label=com.docker.compose.project={self.project}").splitlines()
        require(ids, "Disposable project has no containers")
        containers = json.loads(self.run("docker", "inspect", *ids))
        by_service = {}
        for container in containers:
            labels = container["Config"]["Labels"]
            require(Path(labels.get("com.docker.compose.project.working_dir", "")).resolve() == self.hub,
                    "Refusing to operate on containers outside the disposable installation")
            by_service[labels["com.docker.compose.service"]] = container
        require(len(containers) == 2 and set(by_service) == {"cloud-hub", "tm-core"},
                "Multi-tenancy must run in exactly one Hub and one tm-core container")
        return by_service

    def http(self, path: str, *, key: str = "", sync: bool = False,
             method: str = "GET", payload: dict | None = None,
             tenant_header: str = "") -> tuple[int, dict]:
        headers = {}
        if key:
            headers["X-Token-Monitor-Secret" if sync else "Authorization"] = key if sync else f"Bearer {key}"
        if tenant_header:
            headers["X-CM-Tenant-Id"] = tenant_header
        data = None if payload is None else json.dumps(payload).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("http://127.0.0.1:7878" + path, headers=headers, data=data, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=35)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)

    def ready(self) -> None:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                status, body = self.http("/api/v1/health/ready")
                if status == 200 and body.get("ok") is True:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(1)
        raise AssertionError("Updated project did not become ready within 90 seconds")

    def preflight(self) -> None:
        require(sys.platform == "linux" and os.geteuid() == 0,
                "This script requires a disposable Linux root CI job")
        require(os.environ.get("GITHUB_ACTIONS") == "true", "This script only runs in GitHub Actions")
        require(self.install.parent == self.root and self.install.name == "install",
                "install-dir must be task-root/install")
        require(len(self.root.parts) >= 3 and self.project == PROJECT, "Unsafe task root or project name")
        require((self.install / ".git").is_dir(), "Installation must be a normal clone")
        require(self.git(self.install, "branch", "--show-current") == "main", "Installation must start on main")
        require(not self.git(self.install, "status", "--porcelain", "--untracked-files=no"),
                "Installation has tracked changes")
        origin = Path(self.git(self.install, "remote", "get-url", "origin"))
        require(origin.is_absolute(), "Use an absolute local bare origin")
        self.origin = origin.resolve(strict=True)
        require(self.origin.is_relative_to(self.root) and self.origin != self.install,
                "Origin must stay inside the disposable task root")
        require(self.run("git", "-c", f"safe.directory={self.origin}", "--git-dir", str(self.origin),
                         "rev-parse", "--is-bare-repository") == "true", "Origin must be bare")
        self.initial_env = read_env(self.hub / ".env")
        require(self.initial_env.get("COMPOSE_PROJECT_NAME") == self.project,
                "Persist the project name in .env so self-update uses the same project")
        self.runtime = Path(self.initial_env.get("CM_UPDATE_RUNTIME_HOST", "")).resolve(strict=True)
        require(self.runtime.is_relative_to(self.root) and self.runtime != self.root,
                "Runtime must be inside the disposable task root")
        require(Path(self.env.get("CM_UPDATE_RUNTIME_HOST", "")).resolve() == self.runtime,
                "Export the same CM_UPDATE_RUNTIME_HOST as main .env")
        require(not (self.hub / "update-control/request.json").exists(), "An update is already pending")
        self.tenants = json.loads(self.initial_env["TENANTS_JSON"])
        require(set(self.tenants) == {"alice", "bob"}, "Configure exactly the two test tenants")
        require(all(t.get("role", "user") == "user" for t in self.tenants.values()),
                "Both friends must be ordinary users")
        self.credentials = {"default": {"read": self.initial_env["ACCESS_TOKEN"],
                                         "sync": self.initial_env["TOKEN_MONITOR_SECRET"]}}
        self.credentials.update({name: {"read": row["access_token"], "sync": row["tm_secret"]}
                                 for name, row in self.tenants.items()})
        all_keys = [key for row in self.credentials.values() for key in row.values()]
        self.secrets.update(all_keys)
        require(len(set(all_keys)) == 6 and all(len(key) >= 32 for key in all_keys),
                "Root and tenant read/sync credentials must all be distinct and strong")
        self.ready()
        containers = self.containers()
        for service, container in containers.items():
            values = dict(value.split("=", 1) for value in container["Config"]["Env"] if "=" in value)
            require(json.loads(values["TENANTS_JSON"]) == self.tenants,
                    f"{service}: real container is not using explicit tenant configuration")
        require(containers["cloud-hub"]["NetworkSettings"]["Ports"]["7878/tcp"] ==
                [{"HostIp": "127.0.0.1", "HostPort": "7878"}], "Hub must bind to loopback")
        self.publisher = self.root / "publisher"
        require(not self.publisher.exists(), "Publisher directory already exists")
        self.run("git", "-c", f"safe.directory={self.origin}", "clone", "--no-local", "--branch", "main",
                 str(self.origin), str(self.publisher))
        self.git(self.publisher, "config", "user.name", "Multi-tenant CI")
        self.git(self.publisher, "config", "user.email", "multi-tenant-ci@example.invalid")

    def upload(self, name: str, total: int) -> None:
        payload = {"deviceId": DEVICE_ID, "hostname": f"{name}-host", "platform": "linux",
                   "updatedAt": datetime.now(timezone.utc).isoformat(),
                   "periodWindows": {"timeZone": "UTC"},
                   "today": {"totalTokens": total, "clients": {"codex": total}},
                   "month": {"totalTokens": total}, "allTime": {"totalTokens": total}}
        status, _ = self.http("/api/ingest", key=self.credentials[name]["sync"], sync=True,
                              method="POST", payload=payload)
        require(status == 200, f"{name}: ingestion failed ({status})")

    def seed(self) -> None:
        for name, total in TOTALS.items():
            self.upload(name, total)
            subscription = {"id": f"{name}-subscription", "provider": "claude", "planName": name,
                            "amountMinor": total * 100, "currency": "USD", "startDate": "2026-01-01"}
            status, _ = self.http("/api/subscriptions", key=self.credentials[name]["sync"], sync=True,
                                  method="PUT", payload={"subscriptions": [subscription]})
            require(status == 200, f"{name}: subscription seed failed")

    def assert_isolation(self, totals: dict[str, int]) -> None:
        self.ready()
        for name, expected in totals.items():
            for fake in ("", *self.credentials):
                status, overview = self.http("/api/v1/tm/overview", key=self.credentials[name]["read"],
                                             tenant_header=fake)
                require(status == 200 and overview["totals"]["today"]["totalTokens"] == expected,
                        f"{name}: read isolation failed with forged tenant header {fake!r}")
                require([(d["deviceId"], d["hostname"]) for d in overview["devices"]] ==
                        [(DEVICE_ID, f"{name}-host")], f"{name}: another user's device appeared")
                status, stats = self.http("/api/stats", key=self.credentials[name]["sync"], sync=True,
                                          tenant_header=fake)
                require(status == 200 and stats["periods"]["today"]["totalTokens"] == expected,
                        f"{name}: sync isolation failed with forged tenant header {fake!r}")
            status, subscriptions = self.http("/api/v1/tm/subscriptions", key=self.credentials[name]["read"])
            require(status == 200 and [row["id"] for row in subscriptions["subscriptions"]] ==
                    [f"{name}-subscription"], f"{name}: subscription isolation failed")
        status, _ = self.http("/api/v1/tm/overview", tenant_header="alice")
        require(status == 401, "Tenant header bypassed authentication")
        status, _ = self.http("/api/v1/tm/overview", key="invalid-credential-" + "x" * 32, tenant_header="bob")
        require(status == 401, "Unknown credential bypassed authentication")

    def assert_permissions(self) -> None:
        for name, keys in self.credentials.items():
            status, _ = self.http("/api/v1/tm/overview", key=keys["sync"])
            require(status == 401, f"{name}: sync key was accepted as a dashboard read key")
            status, _ = self.http("/api/stats", key=keys["read"], sync=True)
            require(status == 401, f"{name}: read key was accepted as a sync key")
            status, _ = self.http("/api/ingest", key=keys["read"], sync=True, method="POST",
                                  payload={"deviceId": "must-not-be-created"})
            require(status == 401, f"{name}: read key could upload")
            status, _ = self.http("/api/v1/system/update", key=keys["sync"], method="POST", payload={"ref": "main"})
            require(status == 401, f"{name}: sync key could request a system update")
            if name != "default":
                status, info = self.http("/api/v1/system/update", key=keys["read"])
                require(status == 200 and info["apply_enabled"] is False, f"{name}: update UI appears enabled")
                for path, payload in (("/api/v1/system/update", {"ref": "main"}),
                                      ("/api/v1/system/update/cancel", None)):
                    status, _ = self.http(path, key=keys["read"], method="POST", payload=payload)
                    require(status == 403, f"{name}: ordinary tenant could control updates ({status})")
        status, _ = self.http("/api/v1/tm/overview", key=self.initial_env["TOKEN_MONITOR_SECRET"])
        require(status == 401, "Token Monitor sync secret was accepted as a dashboard key")
        self.report["checks"].append("read/sync separation and ordinary-user update permissions")

    def assert_node_boundary(self) -> None:
        code = """
const tenants = JSON.parse(process.env.TENANTS_JSON);
(async () => {
  for (const [name, row] of Object.entries(tenants)) {
    for (const [target, expected] of [[name, 200], [name === 'alice' ? 'bob' : 'alice', 401], ['unknown', 401], ['', 401]]) {
      const headers = {'X-Token-Monitor-Secret': row.tm_secret};
      if (target) headers['X-CM-Tenant-Id'] = target;
      const r = await fetch('http://127.0.0.1:17321/api/stats', {headers});
      if (r.status !== expected) throw new Error(`${name}/${target}: expected ${expected}, got ${r.status}`);
    }
  }
  console.log('explicit Node tenant boundary OK');
})().catch(e => { console.error(e.message); process.exit(1); });
"""
        node = self.containers()["tm-core"]
        self.run("docker", "exec", node["Id"], "node", "-e", code)
        self.report["checks"].append("explicit tm-core tenant header plus secret validation")

    def assert_streams(self) -> None:
        for name, total in TOTALS.items():
            request = urllib.request.Request("http://127.0.0.1:7878/api/stats/stream", headers={
                "X-Token-Monitor-Secret": self.credentials[name]["sync"],
                "X-CM-Tenant-Id": "bob" if name != "bob" else "alice",
            })
            with urllib.request.urlopen(request, timeout=10) as response:
                require(response.status == 200, f"{name}: SSE failed")
                for _ in range(10):
                    line = response.readline()
                    if line.startswith(b"data:"):
                        stats = json.loads(line[5:])["stats"]
                        require(stats["periods"]["today"]["totalTokens"] == total,
                                f"{name}: SSE exposed another user's totals")
                        require([(d["deviceId"], d["hostname"]) for d in stats["devices"]] ==
                                [(DEVICE_ID, f"{name}-host")], f"{name}: SSE exposed another user's device")
                        break
                else:
                    raise AssertionError(f"{name}: SSE sent no initial data frame")
        self.report["checks"].append("SSE first frames stay isolated despite forged tenant headers")

    def snapshot(self, target: str = "", proof: str = "") -> dict:
        self.ready()
        result = {}
        for service, container in self.containers().items():
            values = dict(value.split("=", 1) for value in container["Config"]["Env"] if "=" in value)
            require(json.loads(values["TENANTS_JSON"]) == self.tenants, f"{service}: tenant credentials changed")
            require(values["TOKEN_MONITOR_SECRET"] == self.initial_env["TOKEN_MONITOR_SECRET"],
                    f"{service}: root sync credential changed")
            if service == "cloud-hub":
                require(all(values.get(key) == self.initial_env[key] for key in ("ACCESS_TOKEN",)),
                        "Running Hub root credentials changed")
                if target:
                    image = json.loads(self.run("docker", "image", "inspect", container["Image"]))[0]
                    image_env = dict(value.split("=", 1) for value in image["Config"]["Env"] if "=" in value)
                    for source in (values, image_env, read_env(self.hub / ".env")):
                        sha = source.get("CM_GIT_SHA", "")
                        require(len(sha) >= 7 and target.startswith(sha), "Hub image/runtime has the wrong Git SHA")
                    require(self.run("docker", "exec", container["Id"], "cat",
                                     "/app/backend/hub/multi_tenant_ci_proof.txt") == proof,
                            "Running Hub image lacks updated source")
            elif target:
                source = self.run("docker", "exec", container["Id"], "cat", "/app/run.js")
                require(f"// CI multi-tenant update proof: {proof}" in source,
                        "Running tm-core image lacks updated source")
            result[service] = {"container_id": container["Id"], "image_id": container["Image"],
                               "started_at": container["State"]["StartedAt"]}
        return result

    def update(self) -> tuple[str, str]:
        before = self.snapshot()
        proof = datetime.now(timezone.utc).isoformat()
        (self.publisher / PROOF_FILE).write_text(proof + "\n", encoding="utf-8")
        with (self.publisher / "hub/tm-core/run.js").open("a", encoding="utf-8") as handle:
            handle.write(f"\n// CI multi-tenant update proof: {proof}\n")
        self.git(self.publisher, "add", "--", PROOF_FILE, "hub/tm-core/run.js")
        self.git(self.publisher, "commit", "-m", "CI: prove both multi-tenant services update")
        self.git(self.publisher, "push", "origin", "HEAD:main")
        target = self.git(self.publisher, "rev-parse", "HEAD")
        status, queued = self.http("/api/v1/system/update", key=self.credentials["default"]["read"],
                                   method="POST", payload={"ref": "main"})
        require(status == 200 and queued["state"] == "queued", "Root web request did not enqueue update")
        pending = json.loads((self.hub / "update-control/request.json").read_text())
        require(pending["id"] == queued["id"] and pending["ref"] == "main", "Web request was not persisted")
        # One invocation is the real watcher's unit of work, without leaving a
        # background polling loop alive in CI.
        self.run("bash", str(self.hub / "scripts/self-update.sh"), str(self.install), timeout=900)
        require(self.git(self.install, "rev-parse", "HEAD") == target, "Updater did not fast-forward to main")
        finished = json.loads((self.runtime / "status.json").read_text())
        require(finished["id"] == queued["id"] and finished["state"] == "ok",
                f"Updater did not finish successfully: {finished}")
        require(not (self.hub / "update-control/request.json").exists(), "Updater left the request pending")
        after = self.snapshot(target, proof)
        for service in before:
            require(before[service]["container_id"] != after[service]["container_id"], f"{service}: old container survived update")
            require(before[service]["image_id"] != after[service]["image_id"], f"{service}: old image survived update")
        current = read_env(self.hub / ".env")
        require(all(current.get(key) == value for key, value in self.initial_env.items()
                    if key not in ("CM_VERSION", "CM_GIT_SHA")), "Update replaced persisted configuration or credentials")
        self.report["update"] = {"commit": target, "before": before, "after": after}
        print(f"PASS: root web update rebuilt both real services at {target[:12]}", flush=True)
        return target, proof

    def restart(self, target: str, proof: str) -> None:
        before = self.snapshot(target, proof)
        self.containers()  # Confirm project ownership immediately before mutation.
        self.compose("restart")
        after = self.snapshot(target, proof)
        for service in before:
            require(before[service]["container_id"] == after[service]["container_id"], "Restart unexpectedly replaced containers")
            require(before[service]["started_at"] != after[service]["started_at"], f"{service}: restart did not occur")
        self.assert_isolation(TOTALS)
        self.report["checks"].append("real Docker restart preserves all tenant data and isolation")

    def recovery(self, target: str, proof: str) -> None:
        backup_root = self.root / "backups"
        backup_root.mkdir()
        self.containers()
        self.run("bash", str(self.hub / "scripts/backup.sh"), str(backup_root))
        backups = list(backup_root.glob("cloud-monitor-backup-*"))
        require(len(backups) == 1, "Expected one full backup")
        backup = backups[0]
        for name, total in TOTALS.items():
            directory = backup if name == "default" else backup / "tenants" / name
            document = json.loads((directory / "devices.json").read_text())
            require(document["devices"][DEVICE_ID]["hostname"] == f"{name}-host", f"{name}: JSON backup lost isolation")
            database = directory / ("cloud-monitor.sqlite3" if name == "default" else "hub.sqlite3")
            require(database.is_file(), f"{name}: SQLite backup missing")
            with closing(sqlite3.connect(database)) as db:
                value = db.execute("SELECT MAX(today_total) FROM tm_snapshot_buckets WHERE device_id=?", (DEVICE_ID,)).fetchone()[0]
            require(value == total, f"{name}: SQLite backup lost its ingest snapshot")
        for name, keys in self.credentials.items():
            status, _ = self.http(f"/api/devices/{DEVICE_ID}", key=keys["sync"], sync=True, method="DELETE")
            require(status == 200, f"{name}: fixture deletion failed")
            status, overview = self.http("/api/v1/tm/overview", key=keys["read"])
            require(status == 200 and overview["devices"] == [], f"{name}: fixture deletion did not commit")
        self.containers()
        self.run("bash", str(self.hub / "scripts/restore.sh"), str(backup), timeout=180)
        self.assert_isolation(TOTALS)
        self.snapshot(target, proof)
        self.report["checks"].append("real full JSON/SQLite backup restores deleted root and tenant data")

        legacy = self.root / "legacy-backup"
        legacy.mkdir()
        for filename in ("devices.json", "cloud-monitor.sqlite3", "BACKUP-MANIFEST.txt"):
            if (backup / filename).is_file():
                shutil.copy2(backup / filename, legacy / filename)
        changed = {"default": 11, "alice": 222, "bob": 333}
        for name in ("alice", "bob"):
            self.upload(name, changed[name])
        self.assert_isolation(changed)
        self.containers()
        self.run("bash", str(self.hub / "scripts/restore.sh"), str(legacy), timeout=180)
        self.assert_isolation(changed)
        self.snapshot(target, proof)
        self.report["checks"].append("legacy root-only restore preserves existing tenants and their newer data")
        print("PASS: complete multi-tenant recovery and legacy backup compatibility", flush=True)

    def refresh_tenant_credentials(self) -> None:
        current = read_env(self.hub / ".env")
        require(all(current.get(key) == value for key, value in self.initial_env.items()
                    if key not in ("TENANTS_JSON", "CM_VERSION", "CM_GIT_SHA")),
                "Tenant management replaced unrelated persisted configuration")
        self.tenants = json.loads(current["TENANTS_JSON"])
        self.credentials = {"default": {"read": current["ACCESS_TOKEN"], "sync": current["TOKEN_MONITOR_SECRET"]}}
        self.credentials.update({name: {"read": row["access_token"], "sync": row["tm_secret"]}
                                 for name, row in self.tenants.items()})
        keys = [key for row in self.credentials.values() for key in row.values()]
        self.secrets.update(keys)
        require(len(set(keys)) == len(keys) and all(len(key) >= 32 for key in keys),
                "Tenant management created overlapping or weak credentials")
        self.initial_env["TENANTS_JSON"] = current["TENANTS_JSON"]

    def assert_revoked(self, name: str, keys: dict[str, str]) -> None:
        for path, key, sync, method, payload in (
            ("/api/v1/tm/overview", keys["read"], False, "GET", None),
            ("/api/stats", keys["sync"], True, "GET", None),
            ("/api/ingest", keys["sync"], True, "POST", {"deviceId": "must-not-be-created"}),
        ):
            status, _ = self.http(path, key=key, sync=sync, method=method, payload=payload)
            require(status == 401, f"{name}: retired credential still accesses {path}")

    def manage_keys(self, target: str, proof: str) -> None:
        old_alice = self.credentials["alice"].copy()
        self.run("python3", str(self.hub / "scripts/tenant.py"), "rotate", "alice")
        self.refresh_tenant_credentials()
        require(all(self.credentials["alice"][key] != value for key, value in old_alice.items()),
                "Alice rotation did not replace both credentials")
        self.containers()
        self.compose("up", "-d", "--force-recreate", timeout=180)
        self.snapshot(target, proof)
        self.assert_revoked("alice", old_alice)
        self.assert_isolation({"default": 11, "alice": 222, "bob": 333})
        self.report["checks"].append("real Alice CLI rotation revokes both old keys while root/Bob and Alice data survive")

        old_bob = self.credentials["bob"].copy()
        self.run("python3", str(self.hub / "scripts/tenant.py"), "remove", "bob")
        self.refresh_tenant_credentials()
        require(set(self.tenants) == {"alice"}, "Bob removal changed the wrong tenant")
        self.containers()
        self.compose("up", "-d", "--force-recreate", timeout=180)
        self.snapshot(target, proof)
        self.assert_revoked("bob", old_bob)
        self.assert_isolation({"default": 11, "alice": 222})
        containers = self.containers()
        bob_state = json.loads(self.run("docker", "exec", containers["tm-core"]["Id"],
                                        "cat", "/data/tenants/bob/devices.json"))
        require(bob_state["devices"][DEVICE_ID]["hostname"] == "bob-host", "Revocation deleted Bob's Node history")
        query = ("import sqlite3; "
                 "c=sqlite3.connect('file:/data/tenants/bob/hub.sqlite3?mode=ro', uri=True); "
                 "print(c.execute('SELECT MAX(today_total) FROM tm_snapshot_buckets').fetchone()[0])")
        require(self.run("docker", "exec", containers["cloud-hub"]["Id"], "python3", "-c", query) == "333",
                "Revocation deleted Bob's SQLite history")
        self.report["checks"].append("real Bob CLI removal revokes access and retains both on-disk histories")
        print("PASS: real CLI key rotation and tenant revocation preserve stored data", flush=True)

    def exercise(self) -> None:
        self.preflight()
        try:
            self.seed()
            self.assert_isolation(TOTALS)
            self.report["checks"].append("same URL/device ID stays isolated despite forged tenant headers")
            self.assert_permissions()
            self.assert_node_boundary()
            self.assert_streams()
            target, proof = self.update()
            self.assert_isolation(TOTALS)
            self.restart(target, proof)
            self.recovery(target, proof)
            self.manage_keys(target, proof)
            self.assert_permissions()
            self.assert_node_boundary()
            self.report["final_services"] = self.snapshot(target, proof)
            self.report["ok"] = True
            print("PASS: real multi-tenant web update, isolation, restart and recovery", flush=True)
        except Exception:
            self.report["ok"] = False
            try:
                self.containers()
                print(self.redact(self.compose("logs", "--tail", "80")), file=sys.stderr)
            except Exception as exc:
                print(self.redact(str(exc)), file=sys.stderr)
            raise
        finally:
            # The workflow owns this sole shared stack and tears it down in its
            # always step. Leave no watcher or auxiliary process behind.
            (self.root / "multi-tenant-e2e.json").write_text(json.dumps(self.report, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--project", required=True)
    Exercise(parser.parse_args()).exercise()


if __name__ == "__main__":
    main()
