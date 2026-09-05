# Cloud Monitor 用量面板

正式界面的源代码在此目录。它保留总览、模型、设备、配额订阅与历史记录，并支持手机底部导航、深色模式、键盘操作、跟随鼠标或手指的明细浮窗。

## 开发与构建

需要 Node.js 22.12 以上，项目和容器构建使用 Node.js 24。

```sh
cd hub/dashboard
npm ci
npm run dev
```

开发预览地址为 `http://127.0.0.1:5188`，默认显示示例数据。设置中可临时连接当前配置的服务，密钥只保留在该预览页面内存中。`CM_DEV_API` 可指定开发代理目标；默认目标是项目现有部署。用 `VITE_HOSTED=true npm run dev` 检查正式登录入口。

```sh
npm run build
npm run build:showcase
```

正式构建输出到 `hub/frontend/app/`，所有静态资源使用 `/static/app/`。后端优先提供这个构建；未构建的源码环境仍使用原静态页面。Docker 多阶段构建会自动安装前端依赖并生成正式页面，运行容器不需要 Node.js。

演示构建输出到 `dist-showcase/`，资源和应用清单使用相对路径。演示入口不会读取保存的密钥、请求用量接口或提供系统更新操作，GitHub Pages 使用此构建。`CM_DEMO=true` 和后端的 `/demo` 同样使用隔离的演示入口。

## 登录与数据

正式页面通过现有 `ACCESS_TOKEN` 验证后才显示真实用量。普通标签页使用会话存储；安装为独立应用时使用本地存储。退出、更换密钥或收到 401／403 时清除两处保存值。写入密钥不作为面板登录密钥。

主用量先显示，订阅、提供商状态和历史明细随后加载；后端明确关闭的能力不会产生额外请求。每五分钟刷新，隐藏页面暂停，回到页面恢复刷新。网络失败保留上次数据并显示提示；页面关闭、连接切换和退出会取消旧请求。

所有组成比例、费用、配额和覆盖率以服务上报值为准。缺失值显示“未提供”，不补成零，不用当天缓存比例推算历史。历史活动恢复日／周／月、当天小时分布、时区与采样覆盖说明；每日归档按服务游标逐页读取，保留费用与缺失状态。系统更新沿用后端返回的版本和任务状态，只有用户点击具体更新按钮才会提交请求。

## 检查

```sh
npm test
npm run test:e2e
npm run build && npm run build:showcase
npm run test:hosted
```

浏览器测试在持续集成中使用 Playwright Chromium，本地使用已安装的 Chrome。`test:hosted` 还需要 Python 3.12、后端依赖和 pytest；可通过 `CM_TEST_PYTHON` 指定解释器。它会在临时目录启动真实 FastAPI 和官方 Node hub，用固定测试密钥检查正式构建，不读取个人配置，也不请求生产更新。

界面来源、原始组件和许可见 [references/README.md](references/README.md)。品牌 SVG 保留原项目的 [NOTICE](public/client-logos/NOTICE.txt)，以单色方式显示。
