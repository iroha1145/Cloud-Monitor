/**
 * Adapted from Beautiful UI's MIT InsightCards.tsx (CompareCard/AnomalyCard).
 * Source copy: references/beautifului/InsightCards.tsx. Keep its inset chart,
 * Liveline stroke, compact metric header, pointer cursor and floating details.
 * Inspecting a day turns the metric header to that day (the scrub pattern of
 * stock apps); the popup keeps only the day's composition. Daily values are
 * always source records, never curve samples.
 * The stroke is Liveline's Fritsch–Carlson cubic through those daily points;
 * its same-Y live tip flattens the latest day against the dashed reference.
 * Slope rules live in trend-math.ts as the spec Android also follows.
 */
import { Suspense } from "react";
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
import { usd } from "./money";
import { compact, count, pct } from "./lib/format";
import { AppErrorBoundary, lazyWithReload } from "./chunkLoad";
import { indexForSelectedDay } from "./trend-math";
import { PART_COLOR, TREND_COLOR } from "./palette";
import { DAY_MS } from "./lib/datetime";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";
import { PopValue } from "./components/motion/pop-value";
import "./insight-trend.css";

const Liveline = lazyWithReload("liveline", () =>
  import("liveline").then((mod) => ({ default: mod.Liveline })),
);

// Liveline plots in seconds.
const DAY = DAY_MS / 1000;
// Room right of the plot for Liveline's value labels: the scale reads on the
// right, as in Arc UI's line chart. Pointer, cursor and dates use plot width.
const AXIS = 56;
/** Short scale labels that fit AXIS: 8000万, 1.2亿, $90, $4.5, $0.25. */
const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);
function axisLabel(value: number, metric: "tokens" | "cost") {
  if (metric === "cost") {
    if (value >= 100) return `$${Math.round(value)}`;
    return value >= 1 ? `$${oneDecimal(value)}` : `$${value.toFixed(2)}`;
  }
  if (value >= 1e8) return `${oneDecimal(value / 1e8)}亿`;
  if (value >= 1e4) return `${oneDecimal(value / 1e4)}万`;
  return String(Math.round(value));
}
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


function DayDetails({
  point,
  short = false,
}: {
  point: TrendPoint;
  /** The phone strip writes 5347.3 万 rather than 53,472,804. */
  short?: boolean;
}) {
  const parts = point.components;
  const amount = short ? compact : count;
  const rows = [
    {
      label: "缓存读取",
      value: parts?.cacheReadKnown ? amount(parts.cacheRead) : "未提供",
      color: PART_COLOR.cacheRead,
    },
    {
      label: "非缓存输入",
      value: parts?.inputKnown ? amount(parts.input) : "未提供",
      color: PART_COLOR.input,
    },
    {
      label: "输出",
      value: parts?.outputKnown ? amount(parts.output) : "未提供",
      color: PART_COLOR.output,
    },
    {
      label: "缓存写入",
      value: parts?.cacheWriteKnown ? amount(parts.cacheWrite) : "未提供",
      color: PART_COLOR.cacheWrite,
    },
    {
      label: "未分类",
      value: parts ? amount(parts.unclassified) : "未提供",
      color: PART_COLOR.unclassified,
    },
  ];
  return (
    <div className="insight-trend-tooltip">
      <div className="insight-trend-tooltip-title">
        <time dateTime={point.day}>{point.day}</time>
        <span>当天用量组成</span>
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
  dayX,
  id,
}: {
  point: TrendPoint;
  anchor: DetailAnchor;
  plot?: DOMRect;
  /** The inspected day's cursor line, which the popup must leave visible. */
  dayX?: number;
  id: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const touch = anchor.input === "touch";
  useLayoutEffect(() => {
    const popup = element.current;
    if (!popup) return;
    const view = window.visualViewport;
    const margin = 8;
    const viewLeft = (view?.offsetLeft ?? 0) + margin;
    const viewTop = (view?.offsetTop ?? 0) + margin;
    const viewRight = viewLeft + (view?.width ?? window.innerWidth) - margin * 2;
    const viewBottom = viewTop + (view?.height ?? window.innerHeight) - margin * 2;
    // The popup lives inside the plot band: the header above reads the same
    // day, and the footer below holds the day buttons.
    const left = Math.max(viewLeft, plot ? plot.left : viewLeft);
    const right = Math.min(viewRight, plot ? plot.right : viewRight);
    const top = Math.max(viewTop, plot ? plot.top + margin : viewTop);
    const bottom = Math.min(viewBottom, plot ? plot.bottom - margin : viewBottom);
    let x: number;
    let y: number;
    let scale: number;
    if (touch) {
      // A finger hides what is under it, and a phone's plot is too small for
      // the card beside it: a strip across the plot, at the edge away from
      // the finger. Narrow phones list the parts in one column.
      popup.style.width = `${Math.max(1, right - left)}px`;
      popup.toggleAttribute("data-narrow", right - left < 300);
      scale = Math.min(1, Math.max(1, bottom - top) / popup.offsetHeight);
      const height = popup.offsetHeight * scale;
      x = left;
      y = anchor.y < (top + bottom) / 2 ? bottom - height : top;
    } else {
      popup.style.width = `${Math.min(220, Math.max(1, right - left))}px`;
      // Only very short or zoomed viewports need scaling; every row stays.
      scale = Math.min(1, Math.max(1, bottom - top) / popup.offsetHeight);
      const width = popup.offsetWidth * scale;
      const height = popup.offsetHeight * scale;
      const gap = 16;
      const line = dayX ?? anchor.x;
      // Beside the day line, clear of the value labels at the right; flip
      // to the line's left when that side does not fit.
      const drawRight = plot ? Math.max(left, plot.right - AXIS) : right;
      x = line + gap;
      if (x + width > drawRight) {
        const flipped = line - gap - width;
        if (flipped >= left || line - left > drawRight - line) x = flipped;
      }
      // A mouse keeps it centred on the pointer's height; keyboard and the
      // day buttons centre it in the plot.
      y = anchor.y - height / 2;
      x = Math.min(Math.max(x, left), right - width);
      y = Math.min(Math.max(y, top), bottom - height);
    }
    popup.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    popup.style.visibility = "visible";
  }, [anchor, point, plot, dayX, touch]);
  return createPortal(
    <div
      ref={element}
      id={id}
      className="insight-trend-floating"
      role="tooltip"
      data-input={anchor.input}
      data-layout={touch ? "strip" : "card"}
    >
      <DayDetails point={point} short={touch} />
    </div>,
    document.body,
  );
}

export function InsightTrend({ data }: { data: DashboardData }) {
  const dark = useDarkMode();
  const uid = useId();
  const [days, setDays] = useState("7");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>(null);
  const [pointerAnchor, setPointerAnchor] = useState<DetailAnchor | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLSpanElement>(null);
  const metricSwitch = useSlidingIndicator<HTMLDivElement>('[aria-pressed="true"]');
  const pointerDown = useRef(false);
  // A tap focuses the plot after its pointerup; that focus is not keyboard use.
  const pointerAt = useRef(0);
  const series = useMemo(() => {
    const last = data.trend.at(-1);
    if (!last) return [];
    const lastTime = utcDay(last.day);
    const floor = lastTime - (Number(days) - 1) * DAY;
    return data.trend.filter((point) => utcDay(point.day) >= floor);
  }, [data.trend, days]);
  const seriesTimes = useMemo(() => series.map((point) => utcDay(point.day)), [series]);
  const {
    tokenTotal, hasCost, allCosts, costTotal, cacheRate, partialCache,
    cacheDays, cacheSkippedDays,
  } = summarizeTrend(series);
  const pointIndex = indexForSelectedDay(series, selectedDay);
  const point = series[pointIndex];
  const firstDay = series[0]?.day;
  const lastDay = series.at(-1)?.day;
  const firstTime = seriesTimes[0];
  const lastTime = seriesTimes.at(-1);
  const span =
    firstTime != null && lastTime != null
      ? Math.max(DAY, lastTime - firstTime)
      : DAY;
  // The chart always holds every reported day; the range only sets how much
  // of it is in view, so 7 ↔ 30 days is Liveline's own window zoom. A paused
  // Liveline keeps the data it mounted with, hence the key on the values.
  const chart = useMemo(() => {
    const end = Date.now() / 1000;
    const last = data.trend.at(-1);
    if (!last) return { points: [], end, value: 0, key: metric };
    const lastStamp = utcDay(last.day);
    const values = data.trend.flatMap((item) =>
      metric !== "tokens" && item.costUsd === null
        ? []
        : [
            {
              time: end - (lastStamp - utcDay(item.day)),
              value: metric === "tokens" ? item.totalTokens : item.costUsd!,
            },
          ],
    );
    return {
      points: values,
      end,
      value: values.at(-1)?.value ?? 0,
      key: `${metric}:${data.trend.map((item) => `${item.day}=${item.totalTokens}/${item.costUsd}`).join(",")}`,
    };
  }, [data.trend, metric]);

  useEffect(() => {
    setSelectedDay(null);
    setPointerAnchor(null);
    setDetailMode(null);
  }, [days, metric]);
  // Scrolling or resizing ends a pointer inspection. Keyboard and day-button
  // inspection stay open and only re-measure: focusing the chart scrolls it
  // into view smoothly, and that scroll must not close what the focus opened.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const dismiss = () => {
      setPointerAnchor(null);
      setDetailMode((mode) => (mode === "pointer" ? null : mode));
      setViewportTick((tick) => tick + 1);
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
  const [plot, setPlot] = useState<DOMRect | undefined>();
  useLayoutEffect(() => {
    if (detailMode === null) {
      setPlot(undefined);
      return;
    }
    setPlot(stageRef.current?.getBoundingClientRect());
  }, [detailMode, selectedDay, days, metric, viewportTick]);

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
        ((event.clientX - bounds.left) / (bounds.width - AXIS) - 0.015) / 0.97,
      ),
    );
    const origin = seriesTimes[0];
    if (origin == null) return;
    const targetDay = origin + progress * span;
    const nearest = seriesTimes.reduce(
      (best, time, i) =>
        Math.abs(time - targetDay) < Math.abs(seriesTimes[best] - targetDay)
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
    setSelectedDay(series[nearest]?.day ?? null);
  };
  const moveDay = (direction: number) => {
    const next = Math.max(
      0,
      Math.min(series.length - 1, pointIndex + direction),
    );
    setSelectedDay(series[next]?.day ?? null);
  };
  const handleKey = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)
    )
      return;
    event.preventDefault();
    setDetailMode("keyboard");
    setPointerAnchor(null);
    if (event.key === "Escape") setDetailMode(null);
    else if (event.key === "Home") setSelectedDay(series[0]?.day ?? null);
    else if (event.key === "End") setSelectedDay(series.at(-1)?.day ?? null);
    else
      moveDay(
        event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1,
      );
  };
  // The original line colours: tokens blue, cost orange (palette.ts).
  const lineColor = TREND_COLOR[metric];
  const position =
    point && firstTime != null
      ? 1.5 + ((seriesTimes[pointIndex] - firstTime) / span) * 97
      : 98.5;
  const tooltipVisible = detailMode !== null && selectedDay !== null && point;
  const day = tooltipVisible ? point : null;
  // Keyboard and day buttons anchor beside the cursor line, not over it.
  const detailAnchor =
    pointerAnchor ||
    (plot
      ? {
          x: plot.left + ((plot.width - AXIS) * position) / 100,
          y: plot.top + plot.height / 2,
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
          <p>每日词元、费用与缓存</p>
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

      {/* While a day is inspected the header reads that day, so the numbers
          sit where the eye already is instead of in a popup over the line. */}
      <div className="insight-trend-metrics" data-day={day?.day}>
        <div>
          <span>
            <i style={{ background: TREND_COLOR.tokens }} aria-hidden="true" />
            {day ? `${shortDay(day.day)} 词元` : "区间词元"}
          </span>
          <strong>
            <PopValue value={compact(day ? day.totalTokens : tokenTotal)} />
          </strong>
          <small>
            {day ? `${count(day.totalTokens)} 词元` : `${series.length} 天已记录`}
          </small>
        </div>
        <div>
          <span>
            <i style={{ background: TREND_COLOR.cost }} aria-hidden="true" />
            {day ? "当天花费" : allCosts ? "区间花费" : hasCost ? "已知花费" : "区间花费"}
          </span>
          <strong>
            <PopValue value={usd(day ? day.costUsd : costTotal)} />
          </strong>
          <small>美元（USD）</small>
        </div>
        <div>
          <span>
            <i style={{ background: TREND_COLOR.cache }} aria-hidden="true" />
            {(day ? day.components?.partial && day.components.cacheRate !== null : partialCache && cacheRate !== null)
              ? "已识别缓存占比"
              : "缓存占比"}
          </span>
          <strong>
            <PopValue value={pct(day ? day.components?.cacheRate ?? null : cacheRate)} />
          </strong>
          <small>
            {day
              ? "缓存读取 ÷ 总词元"
              : cacheSkippedDays > 0
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
            ref={metricSwitch}
            className="insight-trend-switch"
            role="group"
            aria-label="趋势指标"
          >
            <span data-sliding-indicator aria-hidden="true" />
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
              aria-label="每日趋势，使用方向键查看日期"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, series.length - 1)}
              aria-valuenow={Math.max(0, pointIndex)}
              aria-valuetext={
                point
                  ? `${point.day}，${count(point.totalTokens)} 词元，当天花费 ${usd(point.costUsd)}，${point.components?.partial && point.components.cacheRate !== null ? "已识别缓存占比" : "缓存占比"} ${pct(point.components?.cacheRate ?? null)}`
                  : "暂无记录"
              }
              aria-describedby={`${uid}-hint${tooltipVisible ? ` ${uid}-details` : ""}`}
              onPointerDown={(event) => {
                pointerDown.current = true;
                pointerAt.current = performance.now();
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
                if (pointerDown.current || performance.now() - pointerAt.current < 1000) return;
                setDetailMode("keyboard");
                setPointerAnchor(null);
                setSelectedDay((current) => current ?? series.at(-1)?.day ?? null);
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
                <AppErrorBoundary fallback={
                  <div className="insight-trend-no-line" role="status">
                    <strong>趋势曲线暂时无法加载</strong>
                    <span>仍可按日期查看已有明细。</span>
                  </div>
                }>
                  <div className="insight-trend-canvas" aria-hidden="true">
                    <Suspense fallback={null}>
                      <Liveline
                        key={chart.key}
                        data={chart.points}
                        value={chart.value}
                        theme={dark ? "dark" : "light"}
                        color={lineColor}
                        grid
                        badge={false}
                        showValue={false}
                        pulse={false}
                        momentum={false}
                        fill
                        scrub={false}
                        paused
                        window={span / 0.97}
                        cursor="crosshair"
                        lineWidth={2.25}
                        padding={{ top: 38, right: AXIS, bottom: 16, left: 0 }}
                        formatValue={(value) => axisLabel(value, metric)}
                        formatTime={() => ""}
                      />
                    </Suspense>
                  </div>
                </AppErrorBoundary>
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
                    style={{ left: `calc((100% - ${AXIS}px) * ${position / 100})` }}
                  />
                  {detailAnchor && (
                    <FloatingDayDetails
                      point={point}
                      anchor={detailAnchor}
                      plot={plot}
                      dayX={
                        plot
                          ? plot.left + ((plot.width - AXIS) * position) / 100
                          : undefined
                      }
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
                  {point ? shortDay(point.day) : "未提供"}
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

