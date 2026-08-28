"""Docker HEALTHCHECK：根据状态文件判定同步健康。

健康 = 最近一次成功同步在 HEALTH_STALE_SECONDS 内，且没有未解决的永久错误。
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from sync_agent import AgentState, parse_health_stale_seconds


def _state_path() -> Path:
    return Path(
        os.environ.get("STATE_PATH")
        or (Path(__file__).resolve().parent / "agent-state.json")
    )


def main() -> int:
    state_path = _state_path()
    if not state_path.is_file():
        print(f"unhealthy: 状态文件不存在 {state_path}")
        return 1
    state = AgentState(state_path)
    try:
        state.load()
    except Exception as exc:  # StateCorruptError 等
        print(f"unhealthy: 状态文件不可用 ({exc})")
        return 1

    if state.data.get("last_permanent_error"):
        print(f"unhealthy: 存在未解决的永久错误: {state.data['last_permanent_error']}")
        return 1

    last_success = state.data.get("last_success_at")
    if not last_success:
        print("unhealthy: 从未成功同步")
        return 1
    try:
        dt = datetime.fromisoformat(str(last_success).replace("Z", "+00:00"))
    except ValueError:
        print("unhealthy: last_success_at 非法")
        return 1
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    # 与 sync_agent.load_config 同一解析规则（非法回退 3600、下限 60）：
    # 两侧口径不一致会让容器在 agent 健康时被判 unhealthy
    stale = parse_health_stale_seconds(os.environ.get("HEALTH_STALE_SECONDS"))
    age = (datetime.now(timezone.utc) - dt).total_seconds()
    if age > stale:
        print(f"unhealthy: 距上次成功同步 {age:.0f}s 超过阈值 {stale:.0f}s")
        return 1
    print(f"healthy: 上次成功同步于 {last_success}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
