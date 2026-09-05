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
import "./archive-panel.css";

export interface ArchivePanelProps {
  accessToken: string;
  dataMode: "live" | "demo";
  onAuthExpired?: () => void;
  fallbackData?: ArchiveFallbackData;
  historyAvailable?: boolean;
}
const formatCount = (value: number | null) =>
  value === null ? "未提供" : value.toLocaleString("zh-CN");
const formatCost = (value: number | null) =>
  value === null
    ? "未提供"
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
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
      <h4>{title}</h4>
      {entries.length ? (
        <dl>
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{formatCount(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>未提供构成明细</p>
      )}
    </section>
  );
}
function ArchiveRow({ row }: { row: ArchiveDay }) {
  const incomplete =
    row.complete === false || (row.coverage !== null && row.coverage < 60);
  return (
    <details className="archive-day">
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
          <small>用量（Token）</small>
          <strong>{formatCount(row.tokens)}</strong>
        </span>
        <span className="archive-cost">
          <small>费用（美元）</small>
          <strong>{formatCost(row.costUsd)}</strong>
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
            "部分记录可能损坏或缺失，已显示的数据仅代表可读取部分。"}
        </p>
        <div className="archive-compositions">
          <Composition title="客户端构成" values={row.perClient} />
          <Composition title="模型构成" values={row.perModel} />
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
    if (dataMode === "live" && historyAvailable !== false && accessToken)
      void load(null, [], revision);
    return () => {
      activeRequest.current?.abort();
      ++context.current;
      busy.current = false;
    };
    // Requests reset only when their authentication or source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, dataMode, historyAvailable]);
  const visibleRows = fallback ? makeArchiveFallback(fallbackData) : rows;
  const basis =
    metadata?.dayBasis === "device-local"
      ? "按各设备本地日期归档"
      : metadata?.dayBasis
        ? `服务报告的日期口径：${metadata.dayBasis}`
        : "日期口径未提供";
  return (
    <section className="archive-panel" aria-labelledby="archive-title">
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
                ? `服务最多保留 ${metadata.retentionDays} 天，按日期逐页加载。`
                : "读取设备每日归档，按日期逐页加载。"}
          </p>
        </div>
        {dataMode === "live" && historyAvailable !== false && (
          <button
            className="archive-button"
            disabled={loading || !accessToken}
            onClick={() => {
              setFallback(false);
              void load(null, []);
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
        )}
      </header>
      <div className="archive-context">
        {fallback ? (
          <p>
            费用与模型明细只显示概览已经提供的内容；没有归档完整性、覆盖率或客户端构成的数据会标为未提供。
          </p>
        ) : metadata ? (
          <>
            <p>
              {basis}。
              {metadata.deviceTimeZone
                ? `设备时区：${metadata.deviceTimeZone}。`
                : ""}
              {metadata.dashboardTimeZone
                ? `仪表盘时区：${metadata.dashboardTimeZone}。`
                : ""}
            </p>
            {metadata.mixedTimeZones && (
              <p className="archive-warning">
                包含多个设备时区；同一日期对应各设备各自的本地日，并非同一个绝对时间区间。
              </p>
            )}
            {metadata.partial && (
              <p className="archive-warning">
                部分归档未能完整读取
                {metadata.partialErrorCount
                  ? `（${metadata.partialErrorCount} 处）`
                  : ""}
                ，请留意每日完整性标记。
              </p>
            )}
          </>
        ) : (
          <p>归档会保留服务报告的日期、费用和完整性。</p>
        )}
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
      <div className="archive-days" aria-busy={loading}>
        {visibleRows.map((row) => (
          <ArchiveRow key={row.day} row={row} />
        ))}
      </div>
      <footer className="archive-footer">
        <span aria-live="polite">
          {loading
            ? visibleRows.length
              ? "正在加载更多归档…"
              : "正在读取每日归档…"
            : `已显示 ${visibleRows.length} 天`}
        </span>
        {!fallback && cursor && (
          <button
            className="archive-button"
            disabled={loading}
            onClick={() => void load(cursor, rows)}
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
