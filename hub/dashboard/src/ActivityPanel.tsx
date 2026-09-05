import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown, Info, X } from "lucide-react";
import { MetricTooltip } from "./MetricTooltip";
import type { ActivityCoverage, ActivityMetadata, DashboardData } from "./data";
import "./ActivityPanel.css";

type ActivityView = "day" | "week" | "month";
type Cell = { day: string; label: string; total: number | null; future?: boolean; hour?: number };
const VIEWS: ActivityView[] = ["day", "week", "month"];
const VIEW_LABELS = { day: "日", week: "周", month: "月" };
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const DAY = 86_400_000;
const full = (value: number | null) => value === null ? "未提供" : value.toLocaleString("zh-CN");
const compact = (value: number) => value >= 100_000_000
  ? `${(value / 100_000_000).toFixed(2)} 亿`
  : value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : full(value);
const addDay = (day: string, offset: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
const mondayIndex = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

function fallbackMetadata(data: DashboardData): ActivityMetadata {
  let today: string | null = null;
  try {
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: data.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(data.generatedAt));
  } catch { /* Older payloads with no usable date keep the calendar unavailable. */ }
  return {
    timeZone: data.timeZone, today, month: today?.slice(0, 7) || null,
    hourlyDay: today, hourlyStatus: data.hourly.length ? "ready" : "unavailable",
    dailyBasis: null, dailyMixedBasis: null, archiveCutoverDay: null, coverage: null,
  };
}

function samplingMode(value: string | null) {
  return ({
    delta: "增量采样", "delta-low-coverage": "采样覆盖不足",
    "delta-with-reset": "采样含计数重置", none: "暂无可归属采样",
  } as Record<string, string>)[value || ""] || value || "归属方式未提供";
}

function stamp(value: string | null, timeZone: string) {
  if (!value) return "未提供";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch { return "未提供"; }
}

function CoverageDetails({ coverage, metadata, data }: {
  coverage: ActivityCoverage; metadata: ActivityMetadata; data: DashboardData;
}) {
  const names = new Map(data.devices.map((device) => [device.id, device.name]));
  const low = coverage.attributionMode === "delta-low-coverage" ||
    (coverage.observedBuckets !== 0 && coverage.coveragePercent !== null && coverage.coveragePercent < 60);
  return (
    <div className="cm-activity-coverage">
      {low && <p className="cm-activity-warning"><Info size={13} aria-hidden="true" />
        小时分布按采样增量记录，可能集中在首次采样时段。
      </p>}
      <details>
        <summary>
          <span>采样覆盖率 <strong>{coverage.coveragePercent === null ? "未提供" : `${coverage.coveragePercent.toFixed(1)}%`}</strong></span>
          <span>采样说明 <ChevronDown size={13} aria-hidden="true" /></span>
        </summary>
        <dl className="cm-activity-sampling-grid">
          <div><dt>实际 / 期望采样</dt><dd>{full(coverage.observedBuckets)} / {full(coverage.expectedBuckets)}</dd></div>
          <div><dt>归属方式</dt><dd>{samplingMode(coverage.attributionMode)}</dd></div>
          <div><dt>首次采样</dt><dd>{stamp(coverage.firstSampleAt, metadata.timeZone)}</dd></div>
          <div><dt>最近采样</dt><dd>{stamp(coverage.lastSampleAt, metadata.timeZone)}</dd></div>
          {(coverage.gapCount !== null || coverage.resetCount !== null) && <>
            <div><dt>采样缺口</dt><dd>{full(coverage.gapCount)}</dd></div>
            <div><dt>计数重置</dt><dd>{full(coverage.resetCount)}</dd></div>
          </>}
        </dl>
        {coverage.devices.length > 0 && <ul className="cm-activity-device-coverage">
          {coverage.devices.map((device, index) => <li key={`${device.deviceId}-${index}`}>
            <strong>{names.get(device.deviceId) || device.deviceId || "未知设备"}</strong>
            <span>采样 {full(device.observedBuckets)} / {full(device.expectedBuckets)}</span>
            <span>缺口 {full(device.gapCount)} · 重置 {full(device.resetCount)}</span>
            {(device.firstSampleAt || device.lastSampleAt) && <small>
              {stamp(device.firstSampleAt, metadata.timeZone)} — {stamp(device.lastSampleAt, metadata.timeZone)}
            </small>}
          </li>)}
        </ul>}
      </details>
    </div>
  );
}

export function ActivityPanel({ data, selected, onSelect }: {
  data: DashboardData; selected: string | null; onSelect(day: string | null): void;
}) {
  const [view, setView] = useState<ActivityView>("month");
  const uid = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const metadata = data.activityMetadata || fallbackMetadata(data);
  const today = metadata.today;
  const dayMap = useMemo(() => new Map(data.activity.map((day) => [day.day, day.totalTokens])), [data.activity]);
  const hourMap = useMemo(() => new Map(data.hourly.map((hour) => [hour.hour, hour.totalTokens])), [data.hourly]);
  const cells: Cell[] = useMemo(() => {
    if (!today) return [];
    if (view === "day") return Array.from({ length: 24 }, (_, hour) => ({
      day: metadata.hourlyDay || today,
      label: String(hour).padStart(2, "0"),
      total: metadata.hourlyStatus === "ready" ? hourMap.get(hour) ?? null : null,
      hour,
    }));
    if (view === "week") {
      const start = addDay(today, -mondayIndex(today) - 7 * 11);
      return Array.from({ length: 84 }, (_, index) => {
        const day = addDay(start, index);
        return { day, label: "", total: dayMap.get(day) ?? null, future: day > today };
      });
    }
    if (!metadata.month) return [];
    const [year, month] = metadata.month.split("-").map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({ length: days }, (_, index) => {
      const day = `${metadata.month}-${String(index + 1).padStart(2, "0")}`;
      return { day, label: String(index + 1), total: dayMap.get(day) ?? null, future: day > today };
    });
  }, [view, today, metadata.month, metadata.hourlyDay, metadata.hourlyStatus, dayMap, hourMap]);
  const reported = cells.filter((cell) => !cell.future && cell.total !== null);
  const maximum = Math.max(1, ...reported.map((cell) => cell.total || 0));
  const total = reported.reduce((sum, cell) => sum + (cell.total || 0), 0);
  const active = reported.filter((cell) => (cell.total || 0) > 0).length;
  const missing = cells.filter((cell) => !cell.future && cell.total === null).length;
  const monthLabel = metadata.month ? `${Number(metadata.month.slice(0, 4))} 年 ${Number(metadata.month.slice(5))} 月` : "日期未提供";
  const subtitle = view === "day" ? `${metadata.hourlyDay || today || "日期未提供"} · 24 小时`
    : view === "week" ? "最近 12 周 · 每格一天" : `${monthLabel} · 每格一天`;
  const hourlyMessage = {
    disabled: "服务尚未启用小时活动。",
    unavailable: "当前数据未提供小时活动，未上报时段保留为未知。",
    "date-mismatch": "小时记录与当前数据的日期不一致，已暂不展示。",
    ready: "",
  }[metadata.hourlyStatus];
  const dailyBasis = metadata.dailyMixedBasis === true || metadata.dailyBasis === "hybrid-dashboard-and-device-local"
    ? `历史活动包含设备本地日${metadata.archiveCutoverDay ? `（${metadata.archiveCutoverDay}及之前）` : ""}，跨时区设备不可视为同一日期。`
    : metadata.dailyBasis === "device-local" ? "每日记录按设备本地日期汇总。" : "";

  function switchByKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % VIEWS.length
      : event.key === "ArrowLeft" ? (index + VIEWS.length - 1) % VIEWS.length
      : event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setView(VIEWS[next]); tabs.current[next]?.focus();
  }
  function moveCell(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = view === "week"
      ? ({ ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 } as Record<string, number>)
      : { ArrowUp: view === "day" ? -6 : -7, ArrowDown: view === "day" ? 6 : 7, ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>;
    if (delta[event.key] === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = cells.reduce((latest, cell, cellIndex) => cell.future ? latest : cellIndex, -1);
    const next = event.key === "Home" ? 0 : event.key === "End" ? last
      : Math.max(0, Math.min(last, index + delta[event.key]));
    buttons.current[next]?.focus();
  }

  return <section className="sv-card sv-history-activity cm-activity-panel" aria-labelledby="sv-activity-title">
    <header className="cm-activity-head">
      <div><h2 id="sv-activity-title">活动一览</h2><p>{subtitle}</p></div>
      <div className="cm-activity-tabs" role="tablist" aria-label="活动时间范围">
        {VIEWS.map((option, index) => <button key={option} type="button" role="tab"
          id={`${uid}-${option}-tab`} aria-selected={view === option}
          aria-controls={`${uid}-panel`} tabIndex={view === option ? 0 : -1}
          ref={(element) => { tabs.current[index] = element; }}
          onClick={() => setView(option)} onKeyDown={(event) => switchByKey(event, index)}>
          {VIEW_LABELS[option]}
        </button>)}
      </div>
    </header>
    <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${view}-tab`} className="cm-activity-body">
      {!cells.length ? <p className="cm-activity-empty">活动日期未提供，收到有效的数据日期后显示活动。</p> : <>
        {view === "day" && hourlyMessage && <p className="cm-activity-empty">{hourlyMessage}</p>}
        {view === "month" && <div className="cm-activity-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>}
        <div className={`cm-activity-grid cm-activity-grid-${view}`} key={view} role="group"
          aria-label={view === "day" ? "小时用量；方向键移动，回车查看详情" : "每日活动；方向键移动，回车筛选日期"}>
          {view === "month" && Array.from({ length: mondayIndex(`${metadata.month}-01`) }, (_, index) => <span key={`space-${index}`} aria-hidden="true" />)}
          {cells.map((cell, index) => {
            const level = cell.total === null ? "unknown" : cell.total === 0 ? "0"
              : String(Math.min(4, Math.max(1, Math.ceil(cell.total / maximum * 4))));
            const label = cell.hour === undefined ? cell.day
              : `${cell.day} ${cell.label}:00–${String((cell.hour + 1) % 24).padStart(2, "0")}:00`;
            if (cell.future) return <span className="cm-activity-cell is-future" key={cell.day}
              aria-label={`${cell.day}，尚未到来`}>{cell.label}</span>;
            return <MetricTooltip key={cell.hour ?? cell.day} title={label}
              preserveAction={cell.hour === undefined}
              rows={[{ label: "词元用量", value: cell.total === null ? "未上报" : full(cell.total) }]}
              note={cell.hour === undefined ? "点击日期筛选会话" : `活动时区：${metadata.timeZone}`}>
              <button type="button" className={`cm-activity-cell${selected === cell.day && view !== "day" ? " is-selected" : ""}`}
                data-level={level} data-day={cell.day} data-hour={cell.hour}
                aria-pressed={cell.hour === undefined ? selected === cell.day : undefined}
                aria-label={`${label}，${cell.total === null ? "未上报用量" : `${full(cell.total)} 词元`}${cell.hour === undefined ? "，点击筛选会话" : ""}`}
                ref={(element) => { buttons.current[index] = element; }}
                onClick={cell.hour === undefined ? () => onSelect(selected === cell.day ? null : cell.day) : undefined}
                onKeyDown={(event) => moveCell(event, index)}>{cell.label}</button>
            </MetricTooltip>;
          })}
        </div>
        <div className="cm-activity-range"><span>{metadata.timeZone}</span><span className="cm-activity-legend" aria-label="颜色越深，用量越多">少{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}多</span></div>
        <div className="cm-activity-summary">
          <MetricTooltip title="已上报用量合计" rows={[{ label: "词元用量", value: reported.length ? full(total) : "未上报" }]} note="仅合计已上报的时段，未知记录不计为零。">
            <span><small>已上报合计</small><strong>{reported.length ? compact(total) : "—"}</strong></span>
          </MetricTooltip>
          <span><small>有活动{view === "day" ? "时段" : "日期"}</small><strong>{reported.length ? `${active} ${view === "day" ? "小时" : "天"}` : "—"}</strong></span>
          <span><small>已上报{view === "day" ? "时段" : "日期"}</small><strong>{reported.length} / {cells.filter((cell) => !cell.future).length}</strong></span>
        </div>
        {missing > 0 && <p className="cm-activity-missing">斜线格表示未上报，与零用量分开显示。</p>}
      </>}
      <label className="sv-mobile-date-picker">
        <span>按日期筛选会话</span>
        <input type="date" aria-label="按日期筛选会话" value={selected || ""}
          max={today || undefined} onChange={(event) => onSelect(event.target.value || null)} />
      </label>
      {selected && <button type="button" className="cm-activity-selection" onClick={() => onSelect(null)} aria-label="取消活动日期选择">
        已选 {selected}<X size={12} aria-hidden="true" />
      </button>}
      {view !== "day" && dailyBasis && <p className="cm-activity-warning"><Info size={13} aria-hidden="true" />{dailyBasis}</p>}
    </div>
    {metadata.coverage ? <CoverageDetails coverage={metadata.coverage} metadata={metadata} data={data} />
      : <p className="cm-activity-coverage-missing">采样覆盖信息未提供。</p>}
  </section>;
}
