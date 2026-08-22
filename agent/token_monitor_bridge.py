"""可选桥接 v2: 把本地 OpenWebUI 用量摘要推送到 token-monitor 的 hub。

v2 相对 v1 的协议修正（依据 token-monitor @5be24d3 源码核对）:
- 周期对象不再携带杜撰的 perModel；使用标准字段 models / modelCosts /
  modelOutputs / modelUnclassifiedTokens，以及 client 级别的 clientModels /
  clientModelCosts / clientOutputs / clientUnclassifiedTokens。
- Cloud Monitor 只知道 input/output，不知道缓存读写：
  totalTokens = input + output，outputTokens = output，
  unclassifiedTokens = input，capabilities.tokenComponents = false。
- 增加 updatedAt（UTC ISO）与 periodWindows（按 TIME_ZONE 计算本地
  today/month 边界，默认 Asia/Tokyo，使用 zoneinfo）。
- 设备 ID 使用独立的 TOKEN_MONITOR_DEVICE_ID，默认 openwebui:<device-id>，
  避免与真正的 token-monitor agent 互相覆盖。
- hostname/platform 来自 DEVICE_NAME / HOST_PLATFORM，不用容器值。
- 启动时先请求 /api/health 校验 ok 与 role；上游 4xx 禁用桥接，5xx 照常重试。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

import requests

from sync_agent import AGENT_VERSION, AgentConfig, SyncAgent, utc_now_iso

log = logging.getLogger("token-monitor-bridge")

INGEST_PATH = "/api/ingest"
HEALTH_PATH = "/api/health"
CLIENT = "openwebui"


class PermanentBridgeError(Exception):
    """上游 4xx：payload/配置问题，重试无意义。"""


class TransientBridgeError(Exception):
    """上游 5xx 或网络错误：下个周期重试。"""


# ---------------------------------------------------------------- 时区边界


def _period_bounds(now_local: datetime) -> dict[str, dict[str, Any]]:
    """按本地时区计算 today/month 的 key、起点与 endsAt（下一周期起点，UTC ISO）。"""
    tz = now_local.tzinfo
    today_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    next_month = (month_start + timedelta(days=32)).replace(day=1)
    return {
        "today": {
            "start": today_start,
            "key": today_start.date().isoformat(),
            "endsAt": (today_start + timedelta(days=1))
            .astimezone(timezone.utc)
            .isoformat(timespec="seconds"),
        },
        "month": {
            "start": month_start,
            "key": month_start.strftime("%Y-%m"),
            "endsAt": next_month.astimezone(timezone.utc).isoformat(timespec="seconds"),
        },
    }


# ---------------------------------------------------------------- payload


def _period_payload(agent: SyncAgent, start: Optional[datetime], end: datetime) -> dict:
    params: dict[str, Any] = {"end_time": end.isoformat(timespec="seconds")}
    if start is not None:
        params["start_time"] = start.isoformat(timespec="seconds")
    usage = agent.local_get("/api/v1/usage", params)
    totals = usage.get("totals") or {}
    input_tokens = int(totals.get("input_tokens") or 0)
    output_tokens = int(totals.get("output_tokens") or 0)
    total = int(totals.get("total_tokens") or (input_tokens + output_tokens))

    models: dict[str, int] = {}
    model_outputs: dict[str, int] = {}
    model_unclassified: dict[str, int] = {}
    for row in usage.get("by_model") or []:
        name = str(row.get("model_name") or "unknown")
        models[name] = int(row.get("total_tokens") or 0)
        model_outputs[name] = int(row.get("output_tokens") or 0)
        model_unclassified[name] = int(row.get("input_tokens") or 0)

    updated = utc_now_iso()
    return {
        "totalTokens": total,
        "outputTokens": output_tokens,
        "unclassifiedTokens": input_tokens,
        "costUsd": 0,
        "updatedAt": updated,
        "clients": {CLIENT: total},
        "clientOutputs": {CLIENT: output_tokens},
        "clientUnclassifiedTokens": {CLIENT: input_tokens},
        "clientCosts": {},
        "models": models,
        "modelOutputs": model_outputs,
        "modelUnclassifiedTokens": model_unclassified,
        "modelCosts": {},
        "clientModels": {CLIENT: models},
        "clientModelCosts": {CLIENT: {}},
    }


def resolve_tm_device_id(config: AgentConfig) -> Optional[str]:
    """桥接设备 ID：显式配置优先；默认 openwebui: 前缀；与 Cloud ID 相同则拒绝。"""
    device_id = config.device_id or ""
    tm_id = config.token_monitor_device_id or f"{CLIENT}:{device_id}"
    if tm_id == device_id and device_id:
        log.error(
            "TOKEN_MONITOR_DEVICE_ID (%s) 与 Cloud 设备 ID 相同，"
            "会覆盖真正的 token-monitor 设备，桥接拒绝启动",
            tm_id,
        )
        return None
    return tm_id


def build_ingest_payload(agent: SyncAgent, config: AgentConfig, now: Optional[datetime] = None) -> dict:
    tz = ZoneInfo(config.time_zone)
    now_local = now or datetime.now(tz)
    bounds = _period_bounds(now_local.astimezone(tz))
    now_utc = now_local.astimezone(timezone.utc)

    payload: dict[str, Any] = {
        "deviceId": resolve_tm_device_id(config),
        "hostname": config.device_name,
        "platform": config.host_platform,
        "agentVersion": AGENT_VERSION,
        "agentRuntime": "headless-agent",
        "trackedClients": [CLIENT],
        "projectsEnabled": False,
        "historyAvailable": False,
        "syncUploadIntervalMs": int(config.token_monitor_interval_seconds * 1000),
        "capabilities": {"tokenComponents": False},
        "updatedAt": now_utc.isoformat(timespec="seconds"),
        "periodWindows": {
            "timeZone": str(tz),
            "today": {"key": bounds["today"]["key"], "endsAt": bounds["today"]["endsAt"]},
            "month": {"key": bounds["month"]["key"], "endsAt": bounds["month"]["endsAt"]},
        },
    }
    payload["today"] = _period_payload(agent, bounds["today"]["start"], now_utc)
    payload["month"] = _period_payload(agent, bounds["month"]["start"], now_utc)
    payload["allTime"] = _period_payload(agent, None, now_utc)
    return payload


# ---------------------------------------------------------------- 推送


def check_hub_health(session: requests.Session, hub_url: str, timeout: float) -> dict:
    """启动前健康检查：验证 ok 与 role，记录 hubBuild。"""
    resp = session.get(f"{hub_url.rstrip('/')}{HEALTH_PATH}", timeout=timeout)
    if resp.status_code >= 500:
        raise TransientBridgeError(f"hub health HTTP {resp.status_code}")
    if resp.status_code >= 400:
        raise PermanentBridgeError(f"hub health HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise PermanentBridgeError(f"hub health 响应不是 JSON: {exc}") from exc
    if body.get("ok") is not True:
        raise PermanentBridgeError(f"hub health 返回 ok={body.get('ok')!r}")
    role = body.get("role")
    hub_build = body.get("hubBuild")
    log.info(
        "token-monitor hub 健康: role=%s hubBuild=%s deviceCount=%s",
        role,
        json.dumps(hub_build)[:120] if hub_build else "n/a",
        body.get("deviceCount"),
    )
    return body


def push_to_token_monitor(
    agent: SyncAgent,
    hub_url: str,
    secret: str,
    *,
    now: Optional[datetime] = None,
    session: Optional[requests.Session] = None,
) -> dict:
    session = session or agent.session
    payload = build_ingest_payload(agent, agent.config, now=now)
    resp = session.post(
        f"{hub_url.rstrip('/')}{INGEST_PATH}",
        json=payload,
        headers={
            "Authorization": f"Bearer {secret}",
            "X-Token-Monitor-Secret": secret,
            "content-type": "application/json",
        },
        timeout=agent.config.request_timeout_seconds,
    )
    if 400 <= resp.status_code < 500:
        raise PermanentBridgeError(
            f"token-monitor hub 拒绝 HTTP {resp.status_code}: {resp.text[:300]}"
        )
    if resp.status_code >= 500:
        raise TransientBridgeError(f"token-monitor hub HTTP {resp.status_code}")
    return {
        "today": payload["today"]["totalTokens"],
        "month": payload["month"]["totalTokens"],
        "allTime": payload["allTime"]["totalTokens"],
    }


def start_bridge_thread(agent: SyncAgent) -> Optional[threading.Thread]:
    """配置齐全且通过健康检查时启动后台推送线程；4xx 后自动停用。"""
    config = agent.config
    if not config.token_monitor_hub_url or not config.token_monitor_secret:
        log.info("未配置 TOKEN_MONITOR_HUB_URL / TOKEN_MONITOR_SECRET，桥接停用")
        return None
    tm_device_id = resolve_tm_device_id(config)
    if tm_device_id is None:
        return None

    try:
        check_hub_health(agent.session, config.token_monitor_hub_url, config.request_timeout_seconds)
    except PermanentBridgeError as exc:
        log.error("token-monitor 桥接未启动（健康检查失败，判定为永久错误）: %s", exc)
        return None
    except TransientBridgeError as exc:
        log.warning("token-monitor hub 暂不可达，桥接稍后随周期重试: %s", exc)

    interval = config.token_monitor_interval_seconds
    disabled = threading.Event()

    def loop() -> None:
        while not disabled.is_set():
            try:
                summary = push_to_token_monitor(
                    agent, config.token_monitor_hub_url, config.token_monitor_secret
                )
                log.info("已推送 token-monitor 摘要: %s", json.dumps(summary))
            except PermanentBridgeError as exc:
                log.error("token-monitor 桥接因 4xx 永久停用: %s", exc)
                disabled.set()
            except (TransientBridgeError, requests.RequestException, ValueError) as exc:
                log.warning("token-monitor 推送失败（下个周期重试）: %s", exc)
            disabled.wait(interval)

    thread = threading.Thread(target=loop, name="token-monitor-bridge", daemon=True)
    thread.start()
    log.info(
        "token-monitor 桥接已启动: hub=%s device=%s interval=%ss tz=%s",
        config.token_monitor_hub_url,
        tm_device_id,
        interval,
        config.time_zone,
    )
    return thread
