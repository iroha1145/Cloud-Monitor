import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock3, RefreshCw } from "lucide-react";
import {
  isAuthError,
  isMissingArchive,
  makeArchiveFallback,
  mergeArchiveDays,
  nextArchiveCursor,
  readArchive,
  type ArchiveDay,
  type ArchiveFallbackData,
  type ArchivePage,
} from "./restoration-api";
import { full } from "./lib/format";
import { usd } from "./money";
import "./archive-panel.css";

// Fallback days come from the overview in one piece (90 in the demo); show
// them in steps so the page does not unroll every day at once.
const FALLBACK_FIRST = 14;
const FALLBACK_STEP = 30;

export interface ArchivePanelProps {
  accessToken: string;
  dataMode: "live" | "demo";
  onAuthExpired?: () => void;
  fallbackData?: ArchiveFallbackData;
  historyAvailable?: boolean;
}
function Composition({
  title,
  values,
}: {
  title: string;
  values: Record<string, number>;
}) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return (
    <section className="archive-composition">
      <h3>{title}</h3>
      {entries.length ? (
        <dl>
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{full(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>未提供明细</p>
      )}
    </section>
  );
}
function ArchiveRow({ row }: { row: ArchiveDay }) {
  const incomplete =
    row.complete === false || (row.coverage !== null && row.coverage < 60);
  return (
    <details className="archive-day" data-feel-item="row">
      <summary>
        <span className="archive-date">
          <time dateTime={row.day}>{row.day}</time>
          <small>
            {incomplete
              ? "归档不完整"
              : row.complete === true
                ? "归档完整"
                : "完整性未提供"}
          </small>
        </span>
        <span className="archive-number">
          <small>词元</small>
          <strong>{full(row.tokens)}</strong>
        </span>
        <span className="archive-cost">
          <small>费用（美元）</small>
          <strong>{usd(row.costUsd)}</strong>
        </span>
        <ChevronDown size={16} className="archive-chevron" aria-hidden="true" />
      </summary>
      <div className="archive-day-detail">
        <p
          className={
            incomplete ? "archive-note archive-warning" : "archive-note"
          }
        >
          {row.deviceCount !== null
            ? `${row.deviceCount} 台设备参与归档。`
            : "参与设备数未提供。"}
          {row.coverage !== null
            ? `覆盖率 ${row.coverage.toFixed(1)}%。`
            : "覆盖率未提供。"}
          {incomplete &&
            "部分记录缺失，仅显示已同步部分。"}
        </p>
        <div className="archive-compositions">
          <Composition title="按客户端" values={row.perClient} />
          <Composition title="按模型" values={row.perModel} />
        </div>
      </div>
    </details>
  );
}
export function ArchivePanel({
  accessToken,
  dataMode,
  onAuthExpired,
  fallbackData,
  historyAvailable,
}: ArchivePanelProps) {
  const [rows, setRows] = useState<ArchiveDay[]>([]);
  const [metadata, setMetadata] = useState<ArchivePage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(
    dataMode === "demo" || historyAvailable === false,
  );
  const [paginationNote, setPaginationNote] = useState("");
  const [fallbackShown, setFallbackShown] = useState(FALLBACK_FIRST);
  // "加载更多" is disabled while it loads and removed after the last page, and
  // either drops the keyboard focus to the page; it comes back to the button,
  // or to the count beside it once nothing is left to load.
  const moreFocus = useRef(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const footerStatus = useRef<HTMLSpanElement>(null);
  const context = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const lastRequest = useRef<{ cursor: string | null; previous: ArchiveDay[] }>(
    { cursor: null, previous: [] },
  );
  const busy = useRef(false);
  const authCallback = useRef(onAuthExpired);
  authCallback.current = onAuthExpired;
  const load = async (
    requestedCursor: string | null,
    previous: ArchiveDay[],
    revision = context.current,
  ) => {
    if (busy.current || dataMode !== "live" || !accessToken) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    lastRequest.current = { cursor: requestedCursor, previous };
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await readArchive(
        accessToken,
        requestedCursor,
        controller.signal,
      );
      if (controller.signal.aborted || revision !== context.current) return;
      const combined = mergeArchiveDays(previous, page.items);
      const next = nextArchiveCursor(
        page,
        requestedCursor,
        combined.length - previous.length,
      );
      setRows(combined);
      setCursor(next);
      setMetadata((old) =>
        requestedCursor && old
          ? {
              ...page,
              mixedTimeZones: old.mixedTimeZones || page.mixedTimeZones,
              partial: old.partial || page.partial,
              partialErrorCount: old.partialErrorCount + page.partialErrorCount,
            }
          : page,
      );
      setPaginationNote(
        page.hasMore && !next
          ? "服务器未返回可继续翻页的日期，已保留当前记录。请刷新后重试。"
          : "",
      );
    } catch (failure) {
      if (controller.signal.aborted || revision !== context.current) return;
      if (isAuthError(failure)) authCallback.current?.();
      if (isMissingArchive(failure) && previous.length === 0) setFallback(true);
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "历史归档加载失败，请重试。",
        );
    } finally {
      if (revision === context.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    const revision = ++context.current;
    busy.current = false;
    setRows([]);
    setMetadata(null);
    setCursor(null);
    setError("");
    setPaginationNote("");
    setLoading(false);
    setFallback(dataMode === "demo" || historyAvailable === false);
    setFallbackShown(FALLBACK_FIRST);
    if (dataMode === "live" && historyAvailable !== false && accessToken)
      void load(null, [], revision);
    return () => {
      activeRequest.current?.abort();
      ++context.current;
      busy.current = false;
    };
    // Requests reset only when their authentication or source changes.
  }, [accessToken, dataMode, historyAvailable]);
  const fallbackRows = fallback ? makeArchiveFallback(fallbackData) : [];
  const visibleRows = fallback ? fallbackRows.slice(0, fallbackShown) : rows;
  useEffect(() => {
    if (!moreFocus.current || loading) return;
    moreFocus.current = false;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost) (moreButton.current ?? footerStatus.current)?.focus();
  }, [loading, visibleRows.length]);
  const basis =
    metadata?.dayBasis === "device-local"
      ? "按各设备本地日期归档"
      : metadata?.dayBasis
        ? `日期统计方式：${metadata.dayBasis}`
        : "日期统计方式未提供";
  return (
    <section className="archive-panel" aria-labelledby="archive-title" data-feel-card>
      <header className="archive-header">
        <div>
          <span className="archive-eyebrow">
            <Clock3 size={15} aria-hidden="true" />
            历史记录
          </span>
          <h2 id="archive-title">每日归档</h2>
          <p>
            {fallback
              ? dataMode === "demo"
                ? "演示数据 · 展示概览中已有的日期"
                : "归档接口暂不可用 · 展示概览中已有的日期"
              : metadata?.retentionDays
                ? `最多保留 ${metadata.retentionDays} 天记录。`
                : "按日汇总历史用量与费用。"}
          </p>
        </div>
        {dataMode === "live" && historyAvailable !== false && (
          <button
            className="archive-button"
            disabled={!accessToken}
            aria-busy={loading}
            onClick={() => {
              setFallback(false);
              activeRequest.current?.abort();
              const revision = ++context.current;
              busy.current = false;
              void load(null, [], revision);
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
        )}
      </header>
      <div className="archive-context">
        {!fallback && metadata ? (
          <>
            <p>
              {basis}。
              {metadata.deviceTimeZone
                ? `设备时区：${metadata.deviceTimeZone}。`
                : ""}
              {metadata.dashboardTimeZone
                ? `当前时区：${metadata.dashboardTimeZone}。`
                : ""}
            </p>
            {metadata.mixedTimeZones && (
              <p className="archive-warning">
                包含多个设备时区；同一日期对应各设备本地日。
              </p>
            )}
            {metadata.partial && (
              <p className="archive-warning">
                部分归档数据未能完整读取
                {metadata.partialErrorCount
                  ? `（${metadata.partialErrorCount} 处）`
                  : ""}
                ，请参考每日完整性标记。
              </p>
            )}
          </>
        ) : null}
      </div>
      {error && (
        <div className="archive-feedback" role="alert">
          <p>{error}</p>
          <button
            className="archive-button"
            disabled={loading}
            onClick={() =>
              void load(
                lastRequest.current.cursor,
                lastRequest.current.previous,
              )
            }
          >
            重试
          </button>
        </div>
      )}
      {dataMode === "live" && !accessToken && (
        <p className="archive-empty">连接服务后可读取每日归档。</p>
      )}
      {!visibleRows.length &&
        !loading &&
        !error &&
        (dataMode === "demo" || accessToken) && (
          <p className="archive-empty">当前没有可显示的每日记录。</p>
        )}
      {visibleRows.length > 0 && (
        <div className="archive-columns" aria-hidden="true">
          <span>日期</span>
          <span>词元</span>
          <span>费用（美元）</span>
        </div>
      )}
      <div className="archive-days" aria-busy={loading}>
        {visibleRows.map((row) => (
          <ArchiveRow key={row.day} row={row} />
        ))}
      </div>
      <footer className="archive-footer">
        <span
          aria-live="polite"
          className={loading ? "beautiful-loading-text" : undefined}
          ref={footerStatus}
          tabIndex={-1}
        >
          {loading
            ? visibleRows.length
              ? "正在加载更多归档…"
              : "正在读取每日归档…"
            : fallback && visibleRows.length < fallbackRows.length
              ? `已显示 ${visibleRows.length} / ${fallbackRows.length} 天`
              : `已显示 ${visibleRows.length} 天`}
        </span>
        {!fallback && cursor && (
          <button
            ref={moreButton}
            className="archive-button"
            disabled={loading}
            onClick={() => {
              moreFocus.current = true;
              void load(cursor, rows);
            }}
          >
            加载更多
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        )}
        {fallback && visibleRows.length < fallbackRows.length && (
          <button
            ref={moreButton}
            className="archive-button"
            onClick={() => {
              moreFocus.current = true;
              setFallbackShown((shown) => shown + FALLBACK_STEP);
            }}
          >
            加载更多
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        )}
      </footer>
      {paginationNote && (
        <p className="archive-note archive-warning">{paginationNote}</p>
      )}
    </section>
  );
}
