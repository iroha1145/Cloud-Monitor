"""Hosted friend instances share one checkout and follow the main online update.

Docker, git and root are stubbed; the real bash scripts, file layout and
flock run unchanged. No container is started.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import textwrap
import time

import pytest
import yaml

from test_tm_update_coordination import _executable, _updater_fixture


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "hub" / "scripts"

DOCKER_STUB = f"""#!{sys.executable}
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CM_TEST_EVENTS'], 'a') as f:
    f.write(json.dumps(['docker', *args]) + '\\n')
if args[:2] == ['compose', 'version']:
    if '--short' in args:
        print(os.environ.get('CM_TEST_COMPOSE_VERSION', '2.29.1'))
    sys.exit(0)
if 'run' in args and '--help' in args:
    print('      --cap-add list')
    sys.exit(0)
if args[:2] == ['volume', 'inspect']:
    sys.exit(1)
fail = os.environ.get('CM_TEST_FAIL_PROJECT')
if fail and fail in args:
    sys.exit(1)
gate = os.environ.get('CM_TEST_DOCKER_GATE_PROJECT')
if gate and gate in args and args[-3:] == ['up', '-d', '--build']:
    from pathlib import Path
    import time
    Path(os.environ['CM_TEST_REACHED']).touch()
    deadline = time.monotonic() + 10
    while not Path(os.environ['CM_TEST_RESUME']).exists():
        if time.monotonic() > deadline:
            raise SystemExit('docker gate timed out')
        time.sleep(.005)
"""


def _events(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def _compose_calls(events, project):
    return [e for e in events if e[:2] == ["docker", "compose"] and project in e]


def _write_instance(hub, name, port=7879):
    d = hub / "instances" / name
    d.mkdir(parents=True)
    (d / ".env").write_text(
        f"API_KEY={name}-api\nACCESS_TOKEN={name}-access\nTOKEN_MONITOR_SECRET={name}-tm\n"
        "CM_VERSION=old\nCM_GIT_SHA=old-sha\n"
    )
    (d / "compose.override.yml").write_text(
        f'services:\n  cloud-hub:\n    ports: !override\n      - "127.0.0.1:{port}:7878"\n'
    )
    return d


class _ComposeLoader(yaml.SafeLoader):
    pass


_ComposeLoader.add_constructor("!override", lambda loader, node: loader.construct_sequence(node))


# ------------------------------------------------------------- self-update


def _run_self_update(tmp_path, extra_env=None):
    service, checkout, runtime, events, _reached, _resume, env = _updater_fixture(tmp_path, "")
    _executable(checkout.parent / "bin" / "docker", DOCKER_STUB)
    hub = checkout / "hub"
    return service, hub, events, {**env, **(extra_env or {})}, checkout


def test_self_update_rebuilds_each_valid_instance_after_main(tmp_path):
    service, hub, events, env, checkout = _run_self_update(tmp_path)
    alice = _write_instance(hub, "alice")
    bob = _write_instance(hub, "bob", 7880)
    (checkout / "VERSION").write_text("0.9.0\n")
    (hub / ".env").write_text("API_KEY=main-api\nACCESS_TOKEN=main-access\nTOKEN_MONITOR_SECRET=main-tm\n")
    _write_instance(hub, "Bad")  # 非法名称：跳过
    (hub / "instances" / "half").mkdir()  # 缺 override：跳过
    (hub / "instances" / "half" / ".env").write_text("API_KEY=x\n")
    service.apply("main")

    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr

    log = _events(events)
    ups = [e for e in log if e[:2] == ["docker", "compose"] and e[-3:] == ["up", "-d", "--build"]]
    # 主实例在前，其后按名称顺序重建托管实例。
    assert "-p" not in ups[0]
    assert [e[e.index("-p") + 1] for e in ups[1:]] == ["cm-alice", "cm-bob"]
    alice_up = ups[1]
    assert alice_up[alice_up.index("--env-file") + 1] == str(alice / ".env")
    assert alice_up[alice_up.index("--project-directory") + 1] == str(hub)
    files = [alice_up[i + 1] for i, a in enumerate(alice_up) if a == "-f"]
    assert files == [str(hub / "docker-compose.yml"), str(alice / "compose.override.yml")]
    assert not any("cm-Bad" in e or "cm-half" in e for e in log)

    for directory, name in ((hub, "main"), (alice, "alice"), (bob, "bob")):
        values = dict(line.split("=", 1) for line in (directory / ".env").read_text().splitlines())
        assert values == {
            "API_KEY": f"{name}-api", "ACCESS_TOKEN": f"{name}-access",
            "TOKEN_MONITOR_SECRET": f"{name}-tm", "CM_VERSION": "0.9.0", "CM_GIT_SHA": "abc1234",
        }
    job = service.read_job()
    assert job["state"] == "ok"
    assert "托管实例重建失败" not in job["message"]


def test_one_failed_instance_reports_error_without_rolling_back_main_or_skipping_rest(tmp_path):
    service, hub, events, env, checkout = _run_self_update(tmp_path, {"CM_TEST_FAIL_PROJECT": "cm-alice"})
    _write_instance(hub, "alice")
    _write_instance(hub, "bob", 7880)
    service.apply("main")

    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 1, result.stderr
    commands = _events(events)
    assert any(e[-3:] == ["up", "-d", "--build"] for e in _compose_calls(commands, "cm-bob"))
    assert not any("down" in e for e in commands)
    job = service.read_job()
    assert job["state"] == "error"
    assert "主实例已更新到 main（dev abc1234）" in job["message"]
    assert "托管实例重建失败：alice" in job["message"]
    assert "bob" not in job["message"]
    assert not (hub / "update-control" / "request.json").exists()


def test_disabled_instance_stays_stopped_across_update_until_up(tmp_path):
    service, hub, events, env, checkout = _run_self_update(tmp_path)
    alice = _write_instance(hub, "alice")
    _write_instance(hub, "bob", 7880)
    (hub / "scripts").mkdir()
    for name in ("instance.sh", "lib.sh"):
        shutil.copy2(SCRIPTS / name, hub / "scripts" / name)
    before = (alice / ".env").read_text()
    stopped = _instance(hub, env, "down", "alice")
    assert stopped.returncode == 0, stopped.stderr
    assert "已停用" in _instance(hub, env, "list").stdout

    service.apply("main")
    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert not any("up" in e for e in _compose_calls(_events(events), "cm-alice"))
    assert any("up" in e for e in _compose_calls(_events(events), "cm-bob"))
    assert (alice / ".env").read_text() == before
    assert (alice / ".disabled").exists()

    started = _instance(hub, env, "up", "alice")
    assert started.returncode == 0, started.stderr
    assert not (alice / ".disabled").exists()
    previous_events = len(_events(events))
    service.apply("main")
    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert any("up" in e for e in _compose_calls(_events(events)[previous_events:], "cm-alice"))
    assert service.read_job()["state"] == "ok"


def test_instance_identity_write_failure_preserves_secrets_and_continues(tmp_path):
    service, hub, events, env, checkout = _run_self_update(tmp_path)
    alice = _write_instance(hub, "alice")
    _write_instance(hub, "bob", 7880)
    before = (alice / ".env").read_text()
    (alice / ".env.tmp").mkdir()
    service.apply("main")

    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 1, result.stderr
    assert (alice / ".env").read_text() == before
    assert not _compose_calls(_events(events), "cm-alice")
    assert any("up" in e for e in _compose_calls(_events(events), "cm-bob"))
    job = service.read_job()
    assert job["state"] == "error"
    assert "托管实例重建失败：alice" in job["message"]


def test_down_waits_for_running_update_then_stays_disabled(tmp_path):
    real_flock = shutil.which("flock")
    assert real_flock is not None
    service, hub, events, env, checkout = _run_self_update(tmp_path, {"CM_TEST_DOCKER_GATE_PROJECT": "cm-alice"})
    alice = _write_instance(hub, "alice")
    _write_instance(hub, "bob", 7880)
    (hub / "scripts").mkdir()
    for name in ("instance.sh", "lib.sh"):
        shutil.copy2(SCRIPTS / name, hub / "scripts" / name)
    # Signal that down reached the real blocking syscall; do not replace its
    # locking semantics with the coordination fixture's nonblocking stub.
    _executable(tmp_path / "bin" / "flock", f"""#!{sys.executable}
import os, sys
from pathlib import Path
waiting = os.environ.get('CM_TEST_LOCK_WAITING')
if waiting and sys.argv[1:] == ['8']:
    Path(waiting).touch()
os.execv({real_flock!r}, [{real_flock!r}, *sys.argv[1:]])
""")
    reached, resume = Path(env["CM_TEST_REACHED"]), Path(env["CM_TEST_RESUME"])
    waiting = tmp_path / "down-waiting"
    service.apply("main")
    update = subprocess.Popen(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    down = None
    try:
        deadline = time.monotonic() + 10
        while not reached.exists() and update.poll() is None and time.monotonic() < deadline:
            time.sleep(.005)
        assert reached.exists(), update.communicate(timeout=2)
        down = subprocess.Popen(
            ["bash", str(hub / "scripts" / "instance.sh"), "down", "alice"],
            env={**env, "CM_TEST_LOCK_WAITING": str(waiting)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        deadline = time.monotonic() + 10
        while not waiting.exists() and down.poll() is None and time.monotonic() < deadline:
            time.sleep(.005)
        assert waiting.exists(), down.communicate(timeout=2)
        with pytest.raises(subprocess.TimeoutExpired):
            down.communicate(timeout=.2)
        assert not (alice / ".disabled").exists()
        resume.touch()
        output = update.communicate(timeout=10)
        assert update.returncode == 0, output
        output = down.communicate(timeout=10)
        assert down.returncode == 0, output
        assert (alice / ".disabled").exists()

        previous_events = len(_events(events))
        service.apply("main")
        result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert not any("up" in e for e in _compose_calls(_events(events)[previous_events:], "cm-alice"))
    finally:
        resume.touch()
        for process in (update, down):
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


def test_self_update_without_instances_keeps_original_message(tmp_path):
    service, hub, events, env, checkout = _run_self_update(tmp_path)
    service.apply("main")
    result = subprocess.run(["bash", str(SCRIPTS / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert service.read_job()["message"] == "已更新到 main（dev abc1234）。请刷新面板。"
    assert not any("-p" in e for e in _events(events))


def test_real_git_upgrade_from_legacy_then_updates_friends_on_next_request(tmp_path):
    real_git = shutil.which("git")
    assert real_git is not None
    service, hub, events, env, checkout = _run_self_update(tmp_path)
    (tmp_path / "bin" / "git").unlink()

    def git(*args, cwd=checkout):
        return subprocess.run(
            [real_git, "-c", "user.name=Cloud Monitor Test", "-c", "user.email=test@example.invalid",
             "-c", "commit.gpgsign=false", *args],
            cwd=cwd, check=True, capture_output=True, text=True,
        ).stdout.strip()

    origin = tmp_path / "origin.git"
    git("init", "--bare", str(origin), cwd=tmp_path)
    git("init", "-b", "main")
    git("config", "core.autocrlf", "false")
    git("remote", "add", "origin", str(origin))
    scripts = hub / "scripts"
    scripts.mkdir()
    updater = (SCRIPTS / "self-update.sh").read_text()
    library = (SCRIPTS / "lib.sh").read_text()
    switch_end = '\n  git_in checkout -q --detach "refs/tags/$REF" || fail "无法检出标签 $REF"\nfi\n'
    prefix, boundary, _tail = updater.partition(switch_end)
    assert boundary
    # The deployed single-instance updater continues its old tail after Git
    # replaces the script's inode. It cannot adopt new functions mid-request.
    legacy_tail = textwrap.dedent(r'''
        VER="dev"
        if [[ -f "$INSTALL_DIR/VERSION" ]]; then
          VER="$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION")"
        fi
        SHA="$(git_in rev-parse --short HEAD)"
        if [[ -f "$ENVF" ]]; then
          grep -v -E '^(CM_VERSION|CM_GIT_SHA)=' "$ENVF" >"$ENVF.tmp" || true
          printf 'CM_VERSION=%s\nCM_GIT_SHA=%s\n' "$VER" "$SHA" >>"$ENVF.tmp"
          mv "$ENVF.tmp" "$ENVF"
          chmod 600 "$ENVF"
        fi
        write_status "$ID" running "$REF" "正在重建容器（$VER $SHA）"
        (
          cd "$HUB"
          export CM_VERSION="$VER" CM_GIT_SHA="$SHA"
          compose up -d --build
        ) || fail "容器重建失败（代码已更新，服务未重启）"
        write_status "$ID" ok "$REF" "已更新到 $REF（$VER $SHA）。请刷新面板。"
        FINAL_STATE=ok
    ''')
    (scripts / "self-update.sh").write_text(prefix + boundary + legacy_tail)
    legacy_library = library.partition("\n# 把面板显示的版本写进 env 文件")[0] + "\n"
    assert "cm_write_build_identity" not in legacy_library
    (scripts / "lib.sh").write_text(legacy_library)
    (checkout / "VERSION").write_text("0.8.0\n")
    git("add", "hub/scripts", "VERSION")
    git("commit", "-m", "Legacy single-instance updater")
    legacy_sha = git("rev-parse", "HEAD")
    git("push", "-u", "origin", "main")

    (scripts / "self-update.sh").write_text(updater)
    (scripts / "lib.sh").write_text(library)
    (checkout / "VERSION").write_text("0.9.0\n")
    git("add", "hub/scripts", "VERSION")
    git("commit", "-m", "Hosted instance updater")
    target_sha = git("rev-parse", "HEAD")
    target_short = git("rev-parse", "--short", "HEAD")
    git("push", "origin", "main")
    git("reset", "--hard", legacy_sha)
    (hub / ".env").write_text("API_KEY=main-api\nACCESS_TOKEN=main-access\nTOKEN_MONITOR_SECRET=main-tm\n")

    service.apply("main")
    first = subprocess.run(["bash", str(scripts / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert first.returncode == 0, (first.stdout, first.stderr)
    assert git("rev-parse", "HEAD") == target_sha
    assert (scripts / "lib.sh").read_text() == library
    assert service.read_job()["state"] == "ok"
    assert any(e[-3:] == ["up", "-d", "--build"] for e in _events(events))
    assert f"CM_VERSION=0.9.0\nCM_GIT_SHA={target_short}\n" in (hub / ".env").read_text()

    alice = _write_instance(hub, "alice")
    bob = _write_instance(hub, "bob", 7880)
    previous_events = len(_events(events))
    service.apply("main")
    second = subprocess.run(["bash", str(scripts / "self-update.sh"), str(checkout)], env=env, capture_output=True, text=True)
    assert second.returncode == 0, (second.stdout, second.stderr)
    ups = [e for e in _events(events)[previous_events:] if e[-3:] == ["up", "-d", "--build"]]
    assert "-p" not in ups[0]
    assert [e[e.index("-p") + 1] for e in ups[1:]] == ["cm-alice", "cm-bob"]
    for directory, name in ((hub, "main"), (alice, "alice"), (bob, "bob")):
        values = dict(line.split("=", 1) for line in (directory / ".env").read_text().splitlines())
        assert values == {
            "API_KEY": f"{name}-api", "ACCESS_TOKEN": f"{name}-access",
            "TOKEN_MONITOR_SECRET": f"{name}-tm", "CM_VERSION": "0.9.0", "CM_GIT_SHA": target_short,
        }
    assert service.read_job()["state"] == "ok"


# ------------------------------------------------------------- instance.sh


@pytest.fixture
def hub_copy(tmp_path):
    """instance.sh resolves the hub from its own path; run a copy in tmp."""
    install = tmp_path / "install"
    hub = install / "hub"
    (hub / "scripts").mkdir(parents=True)
    for name in ("instance.sh", "lib.sh", "backup.sh", "restore.sh"):
        shutil.copy2(SCRIPTS / name, hub / "scripts" / name)
    shutil.copy2(ROOT / "hub" / "docker-compose.yml", hub / "docker-compose.yml")
    (hub / ".env").write_text("API_KEY=main\nDASHBOARD_TIME_ZONE=Europe/Berlin\n")
    (install / "VERSION").write_text("0.9.0\n")
    binaries = tmp_path / "bin"
    binaries.mkdir()
    _executable(binaries / "docker", DOCKER_STUB)
    events = tmp_path / "events"
    env = {**os.environ, "LC_ALL": "C", "PATH": str(binaries) + os.pathsep + os.environ["PATH"], "CM_TEST_EVENTS": str(events)}
    return hub, events, env


def _instance(hub, env, *args, **kw):
    return subprocess.run(["bash", str(hub / "scripts" / "instance.sh"), *args], env=env, capture_output=True, text=True, **kw)


def test_add_creates_isolated_config_and_starts(hub_copy):
    hub, events, env = hub_copy
    result = _instance(hub, env, "add", "alice", "7879")
    assert result.returncode == 0, result.stderr

    d = hub / "instances" / "alice"
    assert oct(d.stat().st_mode & 0o777) == "0o700"
    assert oct((d / ".env").stat().st_mode & 0o777) == "0o600"
    values = dict(line.split("=", 1) for line in (d / ".env").read_text().splitlines() if line and not line.startswith("#"))
    keys = [values["API_KEY"], values["ACCESS_TOKEN"], values["TOKEN_MONITOR_SECRET"]]
    assert all(len(k) == 64 and int(k, 16) >= 0 for k in keys)
    assert len(set(keys)) == 3
    assert values["DASHBOARD_TIME_ZONE"] == "Europe/Berlin"
    assert values["CM_DEMO"] == "false"
    assert values["CM_VERSION"] == "0.9.0"
    assert values["TOKEN_MONITOR_SECRET"] in result.stdout

    # 按 compose 的 !override 语义合成，确认端口、挂载与更新开关。
    base = yaml.safe_load((hub / "docker-compose.yml").read_text())["services"]["cloud-hub"]
    override = yaml.load((d / "compose.override.yml").read_text(), Loader=_ComposeLoader)["services"]["cloud-hub"]
    assert override["ports"] == ["127.0.0.1:7879:7878"]
    assert override["volumes"] == ["cloud-hub-data:/data"]
    merged_env = {**base["environment"], **override["environment"]}
    assert merged_env["CM_UPDATE_DIR"] not in ("/update", "")
    assert merged_env["CM_UPDATE_RUNTIME_DIR"] not in ("/update-runtime", "")

    ups = [e for e in _compose_calls(_events(events), "cm-alice") if e[-3:] == ["up", "-d", "--build"]]
    assert len(ups) == 1
    assert ups[0][ups[0].index("--env-file") + 1] == str(d / ".env")

    listed = _instance(hub, env, "list")
    assert listed.stdout.split() == ["alice", "127.0.0.1:7879", "已启用"]


@pytest.mark.parametrize("command", ["up", "down"])
def test_failed_instance_command_keeps_disable_intent(hub_copy, command):
    hub, _events_path, env = hub_copy
    alice = _write_instance(hub, "alice")
    if command == "up":
        (alice / ".disabled").touch()
    result = _instance(hub, {**env, "CM_TEST_FAIL_PROJECT": "cm-alice"}, command, "alice")
    assert result.returncode == 1
    assert (alice / ".disabled").exists()


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (("Alice", "7879"), "非法实例名"),
        (("../x", "7879"), "非法实例名"),
        (("bob", "7878"), "已被主实例或其他托管实例占用"),
        (("bob", "7879"), "已被主实例或其他托管实例占用"),
        (("bob", "80"), "1024–65535"),
        (("alice", "7890"), "实例已存在"),
    ],
)
def test_add_rejects_bad_names_ports_and_duplicates(hub_copy, args, message):
    hub, _events_path, env = hub_copy
    assert _instance(hub, env, "add", "alice", "7879").returncode == 0
    result = _instance(hub, env, "add", *args)
    assert result.returncode == 1
    assert message in result.stderr


def test_add_refuses_compose_without_override_tag(hub_copy):
    hub, _events_path, env = hub_copy
    result = _instance(hub, {**env, "CM_TEST_COMPOSE_VERSION": "2.24.3"}, "add", "alice", "7879")
    assert result.returncode == 1
    assert "v2.24.4" in result.stderr
    assert not (hub / "instances" / "alice").exists()


def test_remove_requires_typed_confirmation(hub_copy):
    hub, events, env = hub_copy
    assert _instance(hub, env, "add", "alice", "7879").returncode == 0
    refused = _instance(hub, env, "remove", "alice", input="bob\n")
    assert refused.returncode == 1
    assert (hub / "instances" / "alice").is_dir()
    assert not any("down" in e for e in _compose_calls(_events(events), "cm-alice"))

    done = _instance(hub, env, "remove", "alice", input="alice\n")
    assert done.returncode == 0, done.stderr
    assert not (hub / "instances" / "alice").exists()
    assert any(e[-4:] == ["down", "-v", "--rmi", "local"] for e in _compose_calls(_events(events), "cm-alice"))


# ------------------------------------------------------------- backup / restore


def test_backup_instance_targets_only_that_project(hub_copy, tmp_path):
    hub, events, env = hub_copy
    _write_instance(hub, "alice")
    result = subprocess.run(["bash", str(hub / "scripts" / "backup.sh"), "--instance", "alice", str(tmp_path / "out")], env=env, capture_output=True, text=True)
    # stub 里容器未运行，脚本在第一步停下；只验证目标项目与输出目录名。
    assert result.returncode == 1
    calls = [e for e in _events(events) if e[:2] == ["docker", "compose"] and "version" not in e]
    assert calls and all("cm-alice" in e for e in calls)
    assert [p.name.startswith("cloud-monitor-backup-alice-") for p in (tmp_path / "out").iterdir()] == [True]


def test_backup_rejects_unknown_instance(hub_copy, tmp_path):
    hub, events, env = hub_copy
    result = subprocess.run(["bash", str(hub / "scripts" / "backup.sh"), "--instance", "ghost", str(tmp_path / "out")], env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert "找不到托管实例" in result.stderr
    assert not (tmp_path / "out").exists()


def test_restore_instance_never_falls_back_to_main_volumes(hub_copy, tmp_path):
    hub, events, env = hub_copy
    _write_instance(hub, "alice")
    backup = tmp_path / "bk"
    backup.mkdir()
    (backup / "devices.json").write_text("{}")
    (backup / "cloud-monitor.sqlite3").write_bytes(b"x")
    result = subprocess.run(["bash", str(hub / "scripts" / "restore.sh"), "--instance", "alice", str(backup)], env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert "cm-alice_tm-core-data" in result.stderr
    log = _events(events)
    inspected = [e[3] for e in log if e[:2] == ["docker", "volume"]]
    assert inspected == ["cm-alice_tm-core-data"]
    assert not any("down" in e for e in log)
