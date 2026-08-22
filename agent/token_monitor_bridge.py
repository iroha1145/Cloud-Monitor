"""可选桥接: 把本地 OpenWebUI 用量摘要推送到 token-monitor 的 hub（多设备同步）。

数据流:
    本地 monitor GET /api/v1/usage  →  token-monitor hub POST /api/ingest

payload 遵循 token-monitor 的设备摘要 wire format（见其 src/agent/agent.js 与
tests/hub/server.test.js）: deviceId + today/month/allTime 三个周期，每个周期含
totalTokens / costUsd / clients / clientCosts。hub 端会保留未识别字段，因此
额外附带 perModel 明细不会破坏兼容性。OpenWebUI-Monitor 不计费，costUsd 恒为 0。
"""

from __future__ import annotations

import json
import logging
import os
import platform as _platform
import socket
import threading
import time
from datetime import datetime
from typing import Any, Optional

import requests

from sync_agent import AGENT_VERSION, AgentConfig, SyncAgent

log = logging.getLogger("token-monitor-bridge")

INGEST_PATH = "/api/ingest"
DEFAULT_INTERVAL_SECONDS = 300.0


def _local_now() -> datetime:
    return datetime.now().astimezone()


def _period_bounds(now: datetime, period: str) -> tuple[Optional[datetime], datetime]:
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:  # allTime — hub 只需要完整基线，不限起始时间
        start = None
    return start, now


def _period_payload(agent: SyncAgent, start: Optional[datetime], end: datetime) -> dict:
    params: dict[str, Any] = {"end_time": end.isoformat(timespec="seconds")}
    if start is not None:
        params["start_time"] = start.isoformat(timespec="seconds")
    usage = agent.local_get("/api/v1/usage", params)
    totals = usage.get("totals") or {}
    per_model = {
        row.get("model_name") or "unknown": int(row.get("total_tokens") or 0)
        for row in usage.get("by_model") or []
    }
    total_tokens = int(totals.get("total_tokens") or 0)
    return {
        "totalTokens": total_tokens,
        "costUsd": 0,
        "clients": {"openwebui": total_tokens},
        "clientCosts": {},
        "perModel": per_model,
    }


def build_ingest_payload(agent: SyncAgent, config: AgentConfig) -> dict:
    now = _local_now()
    payload: dict[str, Any] = {
        "deviceId": config.device_id,
        "hostname": socket.gethostname() or "local",
        "platform": config.platform or (_platform.system().lower() or "unknown"),
        "agentVersion": AGENT_VERSION,
        "agentRuntime": "headless-agent",
        "trackedClients": ["openwebui"],
        "projectsEnabled": False,
        "historyAvailable": False,
        "syncUploadIntervalMs": int(_interval_seconds() * 1000),
    }
    for period in ("today", "month", "allTime"):
        start, end = _period_bounds(now, period)
        payload[period] = _period_payload(agent, start, end)
    return payload


def _interval_seconds() -> float:
    try:
        return max(float(os.environ.get("TOKEN_MONITOR_INTERVAL_SECONDS") or DEFAULT_INTERVAL_SECONDS), 30.0)
    except ValueError:
        return DEFAULT_INTERVAL_SECONDS


def push_to_token_monitor(
    agent: SyncAgent,
    hub_url: str,
    secret: str,
) -> dict:
    payload = build_ingest_payload(agent, agent.config)
    resp = requests.post(
        f"{hub_url.rstrip('/')}{INGEST_PATH}",
        json=payload,
        headers={
            "Authorization": f"Bearer {secret}",
            "X-Token-Monitor-Secret": secret,
            "content-type": "application/json",
        },
        timeout=agent.config.request_timeout_seconds,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"token-monitor hub 响应 {resp.status_code}: {resp.text[:300]}")
    return {
        "today": payload["today"]["totalTokens"],
        "month": payload["month"]["totalTokens"],
        "allTime": payload["allTime"]["totalTokens"],
    }


def start_bridge_thread(agent: SyncAgent) -> Optional[threading.Thread]:
    """配置了 TOKEN_MONITOR_HUB_URL 与 TOKEN_MONITOR_SECRET 时启动后台推送线程。"""
    hub_url = (os.environ.get("TOKEN_MONITOR_HUB_URL") or "").strip()
    secret = (os.environ.get("TOKEN_MONITOR_SECRET") or "").strip()
    if not hub_url or not secret:
        log.info("未配置 TOKEN_MONITOR_HUB_URL / TOKEN_MONITOR_SECRET，桥接停用")
        return None

    interval = _interval_seconds()

    def loop() -> None:
        while True:
            try:
                summary = push_to_token_monitor(agent, hub_url, secret)
                log.info("已推送 token-monitor 摘要: %s", json.dumps(summary))
            except (requests.RequestException, RuntimeError, ValueError) as exc:
                log.warning("token-monitor 推送失败（不影响主同步）: %s", exc)
            time.sleep(interval)

    thread = threading.Thread(target=loop, name="token-monitor-bridge", daemon=True)
    thread.start()
    log.info("token-monitor 桥接已启动: hub=%s interval=%ss", hub_url, interval)
    return thread
