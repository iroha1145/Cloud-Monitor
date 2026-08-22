"""本机同步代理：增量拉取本地 openwebui-monitor 数据并推送到云端 Cloud-monitor hub。

数据流:
    本地 monitor GET /api/v1/records|users  →  云端 hub POST /api/v1/sync/push

增量策略: 以「上次同步水位线 (watermark)」为 start_time、本次快照时间点为
end_time 拉取固定窗口，推送成功后水位线前移；云端按 (device_id, local_id)
唯一索引幂等去重，因此水位线边界上的重复拉取是安全的。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import socket
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests

AGENT_VERSION = "cloud-monitor-agent/1.0.0"

log = logging.getLogger("sync-agent")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def default_device_id() -> str:
    raw = f"{socket.gethostname()}|{os.environ.get('USER') or os.getuid()}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{socket.gethostname() or 'device'}-{digest}"


@dataclass(frozen=True)
class AgentConfig:
    local_monitor_url: str
    local_api_key: str
    cloud_hub_url: str
    cloud_api_key: str
    device_id: str
    device_name: str
    platform: str
    sync_interval_seconds: float
    batch_size: int
    state_path: Path
    request_timeout_seconds: float
    run_once: bool = False


def load_config(env: Optional[dict[str, str]] = None) -> AgentConfig:
    env = dict(os.environ if env is None else env)

    def get(name: str, default: str = "") -> str:
        return str(env.get(name, default)).strip()

    hub_url = get("CLOUD_HUB_URL")
    if not hub_url:
        raise SystemExit("缺少 CLOUD_HUB_URL（云端 hub 地址，如 https://monitor.example.com）")

    state_path = Path(
        get("STATE_PATH") or (Path(__file__).resolve().parent / "agent-state.json")
    ).expanduser()

    def _float(name: str, default: float) -> float:
        try:
            return float(get(name) or default)
        except ValueError:
            return default

    def _int(name: str, default: int) -> int:
        try:
            return int(get(name) or default)
        except ValueError:
            return default

    return AgentConfig(
        local_monitor_url=get("LOCAL_MONITOR_URL", "http://host.docker.internal:7878").rstrip("/"),
        local_api_key=get("LOCAL_API_KEY"),
        cloud_hub_url=hub_url.rstrip("/"),
        cloud_api_key=get("CLOUD_API_KEY"),
        device_id=get("DEVICE_ID") or default_device_id(),
        device_name=get("DEVICE_NAME") or socket.gethostname() or "local",
        platform=get("AGENT_PLATFORM") or platform.system().lower() or "unknown",
        sync_interval_seconds=max(_float("SYNC_INTERVAL_SECONDS", 60.0), 5.0),
        batch_size=min(max(_int("BATCH_SIZE", 200), 1), 500),
        state_path=state_path,
        request_timeout_seconds=max(_float("REQUEST_TIMEOUT_SECONDS", 15.0), 1.0),
        run_once=get("RUN_ONCE") in ("1", "true", "yes"),
    )


class AgentState:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {"watermark": None, "pushed_records": 0, "last_push_at": None}

    def load(self) -> None:
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.data.update(loaded)
            except (OSError, ValueError) as exc:
                log.warning("状态文件读取失败，将重新全量同步: %s", exc)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def watermark(self) -> Optional[str]:
        return self.data.get("watermark")

    @watermark.setter
    def watermark(self, value: Optional[str]) -> None:
        self.data["watermark"] = value


class SyncAgent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.state = AgentState(config.state_path)

    # ------------------------------------------------------------ 本地读取

    def local_get(self, path: str, params: dict[str, Any]) -> dict:
        headers = {}
        if self.config.local_api_key:
            headers["Authorization"] = f"Bearer {self.config.local_api_key}"
        resp = requests.get(
            f"{self.config.local_monitor_url}{path}",
            params=params,
            headers=headers,
            timeout=self.config.request_timeout_seconds,
        )
        resp.raise_for_status()
        return resp.json()

    def fetch_users(self) -> list[dict]:
        payload = self.local_get("/api/v1/users", {})
        users = payload.get("users") or []
        return [
            {
                "id": u.get("id"),
                "email": u.get("email") or "",
                "name": u.get("name") or "",
                "role": u.get("role") or "user",
            }
            for u in users
            if u.get("id")
        ]

    def fetch_records_window(
        self, start_time: Optional[str], end_time: str
    ) -> list[dict]:
        """拉取 [start_time, end_time] 窗口内的全部记录（分页聚合，窗口固定）。"""
        records: list[dict] = []
        page = 1
        while True:
            params: dict[str, Any] = {"end_time": end_time, "page": page, "page_size": 200}
            if start_time:
                params["start_time"] = start_time
            payload = self.local_get("/api/v1/records", params)
            batch = payload.get("records") or []
            records.extend(batch)
            total = int(payload.get("total") or 0)
            if not batch or len(records) >= total:
                break
            page += 1
        return records

    # ------------------------------------------------------------ 云端推送

    def push_batch(self, users: list[dict], records: list[dict]) -> dict:
        payload = {
            "device": {
                "id": self.config.device_id,
                "name": self.config.device_name,
                "platform": self.config.platform,
                "agent_version": AGENT_VERSION,
            },
            "users": users,
            "records": [
                {
                    "local_id": r["id"],
                    "user_id": r.get("user_id") or "",
                    "nickname": r.get("nickname") or "",
                    "model_name": r.get("model_name") or "",
                    "input_tokens": int(r.get("input_tokens") or 0),
                    "output_tokens": int(r.get("output_tokens") or 0),
                    "created_at": r.get("created_at") or utc_now_iso(),
                }
                for r in records
            ],
        }
        resp = requests.post(
            f"{self.config.cloud_hub_url}/api/v1/sync/push",
            json=payload,
            headers={"Authorization": f"Bearer {self.config.cloud_api_key}"},
            timeout=self.config.request_timeout_seconds,
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------ 同步循环

    def run_once(self) -> dict:
        snapshot_end = utc_now_iso()
        watermark = self.state.watermark
        users = self.fetch_users()
        records = self.fetch_records_window(watermark, snapshot_end)
        log.info(
            "窗口 [%s, %s] 取到 %d 条记录、%d 个用户",
            watermark or "全量起始",
            snapshot_end,
            len(records),
            len(users),
        )

        # 记录按时间倒序返回，改为升序推送，云端按时间顺序落库
        records.sort(key=lambda r: (r.get("created_at") or "", r.get("id") or 0))

        inserted_total = 0
        for i in range(0, len(records), self.config.batch_size):
            chunk = records[i : i + self.config.batch_size]
            result = self.push_batch(users, chunk)
            inserted_total += int(result.get("inserted") or 0)
            log.info(
                "推送 %d/%d 条：新增 %d，跳过 %d",
                min(i + self.config.batch_size, len(records)),
                len(records),
                result.get("inserted"),
                result.get("skipped"),
            )

        self.state.watermark = snapshot_end
        self.state.data["pushed_records"] += inserted_total
        self.state.data["last_push_at"] = utc_now_iso()
        self.state.save()
        return {"fetched": len(records), "inserted": inserted_total}

    def run_forever(self) -> None:
        log.info(
            "启动 agent: device=%s 本地=%s → 云端=%s 间隔=%ss",
            self.config.device_id,
            self.config.local_monitor_url,
            self.config.cloud_hub_url,
            self.config.sync_interval_seconds,
        )
        while True:
            try:
                summary = self.run_once()
                log.info("同步完成: %s", summary)
            except requests.RequestException as exc:
                log.error("本轮同步失败，将在下个周期重试: %s", exc)
            except (KeyError, ValueError, OSError) as exc:
                log.error("本轮同步出现数据问题，将在下个周期重试: %s", exc)
            if self.config.run_once:
                break
            time.sleep(self.config.sync_interval_seconds)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    try:
        config = load_config()
    except SystemExit as exc:
        log.error("%s", exc)
        return 1
    agent = SyncAgent(config)
    agent.state.load()
    try:
        from token_monitor_bridge import start_bridge_thread

        start_bridge_thread(agent)
    except ImportError as exc:
        log.warning("token-monitor 桥接模块不可用: %s", exc)
    agent.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
