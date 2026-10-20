"""Tenant administration edits only the private env file; no service is required."""

import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import textwrap
import time

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "tenant.py"
spec = importlib.util.spec_from_file_location("tenant_cli", SCRIPT)
tenant = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tenant)

ACCESS_KEY, TM_KEY = (character * 64 for character in "bc")


def entry(tm="e" * 64, access="f" * 64, **extra):
    return {"tm_secret": tm, "access_token": access, "role": "user", **extra}


@pytest.fixture
def env_file(tmp_path):
    directory = tmp_path / "deployment with spaces"
    directory.mkdir()
    path = directory / ".env"
    path.write_bytes((
        '# existing settings and comments stay byte-for-byte\r\n'
        f"export ACCESS_TOKEN='{ACCESS_KEY}' # owner key\r\n"
        f'TOKEN_MONITOR_SECRET={TM_KEY}\r\n'
        'OTHER_SETTING="${KEEP_THIS}"\r\n'
        '# tenant credentials\r\n'
        'TENANTS_JSON= # keep this comment\r\n'
    ).encode())
    return path


def run_cli(path, *args):
    # -S proves there is no site-package/FastAPI dependency. An empty PATH also
    # prevents accidental reliance on Docker, a shell, or another installed CLI.
    return subprocess.run(
        [sys.executable, "-S", str(SCRIPT), "--env-file", str(path), *args],
        env={**os.environ, "PATH": "", "PYTHONIOENCODING": "utf-8"},
        capture_output=True, text=True, encoding="utf-8", timeout=10,
    )


def set_tenants(path, raw):
    lines = path.read_bytes().decode().splitlines(keepends=True)
    path.write_bytes("".join(
        "TENANTS_JSON=" + raw + "\r\n" if line.startswith("TENANTS_JSON=") else line
        for line in lines
    ).encode())


def test_add_list_show_rotate_remove_keep_other_settings_and_data(env_file):
    before = env_file.read_bytes()
    added = run_cli(env_file, "add", "alice")
    assert added.returncode == 0, added.stderr
    config = tenant.EnvFile(env_file)
    alice = config.tenants["alice"]
    assert alice["role"] == "user"
    keys = [alice[name] for name in ("tm_secret", "access_token")]
    assert all(re.fullmatch("[0-9a-f]{64}", value) for value in keys)
    assert len(set(keys + [ACCESS_KEY, TM_KEY])) == 4
    assert all(value in added.stdout for value in keys)
    assert "docker compose up -d --force-recreate" in added.stdout
    written = env_file.read_bytes()
    assert written.startswith(before.partition(b"TENANTS_JSON=")[0])
    assert re.search(rb"TENANTS_JSON=\s*'\{", written) and written.endswith(b"' # keep this comment\r\n")
    if os.name != "nt":
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    listed = run_cli(env_file, "list")
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout.strip() == "alice\tuser"
    assert not any(value in listed.stdout for value in keys + [ACCESS_KEY, TM_KEY])
    shown = run_cli(env_file, "show", "alice")
    assert shown.returncode == 0 and all(value in shown.stdout for value in keys)
    assert env_file.read_bytes() == written

    config.tenants["alice"]["note"] = {"keep": True}
    config.tenants["bob"] = entry("1" * 64, "2" * 64)
    config.save()
    rotated = run_cli(env_file, "rotate", "alice")
    assert rotated.returncode == 0, rotated.stderr
    changed = tenant.EnvFile(env_file).tenants
    assert all(changed["alice"][name] != alice[name] for name in ("tm_secret", "access_token"))
    assert changed["alice"]["note"] == {"keep": True}
    assert changed["bob"] == config.tenants["bob"]
    data = env_file.parent / "tenants" / "alice" / "hub.sqlite3"
    data.parent.mkdir(parents=True)
    data.write_bytes(b"history must survive revocation")
    removed = run_cli(env_file, "remove", "alice")
    assert removed.returncode == 0, removed.stderr
    assert "历史数据保留" in removed.stdout
    assert tenant.EnvFile(env_file).tenants == {"bob": config.tenants["bob"]}
    assert data.read_bytes() == b"history must survive revocation"


@pytest.mark.parametrize("style", ["bare", "single", "double"])
def test_existing_json_quoting_and_comments_are_readable(env_file, style):
    data = json.dumps({"bob": entry()}, separators=(",", ":"))
    raw = {"bare": data, "single": "'" + data + "'", "double": json.dumps(data)}[style]
    set_tenants(env_file, raw + " # existing tenant")
    result = run_cli(env_file, "add", "alice")
    assert result.returncode == 0, result.stderr
    assert tenant.EnvFile(env_file).tenants["bob"] == entry()
    assert b"' # existing tenant\r\n" in env_file.read_bytes()


def test_json_apostrophes_and_dollars_stay_literal_in_compose_single_quotes(env_file):
    bob = entry(tm="bob's-$TOKEN-" + "e" * 64)
    # A double-quoted JSON value would interpolate $TOKEN in Compose; its literal
    # single-quoted representation must remain intact after adding a friend.
    set_tenants(env_file, "'" + json.dumps({"bob": bob}).replace("'", "\\u0027") + "'")
    result = run_cli(env_file, "add", "alice")
    assert result.returncode == 0, result.stderr
    line = next(line for line in env_file.read_text().splitlines() if line.startswith("TENANTS_JSON="))
    assert line.count("'") == 2
    assert "$TOKEN" in line
    assert tenant.EnvFile(env_file).tenants["bob"] == bob


@pytest.mark.parametrize("raw", [
    '{"alice":' + json.dumps(entry()) + ',"alice":' + json.dumps(entry()) + '}',
    json.dumps({"alice": entry(), " alice ": entry("1" * 64, "2" * 64)}),
    json.dumps({"alice": entry(role="owner")}),
    json.dumps({"alice": entry(access=ACCESS_KEY)}),
    json.dumps({"alice": entry(tm=TM_KEY)}),
    json.dumps({"alice": entry(tm="too-short")}),
    '{"alice":',
    '[]',
])
def test_invalid_or_conflicting_config_is_never_rewritten(env_file, raw):
    set_tenants(env_file, raw)
    before = env_file.read_bytes()
    result = run_cli(env_file, "add", "charlie")
    assert result.returncode == 1 and result.stderr.startswith("错误：")
    assert env_file.read_bytes() == before
    assert not list(env_file.parent.glob(".tenant-env-*"))
    assert not any(key in result.stderr for key in (ACCESS_KEY, TM_KEY))


@pytest.mark.parametrize("command,args", [
    ("add", ("default",)), ("add", ("../alice",)), ("add", (" alice ",)),
    ("show", ("missing",)), ("rotate", ("missing",)), ("remove", ("missing",)),
])
def test_bad_commands_do_not_change_config(env_file, command, args):
    before = env_file.read_bytes()
    result = run_cli(env_file, command, *args)
    assert result.returncode == 1
    assert env_file.read_bytes() == before


def test_duplicate_env_assignment_and_duplicate_add_are_rejected(env_file):
    assert run_cli(env_file, "add", "alice").returncode == 0
    before = env_file.read_bytes()
    assert run_cli(env_file, "add", "alice").returncode == 1
    assert env_file.read_bytes() == before
    env_file.write_bytes(before + b"TENANTS_JSON={}\r\n")
    duplicated = env_file.read_bytes()
    assert run_cli(env_file, "remove", "alice").returncode == 1
    assert env_file.read_bytes() == duplicated


def test_generation_retries_all_global_collisions(env_file, monkeypatch):
    set_tenants(env_file, json.dumps({"bob": entry()}))
    config = tenant.EnvFile(env_file)
    sequence = iter([ACCESS_KEY, TM_KEY, "e" * 64, "1" * 64, "1" * 64, "2" * 64])
    monkeypatch.setattr(tenant.secrets, "token_hex", lambda count: next(sequence))
    assert config.new_keys() == {"tm_secret": "1" * 64, "access_token": "2" * 64}


def test_atomic_replacement_uses_private_temp_and_failure_leaves_original(env_file, monkeypatch):
    config = tenant.EnvFile(env_file)
    config.tenants["alice"] = entry()
    original = env_file.read_bytes()

    def refuse_replace(source, destination):
        if os.name != "nt":
            assert stat.S_IMODE(Path(source).stat().st_mode) == 0o600
        assert env_file.read_bytes() == original
        assert b'"alice"' in Path(source).read_bytes()
        raise OSError("simulated atomic replace failure")

    monkeypatch.setattr(tenant.os, "replace", refuse_replace)
    with pytest.raises(OSError, match="simulated"):
        config.save()
    assert env_file.read_bytes() == original
    assert not list(env_file.parent.glob(".tenant-env-*"))


def test_concurrent_edit_is_not_overwritten(env_file):
    config = tenant.EnvFile(env_file)
    config.tenants["alice"] = entry()
    edited = env_file.read_bytes() + b"# another admin edited this file\n"
    env_file.write_bytes(edited)
    with pytest.raises(tenant.ConfigError, match="其他操作修改"):
        config.save()
    assert env_file.read_bytes() == edited


def test_concurrent_cli_reports_busy_then_retry_retains_both_tenants(env_file, tmp_path):
    reached, resume = tmp_path / "read-reached", tmp_path / "resume"
    code = textwrap.dedent("""
        import importlib.util, pathlib, sys, time
        script, env, reached, resume = sys.argv[1:]
        spec = importlib.util.spec_from_file_location('tenant_cli', script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = module.EnvFile.__init__
        def pause_after_read(self, path):
            original(self, path)
            pathlib.Path(reached).touch()
            deadline = time.monotonic() + 15
            while not pathlib.Path(resume).exists():
                if time.monotonic() > deadline:
                    raise TimeoutError('test gate timed out')
                time.sleep(.01)
        module.EnvFile.__init__ = pause_after_read
        sys.argv = [script, '--env-file', env, 'add', 'alice']
        raise SystemExit(module.main())
    """)
    first = subprocess.Popen(
        [sys.executable, "-S", "-c", code, str(SCRIPT), str(env_file), str(reached), str(resume)],
        env={**os.environ, "PATH": "", "PYTHONIOENCODING": "utf-8"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
    )
    try:
        deadline = time.monotonic() + 10
        while not reached.exists() and first.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        assert reached.exists(), first.communicate(timeout=2)
        lock_path = env_file.with_name(env_file.name + ".lock")
        inode = lock_path.stat().st_ino
        busy = run_cli(env_file, "add", "bob")
        assert busy.returncode == 1 and "其他操作修改" in busy.stderr
        assert run_cli(env_file, "list").returncode == 0
        resume.touch()
        output = first.communicate(timeout=10)
        assert first.returncode == 0, output
        retried = run_cli(env_file, "add", "bob")
        assert retried.returncode == 0, retried.stderr
        assert set(tenant.EnvFile(env_file).tenants) == {"alice", "bob"}
        assert lock_path.stat().st_ino == inode
        assert not lock_path.read_bytes().strip(b"\0")
        if os.name != "nt":
            assert stat.S_IMODE(lock_path.stat().st_mode) == 0o600
    finally:
        resume.touch()
        if first.poll() is None:
            first.kill()
            first.communicate(timeout=5)


def test_nonregular_lock_is_refused_without_changing_env(env_file):
    original = env_file.read_bytes()
    env_file.with_name(env_file.name + ".lock").mkdir()
    result = run_cli(env_file, "add", "alice")
    assert result.returncode == 1
    assert env_file.read_bytes() == original


@pytest.mark.parametrize("parent_link", [False, True])
def test_symlink_file_and_directory_are_refused(env_file, tmp_path, parent_link):
    original = env_file.read_bytes()
    link = tmp_path / "link"
    try:
        link.symlink_to(env_file.parent if parent_link else env_file, target_is_directory=parent_link)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable")
    path = link / ".env" if parent_link else link
    result = run_cli(path, "add", "alice")
    assert result.returncode == 1 and "符号链接" in result.stderr
    assert env_file.read_bytes() == original


def test_symlink_lock_is_refused_without_following_it(env_file, tmp_path):
    original = env_file.read_bytes()
    target = tmp_path / "unrelated"
    target.write_bytes(b"must stay unchanged")
    try:
        env_file.with_name(env_file.name + ".lock").symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable")
    result = run_cli(env_file, "add", "alice")
    assert result.returncode == 1 and "符号链接" in result.stderr
    assert env_file.read_bytes() == original
    assert target.read_bytes() == b"must stay unchanged"


def test_missing_tenant_assignment_is_appended_without_losing_last_line(env_file):
    original = env_file.read_bytes().partition(b"TENANTS_JSON=")[0].rstrip(b"\r\n")
    env_file.write_bytes(original)
    result = run_cli(env_file, "add", "alice")
    assert result.returncode == 0, result.stderr
    assert env_file.read_bytes().startswith(original + b"\r\nTENANTS_JSON='")
    assert tenant.EnvFile(env_file).tenants["alice"]["role"] == "user"
