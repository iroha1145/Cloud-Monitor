"""Cloud 扩展：GET /api/v1/tm/provider-status。

官方 tm-core 协议不含此端点。本模块只向固定 allowlist 的 Atlassian
Statuspage 拉取 summary.json（失败再回退 status.json），用已有
httpx.AsyncClient 并发请求，带 in-memory stale-while-revalidate 与
singleflight。客户端不能传 URL（防 SSRF）。外部状态页失败不得影响
Overview / Token ingest。

不记录账户、密钥或完整请求 Header。
"""

from __future__ import annotations

import asyncio
import copy
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

import httpx

log = logging.getLogger("tm-provider-status")

SCHEMA_VERSION = 1
TOTAL_BUDGET_SECONDS = 3.0

# 客户端 / 提供商名 → 状态页 canonical。claude/codex 不得因 STATUS_PAGES
# 只写 anthropic/openai 而消失。GLM/智谱暂无官方 Statuspage，故不建卡。
PROVIDER_ALIASES: dict[str, str] = {
    "claude": "anthropic",
    "anthropic": "anthropic",
    "codex": "openai",
    "openai": "openai",
    "cursor": "cursor",
    "deepseek": "deepseek",
    "kimi": "kimi",
    "moonshot": "kimi",
    "glm": "glm",
    "zhipu": "glm",
    "zai": "glm",
    "chatglm": "glm",
}

_STATUS_RANK = {
    "operational": 0,
    "unknown": 1,
    "degraded": 2,
    "maintenance": 3,
    "outage": 4,
}

_COMPONENT_STATUS = {
    "operational": "operational",
    "degraded_performance": "degraded",
    "partial_outage": "degraded",
    "major_outage": "outage",
    "under_maintenance": "maintenance",
}

_INDICATOR_STATUS = {
    "none": "operational",
    "minor": "degraded",
    "major": "outage",
    "critical": "outage",
    "maintenance": "maintenance",
}


@dataclass(frozen=True)
class StatusPage:
    canonical: str
    name: str
    public_url: str
    summary_url: str
    status_url: str
    prefer: tuple[re.Pattern[str], ...]
    exclude: tuple[re.Pattern[str], ...]


def _rx(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(p, re.IGNORECASE) for p in patterns)


STATUS_PAGES: dict[str, StatusPage] = {
    "anthropic": StatusPage(
        canonical="anthropic",
        name="Anthropic",
        public_url="https://status.claude.com",
        summary_url="https://status.claude.com/api/v2/summary.json",
        status_url="https://status.claude.com/api/v2/status.json",
        prefer=_rx(r"claude\s*api", r"anthropic\s*api", r"claude\s*code", r"^api$"),
        exclude=_rx(r"claude\.ai", r"^claude$", r"console", r"docs"),
    ),
    "openai": StatusPage(
        canonical="openai",
        name="OpenAI",
        public_url="https://status.openai.com",
        summary_url="https://status.openai.com/api/v2/summary.json",
        status_url="https://status.openai.com/api/v2/status.json",
        prefer=_rx(r"^api$", r"openai\s*api", r"chatgpt\s*api", r"api\s*platform", r"codex"),
        exclude=_rx(
            r"^chatgpt$",
            r"chatgpt\s*(web|ios|android|mac|desktop|app)",
            r"chat\.openai",
            r"playground",
            r"^sora$",
        ),
    ),
    "cursor": StatusPage(
        canonical="cursor",
        name="Cursor",
        public_url="https://status.cursor.com",
        summary_url="https://status.cursor.com/api/v2/summary.json",
        status_url="https://status.cursor.com/api/v2/status.json",
        prefer=_rx(r"^api$", r"cursor\s*api", r"\bapi\b", r"agent", r"tab"),
        exclude=_rx(r"^website$", r"^marketing$", r"docs"),
    ),
    # 正式站 status.deepseek.com 已迁 Flashduty，且对非浏览器 TLS 会 RST；
    # 仍提供 Atlassian 镜像（summary.json），页面入口继续指向正式站。
    "deepseek": StatusPage(
        canonical="deepseek",
        name="DeepSeek",
        public_url="https://status.deepseek.com",
        summary_url="https://deepseek.statuspage.io/api/v2/summary.json",
        status_url="https://deepseek.statuspage.io/api/v2/status.json",
        prefer=_rx(r"api\s*service", r"^api$"),
        exclude=_rx(r"web\s*chat", r"网页对话"),
    ),
    "kimi": StatusPage(
        canonical="kimi",
        name="Kimi",
        public_url="https://status.moonshot.cn",
        summary_url="https://status.moonshot.cn/api/v2/summary.json",
        status_url="https://status.moonshot.cn/api/v2/status.json",
        prefer=_rx(r"open\s*api", r"api\s*service", r"^api$", r"\bmodel\b"),
        exclude=_rx(r"^kimi$", r"^website$", r"sign\s*in", r"saas", r"portal"),
    ),
}

ALLOWED_FETCH_URLS: frozenset[str] = frozenset(
    url
    for page in STATUS_PAGES.values()
    for url in (page.summary_url, page.status_url)
)


def utc_now_z() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _canonical_from_usage_name(key: str) -> Optional[str]:
    """模型名 / 复合客户端名 → canonical。无状态页的厂商（如 GLM）返回 None。"""
    if key in PROVIDER_ALIASES:
        canon = PROVIDER_ALIASES[key]
        return canon if canon in STATUS_PAGES else None
    if "claude" in key or "anthropic" in key or "sonnet" in key or "opus" in key or "haiku" in key:
        return "anthropic"
    if "gpt" in key or "openai" in key or "chatgpt" in key or "codex" in key:
        return "openai"
    if re.search(r"(?:^|[^a-z])o[1-9](?:[-.]|$)", key):
        return "openai"
    if "deepseek" in key:
        return "deepseek"
    if "kimi" in key or "moonshot" in key:
        return "kimi"
    if key == "cursor" or key.startswith("cursor-"):
        return "cursor"
    return None


def canonical_provider(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    key = raw.strip().lower()
    if not key:
        return None
    return _canonical_from_usage_name(key)


def _has_today_usage(val: Any) -> bool:
    if val is None:
        return False
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val > 0
    if isinstance(val, dict):
        for field in ("totalTokens", "tokens", "total"):
            if field in val:
                try:
                    return float(val[field] or 0) > 0
                except (TypeError, ValueError):
                    return False
        return True
    return True


def discover_providers(
    stats: Optional[dict],
    subscriptions: Optional[Iterable[Any]] = None,
    *,
    extra_client_names: Optional[Iterable[str]] = None,
) -> dict[str, list[str]]:
    """只收集今日有上报的提供商：periods.today.clients / today.models。

    订阅清单与配额窗口不再单独出卡——今日用量里没出现则不显示。
    extra_client_names 仅供测试注入。subscriptions 保留签名兼容，忽略。
    """
    del subscriptions  # 今日上报口径，不用订阅清单凑卡
    observed: dict[str, list[str]] = {k: [] for k in STATUS_PAGES}

    def add(raw: Any) -> None:
        if not isinstance(raw, str) or not raw.strip():
            return
        name = raw.strip()
        canon = canonical_provider(name)
        if canon is None or canon not in observed:
            return
        bucket = observed[canon]
        if name not in bucket:
            bucket.append(name)

    periods = (stats or {}).get("periods") if isinstance(stats, dict) else None
    today = periods.get("today") if isinstance(periods, dict) else None
    if isinstance(today, dict):
        clients = today.get("clients")
        if isinstance(clients, dict):
            for key, val in clients.items():
                if _has_today_usage(val):
                    add(key)
        models = today.get("models")
        if isinstance(models, dict):
            for key, val in models.items():
                if _has_today_usage(val):
                    add(key)

    if extra_client_names:
        for name in extra_client_names:
            add(name)

    return {k: v for k, v in observed.items() if v}


def _match_any(name: str, patterns: tuple[re.Pattern[str], ...]) -> bool:
    return any(p.search(name) for p in patterns)


def _component_name(component: dict) -> str:
    return str(component.get("name") or "")


def _pick_components(page: StatusPage, components: list[dict]) -> tuple[list[dict], str]:
    """优先 API / Claude Code / Cursor 相关组件，排除 ChatGPT 网页等。"""
    preferred: list[dict] = []
    excluded: list[dict] = []
    other: list[dict] = []
    for component in components:
        if not isinstance(component, dict):
            continue
        name = _component_name(component)
        if not name:
            continue
        is_pref = _match_any(name, page.prefer)
        is_excl = _match_any(name, page.exclude)
        if is_pref and not is_excl:
            preferred.append(component)
        elif is_excl and not is_pref:
            excluded.append(component)
        else:
            other.append(component)
    if preferred:
        return preferred, "preferred"
    if other:
        return other, "other"
    if excluded:
        # 只有被排除的组件（例如仅 ChatGPT 网页）：不要把 API 标成中断
        return [], "excluded_only"
    return [], "none"


def _status_from_component(component: dict) -> str:
    raw = str(component.get("status") or "").strip().lower()
    return _COMPONENT_STATUS.get(raw, "unknown")


def _status_from_indicator(indicator: Any) -> str:
    raw = str(indicator or "").strip().lower()
    return _INDICATOR_STATUS.get(raw, "unknown")


def _worse(a: str, b: str) -> str:
    return a if _STATUS_RANK.get(a, 1) >= _STATUS_RANK.get(b, 1) else b


def parse_status_payload(page: StatusPage, payload: Any) -> dict[str, Any]:
    """解析 Statuspage summary/status JSON → 面板 status 字段。"""
    if not isinstance(payload, dict):
        return {
            "status": "unknown",
            "description": "invalid status payload",
            "source_updated_at": None,
            "error_code": "invalid_json",
        }

    page_meta = payload.get("page") if isinstance(payload.get("page"), dict) else {}
    overall = payload.get("status") if isinstance(payload.get("status"), dict) else {}
    source_updated = page_meta.get("updated_at") or overall.get("updated_at")
    description = str(overall.get("description") or "").strip() or None
    indicator_status = _status_from_indicator(overall.get("indicator"))

    components = payload.get("components")
    chosen: list[dict] = []
    pick_kind = "indicator"
    if isinstance(components, list) and components:
        chosen, pick_kind = _pick_components(page, [c for c in components if isinstance(c, dict)])

    if pick_kind == "excluded_only":
        # ChatGPT 网页故障不得必然把 OpenAI API 标成中断
        status = "operational"
        description = description or "API component not listed; page-level incidents ignored"
    elif chosen:
        status = "operational"
        for component in chosen:
            status = _worse(status, _status_from_component(component))
            updated = component.get("updated_at")
            if updated:
                source_updated = updated
        if not description:
            names = ", ".join(_component_name(c) for c in chosen[:3])
            description = f"{names}: {status}"
    else:
        status = indicator_status if indicator_status != "unknown" else "unknown"
        if not description:
            description = str(overall.get("description") or status)

    return {
        "status": status,
        "description": description,
        "source_updated_at": source_updated if isinstance(source_updated, str) else None,
        "error_code": None,
    }


def _unknown_entry(
    page: StatusPage,
    observed_as: list[str],
    *,
    error_code: str,
    description: str,
    checked_at: str,
    stale: bool = False,
) -> dict[str, Any]:
    return {
        "provider": page.canonical,
        "observed_as": list(observed_as),
        "name": page.name,
        "status": "unknown",
        "description": description,
        "checked_at": checked_at,
        "source_updated_at": None,
        "stale": stale,
        "error_code": error_code,
        "url": page.public_url,
    }


def _ok_entry(
    page: StatusPage,
    observed_as: list[str],
    parsed: dict[str, Any],
    *,
    checked_at: str,
    stale: bool = False,
) -> dict[str, Any]:
    return {
        "provider": page.canonical,
        "observed_as": list(observed_as),
        "name": page.name,
        "status": parsed["status"],
        "description": parsed.get("description"),
        "checked_at": checked_at,
        "source_updated_at": parsed.get("source_updated_at"),
        "stale": stale,
        "error_code": parsed.get("error_code"),
        "url": page.public_url,
    }


def _safe_url(url: str) -> str:
    if url not in ALLOWED_FETCH_URLS:
        raise ValueError(f"refusing non-allowlisted status URL: {url!r}")
    return url


async def _get_json(
    client: httpx.AsyncClient,
    url: str,
    timeout: float,
) -> tuple[Optional[dict], Optional[str]]:
    _safe_url(url)
    try:
        response = await client.get(url, timeout=timeout)
    except httpx.TimeoutException:
        log.warning("provider-status timeout url_host=%s", httpx.URL(url).host)
        return None, "timeout"
    except httpx.HTTPError as exc:
        log.warning("provider-status network error url_host=%s err=%s", httpx.URL(url).host, type(exc).__name__)
        return None, "network"
    if response.status_code != 200:
        log.warning(
            "provider-status non-200 url_host=%s status=%s",
            httpx.URL(url).host,
            response.status_code,
        )
        return None, "http_status"
    try:
        data = response.json()
    except ValueError:
        log.warning("provider-status invalid json url_host=%s", httpx.URL(url).host)
        return None, "invalid_json"
    if not isinstance(data, dict):
        return None, "invalid_json"
    return data, None


async def fetch_one_provider(
    client: httpx.AsyncClient,
    page: StatusPage,
    *,
    timeout: float,
) -> tuple[dict[str, Any], Optional[str]]:
    """summary.json 优先；仅在快速失败（非 timeout）时回退 status.json。"""
    payload, error = await _get_json(client, page.summary_url, timeout)
    if payload is not None:
        return parse_status_payload(page, payload), None
    if error == "timeout":
        return {}, "timeout"
    payload, error2 = await _get_json(client, page.status_url, timeout)
    if payload is not None:
        return parse_status_payload(page, payload), None
    return {}, error2 or error or "network"


async def fetch_provider_statuses(
    client: httpx.AsyncClient,
    observed: dict[str, list[str]],
    *,
    timeout_seconds: float,
    budget_seconds: float = TOTAL_BUDGET_SECONDS,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """并发拉取 allowlist 状态页。总预算默认 3s，不得串行 3×5s。"""
    checked_at = utc_now_z()
    timeout = min(max(float(timeout_seconds), 0.1), budget_seconds)
    canonicals = [c for c in STATUS_PAGES if c in observed]
    if not canonicals:
        return [], []

    async def _one(canon: str) -> tuple[str, dict[str, Any], Optional[str]]:
        page = STATUS_PAGES[canon]
        try:
            # asyncio.wait_for 而非 asyncio.timeout：后者是 3.11+ API，系统
            # Python 3.9 起服时会 AttributeError 导致所有 provider 恒 unknown
            parsed, error = await asyncio.wait_for(
                fetch_one_provider(client, page, timeout=timeout), timeout
            )
            return canon, parsed, error
        except asyncio.TimeoutError:
            return canon, {}, "timeout"

    try:
        rows = await asyncio.wait_for(
            asyncio.gather(*[_one(c) for c in canonicals], return_exceptions=True),
            budget_seconds,
        )
    except asyncio.TimeoutError:
        rows = [(c, {}, "timeout") for c in canonicals]

    providers: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for expected_canon, row in zip(canonicals, rows):
        if isinstance(row, BaseException):
            log.warning("provider-status gather error err=%s", type(row).__name__)
            canon, parsed, error = expected_canon, {}, "internal_error"
        else:
            canon, parsed, error = row
        page = STATUS_PAGES[canon]
        names = observed.get(canon) or [canon]
        if error or not parsed:
            code = error or "unknown"
            providers.append(
                _unknown_entry(
                    page,
                    names,
                    error_code=code,
                    description=f"status page {code}",
                    checked_at=checked_at,
                )
            )
            errors.append({"provider": canon, "error_code": code})
            continue
        providers.append(_ok_entry(page, names, parsed, checked_at=checked_at))
    return providers, errors


def empty_envelope(*, generated_at: Optional[str] = None) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or utc_now_z(),
        "providers": [],
        "partial": False,
        "errors": [],
    }


def assemble_envelope(
    providers: list[dict[str, Any]],
    errors: list[dict[str, str]],
    *,
    generated_at: Optional[str] = None,
    stale: bool = False,
) -> dict[str, Any]:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or utc_now_z(),
        "providers": providers,
        "partial": bool(errors) or any(p.get("status") == "unknown" for p in providers),
        "errors": errors,
    }
    if stale:
        for item in payload["providers"]:
            item["stale"] = True
    return payload


@dataclass
class _CacheEntry:
    fetched_at: float
    key: tuple[tuple[str, tuple[str, ...]], ...]
    payload: dict[str, Any]


def _observed_key(
    observed: dict[str, list[str]],
) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """缓存键包含 canonical 与 observed_as，避免别名展示陈旧。"""
    return tuple(
        sorted(
            (canonical, tuple(sorted(set(names))))
            for canonical, names in observed.items()
        )
    )


class ProviderStatusService:
    """进程内缓存：fresh 直返；过期立即返 stale 并后台刷新；无缓存才等待。"""

    def __init__(
        self,
        *,
        cache_seconds: int = 300,
        timeout_seconds: float = 2.5,
        budget_seconds: float = TOTAL_BUDGET_SECONDS,
        monotonic: Any = time.monotonic,
    ) -> None:
        self.cache_seconds = max(int(cache_seconds), 0)
        self.timeout_seconds = float(timeout_seconds)
        self.budget_seconds = float(budget_seconds)
        self._monotonic = monotonic
        # Lock 延迟到事件循环内首次使用时创建：3.9 的 Lock() 在构造期绑定
        # 当前事件循环，而本服务在 create_app（无运行循环）里构造
        self._lock: Optional[asyncio.Lock] = None
        self._inflight: Optional[asyncio.Task] = None
        self._inflight_key: Optional[tuple[tuple[str, tuple[str, ...]], ...]] = None
        self._cache: Optional[_CacheEntry] = None
        self.fetch_count = 0

    def _mark_stale(self, payload: dict[str, Any], stale: bool) -> dict[str, Any]:
        cloned = copy.deepcopy(payload)
        for item in cloned.get("providers") or []:
            if isinstance(item, dict):
                item["stale"] = stale
        return cloned

    async def snapshot(
        self,
        *,
        client: httpx.AsyncClient,
        observed: dict[str, list[str]],
        wait_for_refresh: bool = True,
    ) -> dict[str, Any]:
        key = _observed_key(observed)
        now = self._monotonic()
        cache = self._cache
        if (
            cache is not None
            and cache.key == key
            and (now - cache.fetched_at) < self.cache_seconds
        ):
            return self._mark_stale(cache.payload, False)

        if cache is not None and cache.key == key:
            self._spawn_refresh(client, observed, key)
            return self._mark_stale(cache.payload, True)

        if not wait_for_refresh:
            self._spawn_refresh(client, observed, key)
            if cache is not None:
                return self._mark_stale(cache.payload, True)
            return assemble_envelope([], [], generated_at=utc_now_z())

        return await self._refresh_wait(client, observed, key)

    def _spawn_refresh(
        self,
        client: httpx.AsyncClient,
        observed: dict[str, list[str]],
        key: tuple[tuple[str, tuple[str, ...]], ...],
    ) -> None:
        if self._inflight is not None and not self._inflight.done() and self._inflight_key == key:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._inflight = loop.create_task(self._do_fetch(client, observed, key))
        self._inflight_key = key

    async def _refresh_wait(
        self,
        client: httpx.AsyncClient,
        observed: dict[str, list[str]],
        key: tuple[tuple[str, tuple[str, ...]], ...],
    ) -> dict[str, Any]:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            cache = self._cache
            now = self._monotonic()
            if (
                cache is not None
                and cache.key == key
                and (now - cache.fetched_at) < self.cache_seconds
            ):
                return self._mark_stale(cache.payload, False)
            if self._inflight is not None and not self._inflight.done() and self._inflight_key == key:
                task = self._inflight
            else:
                task = asyncio.create_task(self._do_fetch(client, observed, key))
                self._inflight = task
                self._inflight_key = key
        return await task

    async def _do_fetch(
        self,
        client: httpx.AsyncClient,
        observed: dict[str, list[str]],
        key: tuple[tuple[str, tuple[str, ...]], ...],
    ) -> dict[str, Any]:
        self.fetch_count += 1
        providers, errors = await fetch_provider_statuses(
            client,
            observed,
            timeout_seconds=self.timeout_seconds,
            budget_seconds=self.budget_seconds,
        )
        payload = assemble_envelope(providers, errors)
        previous = self._cache
        full_failure = bool(observed) and not any(
            provider.get("status") != "unknown" for provider in providers
        )
        if full_failure and previous is not None and previous.key == key:
            # 全部状态页故障时保留 last-known-good；不能用 unknown 覆盖好缓存。
            stale = self._mark_stale(previous.payload, True)
            stale["partial"] = True
            stale["errors"] = list(stale.get("errors") or []) + list(errors)
            return stale
        # 成功或部分成功才替换缓存，供 SWR 返回旧值。
        self._cache = _CacheEntry(
            fetched_at=self._monotonic(),
            key=key,
            payload=copy.deepcopy(payload),
        )
        return self._mark_stale(payload, False)


def disabled_body() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "enabled": False,
        "generated_at": utc_now_z(),
        "providers": [],
        "partial": False,
        "errors": [{"error_code": "disabled"}],
    }
