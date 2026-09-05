"""Online update publication must remain recoverable across process exits."""

import json
import subprocess
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from hub.main import create_app
from hub.tm_update import UpdateService
from test_hub import READ, make_settings


def test_process_exit_after_first_publication_keeps_a_consumable_request(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    # Abruptly exit a real child after the first atomic publication. No cleanup
    # handler runs, just as when the container stops between the two old writes.
    child = subprocess.run(
        [sys.executable, "-c", """
import os
import sys
from pathlib import Path
from hub.config import Settings
from hub import tm_update

control = Path(sys.argv[1])
settings = Settings(
    api_key="a" * 32, access_token="b" * 32,
    database_path=control / "unused.sqlite3", frontend_dir=control,
    max_records_per_push=500, cm_update_dir=control,
)
real_write = tm_update._atomic_write
def publish_then_exit(path, data):
    real_write(path, data)
    os._exit(23)
tm_update._atomic_write = publish_then_exit
tm_update.UpdateService(settings).apply("main")
""", str(control)],
        capture_output=True, text=True, timeout=10,
    )
    assert child.returncode == 23, child.stderr
    assert (control / "request.json").is_file()
    request = json.loads((control / "request.json").read_text())
    restarted = UpdateService(make_settings(tmp_path, cm_update_dir=control))
    assert restarted.read_job()["state"] == "queued"
    assert restarted.read_job()["id"] == request["id"]
    assert request["ref"] == "main"


def test_orphaned_queued_status_can_be_retried_via_http(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    (control / "status.json").write_text(json.dumps({
        "id": "interrupted", "state": "queued", "ref": "main",
    }))
    app = create_app(make_settings(tmp_path, cm_update_dir=control))
    app.state.update_service._fetch = lambda _url: (200, {})
    with TestClient(app) as client:
        job = client.get("/api/v1/system/update", headers=READ).json()["job"]
        assert job["state"] == "error"
        response = client.post("/api/v1/system/update", headers=READ, json={"ref": "main"})
        assert response.status_code == 200, response.text
        assert response.json()["state"] == "queued"
        request = json.loads((control / "request.json").read_text())
        assert response.json()["id"] == request["id"] != "interrupted"


@pytest.mark.parametrize("old_status", [
    {"id": "previous", "state": "ok"},
    {"id": "previous", "state": "error"},
    "invalid JSON",
    [],
])
def test_new_request_is_visible_without_overwriting_old_host_status(tmp_path, old_status):
    control = tmp_path / "update"
    control.mkdir()
    status_path = control / "status.json"
    before = old_status if isinstance(old_status, str) else json.dumps(old_status)
    status_path.write_text(before)
    service = UpdateService(make_settings(tmp_path, cm_update_dir=control))
    job = service.apply("main")
    request = json.loads((control / "request.json").read_text())
    assert job["state"] == "queued"
    assert job["id"] == request["id"] != "previous"
    assert status_path.read_text() == before


def test_published_request_stays_busy_after_restart(tmp_path):
    control = tmp_path / "update"
    control.mkdir()
    settings = make_settings(tmp_path, cm_update_dir=control)
    first = UpdateService(settings).apply("main")
    restarted = UpdateService(settings)
    with pytest.raises(HTTPException) as error:
        restarted.apply("v0.2.0")
    assert error.value.status_code == 409
    assert restarted.read_job() == first


@pytest.mark.parametrize("state", ["ok", "error"])
def test_host_progress_and_completion_survive_request_cleanup(tmp_path, state):
    control = tmp_path / "update"
    control.mkdir()
    service = UpdateService(make_settings(tmp_path, cm_update_dir=control))
    request = service.apply("main")
    status_path = control / "status.json"
    status_path.write_text(json.dumps({**request, "state": "running"}))
    assert service.read_job()["state"] == "running"
    status_path.write_text(json.dumps({**request, "state": state}))
    assert service.read_job()["state"] == state
    (control / "request.json").unlink()
    assert service.read_job()["state"] == state
