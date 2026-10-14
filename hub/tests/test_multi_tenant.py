from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import API_KEY, READ_KEY, TM_SECRET, NodeHub, official_payload, requires_node
from hub.config import ConfigError, Settings, TenantConfig, load_settings, parse_tenants
from hub.main import create_app

ALICE_TM = "alice-tm-secret-0123456789abcdef0001"
ALICE_READ = "alice-read-token-0123456789abcdef02"
BOB_TM = "bob-tm-secret-0123456789abcdef000003"
BOB_READ = "bob-read-token-0123456789abcdef0004"


def test_parse_tenants_and_distinct_secrets(monkeypatch, tmp_path: Path):
    assert parse_tenants(None) == {}
    assert parse_tenants("") == {}

    tenants = parse_tenants(
        json.dumps(
            {
                "alice": {"tm_secret": ALICE_TM, "access_token": ALICE_READ},
                "bob": {"tm_secret": BOB_TM, "access_token": BOB_READ, "role": "admin"},
            }
        )
    )
    assert tenants["alice"].role == "user"
    assert tenants["bob"].role == "admin"

    # 非法 tenant_id（default、路径穿越、非法字符）
    for bad_id in ("default", "../etc", "alice/bob", "a.b", ""):
        with pytest.raises(ConfigError):
            parse_tenants(
                json.dumps({bad_id: {"tm_secret": ALICE_TM, "access_token": ALICE_READ}})
            )

    # 非法 role
    with pytest.raises(ConfigError):
        parse_tenants(
            json.dumps(
                {"alice": {"tm_secret": ALICE_TM, "access_token": ALICE_READ, "role": "super"}}
            )
        )

    # 弱密钥 / 短密钥
    with pytest.raises(ConfigError):
        parse_tenants(
            json.dumps({"alice": {"tm_secret": "short", "access_token": ALICE_READ}})
        )

    # 同一租户内 tm_secret == access_token 必须在 load_settings 被拦截
    monkeypatch.setenv("API_KEY", API_KEY)
    monkeypatch.setenv("ACCESS_TOKEN", READ_KEY)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "hub.sqlite3"))
    monkeypatch.setenv(
        "TENANTS_JSON",
        json.dumps({"alice": {"tm_secret": ALICE_TM, "access_token": ALICE_TM}}),
    )
    with pytest.raises(ConfigError, match="相同"):
        load_settings()

    # 不同租户间或与根密钥冲突也必须拒绝启动
    monkeypatch.setenv(
        "TENANTS_JSON",
        json.dumps(
            {
                "alice": {"tm_secret": ALICE_TM, "access_token": ALICE_READ},
                "bob": {"tm_secret": ALICE_TM, "access_token": BOB_READ},
            }
        ),
    )
    with pytest.raises(ConfigError, match="相同"):
        load_settings()

    monkeypatch.setenv(
        "TENANTS_JSON",
        json.dumps({"alice": {"tm_secret": ALICE_TM, "access_token": READ_KEY}}),
    )
    with pytest.raises(ConfigError, match="相同"):
        load_settings()


@requires_node
def test_multi_tenant_physical_isolation_and_same_device_id(tmp_path: Path):
    node = NodeHub(tmp_path / "devices.json")
    try:
        settings = Settings(
            api_key=API_KEY,
            access_token=READ_KEY,
            database_path=tmp_path / "hub.sqlite3",
            frontend_dir=tmp_path,
            max_records_per_push=500,
            tm_ingest_secret=TM_SECRET,
            tm_core_url=node.url,
            tm_background_enabled=False,
            tenants={
                "alice": TenantConfig(
                    tenant_id="alice",
                    tm_secret=ALICE_TM,
                    access_token=ALICE_READ,
                    role="user",
                ),
                "bob": TenantConfig(
                    tenant_id="bob",
                    tm_secret=BOB_TM,
                    access_token=BOB_READ,
                    role="admin",
                ),
            },
        )
        app = create_app(settings)
        with TestClient(app) as client:
            # Alice 与 Bob 使用完全相同的 deviceId ("shared-mac") 上报不同用量
            alice_payload = official_payload(
                {
                    "deviceId": "shared-mac",
                    "hostname": "alice-macbook",
                    "platform": "darwin",
                    "today": {
                        "totalTokens": 12000,
                        "inputTokens": 8000,
                        "outputTokens": 4000,
                        "costUsd": 0.12,
                        "models": {"claude-opus-4-6": {"totalTokens": 12000, "costUsd": 0.12}},
                        "clients": {"claude": {"totalTokens": 12000, "costUsd": 0.12}},
                    },
                    "month": {"totalTokens": 12000, "costUsd": 0.12},
                    "allTime": {"totalTokens": 12000, "costUsd": 0.12},
                }
            )
            bob_payload = official_payload(
                {
                    "deviceId": "shared-mac",
                    "hostname": "bob-workstation",
                    "platform": "linux",
                    "today": {
                        "totalTokens": 95000,
                        "inputTokens": 60000,
                        "outputTokens": 35000,
                        "costUsd": 0.95,
                        "models": {"gpt-5": {"totalTokens": 95000, "costUsd": 0.95}},
                        "clients": {"codex": {"totalTokens": 95000, "costUsd": 0.95}},
                    },
                    "month": {"totalTokens": 95000, "costUsd": 0.95},
                    "allTime": {"totalTokens": 95000, "costUsd": 0.95},
                }
            )

            r_alice = client.post(
                "/api/ingest",
                json=alice_payload,
                headers={"X-Token-Monitor-Secret": ALICE_TM},
            )
            assert r_alice.status_code == 200

            r_bob = client.post(
                "/api/ingest",
                json=bob_payload,
                headers={"X-Token-Monitor-Secret": BOB_TM},
            )
            assert r_bob.status_code == 200

            # 物理文件隔离验证：devices.json 与 SQLite 均按租户独立落盘
            assert (tmp_path / "tenants" / "alice" / "devices.json").is_file()
            assert (tmp_path / "tenants" / "bob" / "devices.json").is_file()
            assert (tmp_path / "tenants" / "alice" / "hub.sqlite3").is_file()
            assert (tmp_path / "tenants" / "bob" / "hub.sqlite3").is_file()

            # 订阅与同步设置隔离
            assert (
                client.put(
                    "/api/subscriptions",
                    json={
                        "subscriptions": [
                            {
                                "id": "sub-a",
                                "provider": "claude",
                                "planName": "Claude Pro",
                                "amountMinor": 2000,
                                "currency": "USD",
                                "startDate": "2026-10-01",
                            }
                        ]
                    },
                    headers={"X-Token-Monitor-Secret": ALICE_TM},
                ).status_code
                == 200
            )
            assert (
                client.put(
                    "/api/sync/settings/modelAliases",
                    json={
                        "baseRevision": 0,
                        "value": {
                            "modelAliases": {"claude-opus-4-6": "Alice Opus"},
                            "modelAliasGrouping": "duplicates",
                        },
                    },
                    headers={"X-Token-Monitor-Secret": ALICE_TM},
                ).status_code
                == 200
            )

            # Alice 的 overview / subscriptions / daily 只包含 Alice 的数据
            ov_alice = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            )
            assert ov_alice.status_code == 200
            ov_a = ov_alice.json()
            assert ov_a["totals"]["today"]["totalTokens"] == 12000
            assert [d["hostname"] for d in ov_a["devices"]] == ["alice-macbook"]

            sub_alice = client.get(
                "/api/v1/tm/subscriptions",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            ).json()
            assert len(sub_alice["subscriptions"]) == 1
            assert sub_alice["subscriptions"][0]["id"] == "sub-a"

            daily_alice = client.get(
                "/api/v1/tm/history/daily",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            ).json()
            assert len(daily_alice["items"]) == 1
            assert daily_alice["items"][0]["tokens"] == 12000

            # Bob 的 overview / subscriptions / daily 完全独立，不受 Alice 影响
            ov_bob = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {BOB_READ}"},
            )
            assert ov_bob.status_code == 200
            ov_b = ov_bob.json()
            assert ov_b["totals"]["today"]["totalTokens"] == 95000
            assert [d["hostname"] for d in ov_b["devices"]] == ["bob-workstation"]

            sub_bob = client.get(
                "/api/v1/tm/subscriptions",
                headers={"Authorization": f"Bearer {BOB_READ}"},
            ).json()
            assert sub_bob["subscriptions"] == []

            aliases_bob = client.get(
                "/api/sync/settings/modelAliases",
                headers={"X-Token-Monitor-Secret": BOB_TM},
            ).json()
            assert aliases_bob["revision"] == 0
            assert aliases_bob["value"] is None

            # 默认租户（根密钥）为空，未收到 Alice 或 Bob 的设备
            ov_default = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {READ_KEY}"},
            ).json()
            assert ov_default["devices"] == []

            # Alice 删除自己的 "shared-mac" 设备，Bob 的同名设备完好无损
            del_alice = client.delete(
                "/api/devices/shared-mac",
                headers={"X-Token-Monitor-Secret": ALICE_TM},
            )
            assert del_alice.status_code == 200

            ov_alice_after = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            ).json()
            assert ov_alice_after["devices"] == []

            ov_bob_after = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {BOB_READ}"},
            ).json()
            assert len(ov_bob_after["devices"]) == 1
            assert ov_bob_after["totals"]["today"]["totalTokens"] == 95000

            # 租户只读密钥无权访问根 OpenWebUI 数据库路由
            r_owui = client.get(
                "/api/v1/usage",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            )
            assert r_owui.status_code == 401
    finally:
        node.stop()


def test_multi_tenant_system_update_role_enforcement(tmp_path: Path):
    update_dir = tmp_path / "update"
    runtime_dir = tmp_path / "update-runtime"
    update_dir.mkdir()
    runtime_dir.mkdir()
    (runtime_dir / "update.lock").touch()
    (runtime_dir / "watcher.json").write_text(
        json.dumps({"pid": os.getpid(), "started_at": "2026-10-14T00:00:00Z"}),
        encoding="utf-8",
    )

    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp_path / "hub.sqlite3",
        frontend_dir=tmp_path,
        max_records_per_push=500,
        tm_background_enabled=False,
        cm_update_dir=update_dir,
        cm_update_runtime_dir=runtime_dir,
        tenants={
            "alice": TenantConfig(
                tenant_id="alice",
                tm_secret=ALICE_TM,
                access_token=ALICE_READ,
                role="user",
            ),
            "bob": TenantConfig(
                tenant_id="bob",
                tm_secret=BOB_TM,
                access_token=BOB_READ,
                role="admin",
            ),
        },
    )
    app = create_app(settings)
    app.state.update_service._fetch = lambda url: (200, [] if "releases" in url else {"sha": "a" * 40})

    with TestClient(app) as client:
        # 普通租户（role="user"）可查看版本状态，但 apply_enabled 恒为 False，且禁止触发/取消更新
        g_alice = client.get(
            "/api/v1/system/update",
            headers={"Authorization": f"Bearer {ALICE_READ}"},
        )
        assert g_alice.status_code == 200
        assert g_alice.json()["apply_enabled"] is False

        p_alice = client.post(
            "/api/v1/system/update",
            json={"ref": "main"},
            headers={"Authorization": f"Bearer {ALICE_READ}"},
        )
        assert p_alice.status_code == 403

        c_alice = client.post(
            "/api/v1/system/update/cancel",
            headers={"Authorization": f"Bearer {ALICE_READ}"},
        )
        assert c_alice.status_code == 403

        # 管理员租户（role="admin"）拥有更新权限
        g_bob = client.get(
            "/api/v1/system/update",
            headers={"Authorization": f"Bearer {BOB_READ}"},
        )
        assert g_bob.status_code == 200
        assert g_bob.json()["apply_enabled"] is True

        p_bob = client.post(
            "/api/v1/system/update",
            json={"ref": "main"},
            headers={"Authorization": f"Bearer {BOB_READ}"},
        )
        assert p_bob.status_code == 200
        assert p_bob.json()["state"] == "queued"

        c_bob = client.post(
            "/api/v1/system/update/cancel",
            headers={"Authorization": f"Bearer {BOB_READ}"},
        )
        assert c_bob.status_code == 200
        assert c_bob.json()["state"] == "error"


@requires_node
def test_pure_multi_tenant_without_root_tm_secret(tmp_path: Path):
    """不配置根 TOKEN_MONITOR_SECRET、仅配置 TENANTS_JSON 时，租户读写与健康探针正常。"""
    node = NodeHub(tmp_path / "devices.json")
    try:
        settings = Settings(
            api_key=API_KEY,
            access_token=READ_KEY,
            database_path=tmp_path / "hub.sqlite3",
            frontend_dir=tmp_path,
            max_records_per_push=500,
            tm_ingest_secret="",
            tm_core_url=node.url,
            tm_background_enabled=True,
            tenants={
                "alice": TenantConfig(
                    tenant_id="alice",
                    tm_secret=ALICE_TM,
                    access_token=ALICE_READ,
                ),
            },
        )
        app = create_app(settings)
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
            assert client.get("/api/v1/health/ready").status_code == 200

            # 根 ACCESS_TOKEN 没有配根 TOKEN_MONITOR_SECRET，访问 /api/v1/tm/overview 仍返回 404
            r_root = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {READ_KEY}"},
            )
            assert r_root.status_code == 404

            # Alice 租户正常写入与读取
            payload = official_payload(
                {
                    "deviceId": "alice-laptop",
                    "hostname": "alice-air",
                    "platform": "darwin",
                    "today": {"totalTokens": 5000, "costUsd": 0.05},
                    "month": {"totalTokens": 5000, "costUsd": 0.05},
                    "allTime": {"totalTokens": 5000, "costUsd": 0.05},
                }
            )
            assert (
                client.post(
                    "/api/ingest",
                    json=payload,
                    headers={"X-Token-Monitor-Secret": ALICE_TM},
                ).status_code
                == 200
            )
            ov = client.get(
                "/api/v1/tm/overview",
                headers={"Authorization": f"Bearer {ALICE_READ}"},
            )
            assert ov.status_code == 200
            assert ov.json()["totals"]["today"]["totalTokens"] == 5000
    finally:
        node.stop()
