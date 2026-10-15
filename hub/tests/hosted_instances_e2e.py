"""Real Linux/Docker CI exercise of hosted instances and the web update path.

Run as root in GitHub Actions against an already running, disposable installation:
    python3 hosted_instances_e2e.py --install-dir /.../task/install \
        --task-root /.../task --main-project cm-hosted-e2e-main

The installation must be a clean main checkout whose origin is a local bare repo
inside task-root. Its hub/.env must contain the main project name and an absolute
CM_UPDATE_RUNTIME_HOST inside task-root. The workflow owns the main stack; this
script creates and finally tears down only cm-alice and cm-bob. No watcher loop,
Docker substitute, or updater substitute is used.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request


FRIENDS = {"alice": 7879, "bob": 7880}
KEY_NAMES = ("API_KEY", "ACCESS_TOKEN", "TOKEN_MONITOR_SECRET")
DEVICE_ID = "hosted-e2e-shared-device"
PROOF_FILE = "hub/backend/hub/hosted_instance_ci_proof.txt"


def require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name] = value.strip().strip("\"'")
    return values


class Exercise:
    def __init__(self, args: argparse.Namespace):
        self.install = args.install_dir.resolve(strict=True)
        self.root = args.task_root.resolve(strict=True)
        self.hub = self.install / "hub"
        self.main_project = args.main_project
        self.created: list[str] = []
        self.secrets: set[str] = set()
        self.keys: dict[str, dict[str, str]] = {}
        self.report: dict = {"checks": [], "updates": []}
        self.env = dict(os.environ)
        # Compose's process environment takes precedence over --env-file. The
        # generated friend keys and project names must come from their own files.
        for name in (*KEY_NAMES, "COMPOSE_PROJECT_NAME", "CM_VERSION", "CM_GIT_SHA"):
            self.env.pop(name, None)

    def redact(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, "<redacted>")
        return text

    def run(self, *args: str, timeout: int = 120) -> str:
        result = subprocess.run(
            args, env=self.env, capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode:
            raise RuntimeError(self.redact(
                f"Command failed ({result.returncode}): {' '.join(args)}\n"
                f"{result.stdout[-6000:]}\n{result.stderr[-6000:]}"
            ))
        return result.stdout.strip()

    def git(self, directory: Path, *args: str) -> str:
        return self.run("git", "-c", f"safe.directory={directory}", "-C", str(directory), *args)

    def compose(self, name: str, *args: str, timeout: int = 120) -> str:
        command = ["docker", "compose", "--project-directory", str(self.hub)]
        if name == "main":
            command += ["-p", self.main_project, "--env-file", str(self.hub / ".env")]
        else:
            directory = self.hub / "instances" / name
            command += ["-p", f"cm-{name}", "-f", str(self.hub / "docker-compose.yml"),
                        "-f", str(directory / "compose.override.yml"),
                        "--env-file", str(directory / ".env")]
        return self.run(*command, *args, timeout=timeout)

    def project_containers(self, name: str) -> list[str]:
        project = self.main_project if name == "main" else f"cm-{name}"
        return self.run("docker", "ps", "-aq", "--filter",
                        f"label=com.docker.compose.project={project}").splitlines()

    def owned_containers(self, name: str) -> list[dict]:
        ids = self.project_containers(name)
        if not ids:
            return []
        containers = json.loads(self.run("docker", "inspect", *ids))
        for container in containers:
            labels = container["Config"]["Labels"]
            require(Path(labels.get("com.docker.compose.project.working_dir", "")).resolve()
                    == self.hub, f"Refusing to operate on unrelated {name} containers")
        return containers

    def remember_keys(self, name: str) -> None:
        path = self.hub / ".env" if name == "main" else self.hub / "instances" / name / ".env"
        values = read_env(path)
        self.keys[name] = {key: values[key] for key in KEY_NAMES}
        self.secrets.update(self.keys[name].values())

    def url(self, name: str, path: str) -> str:
        port = 7878 if name == "main" else FRIENDS[name]
        return f"http://127.0.0.1:{port}{path}"

    def http(self, name: str, path: str, *, key: str | None = None,
             method: str = "GET", payload: dict | None = None,
             sync: bool = False) -> tuple[int, dict]:
        headers = {}
        if key:
            headers["X-Token-Monitor-Secret" if sync else "Authorization"] = (
                key if sync else f"Bearer {key}"
            )
        data = None if payload is None else json.dumps(payload).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url(name, path), data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=35)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)

    def ready(self, name: str) -> None:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                status, body = self.http(name, "/api/v1/health/ready")
                if status == 200 and body.get("ok") is True:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(1)
        raise AssertionError(f"{name} did not become ready within 90 seconds")

    def preflight(self) -> None:
        require(sys.platform == "linux" and os.geteuid() == 0,
                "This integration script requires a disposable Linux root CI job")
        require(os.environ.get("GITHUB_ACTIONS") == "true", "This script only runs in GitHub Actions")
        require(self.install.parent == self.root and self.install.name == "install",
                "install-dir must be the task-root/install checkout")
        require(self.root != Path("/") and len(self.root.parts) >= 3, "Unsafe task root")
        require(self.main_project.startswith("cm-hosted-e2e-"), "Use a dedicated cm-hosted-e2e-* main project")
        require((self.install / ".git").is_dir(), "Installation must be a normal Git clone")
        require(self.git(self.install, "branch", "--show-current") == "main", "Installation must start on main")
        require(not self.git(self.install, "status", "--porcelain", "--untracked-files=no"),
                "Installation has tracked changes")
        origin = Path(self.git(self.install, "remote", "get-url", "origin"))
        require(origin.is_absolute(), "Origin must be an absolute local path")
        self.origin = origin.resolve(strict=True)
        require(self.origin.is_relative_to(self.root) and self.origin != self.install,
                "Origin must be disposable and inside task-root")
        require(self.run("git", "-c", f"safe.directory={self.origin}", "--git-dir", str(self.origin),
                         "rev-parse", "--is-bare-repository") == "true",
                "Origin must be a local bare repository")
        values = read_env(self.hub / ".env")
        require(values.get("COMPOSE_PROJECT_NAME") == self.main_project,
                "Main .env must pin COMPOSE_PROJECT_NAME for self-update.sh")
        self.runtime = Path(values.get("CM_UPDATE_RUNTIME_HOST", "")).resolve(strict=True)
        require(self.runtime.is_relative_to(self.root) and self.runtime != self.root,
                "Update runtime must be inside task-root")
        require(Path(self.env.get("CM_UPDATE_RUNTIME_HOST", "")).resolve() == self.runtime,
                "Export the same CM_UPDATE_RUNTIME_HOST used in main .env")
        require(not (self.hub / "update-control" / "request.json").exists(), "An update is already pending")
        require(not (self.root / "publisher").exists(), "Publisher directory already exists")
        require(not (self.hub / "instances").exists(), "Start with no existing hosted instance configs")
        for name in FRIENDS:
            require(not self.project_containers(name), f"Refusing to reuse existing cm-{name} containers")
            volumes = self.run("docker", "volume", "ls", "-q", "--filter",
                               f"label=com.docker.compose.project=cm-{name}")
            require(not volumes, f"Refusing to reuse existing cm-{name} data volumes")
        self.remember_keys("main")
        self.ready("main")
        require(len(self.owned_containers("main")) == 2, "Main stack must have its two expected services")
        self.publisher = self.root / "publisher"
        self.run("git", "-c", f"safe.directory={self.origin}", "clone", "--no-local",
                 "--branch", "main", str(self.origin), str(self.publisher))
        self.git(self.publisher, "config", "user.name", "Hosted instance CI")
        self.git(self.publisher, "config", "user.email", "hosted-ci@example.invalid")

    def create_friends(self) -> None:
        for name, port in FRIENDS.items():
            self.created.append(name)
            # Successful add prints generated credentials. Keep its output out of
            # the CI log and read credentials directly from its private env file.
            self.run("bash", str(self.hub / "scripts/instance.sh"), "add", name, str(port), timeout=600)
            self.remember_keys(name)
            self.ready(name)
        all_keys = [value for keys in self.keys.values() for value in keys.values()]
        require(len(set(all_keys)) == 9 and all(len(key) >= 32 for key in all_keys),
                "Main, Alice and Bob must have distinct strong credentials")
        volumes: dict[str, set[str]] = {}
        for name in ("main", *FRIENDS):
            containers = self.owned_containers(name)
            require(len(containers) == 2, f"{name}: expected two independent services")
            volumes[name] = {mount["Name"] for c in containers for mount in c["Mounts"]
                             if mount["Destination"] == "/data"}
            require(len(volumes[name]) == 2, f"{name}: expected two named data volumes")
            hub = next(c for c in containers if c["Config"]["Labels"]["com.docker.compose.service"] == "cloud-hub")
            port = 7878 if name == "main" else FRIENDS[name]
            require(hub["NetworkSettings"]["Ports"]["7878/tcp"] ==
                    [{"HostIp": "127.0.0.1", "HostPort": str(port)}], f"{name}: incorrect public binding")
            if name != "main":
                require(not any(m["Destination"] in ("/update", "/update-runtime") for m in hub["Mounts"]),
                        f"{name}: friend must not mount host update controls")
        require(len(set.union(*volumes.values())) == 6, "Projects share a data volume")
        self.report["data_volumes"] = {name: sorted(value) for name, value in volumes.items()}

    def upload(self, name: str, total: int) -> None:
        payload = {"deviceId": DEVICE_ID, "hostname": f"{name}-host", "platform": "linux",
                   "updatedAt": datetime.now(timezone.utc).isoformat(),
                   "periodWindows": {"timeZone": "UTC"},
                   "today": {"totalTokens": total, "clients": {"codex": total}},
                   "month": {"totalTokens": total}, "allTime": {"totalTokens": total}}
        status, _ = self.http(name, "/api/ingest", key=self.keys[name]["TOKEN_MONITOR_SECRET"],
                              method="POST", payload=payload, sync=True)
        require(status == 200, f"{name}: real ingestion failed ({status})")

    def assert_data_and_access(self) -> None:
        for name, total in (("main", 11), ("alice", 22), ("bob", 33)):
            self.ready(name)
            status, overview = self.http(name, "/api/v1/tm/overview", key=self.keys[name]["ACCESS_TOKEN"])
            require(status == 200, f"{name}: overview failed")
            require(overview["totals"]["today"]["totalTokens"] == total,
                    f"{name}: isolated token total changed")
            require([(d["deviceId"], d["hostname"]) for d in overview["devices"]] ==
                    [(DEVICE_ID, f"{name}-host")], f"{name}: another instance's device appeared")
            for other in self.keys:
                if other == name:
                    continue
                status, _ = self.http(name, "/api/v1/tm/overview", key=self.keys[other]["ACCESS_TOKEN"])
                require(status == 401, f"{other} read credential accessed {name}")
                status, _ = self.http(name, "/api/stats", key=self.keys[other]["TOKEN_MONITOR_SECRET"], sync=True)
                require(status == 401, f"{other} sync credential accessed {name}")
        self.report["checks"].append("same device ID stays isolated; all cross-instance reads return 401")

    def assert_friend_updates_disabled(self) -> None:
        for name in FRIENDS:
            status, info = self.http(name, "/api/v1/system/update", key=self.keys[name]["ACCESS_TOKEN"])
            require(status == 200 and info["apply_enabled"] is False, f"{name}: update appears enabled")
            for path, body in (("/api/v1/system/update", {"ref": "main"}),
                               ("/api/v1/system/update/cancel", None)):
                status, _ = self.http(name, path, key=self.keys[name]["ACCESS_TOKEN"], method="POST", payload=body)
                require(status == 503, f"{name}: friend could control host updates ({status})")
        self.report["checks"].append("friend update UI flag, enqueue and cancellation are disabled")

    def snapshot(self, name: str, target: str | None = None, proof: str | None = None) -> dict:
        self.ready(name)
        containers = self.owned_containers(name)
        hub = next(c for c in containers if c["Config"]["Labels"]["com.docker.compose.service"] == "cloud-hub")
        image = json.loads(self.run("docker", "image", "inspect", hub["Image"]))[0]
        image_env = dict(item.split("=", 1) for item in image["Config"]["Env"] if "=" in item)
        container_env = dict(item.split("=", 1) for item in hub["Config"]["Env"] if "=" in item)
        require(all(container_env.get(key) == value for key, value in self.keys[name].items()),
                f"{name}: running service did not retain its independent credentials")
        if target is not None:
            for source in (image_env, container_env, read_env(self.hub / ".env" if name == "main"
                                                            else self.hub / "instances" / name / ".env")):
                sha = source.get("CM_GIT_SHA", "")
                require(len(sha) >= 7 and target.startswith(sha), f"{name}: wrong built or running Git SHA")
            require(self.run("docker", "exec", hub["Id"], "cat",
                             "/app/backend/hub/hosted_instance_ci_proof.txt") == proof,
                    f"{name}: running image does not contain updated source")
        return {"container_id": hub["Id"], "image_id": hub["Image"],
                "git_sha": container_env.get("CM_GIT_SHA", "")}

    def publish(self, phase: str) -> tuple[str, str]:
        proof = f"{phase}: {datetime.now(timezone.utc).isoformat()}"
        (self.publisher / PROOF_FILE).write_text(proof + "\n", encoding="utf-8")
        self.git(self.publisher, "add", "--", PROOF_FILE)
        self.git(self.publisher, "commit", "-m", f"CI: hosted update proof ({phase})")
        self.git(self.publisher, "push", "origin", "HEAD:main")
        return self.git(self.publisher, "rev-parse", "HEAD"), proof

    def update(self, phase: str, active: tuple[str, ...]) -> tuple[str, str]:
        before = {name: self.snapshot(name) for name in active}
        target, proof = self.publish(phase)
        status, queued = self.http("main", "/api/v1/system/update", key=self.keys["main"]["ACCESS_TOKEN"],
                                   method="POST", payload={"ref": "main"})
        require(status == 200 and queued["state"] == "queued", "Main web endpoint did not enqueue update")
        request = json.loads((self.hub / "update-control/request.json").read_text())
        require(request["id"] == queued["id"] and request["ref"] == "main", "Web request was not persisted")
        # One real updater invocation is the watcher's unit of work. Running this
        # process directly avoids leaving an unbounded background watcher in CI.
        self.run("bash", str(self.hub / "scripts/self-update.sh"), str(self.install), timeout=900)
        require(self.git(self.install, "rev-parse", "HEAD") == target, "Updater did not pull local origin/main")
        finished = json.loads((self.runtime / "status.json").read_text())
        require(finished["id"] == queued["id"] and finished["state"] == "ok",
                f"Updater did not finish successfully: {finished}")
        require("失败" not in finished["message"], f"Updater reported a friend rebuild failure: {finished}")
        require(not (self.hub / "update-control/request.json").exists(), "Updater left the request pending")
        after = {name: self.snapshot(name, target, proof) for name in active}
        for name in active:
            require(before[name]["container_id"] != after[name]["container_id"], f"{name}: old container survived update")
            require(before[name]["image_id"] != after[name]["image_id"], f"{name}: old image survived update")
        for name, keys in self.keys.items():
            path = self.hub / ".env" if name == "main" else self.hub / "instances" / name / ".env"
            require(all(read_env(path).get(key) == value for key, value in keys.items()),
                    f"{name}: update replaced a credential")
        self.report["updates"].append({"phase": phase, "commit": target, "instances": after})
        print(f"PASS: {phase}: real web request, Git fast-forward and new ready images at {target[:12]}", flush=True)
        return target, proof

    def backup_restore(self) -> None:
        before = {name: self.snapshot(name) for name in ("main", "bob")}
        backup_root = self.root / "backups"
        backup_root.mkdir()
        self.run("bash", str(self.hub / "scripts/backup.sh"), "--instance", "alice", str(backup_root))
        backups = list(backup_root.glob("cloud-monitor-backup-alice-*"))
        require(len(backups) == 1, "Expected one Alice backup")
        backup = backups[0]
        devices = json.loads((backup / "devices.json").read_text())
        require(DEVICE_ID in devices["devices"], "Alice backup omitted the real device")
        with sqlite3.connect(backup / "cloud-monitor.sqlite3") as db:
            rows = db.execute("SELECT COUNT(*) FROM tm_snapshot_buckets").fetchone()[0]
        require(rows >= 1, "Alice SQLite backup has no real ingest snapshots")
        status, _ = self.http("alice", f"/api/devices/{DEVICE_ID}",
                              key=self.keys["alice"]["TOKEN_MONITOR_SECRET"], method="DELETE", sync=True)
        require(status == 200, "Could not delete Alice fixture before restore")
        status, cleared = self.http("alice", "/api/v1/tm/overview", key=self.keys["alice"]["ACCESS_TOKEN"])
        require(status == 200 and cleared["devices"] == [], "Alice deletion did not take effect")
        self.run("bash", str(self.hub / "scripts/restore.sh"), "--instance", "alice", str(backup), timeout=180)
        self.assert_data_and_access()
        for name in before:
            require(self.snapshot(name)["container_id"] == before[name]["container_id"],
                    f"Alice restore restarted unrelated {name}")
        self.report["checks"].append("real Alice JSON/SQLite backup restored deleted data without restarting peers")
        print("PASS: Alice backup and restore preserve isolation", flush=True)

    def cleanup(self) -> None:
        errors = []
        for name in reversed(self.created):
            directory = self.hub / "instances" / name
            if not (directory / "compose.override.yml").is_file():
                continue
            try:
                # Verify Docker labels before teardown; every compose call pins
                # both the disposable directory and the exact friend project.
                self.owned_containers(name)
                self.compose(name, "down", "--volumes", "--remove-orphans")
            except Exception as exc:
                errors.append(f"{name}: {exc}")
        require(not errors, "Friend cleanup failed: " + "; ".join(errors))

    def diagnostics(self) -> None:
        for name in ("main", *self.created):
            path = self.hub / ".env" if name == "main" else self.hub / "instances" / name / ".env"
            if path.is_file():
                values = read_env(path)
                self.secrets.update(values.get(key, "") for key in KEY_NAMES if values.get(key))
            try:
                self.owned_containers(name)
                print(self.redact(self.compose(name, "logs", "--tail", "60")), file=sys.stderr)
            except Exception as exc:
                print(self.redact(str(exc)), file=sys.stderr)

    def exercise(self) -> None:
        self.preflight()
        try:
            self.create_friends()
            for name, total in (("main", 11), ("alice", 22), ("bob", 33)):
                self.upload(name, total)
            self.assert_data_and_access()
            self.assert_friend_updates_disabled()
            self.update("all-running", ("main", "alice", "bob"))
            self.assert_data_and_access()
            self.backup_restore()
            self.run("bash", str(self.hub / "scripts/instance.sh"), "down", "bob")
            require(not self.project_containers("bob"), "Bob down left containers running")
            target, proof = self.update("bob-disabled", ("main", "alice"))
            require(not self.project_containers("bob"), "Main update restarted disabled Bob")
            self.run("bash", str(self.hub / "scripts/instance.sh"), "up", "bob", timeout=600)
            self.snapshot("bob", target, proof)
            self.assert_data_and_access()
            self.assert_friend_updates_disabled()
            self.report["final_instances"] = {
                name: self.snapshot(name, target, proof) for name in ("main", "alice", "bob")
            }
            self.report["checks"].append("down Bob stays stopped through main update; up restores current code and old data")
            self.report["ok"] = True
            print("PASS: hosted instances follow main web updates, retain data and respect down/up", flush=True)
        except Exception:
            self.report["ok"] = False
            self.diagnostics()
            raise
        finally:
            try:
                self.cleanup()
            finally:
                (self.root / "hosted-instances-e2e.json").write_text(
                    json.dumps(self.report, indent=2) + "\n", encoding="utf-8",
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--main-project", required=True)
    Exercise(parser.parse_args()).exercise()


if __name__ == "__main__":
    main()
