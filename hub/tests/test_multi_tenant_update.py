"""Key provisioning and a main update must not overwrite each other's env data."""

import fcntl
import json
from pathlib import Path
import subprocess

from test_tm_update_coordination import _updater_fixture


ROOT = Path(__file__).resolve().parents[2]


def test_main_update_respects_tenant_key_lock_and_preserves_configuration(tmp_path):
    service, checkout, _runtime, events, _reached, _resume, env = _updater_fixture(tmp_path, "")
    env_path = checkout / "hub/.env"
    tenants_line = "TENANTS_JSON='" + json.dumps({
        "alice": {"tm_secret": "a" * 64, "access_token": "b" * 64, "role": "user"},
    }) + "'\n"
    original = "ACCESS_TOKEN=" + "c" * 64 + "\n" + tenants_line
    env_path.write_text(original)
    queued = service.apply("main")
    script = ROOT / "hub/scripts/self-update.sh"

    with (env_path.parent / ".env.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = subprocess.run(["bash", str(script), str(checkout)], env=env,
                                capture_output=True, text=True)
    assert result.returncode == 1, result.stderr
    assert env_path.read_text() == original
    failed = service.read_job()
    assert failed["id"] == queued["id"]
    assert failed["state"] == "error"
    assert "密钥配置正在修改" in failed["message"]
    calls = [json.loads(line) for line in events.read_text().splitlines()]
    assert not any(call[0] == "docker" for call in calls)

    service.apply("main")
    result = subprocess.run(["bash", str(script), str(checkout)], env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert env_path.read_text() == original + "CM_VERSION=dev\nCM_GIT_SHA=abc1234\n"
    assert env_path.stat().st_mode & 0o777 == 0o600
    assert service.read_job()["state"] == "ok"
    assert not list(env_path.parent.glob(".env.update.*"))
