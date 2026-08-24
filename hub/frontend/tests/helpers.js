// 共享测试工具：契约数据取自 mock.js（与真实 API 同契约），路由拦截仅在标注处使用。
const ACCESS_TOKEN = process.env.CM_E2E_TOKEN || "test-token";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 真实模式登录：把 ACCESS_TOKEN 写入 sessionStorage（等价于密钥门提交成功后的状态） */
async function loginWithToken(context, token) {
  await context.addInitScript((t) => {
    try { sessionStorage.setItem("cm_access_token", t); } catch (e) { /* noop */ }
  }, token || ACCESS_TOKEN);
}

/** 用 demo 模式生成一份契约合法的 overview 载荷（供路由拦截改造） */
async function sampleOverview(browser, baseURL) {
  const page = await browser.newPage({ baseURL });
  await page.goto("/demo");
  await page.waitForSelector("#shell:not([hidden])");
  const payload = await page.evaluate(() => window.CM_MOCK.buildOverview());
  const subs = await page.evaluate(() => window.CM_MOCK.buildSubscriptions());
  await page.close();
  return { payload, subs };
}

/** 拦截 overview，返回定制载荷；其余 API 落到真实后端 */
async function stubOverview(page, payload) {
  await page.route("**/api/v1/tm/overview*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) })
  );
}

/** 控制台/页面错误收集器 */
function watchConsole(page, origin) {
  const errors = [];
  const notFound = [];
  const external = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  page.on("response", (res) => {
    if (res.status() === 404) notFound.push(res.url());
  });
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin !== origin && u.protocol.startsWith("http")) {
      external.push(req.url());
    }
  });
  return { errors, notFound, external };
}

/** 期望的某时区「今天」yyyy-mm-dd（与 tm.js dayKeyTz 同算法） */
function todayKeyInTz(tz) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

module.exports = { ACCESS_TOKEN, deferred, loginWithToken, sampleOverview, stubOverview, watchConsole, todayKeyInTz };
