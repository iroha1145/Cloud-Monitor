"""The API and the unmodified host updater must agree on the cancellation winner."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time

from fastapi import HTTPException
import pytest

from hub import tm_update
from hub.tm_update import UpdateService
from test_hub import make_settings


ROOT = Path(__file__).resolve().parents[2]


def update_service(tmp_path, *, host_lock=True):
    control = tmp_path / "control"
    runtime = tmp_path / "runtime"
    control.mkdir()
    runtime.mkdir()
    if host_lock:
        (runtime / "update.lock").touch(mode=0o640)
    settings = make_settings(tmp_path, cm_update_dir=control, cm_update_runtime_dir=runtime)
    return UpdateService(settings), control, runtime


@pytest.mark.parametrize("old_status", [None, {"id": "older", "state": "ok", "message": "已更新旧版本"}])
def test_cancel_persists_in_control_without_writing_readonly_host_runtime(tmp_path, monkeypatch, old_status):
    service, control, runtime = update_service(tmp_path)
    status = runtime / "status.json"
    if old_status is not None:
        status.write_text(json.dumps(old_status))
        status.chmod(0o440)
    before = status.read_bytes() if status.exists() else None
    (runtime / "update.lock").chmod(0o440)
    runtime.chmod(0o550)
    real_write = tm_update._atomic_write

    def control_only(path, value):
        assert path.parent != runtime, "container must never write host runtime"
        return real_write(path, value)

    monkeypatch.setattr(tm_update, "_atomic_write", control_only)
    try:
        queued = service.apply("main")
        cancelled = service.cancel()
        assert cancelled["id"] == queued["id"]
        assert cancelled["ref"] == "main"
        assert cancelled["message"] == "已取消更新"
        assert not (control / "request.json").exists()
        assert (status.read_bytes() if status.exists() else None) == before
        restarted = UpdateService(service.settings)
        assert restarted.read_job() == cancelled
        next_job = restarted.apply("v0.2.0")
        assert next_job["state"] == "queued"
        assert next_job["id"] != cancelled["id"]
        assert not (control / "cancel.json").exists()
    finally:
        runtime.chmod(0o750)


def test_cancel_atomic_move_remains_visible_if_receipt_timestamp_write_fails(tmp_path, monkeypatch):
    service, control, _runtime = update_service(tmp_path)
    queued = service.apply("main")

    def cannot_write(_path, _value):
        raise OSError("disk full")

    monkeypatch.setattr(tm_update, "_atomic_write", cannot_write)
    cancelled = service.cancel()
    assert cancelled["id"] == queued["id"]
    assert cancelled["message"] == "已取消更新"
    assert not (control / "request.json").exists()
    assert UpdateService(service.settings).read_job() == cancelled


@pytest.mark.parametrize("old_status", [None, {"id": "older", "state": "ok", "message": "已更新旧版本"}])
def test_publication_failure_survives_restart_without_writing_host_status_and_can_retry(tmp_path, monkeypatch, old_status):
    service, control, runtime = update_service(tmp_path)
    status = runtime / "status.json"
    if old_status is not None:
        status.write_text(json.dumps(old_status))
        status.chmod(0o440)
    before = status.read_bytes() if status.exists() else None
    runtime.chmod(0o550)
    real_write = tm_update._atomic_write
    fail_request = True

    def controlled_write(path, value):
        assert path.parent != runtime, "container must never write host runtime"
        if fail_request and path == control / "request.json":
            raise OSError("request publication failed")
        return real_write(path, value)

    monkeypatch.setattr(tm_update, "_atomic_write", controlled_write)
    try:
        with pytest.raises(HTTPException) as error:
            service.apply("main")
        assert error.value.status_code == 503
        failed = service.read_job()
        assert failed["state"] == "error"
        assert failed["ref"] == "main"
        assert failed["message"] == "更新请求写入失败"
        assert not (control / "request.json").exists()
        assert (control / "publication-error.json").exists()
        assert (status.read_bytes() if status.exists() else None) == before
        restarted = UpdateService(service.settings)
        assert restarted.read_job() == failed
        fail_request = False
        queued = restarted.apply("v0.2.0")
        assert queued["state"] == "queued"
        assert queued["id"] != failed["id"]
        assert not (control / "publication-error.json").exists()
        assert (status.read_bytes() if status.exists() else None) == before
    finally:
        runtime.chmod(0o750)


@pytest.mark.parametrize("host_state", ["running", "unknown"])
def test_api_failure_receipts_never_hide_running_or_unknown_host_state(tmp_path, host_state):
    service, control, runtime = update_service(tmp_path)
    (control / "publication-error.json").write_text(json.dumps({"id": "failed", "ref": "main"}))
    (control / "cancel.json").write_text(json.dumps({"id": "cancelled", "ref": "main"}))
    (runtime / "status.json").write_text(json.dumps({
        "id": "host-job", "state": host_state, "updated_at": tm_update._iso_now(),
    }))
    job = service.read_job()
    assert job["id"] == "host-job"
    assert job["state"] == host_state


def test_api_failure_receipt_never_hides_pending_request_or_unreadable_host_status(tmp_path, monkeypatch):
    service, control, runtime = update_service(tmp_path)
    (control / "publication-error.json").write_text(json.dumps({"id": "failed", "ref": "main"}))
    (control / "request.json").write_text(json.dumps({"id": "pending", "ref": "main"}))
    assert service.read_job()["id"] == "pending"
    assert service.read_job()["state"] == "queued"
    (control / "request.json").unlink()
    original = Path.read_text

    def blocked(path, *args, **kwargs):
        if path == runtime / "status.json":
            raise PermissionError("host status unreadable")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", blocked)
    job = service.read_job()
    assert job["state"] == "unknown"
    assert job["status_unreadable"] is True


@pytest.mark.parametrize("unreadable", [False, True])
def test_legacy_host_can_enqueue_but_cancellation_requires_readable_shared_lock(tmp_path, monkeypatch, unreadable):
    service, control, runtime = update_service(tmp_path, host_lock=unreadable)
    if unreadable:
        real_open = os.open

        def deny_lock(path, *args, **kwargs):
            if Path(path) == runtime / "update.lock":
                raise PermissionError("old root-only lock")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr(os, "open", deny_lock)
    assert service.apply("main")["state"] == "queued"
    with pytest.raises(HTTPException) as error:
        service.cancel()
    assert error.value.status_code == 503
    assert "install.sh" in error.value.detail
    assert (control / "request.json").exists()


def test_symlink_shared_lock_is_rejected_without_touching_target(tmp_path):
    service, control, runtime = update_service(tmp_path, host_lock=False)
    target = tmp_path / "unrelated"
    target.write_text("keep")
    (runtime / "update.lock").symlink_to(target)
    for operation in (lambda: service.apply("main"), service.cancel):
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 503
    assert target.read_text() == "keep"
    assert not (control / "request.json").exists()


def test_later_host_job_is_not_hidden_by_previous_cancellation(tmp_path):
    service, control, runtime = update_service(tmp_path)
    service.apply("main")
    old = service.cancel()
    current = service.apply("v0.2.0")
    assert not (control / "cancel.json").exists()
    for state in ("running", "ok"):
        (runtime / "status.json").write_text(json.dumps({**current, "state": state}))
        job = service.read_job()
        assert job["id"] != old["id"]
        assert job["state"] == state
    (control / "request.json").unlink()
    assert service.read_job()["state"] == "ok"


def _executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def _updater_fixture(tmp_path, gate):
    """Stub privileges/git/docker, but use real OS flock and the real script.

    Root ownership is not available to developer/CI users. Only install/id and
    fchown are substituted; permission modes, file operations, process boundaries
    and exclusive locks remain real. No network or deployment command is run.
    """
    checkout = tmp_path / "checkout"
    control = checkout / "hub/update-control"
    runtime = tmp_path / "runtime"
    binaries = tmp_path / "bin"
    control.mkdir(parents=True)
    runtime.mkdir()
    binaries.mkdir()
    (checkout / ".git").mkdir()
    (runtime / "update.lock").touch(mode=0o640)
    events, reached, resume = (tmp_path / name for name in ("events", "reached", "resume"))
    common = f"#!{sys.executable}\n"
    _executable(binaries / "id", "#!/bin/sh\necho 0\n")
    _executable(binaries / "install", common + "import pathlib,sys\np=pathlib.Path(sys.argv[-1]);p.mkdir(parents=True,exist_ok=True);p.chmod(0o750)\n")
    command_stub = common + """import json,os,sys
from pathlib import Path
with open(os.environ['CM_TEST_EVENTS'],'a') as f:
    f.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')
if 'rev-parse' in sys.argv: print('abc1234')
"""
    _executable(binaries / "git", command_stub)
    _executable(binaries / "docker", command_stub)
    wait = """
from pathlib import Path
def pause_at(stage):
    if os.environ.get('CM_TEST_GATE') == stage:
        Path(os.environ['CM_TEST_REACHED']).touch()
        deadline=time.monotonic()+10
        while not Path(os.environ['CM_TEST_RESUME']).exists():
            if time.monotonic()>deadline: raise SystemExit('test gate timed out')
            time.sleep(.005)
"""
    _executable(binaries / "flock", common + "import fcntl,os,sys,time\n" + wait + """
pause_at('before_lock')
try: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: raise SystemExit(1)
""")
    _executable(binaries / "python3", common + "import os,sys,time\n" + wait + """
args=sys.argv[1:]
if args[0]=='-c':
    code=args[1]
    sys.argv=['-c']+args[2:]
else:
    code=sys.stdin.read()
    sys.argv=['-']+args[1:]
    if len(args)>3 and args[3]=='running': pause_at('before_running')
os.fchown=lambda *_args: None
exec(compile(code,'<host updater>','exec'),{'__name__':'__main__'})
""")
    config = make_settings(tmp_path, cm_update_dir=control, cm_update_runtime_dir=runtime)
    env = {**os.environ, "LC_ALL": "C", "PATH": str(binaries) + os.pathsep + os.environ["PATH"], "CM_UPDATE_RUNTIME_HOST": str(runtime), "CM_TEST_GATE": gate, "CM_TEST_EVENTS": str(events), "CM_TEST_REACHED": str(reached), "CM_TEST_RESUME": str(resume)}
    return UpdateService(config), checkout, runtime, events, reached, resume, env


@pytest.mark.parametrize("gate", ["before_lock", "before_running"])
def test_real_host_script_and_api_have_one_cancellation_winner(tmp_path, gate):
    service, checkout, runtime, events, reached, resume, env = _updater_fixture(tmp_path, gate)
    job = service.apply("main")
    inode = (runtime / "update.lock").stat().st_ino
    process = subprocess.Popen(["bash", str(ROOT / "hub/scripts/self-update.sh"), str(checkout)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 10
        while not reached.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.005)
        assert reached.exists(), process.communicate(timeout=2)
        if gate == "before_lock":
            assert service.cancel()["message"] == "已取消更新"
        else:
            # The host owns the lock before publishing running. Neither cancel
            # nor an enqueue from a separate service instance may get through.
            other = UpdateService(service.settings)
            for operation in (service.cancel, lambda: other.apply("v0.2.0")):
                with pytest.raises(HTTPException) as error:
                    operation()
                assert error.value.status_code == 409
            assert service.read_job()["id"] == job["id"]
        resume.touch()
        stdout, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, (stdout, stderr)
        assert (runtime / "update.lock").stat().st_ino == inode
        commands = [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
        if gate == "before_lock":
            assert commands == []
            assert service.read_job()["message"] == "已取消更新"
        else:
            assert any(command[0] == "docker" and "--build" in command for command in commands)
            assert service.read_job()["state"] == "ok"
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


def test_installer_rejects_nonroot_before_creating_any_files(tmp_path):
    binaries = tmp_path / "bin"
    binaries.mkdir()
    _executable(binaries / "id", "#!/bin/sh\necho 1001\n")
    destination = tmp_path / "not-created"
    env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run(["bash", str(ROOT / "install.sh"), "--mode", "demo", "--yes", "--dir", str(destination)], env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert "sudo" in result.stderr
    assert not destination.exists()
