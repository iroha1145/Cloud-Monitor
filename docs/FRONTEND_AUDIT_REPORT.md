# 前端审计报告

- **审计对象**：Cloud-Monitor 前端（新版 React 面板 `hub/dashboard/` + 旧版原生面板 `hub/frontend/`）
- **审计日期**：2026-09-15
- **审计分支**：`fix/model-vendor-composer-k3-glm`（最新提交 `f375615`）
- **审计结论**：无致命崩溃问题。发现 1 个 P1（移动端滚动阻断）、8 组 P2（包体积 / 无障碍 / 稳定性细节）、9 项 P3 建议。总体健康度良好，XSS 防护与请求竞态处理成熟。

> 路由说明：后端（`hub/backend/hub/main.py`）在 `hub/frontend/app/index.html` 存在时用新版面板 serving `/`，否则回退旧版。因此两套前端都需要维护。

---

## 一、构建与测试状态

| 检查项 | 结果 |
|---|---|
| `tsc -b` 类型检查 | 通过，无错误 |
| `vite build` 生产构建 | 通过，有包体积警告（`main-*.js 715.38 kB / gzip 230 kB`，超 500 kB 阈值） |
| 单元测试 `npm test` | 未验证（沙箱拦截 `tsx` IPC 管道，无法运行） |
| 构建产物 | 输出到 `hub/frontend/app/`，已被 `.gitignore` 忽略，未污染仓库 |

---

## 二、严重问题（P1）

### P1-1. 移动端大面积无法滚动：`touch-action: none` 滥用

**位置**：

- `hub/dashboard/src/metric-tooltip.css:1-5`（`[data-metric-trigger]`）
- `hub/dashboard/src/insight-trend.css:101-108`（`.insight-trend-stage`，高 272px）

**现象**：`MetricTooltip` 触发器遍布全站（模型表格每格、客户端分布条、设备统计、配额窗口、活动热力图每格），`touch-action: none` 禁止浏览器处理触摸滚动。手指落在这些元素上时页面纵向滑动完全失效；趋势图区域同样形成 272px 高的滚动死区。

**影响**：所有触屏用户。页面大面积"滑不动"，属移动端阻断级体验问题。

**修复建议**：

- 普通点按型触发器改为 `touch-action: pan-y`（允许纵向滚动）。
- 趋势图舞台同样改为 `pan-y`：横向拖动查看明细不受影响，纵向可正常滚页。
- 仅在真正需要双向 scrub 的手势区保留 `none`（本项目暂无此需求）。

---

## 三、中等问题（P2）

### P2-1. 首屏包过大，无代码分割

**位置**：`hub/dashboard/src/App.tsx`（一次性引入全部视图）、`hub/dashboard/package.json`

**现象**：

1. `main-*.js` 715 kB / `main-*.css` 190 kB。只看总览也要下载历史归档、系统更新、全部对话框代码。
2. `recharts` 在 `package.json` 中，但 `src` 内零引用，属无效依赖。
3. `hub/dashboard/src/components/ui/dropdown-menu.tsx` 从未被任何页面引用，属死代码。
4. 6 个 `components/ui/*` 文件都从 `radix-ui` 元包导入（如 `import { Dialog as DialogPrimitive } from "radix-ui"`），不利于 tree-shaking。

**修复建议**：

- 对 `SecondaryViews`、`ArchivePanel`、`SystemUpdate`、各 Dialog 做 `React.lazy + Suspense`。
- 删除 `recharts` 依赖与 `dropdown-menu.tsx`。
- 将 `radix-ui` 拆为 `@radix-ui/react-dialog` 等作用域包按需导入。

### P2-2. Tooltip 无障碍问题（`MetricTooltip.tsx`）

**位置**：`hub/dashboard/src/MetricTooltip.tsx:220-228`

**现象**：

1. **可见文本与无障碍名称不一致（WCAG 2.5.3 风险）**：组件覆写触发器的 `aria-label`（如显示"刚刚同步"的元素被覆写为"MacBook Pro · 最近同步，查看详细信息"），读屏用户听不到可见文本。
2. **Tab 顺序爆炸**：矩阵 8×8=64 格、每行模型数格全部 `tabIndex={0}`，键盘用户需上百次 Tab 才能过完一页。
3. **误用 `role="button"`**：大量仅展示 tooltip 的 `<span role="button">` 并无点击行为，读屏播报为按钮会误导用户。
4. `onPointerDown` 对鼠标也 `preventDefault()`，阻止点击聚焦，读屏上下文丢失。

**修复建议**：

- 只用 `aria-describedby` 关联 tooltip，不覆写 `aria-label`。
- 给 `MetricTooltip` 加 `focusable` 开关，仅关键元素可聚焦，纯补充信息只保留悬停。
- tooltip-only 触发器去掉 `role="button"`，保留无 role + `aria-describedby`。
- 仅对触摸 `preventDefault`，鼠标保留默认聚焦行为。

### P2-3. 趋势图性能与键盘细节（`InsightTrend.tsx`）

**位置**：`hub/dashboard/src/InsightTrend.tsx`、`hub/dashboard/src/trend-math.ts`

**现象**：

1. 每次 `mousemove` 做约 90 次 `Date.parse`：`setFromPointer` 内的 `reduce` 每次调用 `utcDay()`，60Hz 下约 5400 次解析/秒，低端机可能掉帧。
2. render 期间读布局：`stageRef.current?.getBoundingClientRect()` 写在渲染函数里，每次渲染强制同步布局；且 `plot` 每次是新对象，导致定位 effect 每 render 重跑。
3. `Liveline` 的 `key` 含 `data.generatedAt`：每 5 分钟轮询后整块 canvas 卸载重挂，tooltip 状态丢失、动画重播。
4. `role="slider"` 只处理左右方向键，APG 规范要求 Up/Down 也映射为前后一天。
5. `trend-math.ts` 当前是 Catmull-Rom + 钳制实现，而 `docs/PR32_UI_AUDIT_REPORT.md` 描述的是 Fritsch–Carlson 单调三次插值（`monotoneTrendSlopes`），文档与代码不一致。经查 PR #32 不在当前 git 历史中（如尚未合并属正常，否则可能是回归）。

**修复建议**：`useMemo` 预计算时间戳数组；布局读取移到事件/effect 内；`key` 只用 `days-metric`；补齐 Up/Down；核对 PR #32 状态并同步文档。

### P2-4. 成功响应的非 JSON 未被包装

**位置**：`hub/dashboard/src/api.ts:24-37`、`hub/dashboard/src/restoration-api.ts` 成功分支

**现象**：若代理返回 200 的 HTML 错误页，`response.json()` 抛出的原生 `SyntaxError`（`Unexpected token '<'…`）会直接展示给用户。后者错误分支已正确 try/catch，成功分支遗漏。

**修复建议**：对成功分支的 `response.json()` 同样 try/catch，转为"服务返回格式异常，请稍后重试"类友好文案。

### P2-5. 旧版面板 Token 清理不对称（`tm.js`）

**位置**：`hub/frontend/tm.js`（`store.token` setter、`enterDemo`、`logout`）

**现象**：`store.token = ""` 只清当前 `display-mode` 对应的 storage（standalone 用 localStorage，标签页用 sessionStorage）。新版 `auth.ts` 的 `clearAccessToken()` 会双清。旧版登出/进演示模式后，另一 storage 的旧 token 残留，切换显示模式后可能"复活"。

**修复建议**：照新版实现双 storage 清理。

### P2-6. 旧版更新轮询循环无法取消（`tm.js`）

**位置**：`hub/frontend/tm.js`（`applyUpdateRef`，约 180×2s 循环）

**现象**：最长 6 分钟的 `for` 循环轮询更新状态，无 `AbortController`；用户关闭对话框后循环继续跑，还会写已隐藏的 DOM，甚至在用户做别的事时突然 `location.reload()`。

**修复建议**：对话框关闭即取消轮询（AbortController / generation 标志），`reload` 前确认对话框仍处于更新流程中。

### P2-7. 旧版 resize / toast 性能细节（`tm.js`）

**位置**：`hub/frontend/tm.js`（`resize` 监听、`toastSpreadTrack`）、`hub/frontend/tm.css`

**现象**：

1. 每次 `resize` 事件同步调用 `positionAllPills(true)`（多次 `offsetWidth` 读写），拖动窗口时高频强制布局（文件内已有 160ms 防抖渲染，pill 定位未纳入）。
2. 超过 1 条 toast 时在 `document` 上监听每次 `pointermove` 并读 `getBoundingClientRect`，60Hz 开销。

**修复建议**：pill 定位纳入 rAF/节流；toast 命中检测缩小监听范围或节流。

### P2-8. CSV 导出与通知计数细节

**位置**：`hub/dashboard/src/App.tsx`（`escapeCsv`、`exportModels`、`notices`）、`hub/dashboard/src/SecondaryViews.tsx`（`sessionsToCsv`、`exportCsv`）

**现象**：

1. `App.tsx` 的 `escapeCsv` 只处理行首 `= + - @`，而 `sessionsToCsv` 还处理前导空白/tab，两处公式注入防护强度不一致。
2. 两处导出都用游离 `<a>` 直接 `click()`，旧版 Firefox 对未挂载节点触发下载不可靠。
3. 渲染用 `[...new Set(notices)]` 去重，但徽标 `statusCount = notices.length` 是去重前长度，极端情况下角标大于实际条数。

**修复建议**：统一用 `sessionsToCsv` 的严格正则；`a` 先 `appendChild` 再 `remove`；先去重再计数。

---

## 四、轻微问题与建议（P3）

| 编号 | 位置 | 说明 | 建议 |
|---|---|---|---|
| P3-1 | `SystemUpdate.tsx`（`displayTime`） | "最近检查"用浏览器本地时区，其他时间用 dashboard 时区 | 统一时区或明确标注 |
| P3-2 | `SystemUpdate.tsx`（release notes） | `<pre>` 纯文本展示，URL 不可点；旧版会 linkify | 补回安全 linkify（先转义），与旧版 parity |
| P3-3 | `HostedRoot.tsx`（登录框） | `autocomplete="current-password"` 会触发密码管理器保存提示，token 并非密码 | 改 `autocomplete="off"`，与旧版一致 |
| P3-4 | 新旧 `theme-color` | 旧版深色 `#0b1220` vs 新版 `#191b20`，浅色 `#f8fafd` vs `#fafafb` | 统一，避免切换面板时浏览器 chrome 闪变 |
| P3-5 | `hub/frontend/mock.js` vs `data.ts createDemoData` | 两套演示数据源各自维护，易漂移 | 长期只保留一套 |
| P3-6 | `restoration-api.ts`（`validUpdateRef`） | 非数字开头 tag（如 `stable`）直接隐藏升级按钮且无解释 | 给出"该版本标识不受支持"提示 |
| P3-7 | `data.ts`（`diagnosticText`） | `JSON.stringify` 单个诊断值未限长 | 截断（如 200 字符） |
| P3-8 | `data.ts`（订阅金额） | `validCounter`（≥0）解析金额，退款/抵扣负数变"未提供" | 如业务无负金额可忽略，否则放宽 |
| P3-9 | `App.tsx` / `MobileNavigation.tsx` | `scrollTo({ behavior: "instant" })` 较新，旧浏览器忽略 | 必要时降级 `scrollTo(0, 0)` |

---

## 五、做得好的地方（保持）

- **XSS 防护严格**：旧版几乎所有 `innerHTML` 插值经 `esc()`，外链有 `http(s)` 白名单，release notes 先转义再 linkify；新版 React 默认转义 + `safeGithubUrl` + 更新 ref 白名单正则。`switchView` 对 hash 做 `VIEWS` 白名单校验，无选择器注入。
- **请求竞态成熟**：新旧两版均有 generation/abort 机制；`nextArchiveCursor` 与旧版 `seen` 集合都防住"游标不前进死循环"。
- **降级完整**：overview → aux 独立状态机、历史分页失败回退概览内嵌数据、tooltip 在触屏/键盘/缩放下的定位修正。
- **无障碍基础好**：skip-link、Radix Dialog 焦点陷阱、趋势图 `role="slider"` + 键盘操作、表格 `scope`、可滚动区 `tabindex + role="region"`。

---

## 六、建议修复顺序

1. **P1-1** `touch-action` 改 `pan-y`（改动小、收益最大）。
2. **P2-1** 代码分割 + 删 `recharts`/死代码（首屏 715 kB 预期减半）。
3. **P2-2 / P2-3** tooltip 无障碍与趋势图性能（键盘用户 + 低端机）。
4. **P2-4 / P2-5 / P2-6** JSON 解析包装、旧版 token 双清、更新循环取消。
5. 其余 P2-7 / P2-8 / P3 按需排期。
