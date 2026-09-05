/**
 * Adapted from Beautiful UI's MIT InsightCards.tsx (CompareCard/AnomalyCard).
 * Source copy: references/beautifului/InsightCards.tsx. Keep its inset chart,
 * Liveline stroke, compact metric header, pointer cursor and floating details.
 * Daily values in the tooltip are always source records, never curve samples.
 */
import { Liveline, type LivelinePoint } from "liveline";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, MoveHorizontal } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { summarizeTrend, type DashboardData, type TrendPoint } from "./data";
import "./insight-trend.css";

const DAY = 86_400;
const compact = (n: number) =>
  n >= 1e8
    ? `${(n / 1e8).toFixed(2)} 亿`
    : n >= 1e4
      ? `${(n / 1e4).toFixed(1)} 万`
      : n.toLocaleString("en-US");
const exact = (n: number) => n.toLocaleString("en-US");
const money = (n: number | null) =>
  n === null
    ? "未提供"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (n: number | null) =>
  n === null ? "未提供" : `${(n * 100).toFixed(1)}%`;
const shortDay = (day: string) =>
  `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;
const utcDay = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

function useDarkMode() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark")),
    );
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** The original primitive's Catmull-Rom smoothing; labels use raw daily rows. */
function smoothPoints(points: LivelinePoint[]): LivelinePoint[] {
  if (points.length < 3) return points;
  const result: LivelinePoint[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)].value;
    const p1 = points[i].value;
    const p2 = points[i + 1].value;
    const p3 = points[Math.min(points.length - 1, i + 2)].value;
    for (let sample = 0; sample < 9; sample += 1) {
      const t = sample / 9;
      const value =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      result.push({
        time: points[i].time + (points[i + 1].time - points[i].time) * t,
        value: Math.max(0, value),
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

function DayDetails({ point }: { point: TrendPoint }) {
  const parts = point.components;
  const rows = [
    {
      label: "缓存读取",
      value: parts?.cacheReadKnown ? exact(parts.cacheRead) : "未提供",
      color: "#25a878",
    },
    {
      label: "非缓存输入",
      value: parts?.inputKnown ? exact(parts.input) : "未提供",
      color: "#3d9aff",
    },
    {
      label: "输出",
      value: parts?.outputKnown ? exact(parts.output) : "未提供",
      color: "#f09a2f",
    },
    {
      label: "缓存写入",
      value: parts?.cacheWriteKnown ? exact(parts.cacheWrite) : "未提供",
      color: "#b393c5",
    },
    {
      label: "未分类",
      value: parts ? exact(parts.unclassified) : "未提供",
      color: "#b4becf",
    },
  ];
  return (
    <div className="insight-chart-tooltip insight-trend-tooltip">
      <div className="insight-trend-tooltip-title">
        <time dateTime={point.day}>{point.day}</time>
        <span>每日明细</span>
      </div>
      <strong className="insight-trend-tooltip-total">
        {exact(point.totalTokens)}
        <small>词元（Tokens）</small>
      </strong>
      <div className="insight-trend-tooltip-metrics">
        <span>
          <small>当天花费</small>
          <b>{money(point.costUsd)}</b>
        </span>
        <span>
          <small>
            {parts?.partial && parts.cacheRate !== null
              ? "已识别缓存占比"
              : "缓存占比"}
          </small>
          <b>{percent(parts?.cacheRate ?? null)}</b>
        </span>
      </div>
      <dl className="insight-trend-tooltip-rows">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>
              <i style={{ background: row.color }} />
              {row.label}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {!parts && <p>当天缓存与用量细项未提供。</p>}
      {parts && !parts.known && (
        <p>当天用量尚未分类，缓存与输入输出细项未提供。</p>
      )}
      {parts?.known && !parts.complete && (
        <p>细项与总量不一致，缓存占比暂不显示。</p>
      )}
      {parts?.known && parts.complete && parts.partial && (
        <p>仅显示已识别的用量，未分类部分未计作缓存。</p>
      )}
    </div>
  );
}

type DetailAnchor = {
  x: number;
  y: number;
  input: "mouse" | "touch" | "keyboard" | "navigation";
};
type DetailMode = "pointer" | "keyboard" | "navigation" | null;

/** Pointer location is independent of the nearest daily record. Rendering in
 * the body lets the popup follow both axes beyond the chart's clipped inset. */
function FloatingDayDetails({
  point,
  anchor,
  plot,
  id,
}: {
  point: TrendPoint;
  anchor: DetailAnchor;
  plot?: DOMRect;
  id: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = element.current;
    if (!popup) return;
    const view = window.visualViewport;
    const margin = 8;
    const minX = (view?.offsetLeft ?? 0) + margin;
    const minY = (view?.offsetTop ?? 0) + margin;
    const availableWidth = (view?.width ?? window.innerWidth) - margin * 2;
    const controlled =
      anchor.input === "keyboard" || anchor.input === "navigation";
    const viewportBottom =
      minY + (view?.height ?? window.innerHeight) - margin * 2;
    // Button/keyboard inspection stays above the plot's bottom edge. The
    // footer remains free even when the card is near the viewport bottom.
    const maxY =
      controlled && plot
        ? Math.min(viewportBottom, plot.bottom - margin)
        : viewportBottom;
    const availableHeight = Math.max(1, maxY - minY);
    popup.style.width = `${Math.min(260, availableWidth)}px`;
    // Only very short/zoomed viewports need scaling; keep every row visible.
    const scale = Math.min(1, availableHeight / popup.offsetHeight);
    const width = popup.offsetWidth * scale;
    const height = popup.offsetHeight * scale;
    const maxX = minX + availableWidth;
    const touch = anchor.input === "touch";
    const gap = touch ? 28 : 16;
    let x = touch ? anchor.x - width / 2 : anchor.x + gap;
    let y = touch ? anchor.y - height - gap : anchor.y + gap;
    if (!touch && x + width > maxX) x = anchor.x - width - gap;
    if (touch && y < minY) y = anchor.y + gap;
    if (!touch && y + height > maxY) y = anchor.y - height - gap;
    if (controlled && plot) {
      x = plot.left + (plot.width - width) / 2;
      y = plot.top + Math.max(margin, (plot.height - height) / 2);
    }
    x = Math.min(Math.max(x, minX), maxX - width);
    y = Math.min(Math.max(y, minY), maxY - height);
    popup.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    popup.style.visibility = "visible";
  }, [anchor, point, plot]);
  return createPortal(
    <div
      ref={element}
      id={id}
      className="insight-trend-floating"
      role="tooltip"
      data-input={anchor.input}
    >
      <DayDetails point={point} />
    </div>,
    document.body,
  );
}

export function InsightTrend({ data }: { data: DashboardData }) {
  const dark = useDarkMode();
  const uid = useId();
  const [days, setDays] = useState("30");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [selected, setSelected] = useState<number | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>(null);
  const [pointerAnchor, setPointerAnchor] = useState<DetailAnchor | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLSpanElement>(null);
  const pointerDown = useRef(false);
  const series = useMemo(() => {
    const last = data.trend.at(-1);
    if (!last) return [];
    const floor = utcDay(last.day) - (Number(days) - 1) * DAY;
    return data.trend.filter((point) => utcDay(point.day) >= floor);
  }, [data.trend, days]);
  const {
    tokenTotal, hasCost, allCosts, costTotal, cacheRate, partialCache,
    cacheDays, cacheSkippedDays,
  } = summarizeTrend(series);
  const pointIndex = Math.min(selected ?? series.length - 1, series.length - 1);
  const point = series[pointIndex];
  const firstDay = series[0]?.day;
  const lastDay = series.at(-1)?.day;
  const span =
    firstDay && lastDay
      ? Math.max(DAY, utcDay(lastDay) - utcDay(firstDay))
      : DAY;
  const chart = useMemo(() => {
    const end = Date.now() / 1000;
    const last = series.at(-1);
    if (!last) return { points: [], end, value: 0 };
    const values = series
      .filter((item) => metric === "tokens" || item.costUsd !== null)
      .map((item) => ({
        time: end - (utcDay(last.day) - utcDay(item.day)),
        value: metric === "tokens" ? item.totalTokens : item.costUsd!,
      }));
    return {
      points: smoothPoints(values),
      end,
      value: values.at(-1)?.value ?? 0,
    };
  }, [series, metric]);

  useEffect(() => {
    setSelected(null);
    setPointerAnchor(null);
    setDetailMode(null);
  }, [days, metric, data.trend]);
  useEffect(() => {
    const dismiss = () => {
      setPointerAnchor(null);
      setDetailMode(null);
      pointerDown.current = false;
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
    };
  }, []);
  useEffect(() => {
    if (!hasCost && metric === "cost") setMetric("tokens");
  }, [hasCost, metric]);

  const setFromPointer = (
    event: PointerEvent<HTMLDivElement>,
    explicit = false,
  ) => {
    if (!series.length) return;
    // Passing across the plot after choosing a date must not overwrite that
    // choice. A deliberate pointer press resumes scrubbing immediately.
    if (!explicit && (detailMode === "navigation" || detailMode === "keyboard"))
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    // Liveline without a badge reserves 1.5% at the right. The expanded
    // window below gives the same breathing room to the first daily point.
    const progress = Math.max(
      0,
      Math.min(
        1,
        ((event.clientX - bounds.left) / bounds.width - 0.015) / 0.97,
      ),
    );
    const targetDay = utcDay(series[0].day) + progress * span;
    const nearest = series.reduce(
      (best, item, i) =>
        Math.abs(utcDay(item.day) - targetDay) <
        Math.abs(utcDay(series[best].day) - targetDay)
          ? i
          : best,
      0,
    );
    setDetailMode("pointer");
    setPointerAnchor({
      x: event.clientX,
      y: event.clientY,
      input: event.pointerType === "touch" ? "touch" : "mouse",
    });
    setSelected(nearest);
  };
  const moveDay = (direction: number) =>
    setSelected((current) =>
      Math.max(
        0,
        Math.min(series.length - 1, (current ?? series.length - 1) + direction),
      ),
    );
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)
    )
      return;
    event.preventDefault();
    setDetailMode("keyboard");
    setPointerAnchor(null);
    if (event.key === "Escape") setDetailMode(null);
    else if (event.key === "Home") setSelected(0);
    else if (event.key === "End") setSelected(series.length - 1);
    else moveDay(event.key === "ArrowLeft" ? -1 : 1);
  };
  const lineColor = metric === "tokens" ? "#3d9aff" : "#f09a2f";
  const position =
    point && firstDay
      ? 1.5 + ((utcDay(point.day) - utcDay(firstDay)) / span) * 97
      : 98.5;
  const tooltipVisible = detailMode !== null && selected !== null && point;
  const stageBounds = stageRef.current?.getBoundingClientRect();
  const detailAnchor =
    pointerAnchor ||
    (stageBounds
      ? {
          x: stageBounds.left + stageBounds.width / 2,
          y: stageBounds.top + stageBounds.height / 2,
          input:
            detailMode === "navigation"
              ? ("navigation" as const)
              : ("keyboard" as const),
        }
      : null);
  // Missing costs remain explicit. A line across a missing day would imply a
  // complete expense series, so the chart switches to an honest sparse view.
  const canDraw = series.length >= 2 && (metric === "tokens" || allCosts);

  return (
    <section
      className="panel trend-panel insight-trend"
      aria-labelledby={`${uid}-title`}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && !pointerDown.current) {
          setDetailMode(null);
          setPointerAnchor(null);
        }
      }}
    >
      <div className="panel-head insight-trend-heading">
        <div>
          <h2 id={`${uid}-title`}>用量趋势</h2>
          <p>沿着曲线，查看每一天的花费与缓存</p>
        </div>
        <Tabs value={days} onValueChange={setDays}>
          <TabsList className="small-tabs" aria-label="趋势日期范围">
            {["7", "30"].map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                id={`${uid}-range-${value}`}
                aria-controls={`${uid}-content`}
              >
                {value} 天
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="insight-trend-metrics">
        <div>
          <span>
            <i style={{ background: "#3d9aff" }} />
            区间词元
          </span>
          <strong>{compact(tokenTotal)}</strong>
          <small>{series.length} 天已记录</small>
        </div>
        <div>
          <span>
            <i style={{ background: "#f09a2f" }} />
            {allCosts ? "区间花费" : hasCost ? "已知花费" : "区间花费"}
          </span>
          <strong>{money(costTotal)}</strong>
          <small>美元（USD）</small>
        </div>
        <div>
          <span>
            <i style={{ background: "#25a878" }} />
            {partialCache && cacheRate !== null ? "已识别缓存占比" : "缓存占比"}
          </span>
          <strong>{percent(cacheRate)}</strong>
          <small>
            {cacheSkippedDays > 0
              ? cacheDays > 0
                ? `仅统计 ${cacheDays}/${series.length} 天`
                : "暂无缓存明细"
              : "缓存读取 ÷ 总词元"}
          </small>
        </div>
      </div>

      <div
        className="insight-trend-inset"
        id={`${uid}-content`}
        role="tabpanel"
        aria-labelledby={`${uid}-range-${days}`}
      >
        <div className="insight-trend-toolbar">
          <span>
            {firstDay && lastDay
              ? `${shortDay(firstDay)} — ${shortDay(lastDay)}`
              : "等待每日记录"}
          </span>
          <div
            className="insight-trend-switch"
            role="group"
            aria-label="趋势指标"
          >
            <button
              type="button"
              aria-pressed={metric === "tokens"}
              onClick={() => setMetric("tokens")}
            >
              词元用量
            </button>
            <button
              type="button"
              aria-pressed={metric === "cost"}
              disabled={!hasCost}
              onClick={() => setMetric("cost")}
            >
              使用费用
            </button>
          </div>
        </div>
        {series.length > 0 ? (
          <>
            <div
              ref={stageRef}
              className="insight-chart-stage insight-trend-stage"
              role="slider"
              tabIndex={0}
              aria-label="每日趋势，使用左右方向键查看日期"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, series.length - 1)}
              aria-valuenow={Math.max(0, pointIndex)}
              aria-valuetext={
                point
                  ? `${point.day}，${exact(point.totalTokens)} 词元，当天花费 ${money(point.costUsd)}，${point.components?.partial && point.components.cacheRate !== null ? "已识别缓存占比" : "缓存占比"} ${percent(point.components?.cacheRate ?? null)}`
                  : "暂无记录"
              }
              aria-describedby={`${uid}-hint${tooltipVisible ? ` ${uid}-details` : ""}`}
              onPointerDown={(event) => {
                pointerDown.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                setFromPointer(event, true);
              }}
              onPointerMove={(event) => setFromPointer(event)}
              onPointerUp={() => {
                pointerDown.current = false;
              }}
              onPointerLeave={(event) => {
                if (
                  event.pointerType === "mouse" &&
                  detailMode === "pointer" &&
                  !pointerDown.current
                ) {
                  setDetailMode(null);
                  setPointerAnchor(null);
                }
              }}
              onPointerCancel={() => {
                pointerDown.current = false;
                setDetailMode(null);
                setPointerAnchor(null);
              }}
              onKeyDown={handleKey}
              onFocus={() => {
                if (pointerDown.current) return;
                setDetailMode("keyboard");
                setPointerAnchor(null);
                setSelected((current) => current ?? series.length - 1);
              }}
              onBlur={(event) => {
                if (
                  navigationRef.current?.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  return;
                setDetailMode(null);
                setPointerAnchor(null);
              }}
            >
              {canDraw ? (
                <div className="insight-trend-canvas" aria-hidden="true">
                  <Liveline
                    key={`${days}-${metric}-${data.generatedAt}`}
                    data={chart.points}
                    value={chart.value}
                    theme={dark ? "dark" : "light"}
                    color={lineColor}
                    grid={false}
                    badge={false}
                    showValue={false}
                    pulse={false}
                    momentum={false}
                    fill={false}
                    scrub={false}
                    paused
                    window={span / 0.97}
                    cursor="crosshair"
                    lineWidth={2.25}
                    padding={{ top: 38, right: 0, bottom: 24, left: 0 }}
                    formatValue={(value) =>
                      metric === "tokens" ? compact(value) : money(value)
                    }
                    formatTime={() => ""}
                  />
                </div>
              ) : (
                <div className="insight-trend-no-line">
                  <strong>
                    {metric === "cost" && !allCosts
                      ? "部分日期费用未提供"
                      : "已记录 1 天"}
                  </strong>
                  <span>移动到日期位置可查看已有明细</span>
                </div>
              )}
              {tooltipVisible && (
                <>
                  <span
                    className="insight-chart-cursor insight-trend-cursor"
                    style={{ left: `${position}%` }}
                  />
                  {detailAnchor && (
                    <FloatingDayDetails
                      point={point}
                      anchor={detailAnchor}
                      plot={stageBounds}
                      id={`${uid}-details`}
                    />
                  )}
                </>
              )}
            </div>
            <div className="insight-trend-dates" aria-hidden="true">
              <span>{shortDay(firstDay!)}</span>
              <span>
                {shortDay(
                  new Date((utcDay(firstDay!) + span / 2) * 1000)
                    .toISOString()
                    .slice(0, 10),
                )}
              </span>
              <span>{shortDay(lastDay!)}</span>
            </div>
            <div className="insight-trend-footer">
              <span id={`${uid}-hint`}>
                <MoveHorizontal aria-hidden="true" size={13} />
                {detailMode === "navigation" || detailMode === "keyboard"
                  ? "点按曲线，继续拖动查看明细"
                  : "悬停或按住拖动，查看当天明细"}
              </span>
              <span
                ref={navigationRef}
                className="insight-trend-day-nav"
                role="group"
                aria-label="逐日查看趋势"
                onKeyDown={handleKey}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (
                    !next ||
                    navigationRef.current?.contains(next) ||
                    stageRef.current?.contains(next)
                  )
                    return;
                  setDetailMode(null);
                  setPointerAnchor(null);
                }}
              >
                <button
                  type="button"
                  aria-label="查看前一天记录"
                  disabled={pointIndex <= 0}
                  onClick={() => {
                    setPointerAnchor(null);
                    setDetailMode("navigation");
                    moveDay(-1);
                  }}
                >
                  <ChevronLeft size={14} />
                </button>
                <time dateTime={point?.day}>
                  {point ? shortDay(point.day) : "—"}
                </time>
                <button
                  type="button"
                  aria-label="查看后一天记录"
                  disabled={pointIndex >= series.length - 1}
                  onClick={() => {
                    setPointerAnchor(null);
                    setDetailMode("navigation");
                    moveDay(1);
                  }}
                >
                  <ChevronRight size={14} />
                </button>
              </span>
            </div>
          </>
        ) : (
          <div className="insight-trend-empty">暂无每日用量记录</div>
        )}
      </div>
    </section>
  );
}

export default InsightTrend;
