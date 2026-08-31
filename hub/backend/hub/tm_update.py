"""在线更新：检索 GitHub Releases，经宿主机监视器执行 git + compose。

cloud-hub 容器只读、无 git、无 docker。面板只负责：
- GET 向 api.github.com 拉 allowlist 仓库的 releases / main tip
- POST 把目标 ref 写进 /update/request.json
宿主机上的 update-watcher.sh 读到请求后跑 self-update.sh。
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .auth import require_access_token
from .config import Settings

log = logging.getLogger("tm-update")

GITHUB_API = "https://api.github.com"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REF_RE = re.compile(r"^(main|master|v?[0-9][A-Za-z0-9._-]{0,64})$")
CACHE_SECONDS = 60.0
RELEASE_PAGE = 10

FetchFn = Callable[[str], tuple[int, Any]]


class ApplyBody(BaseModel):
    ref: str = Field(..., min_length=1, max_length=80)


def validate_github_repo(raw: str) -> str:
    repo = (raw or "").strip()
    if not REPO_RE.match(repo):
        raise ValueError("CM_GITHUB_REPO 必须是 owner/name")
    return repo


def parse_ref(raw: str) -> str:
    ref = (raw or "").strip()
    # REF_RE 锚定 ^ 已排除 "-" 开头，无需再查
    if not REF_RE.match(ref) or ".." in ref:
        raise ValueError("非法更新目标")
    return ref


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def version_key(raw: str) -> tuple[int, ...]:
    s = (raw or "").strip()
    if s.lower().startswith("v") and len(s) > 1 and s[1].isdigit():
        s = s[1:]
    parts: list[int] = []
    for chunk in s.split("."):
        num = ""
        for ch in chunk:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    return tuple(parts or (0,))


def version_gt(left: str, right: str) -> bool:
    """Semver 比较：缺失段视为 0，因此 1.2 与 1.2.0 相等。"""
    a, b = version_key(left), version_key(right)
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


def _norm_sha(raw: str) -> str:
    return (raw or "").strip().lower()[:40]


def _release_item(row: dict[str, Any]) -> dict[str, Any]:
    body = str(row.get("body") or "").strip()
    if len(body) > 800:
        body = body[:800].rstrip() + "…"
    return {
        "tag": str(row.get("tag_name") or ""),
        "name": str(row.get("name") or row.get("tag_name") or ""),
        "published_at": str(row.get("published_at") or ""),
        "html_url": str(row.get("html_url") or ""),
        "prerelease": bool(row.get("prerelease")),
        "notes": body,
    }


@dataclass
class _Cache:
    at: float = 0.0
    payload: dict[str, Any] | None = None


class UpdateService:
    def __init__(self, settings: Settings, fetch: FetchFn | None = None):
        self.settings = settings
        self._fetch = fetch
        self._cache = _Cache()

    @property
    def update_dir(self) -> Path | None:
        path = self.settings.cm_update_dir
        if path is None:
            return None
        try:
            if path.is_dir() and os_access_write(path):
                return path
        except OSError:
            return None
        return None

    def apply_enabled(self) -> bool:
        return self.update_dir is not None

    def read_job(self) -> dict[str, Any]:
        d = self.update_dir
        if d is None:
            return {"state": "unavailable", "message": "未挂载更新目录"}
        status_path = d / "status.json"
        if not status_path.is_file():
            req = d / "request.json"
            if req.is_file():
                return {"state": "queued", "message": "已提交，等待宿主机监视器"}
            return {"state": "idle", "message": ""}
        try:
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"state": "error", "message": "状态文件无法读取"}
        if not isinstance(data, dict):
            return {"state": "error", "message": "状态文件格式错误"}
        state = str(data.get("state") or "idle")
        return {
            "id": str(data.get("id") or ""),
            "state": state,
            "ref": str(data.get("ref") or ""),
            "message": str(data.get("message") or ""),
            "updated_at": str(data.get("updated_at") or ""),
        }

    def current(self) -> dict[str, str]:
        return {
            "version": self.settings.cm_version or "dev",
            "git_sha": self.settings.cm_git_sha or "",
        }

    def check(self, *, force: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        if (
            not force
            and self._cache.payload is not None
            and now - self._cache.at < CACHE_SECONDS
        ):
            payload = dict(self._cache.payload)
            payload["job"] = self.read_job()
            payload["apply_enabled"] = self.apply_enabled()
            return payload

        repo = self.settings.cm_github_repo
        releases_url = f"{GITHUB_API}/repos/{repo}/releases?per_page={RELEASE_PAGE}"
        commits_url = f"{GITHUB_API}/repos/{repo}/commits/{quote('main', safe='')}"
        rel_status, rel_body = self._get(releases_url)
        main_status, main_body = self._get(commits_url)

        github_error = ""
        releases: list[dict[str, Any]] = []
        if rel_status == 200 and isinstance(rel_body, list):
            for row in rel_body:
                if not isinstance(row, dict) or row.get("draft"):
                    continue
                item = _release_item(row)
                if item["tag"]:
                    releases.append(item)
        elif rel_status == 404:
            releases = []
        else:
            github_error = _gh_error(rel_status, rel_body)

        latest = next((r for r in releases if not r["prerelease"]), None)
        if latest is None and releases:
            latest = releases[0]

        main: dict[str, str] | None = None
        if main_status == 200 and isinstance(main_body, dict):
            sha = str(main_body.get("sha") or "")
            msg = ""
            commit = main_body.get("commit")
            if isinstance(commit, dict):
                msg = str(commit.get("message") or "").split("\n", 1)[0][:200]
            if sha:
                main = {"sha": sha, "short_sha": sha[:7], "message": msg}
        elif not github_error:
            github_error = _gh_error(main_status, main_body)

        cur = self.current()
        rel_ahead = bool(latest) and version_gt(latest["tag"], cur["version"])
        cur_sha = _norm_sha(cur["git_sha"])
        main_sha = _norm_sha((main or {}).get("sha") or "")
        main_ahead = bool(main_sha and cur_sha and not main_sha.startswith(cur_sha) and not cur_sha.startswith(main_sha[: len(cur_sha)]))
        if main_sha and not cur_sha:
            main_ahead = True

        payload = {
            "current": cur,
            "repo": f"https://github.com/{repo}",
            "latest_release": latest,
            "releases": releases[:8],
            "main": main,
            "release_ahead": rel_ahead,
            "main_ahead": main_ahead,
            "update_available": rel_ahead or main_ahead,
            "github_error": github_error,
            "checked_at": _iso_now(),
        }
        self._cache = _Cache(at=now, payload=payload)
        out = dict(payload)
        out["job"] = self.read_job()
        out["apply_enabled"] = self.apply_enabled()
        return out

    def apply(self, ref: str) -> dict[str, Any]:
        target = parse_ref(ref)
        d = self.update_dir
        if d is None:
            raise HTTPException(
                status_code=503,
                detail="未启用在线更新：请用 install.sh 安装，宿主机才会挂载更新目录并启动监视器",
            )
        job = self.read_job()
        if job.get("state") in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="已有更新在进行")
        req_id = uuid.uuid4().hex[:16]
        request = {
            "id": req_id,
            "ref": target,
            "requested_at": _iso_now(),
        }
        _atomic_write(d / "request.json", request)
        _atomic_write(
            d / "status.json",
            {
                "id": req_id,
                "state": "queued",
                "ref": target,
                "message": "已写入请求，等待宿主机监视器",
                "updated_at": _iso_now(),
            },
        )
        return self.read_job()

    def _get(self, url: str) -> tuple[int, Any]:
        allowed = f"{GITHUB_API}/repos/{self.settings.cm_github_repo}/"
        if not url.startswith(allowed):
            return 0, {"message": "拒绝访问非 allowlist 地址"}
        if self._fetch is not None:
            return self._fetch(url)
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "Cloud-Monitor-Updater",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        token = self.settings.github_api_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(
                timeout=httpx.Timeout(8.0, connect=4.0),
                follow_redirects=False,
            ) as client:
                resp = client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            log.warning("github 请求失败: %s", exc)
            return 0, {"message": "无法连接 GitHub"}
        try:
            body: Any = resp.json()
        except ValueError:
            body = {"message": (resp.text or "")[:200]}
        return resp.status_code, body


def os_access_write(path: Path) -> bool:
    import os

    return os.access(path, os.W_OK)


def _gh_error(status: int, body: Any) -> str:
    if status == 200:
        return ""
    msg = ""
    if isinstance(body, dict):
        msg = str(body.get("message") or "")
    if status == 0:
        return msg or "无法连接 GitHub"
    if status == 403:
        return "GitHub API 限额已用尽，稍后重试或配置 GITHUB_TOKEN"
    if status == 404:
        return "仓库或 Release 不存在"
    return msg or f"GitHub 返回 {status}"


def _atomic_write(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def build_update_router(settings: Settings, service: UpdateService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/system", tags=["system"])

    @router.get("/update")
    def get_update(request: Request, refresh: int = 0) -> dict[str, Any]:
        require_access_token(request, settings)
        try:
            return service.check(force=bool(refresh))
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @router.post("/update")
    def post_update(request: Request, body: ApplyBody) -> dict[str, Any]:
        require_access_token(request, settings)
        try:
            return service.apply(body.ref)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return router
