# PR #32 UI 改动代码与交互审计报告（第二轮·最终版）

- **当前分支状态（2026-09-15）**：PR #32 已合入 GitHub `main`（`3445a8b`）。本工作区已把 `trend-math.ts` 的 Fritsch–Carlson 规范、`InsightTrend` 直接交给 Liveline 的日点、以及 Android `TrendCurve.kt` 对齐回当前分支，文档与代码一致。
- **审查对象**：[Pull Request #32: 用量趋势曲线改为更圆滑的单调三次插值](https://github.com/iroha1145/Cloud-Monitor/pull/32)
- **目标分支**：`main` ← `cursor/smooth-trend-curve-29ec`
- **最新审查提交**：`c3f0129`（`fix(dashboard): 对齐趋势曲线双端末尾收平与两天三次曲线`）
- **审计范围**：Web 端趋势图表 (`InsightTrend.tsx`, `trend-math.ts`)、Android 端图表与曲线算法 (`Charts.kt`, `TrendCurve.kt`, `TrendCurveTest.kt`)、测试用例与跨端一致性
- **最终审计结论**：**【完全通过 (Approved)】**。PR 作者在最新提交中针对第一轮审计提出的**数学规范定位、跨端末端切线对齐、双点数据形态一致性**等问题做出了极高质量的针对性重构，双端几何行为已实现数学级严格对齐，无任何残留阻断项。

---

## 一、 最新更新对比与问题闭环状态

| 原审计发现（第一轮） | 严重级 | 最新提交（`c3f0129`）跟进处理 | 闭环状态 |
|---|---|---|:---:|
| **1. 生产代码移除引用，`trend-math.ts` 沦为死代码且注释过时** | P2 (中) | 重新定位为**算法规范基准与测试预言机（Specification / Test Oracle）**。详尽重写了 JSDoc 注释，说明其作为离线数学断言与跨端统一规范的作用，并导出了 `monotoneTrendSlopes` 供单元测试验证。 | **已完全闭环** |
| **2. 最新一天（末端点）几何切线双端不一致** | P3 (低) | 抽取纯函数 `monotoneTrendSlopes` 至 `TrendCurve.kt`。Android 端显式加入 `m[n - 1] = 0f`，与 Web 端 Liveline 追加实时 tip 产生的末端水平收平行为完全一致，两端均平滑贴合水平参考虚线。 | **已完全闭环** |
| **3. 仅有 2 天数据时双端形态不一致（线段 vs S 弯）** | P3 (低) | Android `Charts.kt` 去除了原先针对 $N=2$ 的折线直连降级（`if (n == 2) path.lineTo(...)`），双端在 2 天数据时均计算三次贝塞尔，起步带斜率、终点水平收平，形态完全一致。 | **已完全闭环** |

---

## 二、 关键技术细节审计与数学验证

### 1. 双端 Fritsch–Carlson 单调插值斜率算法的等价性证明

在最新代码中，算法逻辑在 Web 端 (`trend-math.ts`)、Android 端 (`TrendCurve.kt`) 以及底层 Canvas 引擎 (`node_modules/liveline/dist/index.js`) 之间实现了完全严格的对称映射：

- **斜率推导**：
  设第 $i$ 段割线斜率为 $\Delta_i = \frac{y_{i+1} - y_i}{x_{i+1} - x_i}$。
  内部节点斜率初值 $m_i = \frac{\Delta_{i-1} + \Delta_i}{2}$（当 $\Delta_{i-1} \cdot \Delta_i \le 0$ 时置 0，极值点平滑收平）。
- **单调性约束**：
  若 $\Delta_i \ne 0$，计算 $\alpha_i = m_i / \Delta_i, \beta_i = m_{i+1} / \Delta_i$。
  当 $\alpha_i^2 + \beta_i^2 > 9$ 时，通过比例缩放因子 $\tau = \frac{3}{\sqrt{\alpha_i^2 + \beta_i^2}}$ 对 $m_i, m_{i+1}$ 进行压缩，确保曲线满足 Fritsch–Carlson 单调性充分条件，**绝对不越界、不产生虚假过冲**。
- **末端收平（Latest Day Flattening）**：
  - Web 端由于 Liveline 在末尾添加同 $Y$ 坐标的 live tip 点（$\Delta_{N-1} = 0$），使得 $m_{N-1}$ 自动收敛为 0；
  - Android 端在 `TrendCurve.kt` 中显式指定 `m[n - 1] = 0f`；
  - **数学严谨性验证**：在最后一个区间 $[x_{n-2}, x_{n-1}]$ 上，由于原本经过缩放后满足 $\alpha^2 + \beta^2 \le 9$（此时 $\alpha^2 \le 9$），当 $\beta$ 变为 0 后，新的 $\alpha_{new}^2 + 0 \le 9$ 依然必然成立。因此末端收平**完全不破坏单调性约束**，不会在最后一个点附近产生任何波形畸变。

### 2. 边界条件覆盖与容错性审计

审查 `android/app/src/main/java/io/github/iroha1145/cloudmonitor/data/TrendCurve.kt`：
- **$N = 0, 1$**：直接返回空数组或 `[0f]`，安全守卫完整；
- **$x_{i+1} == x_i$（除零保护）**：`if (h[i] == 0f) 0f else ...`，杜绝 `NaN` / `Infinity` 产生；
- **$\Delta_i == 0$（水平相邻点）**：将相邻两点斜率安全置 0，平滑过渡；
- **$N = 2$（极少数据场景）**：
  计算得到 $m = [\Delta_0, 0f]$，在三次贝塞尔公式下生成一段单调平滑的 S 弯曲线，使刚接入监控系统（仅两天记录）的设备在两端均能获得连贯优雅的视觉呈现。

---

## 三、 测试与验证审计

1. **Web 端测试**：
   - `hub/dashboard/tests/review.test.ts` 新增对末端收平行为的显式断言：
     `test("the latest daily point is flattened like Liveline's same-Y tip", ...)`；
   - 覆盖负数账单抵扣、段内不越界、大落差峰值平滑及 2 天极简数据，**72 项单元测试全部通过**。
2. **Android 端测试**：
   - 新增 `TrendCurveTest.kt`，包含 3 项纯数学单元测试：
     - `latestDayIsFlattenedOnARisingSeries`：验证单调递增时末端斜率归零；
     - `twoDaysEaseIntoAFlatLatestPoint`：验证 2 点数据平滑缓入端点；
     - `aPeakGetsAFlatTangentWithoutOvershootingNeighbors`：验证大峰值平缓切线与单调防穿透。
   - `WorkbenchTest.kt` 将原脆弱的 shell 虚拟返回键替换为 `InputMethodManager.hideSoftInputFromWindow`，消除了 Activity 重建时的时序竞态，Android 模拟器测试已稳定通过。
3. **CI 状态复核**：
   - GitHub Actions 中 `apk`、`dashboard`、`device-tests (34, google_apis)`、`docker-e2e`、`test` 均已顺利通过；
   - 期间 `tests` 工作流出现的 `test_hourly_activity_diff_buckets` 失败，经溯源为后端测试脚本自身在接近东京时间午夜（23:55）运行跨日数据时的固有 Flaky 现象（硬编码 `now + 6min` 跨天但未 mock 时间），与 PR #32 的 UI 及折线改动完全无关。

---

## 四、 审查结语

PR #32 的本次更新是一次非常严谨、典范级别的重构交付：
- 它不仅彻底解决了大落差峰谷处的折痕尖角缺陷；
- 维护了图表悬停 Tooltip 的 100% 数据保真度；
- 在 Web 与 Android 双端之间确立了统一的数学规范并辅以完备的单元测试；
- 消除了死代码歧义，提升了移动端自动化测试的健壮性。

**建议：予以合并（Ready to merge）**。
