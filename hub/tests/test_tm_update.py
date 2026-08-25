"""在线更新 API：检索 GitHub Releases + 写入宿主机请求文件。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from hub.main import create_app
from hub.tm_update import UpdateService, parse_ref, version_key
from test_hub import READ, make_settings

RELEASE = {
    "tag_name": "v0.2.0",
    "name": "0.2.0",
    "draft": False,
    "prerelease": False,
    "html_url": "https://github.com/iroha1145/Cloud-Monitor/releases/tag/v0.2.0",
    "published_at": "2026-08-26T00:00:00Z",
    "body": "notes",
}


def _fetch_ok(url: str):
    if "/releases" in url:
        return 200, [RELEASE]
    return 200, {"sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "commit": {"message": "feat: x\n\nbody"}}


def test_version_key_orders():
    assert version_key("0.1.0") < version_key("v0.2.0")
    assert version_key("v1.0.0") == version_key("1.0.0")
    assert parse_ref("v0.2.0") == "v0.2.0"
    assert parse_ref("main") == "main"


def test_parse_ref_rejects_paths():
    try:
        parse_ref("../etc/passwd")
        assert False
    except ValueError:
        pass
    try:
        parse_ref("origin/main")
        assert False
    except ValueError:
        pass


def test_check_marks_release_ahead(tmp_path):
    settings = make_settings(tmp_path, cm_version="0.1.0", cm_git_sha="aaa1111")
    out = UpdateService(settings, fetch=_fetch_ok).check(force=True)
    assert out["release_ahead"] is True
    assert out["latest_release"]["tag"] == "v0.2.0"
    assert out["main"]["short_sha"] == "bbbbbbb"
    assert out["apply_enabled"] is False


def test_http_requires_access_token(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        assert client.get("/api/v1/system/update").status_code == 401
        assert client.post("/api/v1/system/update", json={"ref": "main"}).status_code == 401


def test_http_check_ok(tmp_path, monkeypatch):
    settings = make_settings(tmp_path, cm_version="0.1.0", cm_git_sha="aaa1111")
    app = create_app(settings)
    app.state.update_service._fetch = _fetch_ok
    with TestClient(app) as client:
        resp = client.get("/api/v1/system/update", headers=READ)
        assert resp.status_code == 200
        data = resp.json()
        assert data["current"]["version"] == "0.1.0"
        assert data["release_ahead"] is True
        assert data["apply_enabled"] is False


def test_apply_writes_request(tmp_path):
    upd = tmp_path / "update"
    upd.mkdir()
    settings = make_settings(tmp_path, cm_update_dir=upd, cm_version="0.1.0")
    app = create_app(settings)
    with TestClient(app) as client:
        missing = client.post(
            "/api/v1/system/update",
            headers=READ,
            json={"ref": "v0.2.0"},
        )
        assert missing.status_code == 200
        req = json.loads((upd / "request.json").read_text())
        assert req["ref"] == "v0.2.0"
        again = client.post(
            "/api/v1/system/update",
            headers=READ,
            json={"ref": "main"},
        )
        assert again.status_code == 409


def test_apply_without_dir_is_503(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/system/update",
            headers=READ,
            json={"ref": "main"},
        )
        assert resp.status_code == 503


def test_apply_rejects_bad_ref(tmp_path):
    upd = tmp_path / "update"
    upd.mkdir()
    app = create_app(make_settings(tmp_path, cm_update_dir=upd))
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/system/update",
            headers=READ,
            json={"ref": "origin/main"},
        )
        assert resp.status_code == 400


def test_check_only_hits_allowlisted_github(tmp_path):
    urls = []

    def fetch(url: str):
        urls.append(url)
        return _fetch_ok(url)

    UpdateService(make_settings(tmp_path, cm_version="0.1.0"), fetch=fetch).check(force=True)
    assert urls
    assert all(
        u.startswith("https://api.github.com/repos/iroha1145/Cloud-Monitor/") for u in urls
    )


def test_get_rejects_non_github(tmp_path):
    called = []

    def fetch(url: str):
        called.append(url)
        return 200, {}

    svc = UpdateService(make_settings(tmp_path), fetch=fetch)
    status, body = svc._get("https://evil.example/secret")
    assert status == 0
    assert "allowlist" in str(body)
    assert called == []


def test_check_cache_skips_network(tmp_path):
    n = {"c": 0}

    def fetch(url: str):
        n["c"] += 1
        return _fetch_ok(url)

    svc = UpdateService(make_settings(tmp_path, cm_version="0.1.0"), fetch=fetch)
    svc.check()
    first = n["c"]
    assert first > 0
    svc.check()
    assert n["c"] == first
    svc.check(force=True)
    assert n["c"] > first


def test_host_updater_scripts_exist():
    hub = Path(__file__).resolve().parents[1]
    root = hub.parent
    for rel in (
        "scripts/self-update.sh",
        "scripts/update-watcher.sh",
        "scripts/systemd/cloud-monitor-updater.service",
    ):
        path = hub / rel
        assert path.is_file(), rel
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".sh":
            assert "request.json" in text
    install = (root / "install.sh").read_text(encoding="utf-8")
    assert "ensure_updater" in install
    assert "update-watcher.sh" in install
    compose = (hub / "docker-compose.yml").read_text(encoding="utf-8")
    assert "./update-control:/update" in compose
    assert "CM_UPDATE_DIR: /update" in compose
    gitignore = (root / ".gitignore").read_text(encoding="utf-8")
    assert "hub/update-control/*.json" in gitignore
    script = (hub / "scripts/self-update.sh").read_text(encoding="utf-8")
    assert "safe.directory" in script
    assert "--untracked-files=no" in script

