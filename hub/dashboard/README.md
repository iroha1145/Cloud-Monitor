# Cloud Monitor 网页面板 (`hub/dashboard`)

这里是 Cloud Monitor 网页前端的源代码目录（基于 React 19 + TypeScript + Vite 构建）。

## 界面特性

- **五大核心视图**：用量总览、模型分析、已连接设备、配额与订阅、活跃度与每日归档。
- **桌面与手机双端自适应**：
  - **桌面端**：配备可拖拽并吸附到窗口四角的浮动导航菜单，菜单靠近卡片时卡片会自动平滑避让。
  - **手机端**：配备贴底三档磁吸抽屉（收起、半开、全开），单手即可切换页面或打开设置。
- **深色模式与时区自适应**：默认跟随系统深浅色切换（也可手动锁定），所有图表与活跃时段自动按当前浏览器时区展示。
- **设计规范**：视觉层级、字阶、同心圆角、控件尺寸与物理动效详见 [references/README.md](references/README.md)。

## 本地开发

需要 **Node.js 22.12+**（容器与 CI 使用 Node.js 24）：

```bash
cd hub/dashboard
npm ci
npm run dev
```

打开 `http://127.0.0.1:5188` 即可实时预览：
- **默认演示模式**：启动后自带一套完整的示例数据，无需启动后端即可调试界面；点击右上角「刷新数据」会模拟今日新增用量。
- **连接真实服务器**：在预览页点击「连接设置」，填入服务器地址和 `ACCESS_TOKEN` 即可拉取真实数据（密钥仅保存在当前标签页内存中）。
- **调试正式登录页**：运行 `VITE_HOSTED=true npm run dev` 可直接预览实机环境下的登录门禁界面。

## 编译构建

```bash
# 1. 生产环境构建（输出到 ../frontend/app/，供 Python 后端托管）
npm run build

# 2. 静态演示构建（输出到 dist-showcase/，供 GitHub Pages 部署）
npm run build:showcase
```

- **Docker 部署无需手动编译**：根目录 `docker compose up -d --build` 会在多阶段构建中自动完成前端编译。
- **直接裸跑 Python 后端时**：请先执行一次 `npm run build`，否则访问首页会提示「未找到前端页面」。

## 运行测试

```bash
npm test             # 运行全部前端单元与数据契约测试
npm run test:e2e     # 运行 Playwright 浏览器端到端与无障碍测试
npm run test:hosted  # 启动临时 FastAPI + 官方 Node Hub 跑全链路集成测试
```
