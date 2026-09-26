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
  ChevronRight,
  Cloud,
  Download,
  FileClock,
  Grid2X2,
  Layers3,
  Menu,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Wallet,
  UserRound,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { MetricTooltip } from "./MetricTooltip";
import {
  StatefulButton,
  type ButtonState,
} from "./components/motion/button/stateful";
import { NotificationBell } from "./components/rareui/notification-bell";
import GlideMenu from "./components/primitives/GlideMenu";
import { downloadCsv, escapeCsv } from "./lib/csv";
import { scrollToTop } from "./lib/scroll";
import {
  createDemoData,
  PERIOD_LABELS,
  type DashboardData,
  type PeriodKey,
  type UsageEntity,
} from "./data";
import { loadDashboard, isAuthFailure } from "./api";
import { MobileNavigation } from "./MobileNavigation";
import { PageSkeleton } from "./PageSkeleton";
import { DURATION, EASE_SMOOTH_OUT } from "./lib/motion";
import {
  ModelTable,
  Overview,
  pct,
  Stats,
} from "./Overview";
import "./mobile.css";

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

// Showcase navigation is opt-in for a separate public demo build.
const SHOWCASE_UI = import.meta.env.VITE_SHOWCASE_UI === "true";

const pages = [
  {
    id: "overview",
    name: "总览",
    icon: Grid2X2,
    description: "所有用量，汇聚一处。",
  },
  {
    id: "models",
    name: "模型分析",
    icon: Layers3,
    description: "找到最适合你的模型，理解每一份用量。",
  },
  {
    id: "devices",
    name: "设备",
    icon: Monitor,
    description: "随时了解各台设备的用量与同步状态。",
  },
  {
    id: "quota",
    name: "配额与订阅",
    icon: Wallet,
    description: "额度还有多少，下一次何时续费。",
  },
  {
    id: "history",
    name: "历史记录",
    icon: FileClock,
    description: "把每一次使用，放回时间里。",
  },
] as const;
type PageId = (typeof pages)[number]["id"];
const getPage = (): PageId =>
  pages.find((p) => p.id === location.hash.slice(1))?.id || "overview";
function safePreference() {
  return document.documentElement.classList.contains("dark");
}

type AppProps = { initialData?: DashboardData; initialToken?: string; hosted?: boolean; isolatedDemo?: boolean; onSignOut?: () => void };
export default function App({ initialData, initialToken = "", hosted = false, isolatedDemo = false, onSignOut }: AppProps) {
  const [data, setData] = useState<DashboardData>(() => initialData || createDemoData());
  const [page, setPage] = useState<PageId>(getPage),
    [period, setPeriod] = useState<PeriodKey>("today");
  const [dark, setDark] = useState(safePreference),
    [mobile, setMobile] = useState(false);
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
  const mobileReturnFocus = useRef<HTMLButtonElement | null>(null);
  const searchButton = useRef<HTMLButtonElement | null>(null);
  const rememberDialogOpener = (opener: HTMLElement | null) => {
    // Buttons inside the closing navigation drawer will be unmounted.
    dialogReturnFocus.current = opener?.closest(".mobile-nav-dialog")
      ? mobileReturnFocus.current
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
  const current = pages.find((p) => p.id === page)!;
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
  // Sections rise in after navigation only; the first screen stays still.
  const [navigated, setNavigated] = useState(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const onHash = () => {
      const id = location.hash.slice(1);
      // In-page anchors such as the skip link are not pages.
      if (id && !pages.some((p) => p.id === id)) return;
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
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#191b20" : "#fafafb");
  }, [dark]);
  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => {
      try { if (localStorage.getItem("cm_theme") || localStorage.getItem("cm-preview-theme")) return; } catch { /* private mode */ }
      setDark(preference.matches);
    };
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);
  const toggleTheme = () => {
    // A document view transition blocks pointer input while its snapshot animates.
    // Keep the page interactive and animate only the theme button's icons.
    setDark(current => {
      const next = !current;
      try { localStorage.setItem("cm_theme", next ? "dark" : "light"); } catch { /* private mode */ }
      return next;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!document.querySelector('[role="dialog"][data-state="open"]')) {
          rememberDialogOpener(document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement : searchButton.current);
        }
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
    downloadCsv(
      `cloud-monitor-${data.mode}-${period}.csv`,
      "\ufeff" + rows.map((r) => r.map(escapeCsv).join(",")).join("\r\n"),
    );
    setToast("模型用量表已导出。");
  };
  let time = "";
  let date = "";
  try {
    time = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
      timeZone: data.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
    date = new Date(data.generatedAt).toLocaleDateString("zh-CN", {
      timeZone: data.timeZone,
      month: "long",
      day: "numeric",
    });
  } catch {
    time = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    date = new Date(data.generatedAt).toLocaleDateString("zh-CN", {
      month: "long",
      day: "numeric",
    });
  }
  const nav = (
    <>
      <a className="app-brand" href="#overview" aria-label="Cloud Monitor 首页">
        <span className="brand-symbol">
          <Cloud size={23} strokeWidth={2} />
          <span />
        </span>
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
        {pages.map((p) => (
          <a
            data-menu-row
            key={p.id}
            href={`#${p.id}`}
            aria-current={page === p.id ? "page" : undefined}
            className={`nav-item ${page === p.id ? "active" : ""}`}
          >
            <p.icon size={18} />
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
        <div className="workspace-note">
          <div className="mini-cloud">
            <Cloud size={19} />
          </div>
          <strong>用量尽在眼前</strong>
          <p>
            连接你的设备，
            <br />
            让每一次使用都有记录。
          </p>
          <button onClick={openSettings}>
            {data.mode === "demo" ? "连接我的数据" : "管理数据连接"}
            <ArrowRight size={14} />
          </button>
          <div className="note-orbit" aria-hidden="true" />
        </div>
        {!hosted && <button className="sidebar-setting" onClick={openDesign}>
          <Palette size={17} />
          设计说明<span className="new-tag">新</span>
        </button>}
        <button className="sidebar-setting" onClick={openSettings}>
          <Settings2 size={17} />
          工作区设置
        </button>
        <div className="sidebar-profile">
          <span className="profile-avatar">
            <UserRound size={16} />
          </span>
          <span>
            <strong>个人工作空间</strong>
            <small>{hosted ? "已连接云端服务" : isolatedDemo ? "演示工作区" : "本地预览"}</small>
          </span>
          <ShieldCheck size={17} />
        </div>
      </div>
    </>
  );
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={80}>
        <a className="skip-link" href="#main-content">
          跳到主内容
        </a>
        <div
          className={`app-shell ${SHOWCASE_UI ? "showcase-shell" : "dashboard-shell"}`}
        >
          <aside className="sidebar" aria-label="主导航">
            {nav}
          </aside>
          <Dialog open={mobile} onOpenChange={setMobile}>
            <DialogContent className="mobile-nav-dialog" placement="left" returnFocusRef={mobileReturnFocus}>
              <DialogTitle className="sr-only">导航</DialogTitle>
              <DialogDescription className="sr-only">
                切换页面和工作区设置
              </DialogDescription>
              <nav className="mobile-nav-content" aria-label="侧边导航">
                {nav}
              </nav>
            </DialogContent>
          </Dialog>
          <div className="workspace-main">
            <header className="app-topbar">
              <div className="breadcrumb">
                <button
                  className="icon-button mobile-menu"
                  ref={mobileReturnFocus}
                  onClick={() => setMobile(true)}
                  aria-label="打开导航"
                >
                  <Menu size={19} />
                </button>
                <span className="breadcrumb-workspace">工作空间</span>
                <ChevronRight size={13} />
                <strong>{current.name}</strong>
                {!hosted && <span className="preview-badge">{isolatedDemo ? "演示" : "本地预览"}</span>}
              </div>
              <div className="topbar-actions">
                <button
                  className="command-search"
                  ref={searchButton}
                  aria-label="搜索或快速跳转"
                  onClick={(event) => { rememberDialogOpener(event.currentTarget); setSearchOpen(true); }}
                >
                  <Search size={16} />
                  <span>搜索或快速跳转</span>
                  <kbd>⌘ K</kbd>
                </button>
                <span className="topbar-divider" />
                <MetricTooltip
                  title="外观模式"
                  preserveAction
                  rows={[
                    { label: "当前", value: dark ? "深色模式" : "浅色模式" },
                    {
                      label: "点击切换",
                      value: dark ? "浅色模式" : "深色模式",
                    },
                  ]}
                >
                  <button
                    className="icon-button"
                    aria-label={dark ? "切换浅色模式" : "切换深色模式"}
                    onClick={toggleTheme}
                  >
                    <span className="icon-swap" aria-hidden="true">
                      <Sun size={17} data-active={dark} />
                      <Moon size={17} data-active={!dark} />
                    </span>
                  </button>
                </MetricTooltip>
                {SHOWCASE_UI && (
                  <NotificationBell
                    count={statusCount}
                    variant="dot"
                    size={33}
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
              <section
                className={`page-heading ${page === "overview" ? "overview-heading" : ""}`}
              >
                <div className="heading-copy" key={page}>
                  <div className="heading-kicker">
                    <span className="heading-line" />
                    {page === "overview"
                      ? "你的用量工作台"
                      : current.name.toUpperCase()}
                  </div>
                  <h1>
                    {page === "overview" ? "用量，一目了然。" : current.name}
                  </h1>
                  <p>
                    {current.description}
                    <span className="heading-mode">
                      {data.mode === "demo"
                        ? "当前展示示例数据"
                        : "当前展示真实数据"}
                    </span>
                  </p>
                </div>
                {page === "overview" && (
                  <div className="heading-art" aria-hidden="true">
                    <div className="gradient-ribbon ribbon-one" />
                    <div className="gradient-ribbon ribbon-two" />
                    <div className="art-grid" />
                  </div>
                )}
                <div className="heading-actions">
                  <span className="sync-status">
                    <i className={`status-dot ${freshData ? "is-fresh" : ""}`} key={data.generatedAt} />
                    {data.mode === "demo" ? "示例数据" : `更新于 ${time}`}
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
                    icon={<RefreshCw size={14} />}
                    onClick={refresh}
                    disabled={refreshState === "loading"}
                    className="refresh-button"
                  >
                    刷新数据
                  </StatefulButton>
                </div>
              </section>
              {notices.length > 0 && <details className="workspace-notices" open={!!refreshWarning}>
                <summary>{refreshWarning ? "数据刷新未完成" : `${notices.length} 项数据与同步提示`}</summary>
                <ul>{notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>
              </details>}
              {(page === "overview" || page === "models") && (
                <div className="page-controls">
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
                          ? (() => {
                              try {
                                return new Date(data.generatedAt).toLocaleDateString(
                                  "zh-CN",
                                  {
                                    timeZone: data.timeZone,
                                    year: "numeric",
                                    month: "long",
                                  },
                                );
                              } catch {
                                return new Date(data.generatedAt).toLocaleDateString(
                                  "zh-CN",
                                  { year: "numeric", month: "long" },
                                );
                              }
                            })()
                          : "全部历史记录"}
                    </span>
                  </div>
                  <button className="plain-button" onClick={exportModels}>
                    <Download size={14} />
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
              <footer className="page-footer">
                <span>
                  <Cloud size={13} />
                  Cloud Monitor<span className="footer-separator">/</span>
                  每一份用量，都有迹可循。
                </span>
                <span>
                  {data.mode === "demo"
                    ? "示例数据，不代表实际账单"
                    : `每 5 分钟自动刷新 · ${data.timeZone}`}
                  {!hosted && <button onClick={openDesign}>
                    关于这版设计 <ArrowUpRight size={12} />
                  </button>}
                </span>
              </footer>
            </main>
          </div>
          <MobileNavigation page={page} onNavigate={go} />
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
              showDemo={showDemo}
              data={data}
              period={period}
              per={per}
              token={token.current}
              onSignOut={onSignOut}
              pages={pages}
              go={go}
              statusCount={statusCount}
              notices={notices}
              requestVersion={requestVersion}
              inFlight={inFlight}
            />
          </Suspense>
          </AppErrorBoundary>
        )}
        {dialogError && <DialogErrorNotice onDismiss={() => setDialogError(false)} />}
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
      </TooltipProvider>
    </MotionConfig>
  );
}
