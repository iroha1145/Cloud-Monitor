# Cloud-Monitor 界面参考与源码

核对时间：2026-09-05；动效部分 2026-09-26 更新，界面与动效 2026-10-18 对齐 game-manage。此目录保留官方来源与未修改源码；实际采用哪些组件以预览项目导入为准。

## 建议组合

| 来源 | 用在何处 | 本地文件 | 接入说明 |
| --- | --- | --- | --- |
| Beautiful UI | Insight Cards 每日曲线、顶部快捷查找与列表悬停 | `beautifului/InsightCards.tsx`、`SearchList.tsx`、`GlideMenu.tsx` | 曲线使用同源 Liveline；浮窗读取当天记录。搜索接入业务选择回调。 |
| beUI | 刷新状态与数字更新 | `beui/components/motion/button/stateful.tsx`、`number-ticker.tsx` | `StatefulButton` 和 `NumberTicker` 命名导出，保留同目录 base 与 lib helpers。 |
| Rare UI | 顶部告警入口 | `rareui/notification-bell.tsx` | `NotificationBell` 命名或默认导出；`count`、`size={34}`、`color="violet"`、`onClick`。 |
| Transitions.dev | 信息提示框、菜单与详情浮层的节奏 | `transitions/tooltip.css`、对应 `.md` | tooltip.css 为官方 CSS 代码块逐字提取，含减少动画保护，可直接导入。 |
| shadcn/ui | 对话框和通用控件的规范 | `shadcn/dialog.tsx`、`button.tsx` | 官方 new-york-v4 源码，保留许可证；推荐实际通过 shadcn CLI 安装来解析最新依赖。 |

## 依赖与使用限制

Beautiful UI 必须整体导入完整 `beautifului/globals.css` 一次，包括 `@theme inline`；只复制 CSS 变量不够。其依赖 Tailwind CSS v4、`shadow-plugin` 和 React。全局令牌在完整基础文件之后覆盖。`SidebarNav.tsx` 作为研究参考，含付费 `@central-icons-react` 图标，实际接入应换成本项目图标库；建议采用无需付费依赖的 SearchList + GlideMenu。

beUI 的独立组件依赖 `motion`、`clsx`、`tailwind-merge`；StatefulButton 另需 `lucide-react`。已经运行官方 shadcn `view @beui/tabs @beui/number-ticker @beui/button-stateful`，结果保存在 `beui/cli-view.json`。实际工程安装命令：

```sh
npx shadcn@latest add @beui/button-stateful @beui/number-ticker
```

`StatefulButton` 支持 `state="idle" | "loading" | "success" | "error"`，中文标签通过 `loadingText`、`successText`、`errorText` 传入。它包含减少动画处理。

`NumberTicker` 会对 value 做整数四舍五入。金额应以整数分传入，再格式化，而非直接传小数：

```tsx
<NumberTicker value={5145} format={(cents) => (cents / 100).toFixed(2)}
  prefix="$" duration={0.45} stagger={0.018} blur={false} />
```

beUI Tabs 支持 `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent`，`variant="segment" | "pill" | "underline"`，受控 `value/onValueChange`。当前源码没有实现左右箭头焦点游走，关键分区优先使用 shadcn Tabs 的完整键盘交互。可以把 beUI 留给刷新状态和数字变化，避免重叠实现。

Rare UI 通知铃依赖 `motion` 和 `@/lib/utils` 的 cn；告警数量变化时才产生摆动，支持 `useReducedMotion`。需要真实 count 变化，不设置持续循环动画。

## 界面与动效

2026-10-18 按 game-manage 的 `docs/frontend-motion.md` 对齐外观与动效，页面仍为白底、配色沿用本项目原有的组成色、热力色和强调蓝。

**表面**：页面纯白；卡片白色、一圈 `--card-border` 细线、`--shadow-panel` 两层淡阴影（近处接触、远处柔和）；卡片里的小块用 `--inset` 灰底和极淡的内描边，不再套边框和阴影。模型表、会话表的每一行是直角小卡。只有浮层（菜单、对话框、提示、拖动中的菜单）有更深的 `--shadow-float`；毛玻璃（白 96%、模糊 16px）只给浮动菜单和手机底栏。圆角：菜单 30、卡片 26（手机 22）、卡片内小块 18 或 14、按钮与输入框 14、标签 7。按钮、搜索框、分段控件都是圆角矩形，不再用胶囊形；选中的分段和当前页面用强调蓝。

**文字**：不小于 12px；页面标题 28/600，卡片标题 16/600，区块标题 18/600；关键数字字重 500、字距收紧。

**动效**（时长与缓动在 `src/tokens.css`，弹簧缓动 `--ease-spring`、`--ease-spring-smooth` 是从 Feel 弹簧采样的 `linear()` 曲线）：

| 交互 | 实现 | 数值 |
| --- | --- | --- |
| 浮动菜单 | `FloatingNavigation.tsx` | 拖动顶部抓手跟手移动，松手按位置加 70ms 的速度选最近的角，弹簧（质量 1、刚度 260、阻尼 28）收进去，离窗口边 16px；方向键、Home/End 换角；鼠标拖动不画键盘焦点框 |
| 卡片避让 | `lib/feel-cards.ts`、`lib/feel-physics.ts` | 每张卡（`data-feel-card`）在原位置独立判断，靠菜单一侧让出宽度，最多让三分之一、保留 272px 可读宽度，让不开就允许被盖住；同一组弹簧；静止时不留变换和合成层 |
| 卡内回应 | 同上，`data-feel-item` | 菜单移动时，附近的横卡（最多 7px，只左右）和热力格（最多 1.8px）轻微让开并缩小约 1%，菜单停下后全部归位 |
| 卡片回弹 | `lib/elastic-cards.ts` | 拖动卡片空白处最多偏移 8px、轻微倾斜，松手弹回（刚度 330、阻尼 29）；按钮、表格滚动区和文字选择不接管，手机上纵向滑动立即交还页面滚动 |
| 按钮按下 | `motion.css`、`surface.css` | 所有按钮和分段项按下时下沉 1px，悬停只换底色，不放大、不加光晕 |
| 手机底栏与抽屉 | `FloatingNavigation.tsx`、`lib/drawer-physics.ts` | 底栏 84px、离屏幕边 12px，和菜单是同一块表面：宽、高、圆角（32 到 28）、内容淡入和遮罩都随一个进度变化；点按从静止起步的弹簧（刚度 240、阻尼 19）走到下一档，拖过两端有递增阻力，松手按 160ms 的速度选停靠点 |
| 滚动出现 | `lib/scroll-reveal.ts` | 只有首屏以下的卡片先隐藏，滚到时上移 20px、去模糊出现，同批依次延后 60ms；减少动态效果时不隐藏 |
| 模型详情 | `AppDialogs.tsx` 侧栏 | 贴右侧整高显示，从右边 30px 滑入，用 `--ease-spring-smooth` |
| 提示框 | 17 tooltip | 延迟 80ms，出现 150ms，退出 50ms |
| 对话框 | 06 modal | 打开 250ms 由 0.96 放大，关闭 150ms 缩回；弹窗层首次打开后常驻，关闭动画才能播完 |
| 下拉选择 | 05 menu dropdown | 打开 250ms 由 0.97 放大，关闭 150ms |
| 分段切换 | 16 tabs sliding | 统计周期、趋势范围与指标、矩阵指标、活动范围共用一个滑块，位移用 `--ease-spring`（340ms，略过头再回），宽高用 `--ease-spring-smooth`（260ms）；首次定位与尺寸变化不做动画 |
| 页面切换 | 18 texts reveal | 容器淡入 250ms、淡出 150ms；切换页面后各区块上移 8px 依次出现，间隔 40ms，最多 4 级；首次打开的页面保持静止 |
| 折叠明细 | 21 accordion | 所有原生 `<details>` 用 `::details-content` 展开收起 250ms，箭头同步转动；不支持的浏览器保持立即切换 |
| 加载占位 | 14 skeleton | 视图代码加载时显示卡片骨架，1 秒一次的脉动；内容到达后随页面区块上移出现 |
| 提示条 | 22 toast | 上移 16px、去模糊、由 0.97 放大，打开 350ms，关闭 250ms |
| 主题切换 | 圆形展开 | 新外观从菜单按钮处圆形展开 500ms |
| 用量条与环形图 | — | 首次出现时从左填充 500ms，行间隔 40ms；周期切换时宽度和环段过渡 400ms |
| 活动热力图 | beUI heat calendar | 切换日/周/月时格子沿对角线依次弹出，每格延后 18ms；指针悬停的格子放大 1.14 倍 |
| 导航图标 | lucide-animated | 悬停、聚焦、按下和选中变化时播放 380ms 的短动作 |
| 密钥被拒绝 | 12 error shake | 用户提交的密钥被服务端拒绝（401/403）时，输入框 280ms 左右抖动并标为无效；网络错误、自动登录失败和会话过期只显示文字 |

只在用户操作或数据状态变化时触发。同步状态点在每次拿到新快照时闪一圈；数值没变时，数字和用量条不会重播动画。示例数据每次点「刷新数据」会给当天加一点用量，用来检查数字滚动和用量条过渡。减少动画设置下，菜单直接到位、卡片回弹和滚动出现关闭，页面区块、骨架脉动和抖动全部关闭，其余动效时长和延迟压到接近 0。


## 视觉系统（2026-10 改版）

方向是「数字在前，界面退后」：每天打开看一眼用量的人，要的是今天用了多少、花了多少、缓存省了多少，界面不该抢这些数字的位置。

- **令牌**：颜色、字阶、圆角、阴影都在 `src/tokens.css`，浅深两套；Beautiful UI 基础样式先导入，令牌后导入覆盖。文字对比度成对检查：正文与辅助文字在页面底色和卡面上都不低于 4.5:1。
- **字体**：Geist 可变字体（OFL，拉丁字符 29 kB），中文回落苹方 / 微软雅黑；全页启用等宽数位，表格和卡片里的数字上下对齐。字阶 12 / 13 / 14 / 16 / 18 / 28，总览首个数字最大 44px，界面里没有小于 12px 的文字。标题和强调用 600，按钮、标签和数字用 500，正文用 400（2026-10-18 起与 game-manage 一致；此前只用 400 与 500）。
- **表面**：见上文「界面与动效」。白色页面、白卡片加一圈细线和两层淡阴影，卡片里只有一层灰底小块；只有菜单、对话框、提示这些浮起来的东西投更深的阴影。按钮、搜索框和分段控件是 14px 圆角矩形，图标线宽 1.75；矩阵里未上报的组合只写「—」，不画框。灰色不带色相，深色主题同理。
- **组成色谱**：用回面板原版的五色，浅深主题同值：缓存读取 `#25a878`、非缓存输入 `#3d9aff`、输出 `#f09a2f`、缓存写入 `#b393c5`、未分类 `#b4becf`，唯一来源是 `src/palette.ts`。较浅的几色在白底上低于 3:1，所以凡是用它们的图都在旁边写出数值和占比。这五色只表示用量组成，品牌标记、登录页、总览的通栏色谱和模型表的细条都是同一条色谱。
- **图表配色（原版）**：趋势线词元蓝 `#3d9aff`、费用橙 `#f09a2f`，标题前的圆点同色，缓存占比用缓存读取绿（`TREND_COLOR`）；活动日历用原版绿色阶、客户端 × 模型矩阵用原版青绿色阶（两种度量相同），浅深各一套，令牌是 `--activity-1…4`、`--matrix-1…4`，每级自带文字色；额度进度条按卡片轮换三色 `--quota-1…3`，用到 75% 转琥珀、90% 转红；摘要条图标保留原版三色。
- **图表形状（参照 uiarc.dev）**：模型详情的组成图是 208px、24px 厚的圆环，扇区带 4px 圆角、段间留 3px 缝（几何取自 Arc UI 的 donut chart，MIT，见 `src/lib/donut-sector.ts`），缓存占比放在圆心；图例逐行写名称、次要色的数值、加粗的占比。条形照 Arc UI 的 usage meter：胶囊形、段间 2px 缝露出卡片底色，客户端条用一段浅灰表示其余客户端；额度条 10px。趋势折线带渐变面积，右侧留 56px 写刻度（8000万、$90 这类短写法）。
- **总览**：顶部是四张数字卡（总用量最大，带浅蓝底；费用、缓存占比、在线设备并列）和一张通栏组成卡（色谱与五项数值）。环形图只留在模型详情里。
- **热度格**：零用量是空心描边格，未上报是斜线格，三者不靠深浅区分；图例写「颜色越浓」（深色主题下高值更亮），矩阵在费用视图里写「费用越高」。
- **去掉的装饰**：标题旁渐变飘带、侧栏推广卡、个人空间占位、各面板标题右侧的装饰图标、口号式标题与页脚标语。

色彩依据仍是 Stripe 关于可访问配色的文章：可预测的对比度、清晰的色相差异、相近的视觉重量。

## 官方来源

- Beautiful UI 目录：https://www.beautifului.dev/
- Beautiful UI Insight Cards：https://github.com/slev12397/beautiful-ui/blob/main/components/primitives/InsightCards.tsx
- Beautiful UI LoadingState：https://github.com/slev12397/beautiful-ui/blob/main/components/primitives/LoadingState.tsx
- Beautiful UI StreamingText：https://github.com/slev12397/beautiful-ui/blob/main/components/primitives/StreamingText.tsx
- Liveline：https://www.npmjs.com/package/liveline
- Beautiful UI SearchList：https://github.com/slev12397/beautiful-ui/blob/main/components/primitives/SearchList.tsx
- Beautiful UI 基础样式：https://github.com/slev12397/beautiful-ui/blob/main/app/globals.css
- beUI 目录：https://beui.dev/
- beUI 组件注册表：https://beui.dev/r/registry.json
- beUI Tabs：https://beui.dev/r/tabs.json
- beUI NumberTicker：https://beui.dev/r/number-ticker.json
- beUI StatefulButton：https://beui.dev/r/button-stateful.json
- Rare UI 通知铃：https://www.rareui.com/components/notificationbell
- Rare UI 源码：https://github.com/swamimalode07/rare-ui/blob/main/components/ui/notification-bell.tsx
- Transitions.dev：https://transitions.dev/
- Transitions.dev 官方动作令牌：https://github.com/Jakubantalik/transitions.dev/blob/main/skills/transitions-dev/_root.css
- Transitions.dev 提示框：https://github.com/Jakubantalik/transitions.dev/blob/main/skills/transitions-dev/17-tooltip.md
- shadcn/ui 对话框：https://ui.shadcn.com/docs/components/base/dialog
- shadcn/ui 标签页：https://ui.shadcn.com/docs/components/base/tabs
- Stripe 色彩系统：https://stripe.com/blog/accessible-color-systems

## 许可

Beautiful UI、beUI、Rare UI 与 shadcn/ui 的官方 MIT 许可证保留在各自目录。Transitions.dev 官方使用条款说明可把所获免费或 Pro 动效用于个人与商业产品、允许修改，但不可重新打包分发整个动效库或其大部分；本项目只选取必要的免费动效。其条款原文来自官方 GitHub 的 `terms.html` 并保留于 `transitions/terms.html`。Rare UI 于 2026-09-22 把上游许可改为 MIT 加 Commons Clause 与署名要求（需在用户能看到的位置链接 rareui.com）；本目录的通知铃是此前按 MIT 许可复制的，以后再从上游取用组件时需按新条款署名。来源参考目录不代表所有源文件都进入预览应用。

原版品牌图标来自相邻 Cloud-Monitor 项目，原始 SVG 与 NOTICE 均保留于 `public/client-logos/`；界面以单色遮罩呈现。Liveline 的许可见 `node_modules/liveline/LICENSE`。
