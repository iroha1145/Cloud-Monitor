import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Folder } from "lucide-react";
import { PERIOD_LABELS, type DashboardData, type PeriodKey, type ProjectUsage as Project } from "./data";
import { MetricTooltip } from "./MetricTooltip";
import { compact, count, pct } from "./lib/format";
import { usd } from "./money";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";
import { BREAKDOWN_LABELS, groupedShares, projectShares, type ProjectBreakdown } from "./project-usage";
import "./project-usage.css";

const FIRST_ROWS = 6;
// The tooltip names more parts than the bar; past these the rest are one row.
const TOOLTIP_PARTS = 8;

function projectNote(project: Project): string | undefined {
  const parts: string[] = [];
  if (project.devices.length) parts.push(`来自 ${project.devices.join("、")}。`);
  if (project.unpricedTokens) parts.push(`另有 ${count(project.unpricedTokens)} 词元未提供单价，未计入费用。`);
  return parts.join("") || undefined;
}

/** Projects in the selected period, written like the clients card: a share of
 * the period's usage per row, split by model or by client. */
export function ProjectUsage({ data, period }: { data: DashboardData; period: PeriodKey }) {
  const [by, setBy] = useState<ProjectBreakdown>("model");
  const [shown, setShown] = useState(FIRST_ROWS);
  const rows = useRef<HTMLDivElement>(null);
  const breakdownSwitch = useSlidingIndicator<HTMLDivElement>('[aria-pressed="true"]');
  useEffect(() => setShown(FIRST_ROWS), [period]);
  const usage = data.projectsByPeriod?.[period];
  const projects = usage?.projects ?? [];
  const periodTotal = data.periods[period].totalTokens;
  const label = PERIOD_LABELS[period];
  return (
    <section className="panel projects-panel" data-feel-card aria-labelledby="projects-title">
      <div className="panel-head">
        <div>
          <h2 id="projects-title">项目用量</h2>
          <p>共 {projects.length} 个项目</p>
        </div>
        <div className="metric-switch" ref={breakdownSwitch} role="group" aria-label="项目用量拆分方式">
          <span data-sliding-indicator aria-hidden="true" />
          {(["model", "client"] as const).map((key) => (
            <button key={key} type="button" aria-pressed={by === key} onClick={() => setBy(key)}>
              按{BREAKDOWN_LABELS[key]}
            </button>
          ))}
        </div>
      </div>
      {usage?.incomplete && <p className="project-note">部分设备没有同步项目明细，项目用量可能不全。</p>}
      {projects.length ? (
        <div className="client-rows project-rows" ref={rows}>
          {projects.slice(0, shown).map((project) => {
            const shares = projectShares(project, by);
            const parts = groupedShares(shares, by);
            const share = periodTotal ? project.totalTokens / periodTotal : 0;
            return (
              <div className="client-row project-row" key={project.id} data-feel-item="row">
                <div className="client-head">
                  <span>
                    <span className="brand-icon" style={{ "--brand-size": "27px" } as CSSProperties} aria-hidden="true">
                      <Folder className="brand-icon-fallback" strokeWidth={1.7} />
                    </span>
                    <strong>{project.name}</strong>
                  </span>
                  <strong>{pct(share)}</strong>
                </div>
                <MetricTooltip
                  title={`${project.name} · 按${BREAKDOWN_LABELS[by]}`}
                  rows={[
                    { label: `占${label}全部用量`, value: pct(share) },
                    ...groupedShares(shares, by, TOOLTIP_PARTS).map((part) => ({
                      label: part.label,
                      value: `${compact(part.tokens)} · ${pct(part.share)}`,
                      color: part.color,
                    })),
                  ]}
                  note={projectNote(project)}
                  strictTouchBounds
                  focusable
                >
                  <div
                    className="metric-bar-trigger"
                    role="img"
                    aria-label={`${project.name} 用量 ${count(project.totalTokens)}，占${label}全部用量 ${pct(share)}`}
                  >
                    <div className="client-track" aria-hidden="true">
                      {/* Parts are scaled to the project, so the bar stays its share of the period. */}
                      {parts.map((part) => (
                        <span key={part.key} style={{ flexGrow: part.share * project.totalTokens, background: part.color }} />
                      ))}
                      {periodTotal > project.totalTokens && (
                        <span className="track-rest" style={{ flexGrow: periodTotal - project.totalTokens }} />
                      )}
                    </div>
                  </div>
                </MetricTooltip>
                {/* role keeps list semantics that Safari drops with list-style: none */}
                <ul className="project-share-legend" role="list" aria-label={`${project.name} 按${BREAKDOWN_LABELS[by]}的占比`}>
                  {parts.map((part) => (
                    <li key={part.key}>
                      <i style={{ background: part.color }} aria-hidden="true" />
                      <span>{part.label}</span>
                      <strong>{pct(part.share)}</strong>
                    </li>
                  ))}
                </ul>
                <div className="client-foot">
                  <span>{compact(project.totalTokens)} 词元</span>
                  <span>{usd(project.costUsd)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-inline">
          <strong>暂无项目用量</strong>
          <span>
            {usage?.reported === false
              ? `当前服务没有提供${label}的项目数据。`
              : "设备开启项目统计并同步会话后，这里会按项目列出用量。"}
          </span>
        </div>
      )}
      {projects.length > shown && (
        <button
          type="button"
          className="plain-button more-projects"
          onClick={(event) => {
            const first = shown;
            setShown((value) => value + 10);
            // A key press (detail 0) would leave focus on a button that may
            // vanish; carry it to the first project just shown.
            if (event.detail === 0) {
              requestAnimationFrame(() =>
                rows.current?.querySelectorAll<HTMLElement>(".metric-bar-trigger")[first]?.focus(),
              );
            }
          }}
        >
          再显示 {Math.min(10, projects.length - shown)} 个项目 <ChevronDown size={15} />
        </button>
      )}
      <div className="table-foot">
        <span>
          项目占比按{label}全部用量计算，{BREAKDOWN_LABELS[by]}占比按项目自身用量计算；没有项目信息的用量不计入项目。
        </span>
      </div>
    </section>
  );
}
