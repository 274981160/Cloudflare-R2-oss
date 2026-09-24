import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
// localStorage 存裸 base64（App 自己拼 Basic）
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

async function fresh() {
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_f3`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_f3`, { method: "MKCOL", headers: { Authorization: AUTH } });
}
const names = async () => {
  const res = await fetch(`${BASE}/api/list/_f3`, { headers: { Authorization: AUTH } });
  return (await res.json()).files.map((f) => f.name).sort();
};
async function openApp(opts) {
  const ctx = await browser.newContext(opts || { viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_f3`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}
// 这个 headless 环境里 Playwright 的鼠标事件对部分元素不生效，用 dispatchEvent
const click = (page, sel) => page.locator(sel).dispatchEvent("click");

/* ---------- 场景 1：3 个文件，其中 1 个失败 → 面板逐项显示 + 可重试 ---------- */
await fresh();
{
  const { ctx, page, errors } = await openApp();
  let blockB = true;
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (blockB && route.request().method() === "PUT" && url.includes("f3b.txt")) {
      return route.fulfill({ status: 500, body: "boom" });
    }
    return route.continue();
  });
  await click(page, ".upload-button");
  await page.waitForTimeout(500);
  await page.locator('input[type="file"][accept="*"]').first().setInputFiles([fixture("f3a.txt"), fixture("f3b.txt"), fixture("f3c.txt")]);
  await page.waitForTimeout(4000);

  console.log("=== 场景 1：逐文件状态 ===");
  const head = await page.locator(".upload-status-head").innerText();
  check("汇总显示已完成/失败数", /已完成\s*2\/3/.test(head.replace(/\s+/g, " ")) && /失败\s*1/.test(head.replace(/\s+/g, " ")), head.replace(/\n/g, " "));
  const rows = await page.locator(".upload-task").allInnerTexts();
  check("详情里每个文件一条", rows.length === 3, rows.map((r) => r.split("\n")[0]).join(" / "));
  const joined = rows.join(" | ");
  check("成功项标「已完成」", (joined.match(/已完成/g) || []).length === 2, joined.slice(0, 100));
  check("失败项标「失败」并给出原因", /f3b\.txt[\s\S]*失败/.test(joined) && /boom|请求失败/.test(joined), joined.slice(0, 140));
  check("失败项有「重试」按钮", (await page.locator(".upload-task-retry").count()) === 1);
  check("只有 2 个文件真的落地", (await names()).join(",") === "f3a.txt,f3c.txt", (await names()).join(","));

  // 重试单个失败项
  blockB = false;
  await click(page, ".upload-task-retry");
  await page.waitForTimeout(4000);
  check("重试后 3 个文件都在", (await names()).join(",") === "f3a.txt,f3b.txt,f3c.txt", (await names()).join(","));
  const head2 = await page.locator(".upload-status-head").innerText();
  check("汇总更新为 3/3", /已完成\s*3\/3/.test(head2.replace(/\s+/g, " ")), head2.replace(/\n/g, " "));
  check("失败项消失后不再显示重试", (await page.locator(".upload-task-retry").count()) === 0);
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 场景 2：「重试全部失败」+ 关闭面板 ---------- */
await fresh();
{
  const { ctx, page } = await openApp();
  let blockAll = true;
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (blockAll && route.request().method() === "PUT" && /f3[ab]\.txt/.test(url)) {
      return route.fulfill({ status: 500, body: "boom" });
    }
    return route.continue();
  });
  await click(page, ".upload-button");
  await page.waitForTimeout(500);
  await page.locator('input[type="file"][accept="*"]').first().setInputFiles([fixture("f3a.txt"), fixture("f3b.txt"), fixture("f3c.txt")]);
  await page.waitForTimeout(4000);
  console.log("=== 场景 2：重试全部失败 ===");
  check("两个失败项", (await page.locator(".upload-task-retry").count()) === 2, String(await page.locator(".upload-task-retry").count()));
  const retryAll = page.locator(".upload-retry-all");
  check("出现「重试全部失败」按钮", (await retryAll.count()) === 1, await retryAll.innerText().catch(() => ""));
  blockAll = false;
  await click(page, ".upload-retry-all");
  await page.waitForTimeout(4500);
  check("全部重试后 3 个文件都在", (await names()).join(",") === "f3a.txt,f3b.txt,f3c.txt", (await names()).join(","));
  check("重试后没有残留失败项", (await page.locator(".upload-task-retry").count()) === 0);
  const dismiss = page.locator(".upload-dismiss");
  if (await dismiss.count()) {
    await click(page, ".upload-dismiss");
    await page.waitForTimeout(500);
    check("「关闭」能收起面板", (await page.locator(".upload-status").count()) === 0);
  } else {
    check("全部成功后不显示「关闭」（无失败项时不需要它）", (await page.locator(".upload-dismiss").count()) === 0);
  }
  // 全部成功后面板应自动收起
  await page.waitForTimeout(5000);
  check("全部成功后面板自动收起", (await page.locator(".upload-status").count()) === 0);
  await ctx.close();
}

/* ---------- 场景 3：手机布局 ---------- */
await fresh();
{
  const { ctx, page } = await openApp({ ...devices["Pixel 5"] });
  let blockB = true;
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (blockB && route.request().method() === "PUT" && url.includes("f3b.txt")) return route.fulfill({ status: 500, body: "boom" });
    return route.continue();
  });
  await click(page, ".upload-button");
  await page.waitForTimeout(500);
  await page.locator('input[type="file"][accept="*"]').first().setInputFiles([fixture("f3a.txt"), fixture("f3b.txt")]);
  await page.waitForTimeout(4000);
  console.log("=== 场景 3：手机布局 ===");
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const panel = document.querySelector(".upload-status");
    const list = document.querySelector(".upload-task-list");
    return {
      vw: window.innerWidth,
      docScroll: doc.scrollWidth,
      panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : 0,
      listOverflow: list ? list.scrollWidth > list.clientWidth + 2 : false,
      retryH: (() => { const b = document.querySelector(".upload-task-retry"); return b ? Math.round(b.getBoundingClientRect().height) : 0; })(),
    };
  });
  check("手机页面不横向溢出", m.docScroll <= m.vw + 1, `${m.docScroll}/${m.vw}`);
  check("面板在屏内", m.panelRight <= m.vw + 1, `${m.panelRight}/${m.vw}`);
  check("任务列表内部不溢出", m.listOverflow === false);
  check("重试按钮触摸目标 ≥28px", m.retryH >= 28, `${m.retryH}px`);
  // 提示不能盖住面板头部
  const overlap = await page.evaluate(() => {
    const notice = document.querySelector(".notice");
    const head = document.querySelector(".upload-status-head");
    if (!notice || !head) return null;
    const a = notice.getBoundingClientRect(), b = head.getBoundingClientRect();
    return !(a.bottom <= b.top + 2 || a.top >= b.bottom - 2);
  });
  check("提示不遮挡面板头部", overlap === false, overlap === null ? "(无提示或面板)" : String(overlap));
  await page.screenshot({ path: artifact("f3-mobile.png") });
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
