import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Cloud,
  Command,
  Fingerprint,
  Info,
  Link2,
  Palette,
  ShieldCheck,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { MetricTooltip } from "./MetricTooltip";
import {
  StatefulButton,
} from "./components/motion/button/stateful";
import SearchList from "./components/primitives/SearchList";
import {
  PERIOD_LABELS,
  providerName,
  type DashboardData,
  type PeriodKey,
  type PeriodUsage,
  type UsageEntity,
} from "./data";
import { SystemUpdate } from "./SystemUpdate";
import { BrandIcon, compact, CompositionCard, count, money } from "./Overview";

const SHOWCASE_UI = import.meta.env.VITE_SHOWCASE_UI === "true";

type PageItem = { id: string; name: string };

export default function AppDialogs({
  searchOpen,
  setSearchOpen,
  settings,
  setSettings,
  notifications,
  setNotifications,
  design,
  setDesign,
  selected,
  setSelected,
  hosted,
  isolatedDemo,
  secret,
  setSecret,
  connect,
  connecting,
  setConnecting,
  connectError,
  setConnectError,
  showDemo,
  data,
  period,
  per,
  token,
  onSignOut,
  pages,
  go,
  statusCount,
  notices,
  requestVersion,
  inFlight,
  returnFocusRef,
}: {
  searchOpen: boolean;
  setSearchOpen: (value: boolean) => void;
  settings: boolean;
  setSettings: (value: boolean) => void;
  notifications: boolean;
  setNotifications: (value: boolean) => void;
  design: boolean;
  setDesign: (value: boolean) => void;
  selected: UsageEntity | null;
  setSelected: (value: UsageEntity | null) => void;
  hosted: boolean;
  isolatedDemo: boolean;
  secret: string;
  setSecret: (value: string) => void;
  connect: (event: React.FormEvent) => void;
  connecting: boolean;
  setConnecting: (value: boolean) => void;
  connectError: string;
  setConnectError: (value: string) => void;
  showDemo: () => void;
  data: DashboardData;
  period: PeriodKey;
  per: PeriodUsage;
  token: string;
  onSignOut?: () => void;
  pages: readonly PageItem[];
  go: (id: string) => void;
  statusCount: number;
  notices: string[];
  requestVersion: { current: number };
  inFlight: { current: AbortController | null };
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="search-dialog" returnFocusRef={returnFocusRef}>
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
            if (connecting) {
              requestVersion.current++;
              inFlight.current?.abort();
              setConnecting(false);
            }
            setSecret("");
            setConnectError("");
          }
        }}
      >
        <DialogContent className={`settings-dialog ${hosted ? "hosted-settings" : ""}`} returnFocusRef={returnFocusRef}>
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
            <span className="demo-icon">
              <Fingerprint size={22} />
            </span>
            <span>
              <strong>继续浏览示例工作区</strong>
              <small>包含模型、缓存、设备与订阅的完整示例</small>
            </span>
            <ChevronRight size={17} />
          </button></>}
          {hosted && <>
            <SystemUpdate accessToken={token} dataMode={data.mode} timeZone={data.timeZone} onAuthExpired={onSignOut} />
            <button className="connection-logout" onClick={onSignOut}>退出登录或更换密钥</button>
          </>}
        </DialogContent>
      </Dialog>
      {SHOWCASE_UI && (
        <Dialog open={notifications} onOpenChange={setNotifications}>
          <DialogContent className="notifications-dialog" returnFocusRef={returnFocusRef}>
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
          returnFocusRef={returnFocusRef}
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
        <DialogContent className="design-dialog" returnFocusRef={returnFocusRef}>
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
    </>
  );
}
