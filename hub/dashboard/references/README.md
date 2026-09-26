# Cloud-Monitor 界面参考与源码

核对时间：2026-09-05；动效部分 2026-09-26 更新。此目录保留官方来源与未修改源码；实际采用哪些组件以预览项目导入为准。

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

Rare UI 通知铃依赖 `motion`、`@radix-ui/react-slot` 和 `@/lib/utils` 的 cn；告警数量变化时才产生摆动，支持 `useReducedMotion`。需要真实 count 变化，不设置持续循环动画。

## 动效规范

标题进入采用官方 `StreamingText.tsx` 中的 `fade-up 350ms cubic-bezier(0.23,1,0.32,1)`，副说明延后 90 毫秒；刷新进行中才显示官方 `LoadingState.tsx` 的文字高光，保持 1.4 秒周期，归档与系统更新的读取提示沿用同一高光。两个原始文件保留在 `beautifului/`。用量蓝 `#3d9aff`、输出橙 `#f09a2f`、缓存绿 `#25a878` 取自 Insight Cards 与 Filter Table 的实际用色；文字和底色采用其冷中性色，并提高辅助文字对比度。

时长与缓动统一取自 Transitions.dev 官方令牌，写在 `src/styles.css` 的 `:root`（`--duration-*`、`--ease-smooth-out` 等），各处配方在 `src/motion.css`，`src/lib/motion.ts` 为 motion/react 提供同一组数值。各处用法：

| 交互 | 配方 | 节奏 |
| --- | --- | --- |
| 提示框 | 17 tooltip | 延迟 80ms，出现 150ms，退出 50ms |
| 对话框 | 06 modal | 打开 250ms 由 0.96 放大，关闭 150ms 缩回；弹窗层首次打开后常驻，关闭动画才能播完 |
| 下拉选择 | 05 menu dropdown | 打开 250ms 由 0.97 放大，关闭 150ms |
| 手机抽屉 | 07 panel reveal | 从左侧滑入 400ms，滑出 250ms |
| 分段切换 | 16 tabs sliding | 统计周期、趋势范围与指标、矩阵指标、活动范围、手机底部导航共用一个滑块，250ms；首次定位与尺寸变化不做动画 |
| 页面切换 | 18 texts reveal | 容器淡入 250ms、淡出 150ms；切换页面后各区块上移 8px 依次出现，间隔 40ms，最多 4 级；首次打开的页面保持静止 |
| 折叠明细 | 21 accordion | 所有原生 `<details>` 用 `::details-content` 展开收起 250ms，箭头同步转动；不支持的浏览器保持立即切换 |
| 加载占位 | 14 skeleton | 视图代码加载时显示卡片骨架，1 秒一次的脉动；内容到达后随页面区块上移出现 |
| 提示条 | 22 toast | 上移 16px、去模糊、由 0.97 放大，打开 350ms，关闭 250ms |
| 主题切换 | 09 icon swap + beUI theme toggle | 日月图标交替 250ms；新主题以按钮为圆心扩散 500ms（View Transitions，不支持时直接切换） |
| 用量条与环形图 | — | 首次出现时从左填充 500ms，行间隔 40ms；周期切换时宽度和环段过渡 400ms |
| 活动热力图 | beUI heat calendar | 切换日/周/月时格子沿对角线依次弹出，每格延后 18ms；指针悬停的格子放大 1.14 倍 |
| 模型表 | Beautiful UI GlideMenu | 一块高亮在行间滑动，只在可悬停的设备上启用 |
| 密钥被拒绝 | 12 error shake | 用户提交的密钥被服务端拒绝（401/403）时，输入框 280ms 左右抖动并标为无效；网络错误、自动登录失败和会话过期只显示文字 |

只在用户操作或数据状态变化时触发。同步状态点在每次拿到新快照时闪一圈；数值没变时，数字和用量条不会重播动画。示例数据每次点「刷新数据」会给当天加一点用量，用来检查数字滚动和用量条过渡。减少动画设置下，页面区块、骨架脉动、抖动和主题扩散全部关闭，其余动效时长和延迟压到接近 0。

仪表板不需要持续流光、立体卡片倾斜、磁性按钮。用轻微的选中背景滑动、同步完成勾选、数值滚动表达反馈。上述选择是本项目的设计判断，不是来源方要求。

## 视觉依据

Stripe 的官方文章强调可预测的文字对比度、清晰的色相差异、不同颜色相近的视觉重量。适合此项目的提炼是浅色工作台、深色数字、统一间距、细边框与青绿、蓝、暖橙的分工配色；缓存读写、输出和未知部分使用可区分的语义色。色彩应成对检查文字/底色对比度，不能只追求柔和灰色。

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
