"""差分测试：官方 createHub() 与 Cloud-Monitor（校验→转发→快照全链路）
接收完全相同的载荷序列后，核心协议输出必须等价。

"等价"的范围: ingest 响应、stats 的 periods 数值与设备清单、devices 记录、
history、删除行为、partial/limits-only/trackedClients 变化、窗口过期。
Cloud 扩展字段（快照/面板）不在对比范围，但不得替换官方字段。
"""

from __future__ import annotations

import json

import httpx
import pytest

from conftest import (
    TM_SECRET,
    agent_style_payload,
    limits_only_payload,
    make_cloud_app,
    official_payload,
    requires_node,
    widget_style_payload,
)

HEADERS = {"X-Token-Monitor-Secret": TM_SECRET}

CORE_PERIOD_FIELDS = (
    "totalTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "unclassifiedTokens", "costUsd", "clients", "models", "clientModels",
)


def _core_periods(stats: dict) -> dict:
    periods = stats["periods"]
    return {
        name: {field: periods[name].get(field) for field in CORE_PERIOD_FIELDS}
        for name in ("today", "month", "allTime")
    }


def _device_core(records: list[dict]) -> dict:
    return {
        r["deviceId"]: {
            k: r.get(k)
            for k in ("deviceId", "hostname", "platform", "osName", "agentRuntime")
        }
        for r in records
    }


@requires_node
def test_differential_full_sequence(node_hub, tmp_path):
    """widget + agent + limits-only + partial + trackedClients 变化 + 删除。"""
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        sequence = [
            ("widget", widget_style_payload()),
            ("agent", agent_style_payload()),
            # 官方源码规范化生成的第三台设备载荷
            ("official-generated", official_payload({
                "deviceId": "dev-generated",
                "hostname": "Generated-By-Official-Code",
                "today": {"totalTokens": 777, "clients": {"cursor": 777}},
                "month": {"totalTokens": 7777, "clients": {"cursor": 7777}},
                "allTime": {"totalTokens": 77777, "clients": {"cursor": 77777}},
            })),
            # partial：只带 today（组件与总量一致；官方 normalize 以组件
            # 归一，不带 month/allTime 时这两个周期按官方语义归零）
            ("partial", {
                "deviceId": "dev-mac",
                "periodWindows": widget_style_payload()["periodWindows"],
                "today": {"totalTokens": 2000000, "clients": {"claude": 1400000, "codex": 600000}},
                "syncUploadIntervalMs": 300000,
                "updatedAt": "2026-08-22T06:10:00.000Z",
            }),
            # limits-only：不得把 token 量归零
            ("limits-only", limits_only_payload()),
        ]
        for name, payload in sequence:
            direct = httpx.post(f"{node_hub.url}/api/ingest", json=payload, headers=HEADERS)
            via_cloud = cloud.post("/api/ingest", json=payload, headers=HEADERS)
            assert via_cloud.status_code == direct.status_code == 200, name
            assert via_cloud.json()["ok"] is True and via_cloud.json()["deviceId"] == payload["deviceId"]

        # limits-only（limitsOnly:true）后 token 量未被清零
        mid = cloud.get("/api/stats", headers=HEADERS).json()
        assert mid["periods"]["today"]["totalTokens"] == 2000000 + 320000 + 777

        # trackedClients 收缩（最后一步：重传 widget 原始总量）
        tail = widget_style_payload() | {"trackedClients": ["claude"]}
        direct = httpx.post(f"{node_hub.url}/api/ingest", json=tail, headers=HEADERS)
        via_cloud = cloud.post("/api/ingest", json=tail, headers=HEADERS)
        assert via_cloud.status_code == direct.status_code == 200

        direct_stats = httpx.get(f"{node_hub.url}/api/stats", headers=HEADERS).json()
        cloud_stats = cloud.get("/api/stats", headers=HEADERS).json()

        assert _core_periods(cloud_stats) == _core_periods(direct_stats)
        assert _device_core(cloud_stats["devices"]) == _device_core(direct_stats["devices"])
        assert cloud_stats["staleAfterMs"] == direct_stats["staleAfterMs"]
        assert cloud_stats["historyRevision"] == direct_stats["historyRevision"]
        assert cloud_stats["subscriptionsUpdatedAt"] == direct_stats["subscriptionsUpdatedAt"]

        direct_history = httpx.get(f"{node_hub.url}/api/history", headers=HEADERS).json()
        cloud_history = cloud.get("/api/history", headers=HEADERS).json()
        assert cloud_history == direct_history

        # limits-only 后 token 仍保留（不会被清零）
        # tracked-change 重传了 widget 原始 today(1846320)，partial 的 2000000 被覆盖
        assert cloud_stats["periods"]["today"]["totalTokens"] == 1846320 + 320000 + 777

        # 删除等价
        direct_del = httpx.request("DELETE", f"{node_hub.url}/api/devices/dev-headless", headers=HEADERS)
        cloud_del = cloud.delete("/api/devices/dev-generated", headers=HEADERS)
        assert direct_del.json() == {"ok": True, "deviceId": "dev-headless"}
        assert cloud_del.json() == {"ok": True, "deviceId": "dev-generated"}


@requires_node
def test_differential_models_authoritative_vs_client_models(node_hub, tmp_path):
    """需求七: models 是权威；clientModels 部分归属不得吞掉未归属 token。"""
    payload = {
        "deviceId": "dev-models",
        "syncUploadIntervalMs": 300000,
        "updatedAt": "2026-08-22T06:00:00.000Z",
        "today": {"models": {"gpt-5": 1000}, "clientModels": {"codex": {"gpt-5": 800}}},
    }
    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        cloud.post("/api/ingest", json=payload, headers=HEADERS)
        stats = cloud.get("/api/stats", headers=HEADERS).json()
        direct = httpx.post(f"{node_hub.url}/api/ingest", json=payload, headers=HEADERS).json()
        assert stats["periods"]["today"]["models"] == direct["stats"]["periods"]["today"]["models"]
        # models 是权威：未归属 clientModels 的 200 仍在 models 中，不消失
        assert stats["periods"]["today"]["models"] == {"gpt-5": 1000}


@requires_node
def test_official_generated_payload_shape(node_hub, tmp_path):
    """official_payload() 确实由官方 usage.js 处理（含规范化字段）。"""
    spec = {
        "deviceId": "dev-gen2",
        "today": {
            "totalTokens": 500,
            "outputTokens": 100,
            "cacheReadTokens": 250,
            "clients": {"claude": 500},
            "clientModels": {"claude": {"opus": 500}},
        },
    }
    payload = official_payload(spec)
    assert payload["deviceId"] == "dev-gen2"
    today = payload["periods"]["today"]
    assert today["totalTokens"] == 500
    assert today["capabilities"]["tokenComponents"] is True
    # 官方语义：客户端级拆分与 models 只保留上报值，不从总量推导
    assert today["clientCacheReads"] == {}
    assert today["unclassifiedTokens"] == 0

    cloud = make_cloud_app(tmp_path, node_hub.url)
    with cloud:
        resp = cloud.post("/api/ingest", json=payload, headers=HEADERS)
        assert resp.status_code == 200
        stats = cloud.get("/api/stats", headers=HEADERS).json()
        assert stats["periods"]["today"]["cacheReadTokens"] == 250
        assert stats["periods"]["today"]["clientModels"] == {"claude": {"opus": 500}}
