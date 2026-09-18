"""在线更新：检索 GitHub Releases，经宿主机监视器执行 git + compose。

cloud-hub 容器只读、无 git、无 docker。面板只负责：
- GET 向 api.github.com 拉 allowlist 仓库的 releases / main tip
- POST 把目标 ref 写进 /update/request.json
宿主机上的 update-watcher.sh 读到请求后跑 self-update.sh。
"""

from __future__ import annotations

import json
import fcntl
import logging
import os
import re
import stat
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Callable
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from .auth import require_access_token
from .config import Settings

log = logging.getLogger("tm-update")

GITHUB_API = "https://api.github.com"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REF_RE = re.compile(r"^(main|master|v?[0-9]+(\.[0-9A-Za-z_-]+)*)$")
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
STALE_RUNNING_SECONDS = 30 * 60
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
    text = raw or ""
    ref = text.strip()
    # 拒绝裸 40 位 SHA，避免把部署降级到任意历史提交。
    # fullmatch：制表符/后缀不得被 re.match 前缀放过（与 self-update.sh valid_ref 对齐）。
    if (
        "\t" in text
        or len(ref) > 66
        or SHA_RE.fullmatch(ref)
        or not REF_RE.fullmatch(ref)
        or ".." in ref
    ):
        raise ValueError("非法更新目标")
    return ref


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _job_age_seconds(updated_at: str) -> float | None:
    raw = (updated_at or "").strip()
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - ts).total_seconds())


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
        self._apply_lock = Lock()

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

    def status_file(self) -> Path | None:
        runtime = self.settings.cm_update_runtime_dir
        if runtime is not None:
            return runtime / "status.json"
        d = self.update_dir
        return None if d is None else d / "status.json"

    @contextmanager
    def _coordination_lock(self, *, allow_legacy_enqueue: bool = False):
        """Share the host's lock without writing its read-only runtime mount."""
        directory = self.update_dir
        if directory is None:
            raise HTTPException(status_code=503, detail="未启用在线更新")
        runtime = self.settings.cm_update_runtime_dir
        lock_path = (runtime or directory) / "update.lock"
        if lock_path.is_symlink() or lock_path.parent.is_symlink():
            raise HTTPException(status_code=503, detail="更新锁文件异常")
        flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
        # Without a separate runtime (local development), both sides may use
        # the writable control directory. Production locks are host-created.
        if runtime is None:
            flags |= os.O_CREAT
        try:
            fd = os.open(lock_path, flags, 0o640)
        except (FileNotFoundError, PermissionError) as exc:
            if allow_legacy_enqueue and runtime is not None:
                # Older installers left update.lock absent or root-only. Keep
                # their next upgrade possible; the new host script initializes
                # the shared lock. Cancellation must fail closed until then.
                log.warning("旧版宿主更新锁尚不可读；本次仅允许提交更新")
                yield
                return
            raise HTTPException(
                status_code=503,
                detail="无法读取宿主更新锁，请用 sudo 重新运行 install.sh",
            ) from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail="无法读取宿主更新锁") from exc
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise HTTPException(status_code=503, detail="更新锁文件异常")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise HTTPException(status_code=409, detail="宿主机正在处理更新，无法更改任务") from exc
            except OSError as exc:
                raise HTTPException(status_code=503, detail="无法锁定宿主更新任务") from exc
            yield
        finally:
            os.close(fd)

    def read_job(self) -> dict[str, Any]:
        d = self.update_dir
        if d is None:
            return {"state": "unavailable", "message": "未挂载更新目录"}
        # request.json is the enqueue commit point. The watcher retains it
        # until it has published a terminal status for the same request ID.
        try:
            pending = json.loads((d / "request.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            pending = None
        except (OSError, ValueError):
            return {"state": "error", "message": "请求文件无法读取"}
        if pending is not None and not isinstance(pending, dict):
            return {"state": "error", "message": "请求文件格式错误"}
        status_path = self.status_file()
        status_unreadable = False
        try:
            if status_path is None:
                raise FileNotFoundError
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = {"state": "idle", "message": ""}
        except OSError:
            # 权限拒绝：不得改写成 queued，否则页面会取消已开始的重建。
            status_unreadable = True
            data = {"state": "unknown", "message": "状态文件无法读取"}
        except ValueError:
            data = {"state": "error", "message": "状态文件无法读取"}
        if not isinstance(data, dict):
            data = {"state": "error", "message": "状态文件格式错误"}
        if pending is None and not status_unreadable and data.get("state") not in {"running", "unknown"}:
            # Cancellation is an atomic move of request.json into the writable
            # control directory. Never write or replace the host's status file.
            # A new enqueue removes this receipt before publishing its request.
            try:
                cancelled = json.loads((d / "cancel.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                cancelled = None
            if isinstance(cancelled, dict) and cancelled.get("id"):
                data = {
                    "id": cancelled["id"], "state": "error",
                    "ref": cancelled.get("ref") or "", "message": "已取消更新",
                    "updated_at": cancelled.get("updated_at") or cancelled.get("requested_at") or "",
                }
            try:
                failed = json.loads((d / "publication-error.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                failed = None
            if isinstance(failed, dict) and failed.get("id"):
                data = {
                    "id": failed["id"], "state": "error",
                    "ref": failed.get("ref") or "", "message": "更新请求写入失败",
                    "updated_at": failed.get("updated_at") or "",
                }
        if pending is not None and status_unreadable:
            return {
                "id": str(pending.get("id") or ""),
                "state": "unknown",
                "ref": str(pending.get("ref") or ""),
                "message": "升级状态无法读取，无法确认是否已在重建",
                "updated_at": str(pending.get("requested_at") or ""),
                "status_unreadable": True,
            }
        if pending is not None and (
            not data.get("id") or data.get("id") != pending.get("id")
        ):
            data = {
                "id": pending.get("id"), "state": "queued", "ref": pending.get("ref"),
                "message": "已提交，等待宿主机监视器",
                "updated_at": pending.get("requested_at"),
            }
        elif pending is None and data.get("state") == "queued":
            # Recover leftovers from the former status-then-request protocol.
            data = {**data, "state": "error", "message": "上次更新请求未完成提交，请重新提交"}
        elif pending is None and data.get("state") == "running":
            updated = str(data.get("updated_at") or "")
            age = _job_age_seconds(updated)
            if age is None or age > STALE_RUNNING_SECONDS:
                data = {
                    **data,
                    "state": "error",
                    "message": "更新超时，容器可能未重建，请重试",
                }
        state = str(data.get("state") or "idle")
        job = {
            "id": str(data.get("id") or ""),
            "state": state,
            "ref": str(data.get("ref") or ""),
            "message": str(data.get("message") or ""),
            "updated_at": str(data.get("updated_at") or ""),
        }
        if status_unreadable:
            job["status_unreadable"] = True
        return job

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
        # FastAPI runs sync endpoints in multiple threads even with one worker.
        with self._apply_lock, self._coordination_lock(allow_legacy_enqueue=True):
            return self._enqueue(ref)

    def _enqueue(self, ref: str) -> dict[str, Any]:
        target = parse_ref(ref)
        d = self.update_dir
        if d is None:
            raise HTTPException(
                status_code=503,
                detail="未启用在线更新：请用 install.sh 安装，宿主机才会挂载更新目录并启动监视器",
            )
        job = self.read_job()
        if job.get("state") in {"queued", "running", "unknown"} or (d / "request.json").exists():
            raise HTTPException(status_code=409, detail="已有更新在进行")
        req_id = uuid.uuid4().hex[:16]
        request = {
            "id": req_id,
            "ref": target,
            "requested_at": _iso_now(),
        }
        try:
            # Retire old API receipts before publication, so a crash or an
            # immediately completed new request cannot resurrect an old result.
            for name in ("cancel.json", "publication-error.json"):
                (d / name).unlink(missing_ok=True)
            # Publish once. read_job derives queued from this durable request,
            # leaving the watcher's running/finished status untouched.
            _atomic_write(d / "request.json", request)
        except OSError as exc:
            try:
                _atomic_write(d / "publication-error.json", {
                    "id": req_id, "state": "error", "ref": target,
                    "message": "更新请求写入失败", "updated_at": _iso_now(),
                })
            except OSError:
                # A completely unwritable control mount still has the HTTP
                # failure response; the read-only host status is never changed.
                log.warning("更新请求写入失败，且无法保存失败回执")
            raise HTTPException(status_code=503, detail="更新请求写入失败，请检查更新目录") from exc
        return self.read_job()

    def cancel(self) -> dict[str, Any]:
        d = self.update_dir
        if d is None:
            raise HTTPException(status_code=503, detail="未启用在线更新")
        with self._apply_lock, self._coordination_lock():
            job = self.read_job()
            if (
                job.get("state") in {"running", "unknown"}
                or job.get("status_unreadable")
            ):
                raise HTTPException(
                    status_code=409,
                    detail="更新已开始重建，无法中止",
                )
            req = d / "request.json"
            cancelled = d / "cancel.json"
            try:
                if req.exists() or req.is_symlink():
                    if req.is_symlink() or cancelled.is_symlink() or d.is_symlink():
                        raise HTTPException(status_code=400, detail="更新请求文件异常")
                    # One atomic rename both removes the queued job and saves
                    # its cancellation receipt, even if the process exits next.
                    req.replace(cancelled)
                else:
                    return self.read_job()
            except OSError as exc:
                raise HTTPException(status_code=503, detail="无法取消更新请求") from exc
            try:
                _atomic_write(cancelled, {
                    "id": job.get("id") or "",
                    "state": "error",
                    "ref": job.get("ref") or "",
                    "message": "已取消更新",
                    "updated_at": _iso_now(),
                })
            except OSError:
                # The renamed request is already a durable cancellation receipt.
                log.warning("已取消更新，但无法补充取消时间")
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
    if path.is_symlink() or path.parent.is_symlink():
        raise OSError("refusing to follow symlink")
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        if tmp.exists() or tmp.is_symlink():
            tmp.unlink()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(tmp, flags, 0o660)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False) + "\n")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


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
    async def post_update(request: Request) -> dict[str, Any]:
        require_access_token(request, settings)
        try:
            raw = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON") from exc
        try:
            body = ApplyBody.model_validate(raw)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail="请求体校验失败") from exc
        from starlette.concurrency import run_in_threadpool

        try:
            return await run_in_threadpool(service.apply, body.ref)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/update/cancel")
    def cancel_update(request: Request) -> dict[str, Any]:
        require_access_token(request, settings)
        return service.cancel()

    return router
