"""token-monitor ingest 载荷的严格校验（转发官方 Node hub 之前执行）。

官方 readJsonBody 只限制体积（1 MiB）；数字与结构的规范化发生在
mergeDeviceRecord 内。本层在转发前拒绝明显恶意/损坏的载荷（负数、bool、
NaN/Infinity、超 64 位、非法时区、原型污染键、数量超限、过度未来时间），
避免污染官方聚合与 SQLite 快照。任何拒绝都返回明确的 400 错误，不静默
截断。官方 merge 仍是字段语义（合并/归属/unclassified）的唯一权威。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_SAFE_INT = 2**63 - 1
MAX_COST = 1e12
MAX_FUTURE_SKEW = timedelta(hours=24)
MAX_DEPTH = 12

LIMITS = {
    "deviceId": 128,
    "hostname": 128,
    "platform": 64,
    "osName": 64,
    "osVersion": 64,
    "agentVersion": 64,
    "agentRuntime": 64,
    "generic_key": 256,
}

COUNT_LIMITS = {
    "trackedClients": 64,
    "clients": 256,
    "models": 512,
    "clientModels": 64,      # client 个数
    "sessions": 4096,
    "projects": 2048,
    "history_rows": 740,
    "limits_providers": 64,
    "subscriptions": 512,
}

PROTOTYPE_KEYS = {"__proto__", "constructor", "prototype"}
PERIOD_NAMES = ("today", "month", "allTime")
TOKEN_INT_SUFFIXES = ("tokens", "Tokens")


class PayloadValidationError(ValueError):
    pass


def _reject(message: str) -> None:
    raise PayloadValidationError(message)


def _check_int(value: Any, path: str) -> int:
    if isinstance(value, bool):
        _reject(f"{path}: 布尔值不是合法 token 数")
    if isinstance(value, float):
        if not math.isfinite(value):
            _reject(f"{path}: 非有限数值")
        if not value.is_integer():
            _reject(f"{path}: token 数必须为整数（得到 {value}）")
        value = int(value)
    if not isinstance(value, int):
        _reject(f"{path}: token 数必须是数字（得到 {type(value).__name__}）")
    if value < 0:
        _reject(f"{path}: 负数不被接受（{value}）")
    if value > MAX_SAFE_INT:
        _reject(f"{path}: 超出 64 位安全范围（{value}）")
    return value


def _check_cost(value: Any, path: str) -> None:
    if value is None:
        return
    if isinstance(value, bool):
        _reject(f"{path}: 布尔值不是合法金额")
    if not isinstance(value, (int, float)):
        _reject(f"{path}: 金额必须是数字")
    if not math.isfinite(float(value)):
        _reject(f"{path}: NaN/Infinity 不被接受")
    if float(value) < 0:
        _reject(f"{path}: 负金额不被接受")
    if float(value) > MAX_COST:
        _reject(f"{path}: 金额超出合理上限")


def _check_timestamp(value: Any, path: str, *, allow_future: timedelta) -> None:
    if not isinstance(value, str) or not value:
        return  # 缺失交给官方规范化
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        _reject(f"{path}: 非法时间戳 {value!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if dt > datetime.now(timezone.utc) + allow_future:
        _reject(f"{path}: 时间过度超前（{value}）")


def _check_tz(name: Any, path: str) -> None:
    if not isinstance(name, str) or not name:
        return
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        _reject(f"{path}: 非法 IANA 时区 {name!r}")


def _is_token_key(key: str) -> bool:
    return key.endswith(TOKEN_INT_SUFFIXES) or key in (
        "timedDurationMs", "amountMinor",
    )


def _walk(value: Any, path: str, depth: int) -> None:
    """通用遍历：深度、原型键、键长、token/金额叶子、时间戳。"""
    if depth > MAX_DEPTH:
        _reject(f"{path}: JSON 嵌套超过 {MAX_DEPTH} 层")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                _reject(f"{path}: 非字符串键 {key!r}")
            if key in PROTOTYPE_KEYS:
                _reject(f"{path}.{key}: 原型敏感键被拒绝")
            if len(key) > LIMITS["generic_key"]:
                _reject(f"{path}.{key}: 键过长（>{LIMITS['generic_key']}）")
            child = f"{path}.{key}"
            if _is_token_key(key):
                if isinstance(item, bool):
                    _reject(f"{child}: 布尔值不是合法 token 数")
                if isinstance(item, (int, float)):
                    _check_int(item, child)
                elif item is not None and not isinstance(item, (dict, list)):
                    _reject(f"{child}: token 数必须是数字")
            elif key in ("costUsd", "balanceUsd", "usedPercent"):
                _check_cost(item, child)
            elif key in ("updatedAt", "receivedAt", "resetsAt", "startedAt", "lastUsedAt", "date"):
                if key in ("updatedAt", "receivedAt"):
                    _check_timestamp(item, child, allow_future=MAX_FUTURE_SKEW)
            _walk(item, child, depth + 1)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _walk(item, f"{path}[{i}]", depth + 1)
    elif isinstance(value, float):
        if not math.isfinite(value):
            _reject(f"{path}: NaN/Infinity 不被接受")


def _periods_of(payload: dict) -> dict:
    periods = payload.get("periods") if isinstance(payload.get("periods"), dict) else {}
    out = {}
    for name in PERIOD_NAMES:
        raw = payload.get(name)
        out[name] = raw if isinstance(raw, dict) else periods.get(name)
    return out


def _count_dict(value: Any) -> int:
    return len(value) if isinstance(value, dict) else 0


def validate_ingest_payload(payload: Any) -> dict:
    """入口：校验失败抛 PayloadValidationError（路由转 400）。"""
    if not isinstance(payload, dict):
        _reject("请求体必须是 JSON 对象")

    device_id = payload.get("deviceId") or payload.get("id")
    if not isinstance(device_id, str) or not device_id.strip():
        _reject("缺少有效 deviceId")
    if len(device_id) > LIMITS["deviceId"]:
        _reject(f"deviceId 过长（>{LIMITS['deviceId']}）")
    for field in ("hostname", "platform", "osName", "osVersion", "agentVersion", "agentRuntime"):
        value = payload.get(field)
        if value is not None and not isinstance(value, str):
            _reject(f"{field}: 必须是字符串")
        if isinstance(value, str) and len(value) > LIMITS[field]:
            _reject(f"{field}: 过长（>{LIMITS[field]}）")

    tracked = payload.get("trackedClients")
    if tracked is not None:
        if not isinstance(tracked, list) or len(tracked) > COUNT_LIMITS["trackedClients"]:
            _reject(f"trackedClients 必须是不超过 {COUNT_LIMITS['trackedClients']} 项的数组")
        for name in tracked:
            if not isinstance(name, str) or len(name) > LIMITS["generic_key"]:
                _reject("trackedClients 条目必须是短字符串")

    periods = _periods_of(payload)
    for name, period in periods.items():
        if period is None:
            continue
        if not isinstance(period, dict):
            _reject(f"{name}: 周期必须是对象")
        if _count_dict(period.get("clients")) > COUNT_LIMITS["clients"]:
            _reject(f"{name}.clients 超过 {COUNT_LIMITS['clients']} 项")
        if _count_dict(period.get("models")) > COUNT_LIMITS["models"]:
            _reject(f"{name}.models 超过 {COUNT_LIMITS['models']} 项")
        client_models = period.get("clientModels")
        if isinstance(client_models, dict) and len(client_models) > COUNT_LIMITS["clientModels"]:
            _reject(f"{name}.clientModels 客户端数超过 {COUNT_LIMITS['clientModels']}")
        sessions = period.get("sessions")
        if isinstance(sessions, dict) and len(sessions) > COUNT_LIMITS["sessions"]:
            _reject(f"{name}.sessions 超过 {COUNT_LIMITS['sessions']} 项")
        projects = period.get("projects")
        if isinstance(projects, dict) and len(projects) > COUNT_LIMITS["projects"]:
            _reject(f"{name}.projects 超过 {COUNT_LIMITS['projects']} 项")

    windows = payload.get("periodWindows")
    if isinstance(windows, dict):
        _check_tz(windows.get("timeZone"), "periodWindows.timeZone")
        for name in PERIOD_NAMES[:2]:
            window = windows.get(name)
            if isinstance(window, dict):
                key = window.get("key")
                if key is not None and not isinstance(key, str):
                    _reject(f"periodWindows.{name}.key 必须是字符串")
                _check_timestamp(
                    window.get("endsAt"), f"periodWindows.{name}.endsAt",
                    allow_future=timedelta(days=45),
                )

    history = payload.get("history")
    if isinstance(history, dict):
        daily = history.get("daily")
        if isinstance(daily, list) and len(daily) > COUNT_LIMITS["history_rows"]:
            _reject(f"history.daily 超过 {COUNT_LIMITS['history_rows']} 行")

    limits_raw = payload.get("limits")
    if isinstance(limits_raw, dict):
        providers = limits_raw.get("providers")
        if isinstance(providers, list) and len(providers) > COUNT_LIMITS["limits_providers"]:
            _reject(f"limits.providers 超过 {COUNT_LIMITS['limits_providers']} 项")

    _check_timestamp(payload.get("updatedAt"), "updatedAt", allow_future=MAX_FUTURE_SKEW)
    _walk(payload, "$", 0)
    return payload


def is_limits_only_update(payload: dict) -> bool:
    """仅 limits / 订阅类更新：不产生 token 历史点。"""
    if not isinstance(payload, dict):
        return False
    periods = _periods_of(payload)
    has_usage = any(isinstance(p, dict) for p in periods.values())
    has_limits = isinstance(payload.get("limits"), dict)
    return has_limits and not has_usage
