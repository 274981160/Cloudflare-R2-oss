import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

async function open(ctxOpts, label) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  const searchReqs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("/api/search")) searchReqs.push(r.url().replace(BASE, "")); });
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_s1`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(1000);
  console.log(`\n=== ${label} ===`);
  return { ctx, page, errors, searchReqs };
}

// 列表里还有「..」上一级项，统计结果时要排除
const rows = async (page) =>
  (await page.locator(".file-list .file-item").allInnerTexts()).filter(
    (text) => !text.trim().startsWith("..")
  );

/* ---------- 桌面 ---------- */
{
  const { ctx, page, errors, searchReqs } = await open({ viewport: { width: 1200, height: 800 } }, "桌面");

  // 输入关键词：当前目录即时过滤，不发请求
  await page.locator('input[type="search"]').fill("report");
  await page.waitForTimeout(700);
  check("输入时只过滤当前目录（不发请求）", searchReqs.length === 0, `${searchReqs.length} 个搜索请求`);
  const barText = await page.locator(".search-bar").innerText();
  check("提示行显示当前目录匹配数", /当前目录匹配\s*1/.test(barText.replace(/\s+/g, " ")), barText.replace(/\n/g, " "));
  const localRows = await rows(page);
  check("当前目录只剩匹配项", localRows.length === 1 && localRows[0].includes("report-2026"), localRows.join(" | ").slice(0, 60));

  // 点「搜索全部目录」
  await page.locator(".search-bar-button", { hasText: "搜索全部目录" }).click();
  await page.waitForTimeout(2500);
  check("点了才发搜索请求", searchReqs.length === 1, searchReqs.join(" | "));
  const globalRows = await rows(page);
  check("全局结果跨目录 3 条", globalRows.length === 3, globalRows.map((t) => t.split("\n")[0]).join(" / "));
  const joined = globalRows.join(" | ");
  check("结果里显示所在目录", joined.includes("_s2/sub") && joined.includes("_s1"), joined.slice(0, 90));
  const globalBar = await page.locator(".search-bar").innerText();
  check("提示行显示全局结果数", /全部目录找到\s*3/.test(globalBar.replace(/\s+/g, " ")), globalBar.replace(/\n/g, " "));

  // 打开所在目录（菜单）
  await page.locator(".file-item", { hasText: "report-final" }).first().locator(".file-more").click();
  await page.waitForTimeout(500);
  const menuText = await page.locator(".contextmenu").innerText();
  check("搜索结果菜单有「打开所在目录」", menuText.includes("打开所在目录"), menuText.replace(/\n/g, "|").slice(0, 70));
  await page.locator(".contextmenu button", { hasText: "打开所在目录" }).click();
  await page.waitForTimeout(2500);
  const crumb = await page.locator(".breadcrumb").innerText();
  check("跳到了所在目录 _s2/sub", crumb.includes("_s2") && crumb.includes("sub"), crumb.replace(/\n/g, " ").slice(0, 60));
  check("跳转后退出全局搜索视图", (await page.locator(".search-bar").count()) === 0);
  check("目标文件被选中", (await page.locator(".file-item.selected").count()) >= 1);

  // 改关键词退回当前目录模式
  await page.locator('input[type="search"]').fill("other");
  await page.waitForTimeout(600);
  const backBar = await page.locator(".search-bar").innerText().catch(() => "");
  check("改关键词后退回「当前目录匹配」", /当前目录匹配/.test(backBar.replace(/\s+/g, " ")), backBar.replace(/\n/g, " "));
  check("无 JS 错误（桌面）", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 手机 ---------- */
{
  const { ctx, page, errors } = await open({ ...devices["Pixel 5"] }, "手机");
  await page.locator('input[type="search"]').fill("report");
  await page.waitForTimeout(600);
  await page.locator(".search-bar-button", { hasText: "搜索全部目录" }).click();
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const bar = document.querySelector(".search-bar");
    const btn = bar ? bar.querySelector("button") : null;
    return {
      vw: window.innerWidth,
      docScroll: doc.scrollWidth,
      barRight: bar ? Math.round(bar.getBoundingClientRect().right) : 0,
      btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
    };
  });
  check("手机页面不横向溢出", m.docScroll <= m.vw + 1, `${m.docScroll}/${m.vw}`);
  check("搜索按钮触摸目标 ≥32px", m.btnH >= 32, `${m.btnH}px`);
  const rowsText = await rows(page);
  check("手机上全局结果也是 3 条", rowsText.length === 3, `${rowsText.length} 条`);
  await page.screenshot({ path: artifact("search-mobile.png") });
  check("无 JS 错误（手机）", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
