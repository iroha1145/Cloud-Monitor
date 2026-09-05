import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, ExternalLink, RefreshCw } from "lucide-react";
import {
  availableUpdateTargets,
  isAuthError,
  isUpdateBusy,
  readUpdateStatus,
  submitSystemUpdate,
  type UpdateJob,
  type UpdateStatus,
} from "./restoration-api";
import "./system-update.css";

export interface SystemUpdateProps {
  accessToken: string;
  dataMode: "live" | "demo";
  onAuthExpired?: () => void;
}
const JOB_LABELS: Record<string, string> = {
  idle: "暂无更新任务",
  unavailable: "在线升级未启用",
  queued: "等待宿主机处理",
  running: "正在执行更新",
  ok: "更新已完成",
  error: "更新失败",
  unknown: "任务状态未提供",
};
function displayTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { hour12: false })
    : "未提供";
}
function JobStatus({ job }: { job: UpdateJob }) {
  return (
    <div
      className={`system-update-job system-update-job-${job.state === "error" ? "error" : job.state === "ok" ? "ok" : "normal"}`}
      role="status"
      aria-live="polite"
    >
      <strong>{JOB_LABELS[job.state] || `任务状态：${job.state}`}</strong>
      {job.message && <p>{job.message}</p>}
      {job.ref && (
        <small>
          目标版本：{job.ref}
          {job.updatedAt ? ` · ${displayTime(job.updatedAt)}` : ""}
        </small>
      )}
      {job.state === "queued" && (
        <p>请求已写入更新目录；宿主机处理后才会开始升级。</p>
      )}
      {job.state === "running" && (
        <p>页面会继续检查进度，服务重启时可能短暂断开。</p>
      )}
      {job.state === "ok" && (
        <button
          className="system-update-button"
          onClick={() => window.location.reload()}
        >
          刷新页面
        </button>
      )}
    </div>
  );
}
export function SystemUpdate({
  accessToken,
  dataMode,
  onAuthExpired,
}: SystemUpdateProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [connectionNote, setConnectionNote] = useState("");
  const [request, setRequest] = useState({ id: 0, refresh: false });
  const context = useRef(0);
  const postController = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const statusRef = useRef<UpdateStatus | null>(null);
  const authCallback = useRef(onAuthExpired);
  authCallback.current = onAuthExpired;
  useEffect(() => {
    ++context.current;
    postController.current?.abort();
    statusRef.current = null;
    setStatus(null);
    setError("");
    setConnectionNote("");
    submittingRef.current = false;
    setSubmitting(false);
    return () => {
      ++context.current;
      postController.current?.abort();
    };
  }, [accessToken, dataMode]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let pollStarted = Date.now();
    const check = async (refresh: boolean) => {
      if (dataMode !== "live" || !accessToken || stopped) {
        setLoading(false);
        return;
      }
      if (!statusRef.current) setLoading(true);
      try {
        const next = await readUpdateStatus(
          accessToken,
          refresh,
          controller.signal,
        );
        if (stopped) return;
        // A check started before the user submitted must not overwrite the submitted job.
        if (submittingRef.current) return;
        statusRef.current = next;
        setStatus(next);
        setError("");
        setConnectionNote("");
        if (isUpdateBusy(next.job)) {
          if (Date.now() - pollStarted < 6 * 60 * 1000)
            timer = setTimeout(() => void check(false), 2000);
          else
            setConnectionNote(
              "已停止自动等待。更新任务可能仍在进行，请检查最新状态。",
            );
        }
      } catch (failure) {
        if (stopped || controller.signal.aborted) return;
        if (isAuthError(failure)) {
          setError(
            failure instanceof Error ? failure.message : "访问权限已失效。",
          );
          authCallback.current?.();
          return;
        }
        const message =
          failure instanceof Error ? failure.message : "更新检查失败，请重试。";
        if (statusRef.current && isUpdateBusy(statusRef.current.job)) {
          setConnectionNote(
            `暂时无法读取更新进度。${message}服务恢复后会继续检查。`,
          );
          if (Date.now() - pollStarted < 6 * 60 * 1000)
            timer = setTimeout(() => void check(false), 4000);
          else setConnectionNote(`等待超时。${message}请手动检查最新状态。`);
        } else setError(message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    pollStarted = Date.now();
    if (dataMode === "live" && accessToken) {
      setLoading(true);
      void check(request.refresh);
    } else setLoading(false);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, dataMode, request]);
  const checkNow = (refresh = true) =>
    setRequest((old) => ({ id: old.id + 1, refresh }));
  const apply = async (ref: string) => {
    const current = statusRef.current;
    if (
      dataMode !== "live" ||
      !accessToken ||
      submittingRef.current ||
      !current ||
      !availableUpdateTargets(current).some((target) => target.ref === ref)
    )
      return;
    const revision = context.current;
    const controller = new AbortController();
    postController.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    setConnectionNote("");
    try {
      const job = await submitSystemUpdate(accessToken, ref, controller.signal);
      if (controller.signal.aborted || revision !== context.current) return;
      const next = { ...current, job };
      statusRef.current = next;
      setStatus(next);
    } catch (failure) {
      if (controller.signal.aborted || revision !== context.current) return;
      if (isAuthError(failure)) authCallback.current?.();
      setError(
        failure instanceof Error ? failure.message : "无法提交更新，请重试。",
      );
      // A failed response can follow a successful write. Recheck before another submission.
      setConnectionNote("正在重新读取任务状态，以确认提交结果。");
      try {
        const confirmed = await readUpdateStatus(
          accessToken,
          false,
          controller.signal,
        );
        if (controller.signal.aborted || revision !== context.current) return;
        statusRef.current = confirmed;
        setStatus(confirmed);
        if (
          isUpdateBusy(confirmed.job) ||
          (confirmed.job.state === "ok" &&
            !!confirmed.job.id &&
            confirmed.job.id !== current.job.id &&
            confirmed.job.ref === ref)
        )
          setError("");
        setConnectionNote("");
      } catch {
        if (controller.signal.aborted || revision !== context.current) return;
        // Unknown state removes all upgrade actions until a later check succeeds.
        const unknown = {
          ...current,
          job: {
            ...current.job,
            state: "unknown",
            message: "提交结果尚未确认，请检查最新状态后再操作。",
          },
        };
        statusRef.current = unknown;
        setStatus(unknown);
        setConnectionNote("提交结果尚未确认，请检查最新状态后再操作。");
      }
    } finally {
      if (revision === context.current) {
        submittingRef.current = false;
        setSubmitting(false);
        checkNow(false);
      }
    }
  };
  const targets = status ? availableUpdateTargets(status) : [];
  const jobBusy = !!status && isUpdateBusy(status.job);
  return (
    <section className="system-update" aria-labelledby="system-update-title">
      <header className="system-update-header">
        <div>
          <span className="system-update-eyebrow">
            <ArrowUpCircle size={15} aria-hidden="true" />
            服务维护
          </span>
          <h2 id="system-update-title">系统更新</h2>
          <p>检查正式版本与主分支进度，并查看宿主机更新任务。</p>
        </div>
        <button
          className="system-update-button"
          disabled={
            dataMode === "demo" || !accessToken || loading || submitting
          }
          onClick={() => checkNow()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {loading ? "正在检查…" : "检查更新"}
        </button>
      </header>
      {dataMode === "demo" ? (
        <p className="system-update-empty">
          演示模式不读取服务器版本，也不会提交升级任务。
        </p>
      ) : !accessToken ? (
        <p className="system-update-empty">连接服务后可检查和管理系统更新。</p>
      ) : (
        <>
          {error && (
            <p className="system-update-error" role="alert">
              {error}
            </p>
          )}
          {connectionNote && (
            <p className="system-update-hint" role="status">
              {connectionNote}
            </p>
          )}
          {loading && !status && (
            <p className="system-update-empty" role="status">
              正在读取版本与任务状态…
            </p>
          )}
          {status && (
            <>
              <dl className="system-update-versions">
                <div>
                  <dt>当前版本</dt>
                  <dd>
                    <strong>{status.current.version}</strong>
                    <code>
                      {status.current.gitSha
                        ? status.current.gitSha.slice(0, 7)
                        : "提交标识未提供"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>最新正式版本</dt>
                  <dd>
                    {status.latestRelease ? (
                      <>
                        <strong>{status.latestRelease.tag}</strong>
                        <span
                          className={`system-update-tag ${status.releaseAhead ? "is-new" : ""}`}
                        >
                          {status.releaseAhead ? "有新版本" : "暂无较新版本"}
                        </span>
                        {status.latestRelease.prerelease && (
                          <span className="system-update-tag">预发布</span>
                        )}
                        {status.latestRelease.publishedAt && (
                          <small>
                            {status.latestRelease.publishedAt.slice(0, 10)}
                          </small>
                        )}
                      </>
                    ) : (
                      <span>
                        {status.githubError ? "暂未获取" : "暂无发布版本"}
                      </span>
                    )}
                  </dd>
                </div>
                {status.main && (
                  <div>
                    <dt>主分支（main）</dt>
                    <dd>
                      <code>
                        {status.main.shortSha || status.main.sha.slice(0, 7)}
                      </code>
                      <span
                        className={`system-update-tag ${status.mainAhead ? "is-new" : ""}`}
                      >
                        {status.mainAhead ? "有新提交" : "已同步"}
                      </span>
                      {status.main.message && (
                        <small className="system-update-commit">
                          {status.main.message}
                        </small>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {status.githubError && (
                <p className="system-update-error" role="status">
                  版本来源暂不可用：{status.githubError}
                </p>
              )}
              {!status.applyEnabled && (
                <p className="system-update-hint">
                  在线升级未启用。需要挂载可写的更新目录，并由安装脚本配置宿主机更新监视器。
                </p>
              )}
              {status.applyEnabled && (
                <p className="system-update-hint">
                  升级请求由宿主机更新监视器处理；目录可写不代表监视器正在运行。
                </p>
              )}
              <JobStatus job={status.job} />
              {status.latestRelease?.notes && (
                <details className="system-update-notes">
                  <summary>查看版本说明</summary>
                  <pre>{status.latestRelease.notes}</pre>
                </details>
              )}
              <footer className="system-update-footer">
                <div className="system-update-actions">
                  {targets.map((target) => (
                    <button
                      key={target.ref}
                      className={`system-update-button ${target.ref !== "main" ? "system-update-primary" : ""}`}
                      disabled={submitting || loading || jobBusy}
                      onClick={() => void apply(target.ref)}
                    >
                      {submitting ? "正在提交…" : target.label}
                    </button>
                  ))}
                  {status.latestRelease?.url && (
                    <a
                      href={status.latestRelease.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      版本详情
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <small>最近检查：{displayTime(status.checkedAt)}</small>
              </footer>
            </>
          )}
        </>
      )}
    </section>
  );
}
