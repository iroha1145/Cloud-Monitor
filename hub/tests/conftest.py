"""token-monitor 官方协议测试的公共基座。

提供两类 fixture:
- node_hub / cloud_app: 进程内 TestClient（大多数协议测试）
- live_stack: 真实 uvicorn + Node hub（SSE 流式测试需要真实连接）

测试输入的"官方生成载荷"由 tm-core/make_payload.js 用 vendored 官方
usage.js 产生，保证不是手写近似。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi.testclient import TestClient

HUB_ROOT = Path(__file__).resolve().parents[1]
VENDOR = HUB_ROOT / "tm-core" / "vendor"
sys.path.insert(0, str(HUB_ROOT / "backend"))

from hub.config import Settings  # noqa: E402
from hub.main import create_app  # noqa: E402

TM_SECRET = "unit-tm-secret-0123456789abcdef0000"
API_KEY = "a" * 32
READ_KEY = "b" * 32

NODE_AVAILABLE = shutil.which("node") is not None
requires_node = pytest.mark.skipif(not NODE_AVAILABLE, reason="本机无 node，差分测试需要官方 hub")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class NodeHub:
    """直接以官方 createHub() 起一个 hub 进程（不经 Cloud 代理，做差分基线）。"""

    def __init__(self, data_file: Path):
        self.port = free_port()
        self.data_file = data_file
        self.proc = subprocess.Popen(
            ["node", str(HUB_ROOT / "tm-core" / "run.js")],
            env={
                **os.environ,
                "TOKEN_MONITOR_PORT": str(self.port),
                "TOKEN_MONITOR_SECRET": TM_SECRET,
                "TOKEN_MONITOR_DATA_FILE": str(data_file),
            },
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                resp = httpx.get(f"http://127.0.0.1:{self.port}/api/health", timeout=1)
                if resp.status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        else:
            self.stop()
            stderr = self.proc.stderr.read().decode() if self.proc.stderr else ""
            raise RuntimeError("node hub 未能在 10s 内就绪: " + stderr)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def headers(self) -> dict:
        return {"X-Token-Monitor-Secret": TM_SECRET}

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def make_cloud_app(
    tmp_path: Path,
    node_url: str,
    *,
    database_path: Path | None = None,
    outbox_max: int = 1000,
    background: bool = False,
) -> TestClient:
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=database_path or (tmp_path / "hub.sqlite3"),
        frontend_dir=tmp_path,
        max_records_per_push=500,
        tm_ingest_secret=TM_SECRET,
        tm_core_url=node_url,
        tm_outbox_max_pending=outbox_max,
        tm_background_enabled=background,
    )
    app = create_app(settings)
    return TestClient(app)


def official_payload(spec: dict) -> dict:
    """用 vendored 官方 usage.js 生成规范化载荷（mergeDeviceRecord 语义）。"""
    result = subprocess.run(
        ["node", str(HUB_ROOT / "tm-core" / "make_payload.js")],
        input=json.dumps(spec),
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return json.loads(result.stdout)


def _utc_iso(dt) -> str:
    return (
        dt.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _period_windows(tz: str, day: str | None = None) -> dict:
    """按当前时间生成有效周期窗口（不硬编码日期，避免随墙钟过期）。"""
    zone = ZoneInfo(tz)
    day_key = day or datetime.now(zone).date().isoformat()
    day_start = datetime.fromisoformat(day_key).replace(tzinfo=zone)
    today_end = day_start + timedelta(days=1)
    month_start = day_start.replace(day=1)
    month_end = (
        month_start.replace(year=month_start.year + 1, month=1)
        if month_start.month == 12
        else month_start.replace(month=month_start.month + 1)
    )
    return {
        "timeZone": tz,
        "today": {"key": day_key, "endsAt": _utc_iso(today_end)},
        "month": {"key": day_key[:7], "endsAt": _utc_iso(month_end)},
    }


def _now_iso() -> str:
    return _utc_iso(datetime.now(timezone.utc))


def widget_style_payload(device_id="dev-mac", *, tz="Asia/Tokyo", day=None) -> dict:
    """官方 widget 风格摘要（含缓存拆分/周期窗口/limits）。"""
    return {
        "deviceId": device_id,
        "hostname": "MacBook-Pro",
        "platform": "darwin",
        "osName": "macOS",
        "osVersion": "15.5",
        "agentVersion": "1.8.2",
        "agentRuntime": "widget",
        "trackedClients": ["claude", "codex"],
        "projectsEnabled": False,
        "historyAvailable": True,
        "syncUploadIntervalMs": 300000,
        "updatedAt": _now_iso(),
        "periodWindows": _period_windows(tz, day),
        "today": {
            "totalTokens": 1846320,
            "outputTokens": 421000,
            "cacheReadTokens": 986000,
            "cacheWriteTokens": 120000,
            "unclassifiedTokens": 319320,
            "costUsd": 4.82,
            "clients": {"claude": 1200000, "codex": 646320},
            "clientOutputs": {"claude": 300000, "codex": 121000},
            "clientCacheReads": {"claude": 800000, "codex": 186000},
            "clientCacheWrites": {"claude": 90000, "codex": 30000},
            "clientUnclassifiedTokens": {"claude": 210000, "codex": 109320},
            "clientCosts": {"claude": 3.8, "codex": 1.02},
            "models": {"opus-4.5": 1000000, "gpt-5.2": 846320},
            "modelOutputs": {"opus-4.5": 250000, "gpt-5.2": 171000},
            "modelCacheReads": {"opus-4.5": 700000, "gpt-5.2": 286000},
            "modelCacheWrites": {"opus-4.5": 80000, "gpt-5.2": 40000},
            "modelUnclassifiedTokens": {"opus-4.5": 170000, "gpt-5.2": 149320},
            "modelCosts": {"opus-4.5": 3.0, "gpt-5.2": 1.82},
            "clientModels": {"claude": {"opus-4.5": 1000000}, "codex": {"gpt-5.2": 846320}},
            "sessions": {},
        },
        "month": {
            "totalTokens": 28463200,
            "costUsd": 71.4,
            "clients": {"claude": 24000000, "codex": 4463200},
            "models": {"opus-4.5": 24000000, "gpt-5.2": 4463200},
        },
        "allTime": {
            "totalTokens": 128463200,
            "costUsd": 402.1,
            "clients": {"claude": 100000000, "codex": 28463200},
            "models": {"opus-4.5": 100000000, "gpt-5.2": 28463200},
        },
    }


def agent_style_payload(device_id="dev-headless") -> dict:
    """官方 headless agent 风格摘要。"""
    return {
        "deviceId": device_id,
        "hostname": "build-server",
        "platform": "linux",
        "agentVersion": "1.8.2",
        "agentRuntime": "headless-agent",
        "trackedClients": ["codex"],
        "projectsEnabled": False,
        "historyAvailable": False,
        "syncUploadIntervalMs": 300000,
        "updatedAt": _now_iso(),
        "periodWindows": _period_windows("UTC"),
        "today": {"totalTokens": 320000, "clients": {"codex": 320000}},
        "month": {"totalTokens": 6200000, "clients": {"codex": 6200000}},
        "allTime": {"totalTokens": 20800000, "clients": {"codex": 20800000}},
    }


def limits_only_payload(device_id="dev-mac") -> dict:
    return {
        "deviceId": device_id,
        "limitsOnly": True,  # 官方标志：继承既有 periods，仅更新 limits
        "hostname": "MacBook-Pro",
        "platform": "darwin",
        "agentVersion": "1.8.2",
        "agentRuntime": "widget",
        "syncUploadIntervalMs": 300000,
        "updatedAt": _now_iso(),
        "limits": {
            "providers": [
                {
                    "provider": "claude",
                    "planLabel": "Max 5x",
                    "windows": [
                        {"kind": "session", "label": "5h", "usedPercent": 42, "resetsAt": "2026-08-22T18:00:00.000Z"},
                        {"kind": "weekly", "label": "7d", "usedPercent": 18},
                    ],
                }
            ]
        },
    }


@pytest.fixture()
def node_hub(tmp_path):
    hub = NodeHub(tmp_path / "baseline-devices.json")
    yield hub
    hub.stop()


@pytest.fixture()
def cloud(node_hub, tmp_path):
    client = make_cloud_app(tmp_path, node_hub.url)
    with client:
        yield client


class LiveStack:
    def __init__(self, hub_client: TestClient, port: int, data_file: Path, db_path: Path):
        self.client = hub_client
        self.port = port
        self.data_file = data_file
        self.db_path = db_path

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture(scope="module")
def live_stack(tmp_path_factory):
    """真实 uvicorn + Node hub，用于 SSE 流式行为验收。"""
    import uvicorn

    tmp = tmp_path_factory.mktemp("live")
    node = NodeHub(tmp / "devices.json")
    port = free_port()
    settings = Settings(
        api_key=API_KEY,
        access_token=READ_KEY,
        database_path=tmp / "hub.sqlite3",
        frontend_dir=tmp,
        max_records_per_push=500,
        tm_ingest_secret=TM_SECRET,
        tm_core_url=node.url,
    )
    app = create_app(settings)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/v1/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        node.stop()
        pytest.fail("live uvicorn 未就绪")
    yield LiveStack(None, port, node.data_file, settings.database_path)
    server.should_exit = True
    thread.join(timeout=5)
    node.stop()
