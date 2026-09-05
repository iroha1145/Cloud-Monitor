import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Command,
  Database,
  Download,
  ExternalLink,
  FileClock,
  Fingerprint,
  Grid2X2,
  Info,
  Layers3,
  Link2,
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
  DialogHeader,
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
import SearchList from "./components/primitives/SearchList";
import GlideMenu from "./components/primitives/GlideMenu";
import {
  createDemoData,
  PERIOD_LABELS,
  providerName,
  type DashboardData,
  type PeriodKey,
  type UsageEntity,
} from "./data";
import { loadDashboard, isAuthFailure } from "./api";
import { MobileNavigation } from "./MobileNavigation";
import { ArchivePanel } from "./ArchivePanel";
import { SystemUpdate } from "./SystemUpdate";
import {
  BrandIcon,
  compact,
  CompositionCard,
  count,
  ModelTable,
  ModelMatrix,
  money,
  Overview,
  pct,
  Stats,
} from "./Overview";
import { DevicesView, HistoryView, QuotaView } from "./SecondaryViews";
import "./secondary.css";
import "./mobile.css";

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
function escapeCsv(value: unknown) {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
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
    [connecting, setConnecting] = useState(false),
    [refreshState, setRefreshState] = useState<ButtonState>("idle");
  const [toast, setToast] = useState("");
  const token = useRef(initialToken);
  const inFlight = useRef<AbortController | null>(null);
  const [refreshWarning, setRefreshWarning] = useState("");
  const requestVersion = useRef(0);
  const reduce = useReducedMotion();
  const current = pages.find((p) => p.id === page)!;
  const per = data.periods[period];
  const notices = [...(refreshWarning ? [refreshWarning] : []),
    ...data.notices,
    ...data.devices
      .filter((d) => d.status !== "online")
      .map(
        (d) =>
          `${d.name} ${d.status === "delayed" ? "上报有延迟，请检查设备端连接。" : "当前离线，已保留最近一次用量。"}`,
      ),
  ];
  const statusCount = notices.length;
  useEffect(() => {
    const onHash = () => {
      setPage(getPage());
      setMobile(false);
      window.scrollTo({ top: 0, behavior: "instant" });
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
    setDark(value => {
      try { localStorage.setItem("cm_theme", value ? "light" : "dark"); } catch { /* private mode */ }
      return !value;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
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
  useEffect(() => {
    if (data.mode !== "live") return;
    const cancel = () => { ++requestVersion.current; inFlight.current?.abort(); setRefreshState("idle"); };
    const update = async () => {
      if (document.hidden) return;
      inFlight.current?.abort();
      const controller = new AbortController(); inFlight.current = controller;
      setRefreshState("idle");
      const version = ++requestVersion.current;
      try {
        const next = await loadDashboard(token.current, controller.signal, value => {
          if (version === requestVersion.current) setData(value);
        });
        if (version === requestVersion.current) { setData(next); setRefreshWarning(""); }
      } catch (error) {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        if (isAuthFailure(error) && hosted) { onSignOut?.(); return; }
        setRefreshWarning("自动刷新未完成，已保留上次数据。请检查连接或重新刷新。");
      }
    };
    if (hosted) void update();
    const timer = setInterval(() => void update(), 300000);
    const visible = () => { if (document.hidden) cancel(); else void update(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void update(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", restored);
    window.addEventListener("pagehide", cancel);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", cancel); window.removeEventListener("pageshow", restored); cancel(); };
  }, [data.mode, hosted, onSignOut]);
  useEffect(() => () => { ++requestVersion.current; inFlight.current?.abort(); }, []);
  const go = (id: PageId) => {
    location.hash = id;
    setMobile(false);
  };
  const refresh = async () => {
    if (refreshState === "loading") return;
    setRefreshState("loading");
    const version = ++requestVersion.current;
    inFlight.current?.abort();
    const controller = new AbortController(); inFlight.current = controller;
    try {
      if (data.mode === "live") {
        const next = await loadDashboard(token.current, controller.signal, value => {
          if (version === requestVersion.current) setData(value);
        });
        if (version !== requestVersion.current) return;
        setData(next);
      } else {
        await new Promise((r) => setTimeout(r, 600));
        if (version !== requestVersion.current) return;
        setData(createDemoData());
      }
      setRefreshWarning("");
      setRefreshState("success");
      setToast(
        data.mode === "live" ? "已获取最新用量。" : "示例数据已重新加载。",
      );
    } catch (e) {
      if (version !== requestVersion.current) return;
      if (controller.signal.aborted) return;
      if (isAuthFailure(e) && hosted) { onSignOut?.(); return; }
      setRefreshState("error");
      setRefreshWarning(e instanceof Error ? e.message : "刷新失败，已保留上次数据。");
      setToast(e instanceof Error ? e.message : "刷新失败，已保留上次数据。");
    }
    setTimeout(() => { if (version === requestVersion.current) setRefreshState("idle"); }, 1800);
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isolatedDemo || hosted || !secret.trim()) return;
    setConnecting(true);
    setConnectError("");
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
    setData(createDemoData());
    setSettings(false);
    setToast("已切换为示例工作区。");
  };
  const openSettings = () => {
    setMobile(false);
    setSettings(true);
  };
  const openDesign = () => {
    setMobile(false);
    setDesign(true);
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
    const blob = new Blob(
      ["\ufeff" + rows.map((r) => r.map(escapeCsv).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cloud-monitor-${data.mode}-${period}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("模型用量表已导出。");
  };
  const time = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
    timeZone: data.timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = new Date(data.generatedAt).toLocaleDateString("zh-CN", {
    timeZone: data.timeZone,
    month: "long",
    day: "numeric",
  });
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
            <DialogContent className="mobile-nav-dialog" placement="left">
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
                  aria-label="搜索或快速跳转"
                  onClick={() => setSearchOpen(true)}
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
                    {dark ? <Sun size={17} /> : <Moon size={17} />}
                  </button>
                </MetricTooltip>
                {SHOWCASE_UI && (
                  <NotificationBell
                    count={statusCount}
                    variant="dot"
                    size={33}
                    color="orange"
                    onClick={() => setNotifications(true)}
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
                    <i className="status-dot" />
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
                <ul>{[...new Set(notices)].map((notice, index) => <li key={index}>{notice}</li>)}</ul>
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
                          ? new Date(data.generatedAt).toLocaleDateString(
                              "zh-CN",
                              {
                                timeZone: data.timeZone,
                                year: "numeric",
                                month: "long",
                              },
                            )
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
                  initial={{ opacity: 0, y: reduce ? 0 : 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reduce ? 0 : -4 }}
                  transition={{
                    duration: reduce ? 0 : 0.18,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  {page === "overview" ? (
                    <Overview
                      data={data}
                      period={period}
                      onModel={setSelected}
                    />
                  ) : page === "models" ? (
                    <>
                      <Stats data={data} period={period} />
                      <ModelTable per={per} full onSelect={setSelected} />
                      <ModelMatrix per={per} />
                    </>
                  ) : page === "devices" ? (
                    <DevicesView data={data} />
                  ) : page === "quota" ? (
                    <QuotaView data={data} />
                  ) : (
                    <><HistoryView data={data} /><ArchivePanel accessToken={token.current} dataMode={data.mode} fallbackData={data} historyAvailable={data.features?.history_daily} onAuthExpired={onSignOut} /></>
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
                  {!hosted && <button onClick={() => setDesign(true)}>
                    关于这版设计 <ArrowUpRight size={12} />
                  </button>}
                </span>
              </footer>
            </main>
          </div>
          <MobileNavigation page={page} onNavigate={go} />
        </div>
        <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
          <DialogContent className="search-dialog">
            <DialogTitle className="sr-only">快速查找</DialogTitle>
            <DialogDescription className="sr-only">
              搜索页面或模型名称并跳转
            </DialogDescription>
            <div className="search-dialog-heading">
              <Command size={18} />
              <span>快速查找</span>
              <kbd>esc</kbd>
            </div>
            <SearchList
              items={[
                ...pages.map((p) => p.name),
                ...per.models.map((m) => m.name),
              ]}
              labels={{
                placeholder: "搜索页面或模型…",
                ariaLabel: "快速查找",
                emptyTitle: "没有找到匹配项",
                emptyHint: "试试模型名称，或输入“设备”。",
              }}
              onSelect={(item) => {
                const target = pages.find((p) => p.name === item);
                if (target) go(target.id);
                else {
                  go("models");
                  setTimeout(
                    () =>
                      setSelected(
                        per.models.find((m) => m.name === item) || null,
                      ),
                    100,
                  );
                }
                setSearchOpen(false);
              }}
            />
            <div className="search-dialog-foot">
              <span>按 Tab 选择结果，Enter 打开</span>
              <span>
                <Command size={11} /> K
              </span>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          open={settings}
          onOpenChange={(v) => {
            setSettings(v);
            if (!v) {
              if (connecting) { requestVersion.current++; inFlight.current?.abort(); setConnecting(false); }
              setSecret("");
              setConnectError("");
            }
          }}
        >
          <DialogContent className={`settings-dialog ${hosted ? "hosted-settings" : ""}`}>
            <DialogHeader>
              <span className="dialog-icon">
                <Link2 size={22} />
              </span>
              <DialogTitle>{hosted ? "工作区设置" : isolatedDemo ? "演示工作区" : "连接你的用量"}</DialogTitle>
              <DialogDescription>
                {hosted ? "查看服务版本，管理此设备上的登录。" : isolatedDemo ? "此页面使用示例数据，供浏览和体验界面。" : "接入现有云端服务，用真实数据体验新面板。"}
              </DialogDescription>
            </DialogHeader>
            <div className="connection-target">
              <Cloud size={20} />
              <span>
                <strong>Cloud Monitor</strong>
                <small>{hosted ? location.host : isolatedDemo ? "示例数据" : "token.openweb-ui.xyz"}</small>
              </span>
              <span className="connection-pill">
                {data.mode === "live" ? "已连接" : "待连接"}
              </span>
            </div>
            {!hosted && !isolatedDemo && <><form onSubmit={connect}>
              <label className="form-label" htmlFor="access-key">
                访问密钥
              </label>
              <input
                id="access-key"
                className="form-input"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="输入面板访问密钥"
                autoComplete="off"
                required
              />
              <p className="field-help">
                <ShieldCheck size={13} />
                密钥只保留在此页面内存中，刷新或关闭后清除。
              </p>
              {connectError && (
                <p role="alert" className="error-message">
                  {connectError}
                </p>
              )}
              <StatefulButton
                className="connect-submit"
                type="submit"
                state={connecting ? "loading" : "idle"}
                loadingText="正在连接"
                disabled={connecting || !secret.trim()}
              >
                连接并查看真实用量
                <ArrowRight size={15} />
              </StatefulButton>
            </form>
            <div className="dialog-divider">
              <span>或</span>
            </div>
            <button className="demo-button" onClick={showDemo}>
              <SparkleIcon />
              <span>
                <strong>继续浏览示例工作区</strong>
                <small>包含模型、缓存、设备与订阅的完整示例</small>
              </span>
              <ChevronRight size={17} />
            </button></>}
            {hosted && <>
              <SystemUpdate accessToken={token.current} dataMode={data.mode} onAuthExpired={onSignOut} />
              <button className="connection-logout" onClick={onSignOut}>退出登录或更换密钥</button>
            </>}
          </DialogContent>
        </Dialog>
        {SHOWCASE_UI && (
          <Dialog open={notifications} onOpenChange={setNotifications}>
            <DialogContent className="notifications-dialog">
              <DialogHeader>
                <DialogTitle>
                  工作区提示 <span className="count-badge">{statusCount}</span>
                </DialogTitle>
                <DialogDescription>
                  {data.mode === "demo"
                    ? "以下是示例工作区的状态，供预览使用。"
                    : "需要留意的同步与数据状态。"}
                </DialogDescription>
              </DialogHeader>
              {notices.length ? (
                notices.map((n, i) => (
                  <div className="notification-row" key={i}>
                    <Info size={18} />
                    <p>{n}</p>
                  </div>
                ))
              ) : (
                <div className="empty-inline">
                  <ShieldCheck size={28} />
                  <strong>一切正常</strong>
                  <span>暂无需要处理的工作区提示。</span>
                </div>
              )}
              <button
                className="plain-button"
                onClick={() => {
                  setNotifications(false);
                  go("devices");
                }}
              >
                查看设备状态
                <ArrowRight size={14} />
              </button>
            </DialogContent>
          </Dialog>
        )}
        <Dialog
          open={!!selected}
          onOpenChange={(v) => {
            if (!v) setSelected(null);
          }}
        >
          <DialogContent
            className="model-dialog"
            onOpenAutoFocus={(event) => {
              const content = event.target;
              if (content instanceof HTMLElement) {
                const close = content.querySelector<HTMLButtonElement>(
                  '[data-slot="dialog-close"]',
                );
                if (close) {
                  event.preventDefault();
                  close.focus();
                }
              }
            }}
          >
            {selected && (
              <>
                <DialogHeader>
                  <BrandIcon
                    name={selected.name}
                    color={selected.color}
                    size={45}
                  />
                  <DialogTitle>{selected.name}</DialogTitle>
                  <DialogDescription>
                    {providerName(selected.provider)} · {PERIOD_LABELS[period]}
                    用量详情
                  </DialogDescription>
                </DialogHeader>
                <div className="model-detail-stats">
                  <div>
                    <span>总用量</span>
                    <strong>{compact(selected.totalTokens)}</strong>
                    <small>{count(selected.totalTokens)} Tokens</small>
                  </div>
                  <div>
                    <span>使用费用</span>
                    <strong>{money(selected.costUsd)}</strong>
                    <small>美元 · 已上报费用</small>
                  </div>
                </div>
                <CompositionCard
                  small
                  per={{
                    ...per,
                    totalTokens: selected.totalTokens,
                    components: selected.components,
                  }}
                />
                <p className="detail-note">
                  {selected.components.partial
                    ? "部分组成尚未识别，已保留可确认的缓存计数。"
                    : "该模型用量组成完整。缓存占比按缓存读取量除以总用量计算。"}
                </p>
              </>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={design} onOpenChange={setDesign}>
          <DialogContent className="design-dialog">
            <DialogHeader>
              <span className="dialog-icon">
                <Palette size={23} />
              </span>
              <DialogTitle>清晰、有序，轻盈一些。</DialogTitle>
              <DialogDescription>
                为每日查看用量而设计的新工作台。
              </DialogDescription>
            </DialogHeader>
            <div className="design-swatches">
              {[
                ["正文", "#20242b"],
                ["缓存读取", "#25a878"],
                ["非缓存输入", "#3d9aff"],
                ["输出", "#f09a2f"],
                ["缓存写入", "#b393c5"],
              ].map(([label, c]) => (
                <MetricTooltip
                  key={c}
                  title={label}
                  rows={[{ label: "色值", value: c }]}
                >
                  <span style={{ background: c }} role="img" />
                </MetricTooltip>
              ))}
            </div>
            <p className="design-intro">
              从 Stripe
              的信息层次和留白出发，让用量、缓存和费用直接可见。色彩负责强调，动效负责交代变化。
            </p>
            <div className="design-sources">
              {[
                ["Stripe", "https://stripe.com", "排版、空间与信息层次"],
                [
                  "Beautiful UI",
                  "https://www.beautifului.dev",
                  "趋势曲线、快速搜索与导航反馈",
                ],
                ["beUI", "https://beui.dev", "数字变化与刷新状态"],
                ["Rare UI", "https://www.rareui.com", "新提示出现时的通知铃"],
                [
                  "Transitions",
                  "https://transitions.dev",
                  "短促的提示、弹层过渡",
                ],
                [
                  "shadcn/ui",
                  "https://ui.shadcn.com",
                  "键盘可用的页签、选项与对话框",
                ],
              ].map(([name, url, desc]) => (
                <a key={name} href={url} target="_blank" rel="noreferrer">
                  <span>
                    <strong>{name}</strong>
                    <small>{desc}</small>
                  </span>
                  <ArrowUpRight size={15} />
                </a>
              ))}
            </div>
            <p className="field-help">
              <Activity size={13} />
              系统开启“减少动态效果”后，将自动简化动画。
            </p>
          </DialogContent>
        </Dialog>
        <AnimatePresence>
          {toast && (
            <motion.div
              className="app-toast"
              role="status"
              initial={{
                opacity: 0,
                y: reduce ? 0 : 16,
                scale: reduce ? 1 : 0.98,
              }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduce ? 0 : 8 }}
              transition={{ duration: 0.18 }}
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
function SparkleIcon() {
  return (
    <span className="demo-icon">
      <Fingerprint size={22} />
    </span>
  );
}
