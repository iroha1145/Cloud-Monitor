import { Suspense, useEffect, useRef, useState } from "react";
import { AppErrorBoundary, DialogErrorNotice, lazyWithReload } from "./chunkLoad";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  Cloud,
  Palette,
  UserRound,
  X,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  StatefulButton,
  type ButtonState,
} from "./components/motion/button/stateful";
import { NotificationBell } from "./components/rareui/notification-bell";
import { BrandMark } from "./BrandMark";
import GlideMenu from "./components/primitives/GlideMenu";
import { downloadCsv, rowsToCsv } from "./lib/csv";
import { scrollToTop } from "./lib/scroll";
import { useTheme } from "./lib/theme";
import { ThemeMenu } from "./ThemeMenu";
import { formatZoned } from "./lib/datetime";
import {
  createDemoData,
  PERIOD_LABELS,
  type DashboardData,
  type PeriodKey,
  type UsageEntity,
} from "./data";
import { loadDashboard, isAuthFailure } from "./api";
import { FloatingNavigation } from "./FloatingNavigation";
import { createElasticCards } from "./lib/elastic-cards";
import { installScrollReveal } from "./lib/scroll-reveal";
import { AnimatedNavIcon } from "./AnimatedNavIcon";
import { PAGES, type PageId } from "./pages";
import { PageSkeleton } from "./PageSkeleton";
import { DURATION, EASE_SMOOTH_OUT } from "./lib/motion";
import {
  ModelTable,
  Overview,
  Stats,
} from "./Overview";
import { pct } from "./lib/format";
import "./mobile.css";
import "./surface.css";

const DevicesView = lazyWithReload("secondary", async () => ({
  default: (await import("./SecondaryViews")).DevicesView,
}));
const HistoryView = lazyWithReload("secondary", async () => ({
  default: (await import("./SecondaryViews")).HistoryView,
}));
const QuotaView = lazyWithReload("secondary", async () => ({
  default: (await import("./SecondaryViews")).QuotaView,
}));
const ArchivePanel = lazyWithReload("archive", async () => ({
  default: (await import("./ArchivePanel")).ArchivePanel,
}));
const AppDialogs = lazyWithReload("dialogs", () => import("./AppDialogs"));
const ModelMatrixView = lazyWithReload("matrix", async () => ({
  default: (await import("./Overview")).ModelMatrix,
}));

// The shortcut handler takes either modifier; the hint names the one this
// platform's keyboard actually has.
const SEARCH_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";

// Showcase navigation is opt-in for a separate public demo build.
const SHOWCASE_UI = import.meta.env.VITE_SHOWCASE_UI === "true";

const getPage = (): PageId =>
  PAGES.find((p) => p.id === location.hash.slice(1))?.id || "overview";

type AppProps = { initialData?: DashboardData; initialToken?: string; hosted?: boolean; isolatedDemo?: boolean; onSignOut?: () => void };
export default function App({ initialData, initialToken = "", hosted = false, isolatedDemo = false, onSignOut }: AppProps) {
  const [data, setData] = useState<DashboardData>(() => initialData || createDemoData());
  const [page, setPage] = useState<PageId>(getPage),
    [period, setPeriod] = useState<PeriodKey>("today");
  const { preference, chooseTheme } = useTheme();
  const [mobile, setMobile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false),
    [settings, setSettings] = useState(false),
    [design, setDesign] = useState(false),
    [notifications, setNotifications] = useState(false);
  const [selected, setSelected] = useState<UsageEntity | null>(null),
    [secret, setSecret] = useState("");
  const [connectError, setConnectError] = useState(""),
    [keyRejected, setKeyRejected] = useState(false),
    [connecting, setConnecting] = useState(false),
    [refreshState, setRefreshState] = useState<ButtonState>("idle");
  const [toast, setToast] = useState("");
  const [dialogError, setDialogError] = useState(false);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const searchButton = useRef<HTMLButtonElement | null>(null);
  const rememberDialogOpener = (opener: HTMLElement | null) => {
    // The sheet's handle remains available after its menu content closes.
    dialogReturnFocus.current = opener?.closest(".feel-nav-drawer")
      ? document.querySelector<HTMLElement>("[data-mobile-navigation-trigger]")
      : opener;
    setDialogError(false);
  };
  const token = useRef(initialToken);
  const dataRef = useRef(data);
  dataRef.current = data;
  const inFlight = useRef<AbortController | null>(null);
  const [refreshWarning, setRefreshWarning] = useState("");
  const requestVersion = useRef(0);
  const reduce = useReducedMotion();
  const toastHidden = reduce
    ? { opacity: 0, y: 0, scale: 1, filter: "blur(0px)" }
    : { opacity: 0, y: 16, scale: 0.97, filter: "blur(2px)" };
  // The status dot rings once for each refresh that delivers a new snapshot.
  const firstSnapshot = useRef(data.generatedAt);
  const freshData = data.generatedAt !== firstSnapshot.current;
  // Dialogs load on first use and stay mounted, so closing can animate out.
  const [dialogsLoaded, setDialogsLoaded] = useState(false);
  if (!dialogsLoaded && (searchOpen || settings || notifications || !!selected || design))
    setDialogsLoaded(true);
  const current = PAGES.find((p) => p.id === page)!;
  const per = data.periods[period];
  const notices = [...new Set([
    ...(refreshWarning ? [refreshWarning] : []),
    ...data.notices,
    ...data.devices
      .filter((d) => d.status !== "online")
      .map(
        (d) =>
          `${d.name} ${d.status === "delayed" ? "上报有延迟，请检查设备端连接。" : "当前离线，已保留最近一次用量。"}`,
      ),
  ])];
  const statusCount = notices.length;
  // Cards give a little under a drag on their empty space and spring back.
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!workspace.current) return;
    const elastic = createElasticCards(workspace.current);
    // Cards below the fold rise in when they are scrolled to.
    const reveal = installScrollReveal(workspace.current);
    return () => { elastic.destroy(); reveal(); };
  }, []);
  // Sections rise in after navigation only; the first screen stays still.
  const [navigated, setNavigated] = useState(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const onHash = () => {
      const id = location.hash.slice(1);
      // In-page anchors such as the skip link are not pages.
      if (id && !PAGES.some((p) => p.id === id)) return;
      const next = getPage();
      if (next !== pageRef.current) setNavigated(true);
      setPage(next);
      setMobile(false);
      scrollToTop();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const activeDialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (!activeDialog || activeDialog.classList.contains("feel-nav-drawer")) {
          rememberDialogOpener(document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement : searchButton.current);
        }
        setMobile(false);
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(t);
  }, [toast]);
  const userRefresh = useRef(false);
  const demoRefreshes = useRef(0);
  useEffect(() => {
    if (data.mode !== "live") return;
    const cancel = () => {
      if (userRefresh.current) return;
      ++requestVersion.current;
      inFlight.current?.abort();
      setRefreshState("idle");
    };
    const update = async () => {
      if (document.hidden || userRefresh.current) return;
      inFlight.current?.abort();
      const controller = new AbortController(); inFlight.current = controller;
      setRefreshState("idle");
      const version = ++requestVersion.current;
      try {
        const next = await loadDashboard(token.current, controller.signal, value => {
          if (version === requestVersion.current) setData(value);
        }, dataRef.current);
        if (version === requestVersion.current) { setData(next); setRefreshWarning(""); }
      } catch (error) {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        if (isAuthFailure(error) && hosted) { onSignOut?.(); return; }
        setRefreshWarning("自动刷新未完成，已保留上次数据。请检查连接或重新刷新。");
      }
    };
    // HostedRoot has already loaded every enabled endpoint before mounting us.
    // Keep that complete first screen until a scheduled or explicit refresh.
    if (hosted && !initialData) void update();
    const timer = setInterval(() => void update(), 300000);
    const visible = () => { if (document.hidden) cancel(); else void update(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void update(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", restored);
    window.addEventListener("pagehide", cancel);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", cancel); window.removeEventListener("pageshow", restored); cancel(); };
  }, [data.mode, hosted, initialData, onSignOut]);
  useEffect(() => () => { ++requestVersion.current; inFlight.current?.abort(); }, []);
  const go = (id: string) => {
    location.hash = id;
    setMobile(false);
  };
  const refresh = async () => {
    if (refreshState === "loading") return;
    userRefresh.current = true;
    setRefreshState("loading");
    const version = ++requestVersion.current;
    inFlight.current?.abort();
    const controller = new AbortController(); inFlight.current = controller;
    try {
      if (data.mode === "live") {
        const next = await loadDashboard(token.current, controller.signal, value => {
          if (version === requestVersion.current) setData(value);
        }, dataRef.current);
        if (version !== requestVersion.current) return;
        setData(next);
      } else {
        await new Promise((r) => setTimeout(r, 600));
        if (version !== requestVersion.current) return;
        setData(createDemoData(new Date(), ++demoRefreshes.current));
      }
      setRefreshWarning("");
      setRefreshState("success");
      setToast(
        data.mode === "live" ? "已获取最新用量。" : "示例数据已重新加载。",
      );
    } catch (e) {
      if (version === requestVersion.current && !controller.signal.aborted) {
        if (isAuthFailure(e) && hosted) { onSignOut?.(); }
        else {
          setRefreshState("error");
          setRefreshWarning(e instanceof Error ? e.message : "刷新失败，已保留上次数据。");
          setToast(e instanceof Error ? e.message : "刷新失败，已保留上次数据。");
        }
      }
    } finally {
      userRefresh.current = false;
    }
    setTimeout(() => {
      if (version !== requestVersion.current) return;
      setRefreshState("idle");
    }, 1800);
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isolatedDemo || hosted || !secret.trim()) return;
    setConnecting(true);
    setConnectError("");
    setKeyRejected(false);
    const version = ++requestVersion.current;
    inFlight.current?.abort();
    const controller = new AbortController(); inFlight.current = controller;
    try {
      const live = await loadDashboard(secret.trim(), controller.signal);
      if (version !== requestVersion.current) return;
      token.current = secret.trim();
      setSecret("");
      setData(live);
      setSettings(false);
      setToast("已连接 Cloud Monitor，正在显示真实用量。");
    } catch (e) {
      if (version !== requestVersion.current) return;
      setKeyRejected(isAuthFailure(e));
      setConnectError(
        e instanceof Error ? e.message : "连接失败，请稍后重试。",
      );
    } finally {
      if (version === requestVersion.current) setConnecting(false);
    }
  };
  const showDemo = () => {
    requestVersion.current++;
    inFlight.current?.abort();
    setRefreshState("idle");
    token.current = "";
    setSecret("");
    setConnectError("");
    setKeyRejected(false);
    demoRefreshes.current = 0;
    setData(createDemoData());
    setSettings(false);
    setToast("已切换为示例工作区。");
  };
  const openSettings = (event: React.MouseEvent<HTMLElement>) => {
    rememberDialogOpener(event.currentTarget);
    setMobile(false);
    setSettings(true);
  };
  const openDesign = (event: React.MouseEvent<HTMLElement>) => {
    rememberDialogOpener(event.currentTarget);
    setMobile(false);
    setDesign(true);
  };
  const openModel = (model: UsageEntity, opener: HTMLButtonElement) => {
    rememberDialogOpener(opener);
    setSelected(model);
  };
  const exportModels = () => {
    const rows = [
      ["模型", "周期", "总词元", "缓存读取", "缓存占比", "费用美元"],
      ...per.models.map((m) => [
        m.name,
        PERIOD_LABELS[period],
        m.totalTokens,
        m.components.cacheReadKnown ? m.components.cacheRead : "未提供",
        pct(m.components.cacheRate),
        m.costUsd ?? "",
      ]),
    ];
    downloadCsv(`cloud-monitor-${data.mode}-${period}.csv`, rowsToCsv(rows));
    setToast("模型用量表已导出。");
  };
  const generated = new Date(data.generatedAt);
  // An unknown time zone falls back to the browser's own clock.
  const zoned = (options: Intl.DateTimeFormatOptions) =>
    formatZoned(generated, data.timeZone, options) ??
    generated.toLocaleString("zh-CN", options);
  const time = zoned({ hour: "2-digit", minute: "2-digit" });
  const date = zoned({ month: "long", day: "numeric" });
  const nav = (
    <>
      <a className="app-brand" href="#overview" aria-label="Cloud Monitor 首页">
        <BrandMark />
        <span>Cloud Monitor</span>
      </a>
      {SHOWCASE_UI && (
        <button className="workspace-picker" onClick={openSettings}>
          <span className="workspace-avatar">
            <Cloud size={17} />
          </span>
          <span>
            <strong>
              {data.mode === "demo" ? "示例工作区" : "我的工作区"}
            </strong>
            <small>
              {data.mode === "demo" ? "体验全新界面" : "已连接云端服务"}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
      )}
      <p className="nav-label">工作空间</p>
      <GlideMenu className="nav-list" highlightClassName="nav-hover">
        {PAGES.map((p) => (
          <a
            data-menu-row
            key={p.id}
            href={`#${p.id}`}
            aria-current={page === p.id ? "page" : undefined}
            className={`nav-item ${page === p.id ? "active" : ""}`}
          >
            <AnimatedNavIcon name={p.id} size={19} active={page === p.id} />
            <span>{p.name}</span>
            {p.id === "devices" && (
              <span className="nav-count">{data.devices.length}</span>
            )}
            {page === p.id && (
              <motion.span
                className="nav-active"
                layoutId="navigation-active"
                transition={{ type: "spring", stiffness: 400, damping: 36 }}
              />
            )}
          </a>
        ))}
      </GlideMenu>
      <div className="sidebar-bottom">
        <div className="sidebar-connection">
          <span className="sidebar-connection-state">
            <i className={`status-dot ${data.mode === "demo" ? "muted" : ""}`} />
            {hosted ? "已连接云端服务" : isolatedDemo ? "演示工作区" : data.mode === "demo" ? "示例数据 · 本地预览" : "真实数据 · 本地预览"}
          </span>
          {!hosted && !isolatedDemo && (
            <button className="sidebar-connect" onClick={openSettings}>
              {data.mode === "demo" ? "连接我的数据" : "管理数据连接"}
              <ArrowRight size={14} />
            </button>
          )}
        </div>
        {!hosted && <button className="sidebar-setting" onClick={openDesign}>
          <Palette size={16} />
          设计说明
        </button>}
        <button className="sidebar-setting" onClick={openSettings}>
          <AnimatedNavIcon name="settings" size={16} />
          工作区设置
        </button>
      </div>
    </>
  );
  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <div
        className={`app-shell ${SHOWCASE_UI ? "showcase-shell" : "dashboard-shell"}`}
      >
        <FloatingNavigation open={mobile} onOpenChange={setMobile} currentPage={page} onNavigate={go} pageName={current.name}>
          {nav}
        </FloatingNavigation>
        <div className="workspace-main" ref={workspace}>
          <header className="app-topbar" data-feel-card>
            <div className="topbar-left">
              <button
                className="command-search"
                ref={searchButton}
                aria-label="搜索或快速跳转"
                onClick={(event) => { rememberDialogOpener(event.currentTarget); setSearchOpen(true); }}
              >
                <AnimatedNavIcon name="search" size={16} />
                <span>搜索或快速跳转</span>
                <kbd>{SEARCH_SHORTCUT}</kbd>
              </button>
            </div>
            <div className="topbar-actions">
              {!hosted && <span className="preview-badge">{isolatedDemo ? "演示" : "本地预览"}</span>}
              <ThemeMenu preference={preference} onChoose={chooseTheme} />
              {SHOWCASE_UI && (
                <NotificationBell
                  className="topbar-bell"
                  count={statusCount}
                  size={34}
                  color="orange"
                  onClick={(event) => { rememberDialogOpener(event.currentTarget); setNotifications(true); }}
                  aria-label={`查看 ${statusCount} 条工作区提示`}
                />
              )}
              <button
                className="top-avatar"
                aria-label="打开工作区设置"
                onClick={openSettings}
              >
                <UserRound size={16} />
              </button>
            </div>
          </header>
          <main id="main-content" className="main-content">
            <section className="page-heading" data-feel-card>
              <div className="heading-copy" key={page}>
                <p className="heading-kicker">
                  {date}
                  <span aria-hidden="true">·</span>
                  {data.timeZone}
                </p>
                <h1>{current.name}</h1>
                <p className="heading-mode">
                  {data.mode === "demo"
                    ? "当前展示示例数据"
                    : "当前展示真实数据"}
                </p>
              </div>
              <div className="heading-actions">
                <span className="sync-status">
                  <i className={`status-dot ${freshData ? "is-fresh" : ""}`} key={data.generatedAt} />
                  更新于 {time}
                </span>
                <StatefulButton
                  variant="outline"
                  size="sm"
                  state={refreshState}
                  loadingText={
                    <span className="beautiful-loading-text">刷新中</span>
                  }
                  successText="已更新"
                  errorText="重试"
                  icon={<AnimatedNavIcon name="refresh" size={14} />}
                  onClick={refresh}
                  disabled={refreshState === "loading"}
                  className="refresh-button"
                >
                  刷新数据
                </StatefulButton>
              </div>
            </section>
            {notices.length > 0 && <details className="workspace-notices" data-feel-card open={!!refreshWarning}>
              <summary>{refreshWarning ? "数据刷新未完成" : `${notices.length} 项数据与同步提示`}</summary>
              <ul>{notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>
            </details>}
            {(page === "overview" || page === "models") && (
              <div className="page-controls" data-feel-card>
                <div className="period-group">
                  <Tabs
                    value={period}
                    onValueChange={(v) => setPeriod(v as PeriodKey)}
                  >
                    <TabsList aria-label="统计周期" className="period-tabs">
                      {Object.entries(PERIOD_LABELS).map(([key, label]) => (
                        <TabsTrigger
                          key={key}
                          value={key}
                          id={`period-${key}`}
                          aria-controls="period-summary"
                        >
                          {label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  <span className="date-label">
                    <CalendarDays size={14} />
                    {period === "today"
                      ? date
                      : period === "month"
                        ? zoned({ year: "numeric", month: "long" })
                        : "全部历史记录"}
                  </span>
                </div>
                <button className="plain-button" onClick={exportModels}>
                  <AnimatedNavIcon name="download" size={14} />
                  <span>导出数据</span>
                </button>
              </div>
            )}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={page}
                className={navigated ? "page-stage" : undefined}
                id="period-summary"
                role={
                  page === "overview" || page === "models"
                    ? "tabpanel"
                    : undefined
                }
                aria-labelledby={
                  page === "overview" || page === "models"
                    ? `period-${period}`
                    : undefined
                }
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  transition: { duration: reduce ? 0 : DURATION.fast, ease: EASE_SMOOTH_OUT },
                }}
                exit={{
                  opacity: 0,
                  transition: { duration: reduce ? 0 : DURATION.quick, ease: EASE_SMOOTH_OUT },
                }}
              >
                {page === "overview" ? (
                  <Overview
                    data={data}
                    period={period}
                    onModel={openModel}
                  />
                ) : page === "models" ? (
                  <>
                    <Stats data={data} period={period} />
                    <ModelTable per={per} full onSelect={openModel} />
                    <AppErrorBoundary title="模型矩阵已更新，请刷新。">
                      <Suspense fallback={<PageSkeleton label="正在加载矩阵…" columns={1} height={320} />}>
                        <ModelMatrixView per={per} />
                      </Suspense>
                    </AppErrorBoundary>
                  </>
                ) : (
                  <AppErrorBoundary>
                    <Suspense fallback={<PageSkeleton label="正在加载…" summary />}>
                      {page === "devices" ? (
                        <DevicesView data={data} />
                      ) : page === "quota" ? (
                        <QuotaView data={data} />
                      ) : (
                        <>
                          <HistoryView data={data} />
                          <ArchivePanel accessToken={token.current} dataMode={data.mode} fallbackData={data} historyAvailable={data.features?.history_daily} onAuthExpired={onSignOut} />
                        </>
                      )}
                    </Suspense>
                  </AppErrorBoundary>
                )}
              </motion.div>
            </AnimatePresence>
            <footer className="page-footer" data-feel-card>
              <span>
                Cloud Monitor
                <span className="footer-separator" aria-hidden="true">·</span>
                {data.mode === "demo"
                  ? "演示数据"
                  : `每 5 分钟自动刷新 · ${data.timeZone}`}
              </span>
              {!hosted && <button onClick={openDesign}>
                关于这版设计 <ArrowUpRight size={12} />
              </button>}
            </footer>
          </main>
        </div>
      </div>
      {dialogsLoaded && (
        <AppErrorBoundary
          title="对话框已更新，请刷新。"
          variant="dialog"
          onFail={() => {
            setDialogError(true);
            setDialogsLoaded(false);
            setSearchOpen(false);
            setSettings(false);
            setNotifications(false);
            setDesign(false);
            setSelected(null);
          }}
        >
        <Suspense fallback={null}>
          <AppDialogs
            returnFocusRef={dialogReturnFocus}
            searchOpen={searchOpen}
            setSearchOpen={setSearchOpen}
            settings={settings}
            setSettings={setSettings}
            notifications={notifications}
            setNotifications={setNotifications}
            design={design}
            setDesign={setDesign}
            selected={selected}
            setSelected={setSelected}
            hosted={hosted}
            isolatedDemo={isolatedDemo}
            secret={secret}
            setSecret={setSecret}
            connect={connect}
            connecting={connecting}
            setConnecting={setConnecting}
            connectError={connectError}
            setConnectError={setConnectError}
            keyRejected={keyRejected}
            setKeyRejected={setKeyRejected}
            showDemo={showDemo}
            data={data}
            period={period}
            per={per}
            token={token.current}
            onSignOut={onSignOut}
            pages={PAGES}
            go={go}
            statusCount={statusCount}
            notices={notices}
            requestVersion={requestVersion}
            inFlight={inFlight}
          />
        </Suspense>
        </AppErrorBoundary>
      )}
      {dialogError && (
        <DialogErrorNotice
          onDismiss={() => setDialogError(false)}
        />
      )}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="app-toast"
            role="status"
            initial={toastHidden}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              filter: "blur(0px)",
              // Drop the settled filter so the toast text is not left on a filter layer.
              transitionEnd: { filter: "none" },
              transition: { duration: DURATION.medium, ease: EASE_SMOOTH_OUT },
            }}
            exit={{
              ...toastHidden,
              transition: { duration: DURATION.fast, ease: EASE_SMOOTH_OUT },
            }}
          >
            <Check size={16} />
            <span>{toast}</span>
            <button aria-label="关闭提示" onClick={() => setToast("")}>
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
