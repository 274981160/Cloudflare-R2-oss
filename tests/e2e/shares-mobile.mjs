import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

async function openShares(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_exp`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
  await page.waitForTimeout(400);
  await page.locator(".menu-content li", { hasText: "分享管理" }).first().click();
  await page.waitForSelector(".shares-table tbody tr", { timeout: 15000 });
  await page.waitForTimeout(500);
  return { page, errors };
}

/* ---------- 手机 ---------- */
{
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const { page, errors } = await openShares(ctx);
  console.log("\n=== 手机（Pixel 5，393px 宽）===");

  const rows = await page.locator(".shares-table tbody tr").count();
  check("分享列表有数据", rows >= 2, `${rows} 行`);

  const meta = await page.locator(".shares-key-meta").first().innerText();
  // 第一行可能是永久分享（显示「长期有效」而不是「到期」），所以这里只要求有创建时间
  check("路径下方显示创建时间", /创建/.test(meta), meta.replace(/\n/g, " "));
  const allMeta = (await page.locator(".shares-key-meta").allInnerTexts()).join(" | ");
  check("有效期能看出来（30 天后，应为 2026-10-23）", /2026-10-2\d/.test(allMeta), allMeta.replace(/\n/g, " "));
  check("永久分享显示「长期有效」", /长期有效/.test(allMeta), allMeta.replace(/\n/g, " "));

  // 关键：表格不能被长文件名撑宽（应可横向不溢出）
  const metrics = await page.evaluate(() => {
    const wrap = document.querySelector(".shares-table-wrap");
    const table = document.querySelector(".shares-table");
    const keyCell = document.querySelector(".shares-key");
    return {
      wrapClient: wrap.clientWidth,
      wrapScroll: wrap.scrollWidth,
      tableWidth: table.getBoundingClientRect().width,
      keyCellWidth: keyCell.getBoundingClientRect().width,
      dialogWidth: document.querySelector(".shares-dialog").getBoundingClientRect().width,
      viewport: window.innerWidth,
    };
  });
  console.log("布局数据:", JSON.stringify(metrics));
  check("表格不超出容器（没有横向撑宽）", metrics.tableWidth <= metrics.wrapClient + 1, `表 ${Math.round(metrics.tableWidth)} / 容器 ${metrics.wrapClient}`);
  check("容器无需横向滚动", metrics.wrapScroll <= metrics.wrapClient + 1, `scrollWidth ${metrics.wrapScroll} vs client ${metrics.wrapClient}`);
  check("路径单元格在容器内折行", metrics.keyCellWidth <= metrics.wrapClient, `${Math.round(metrics.keyCellWidth)}px`);
  check("弹窗不超出屏幕", metrics.dialogWidth <= metrics.viewport, `${Math.round(metrics.dialogWidth)} / ${metrics.viewport}`);

  // 按钮可见可用
  const shortLabel = await page.locator(".shares-btn-short").first().innerText();
  check("窄屏按钮用短文案", shortLabel.trim() === "复制", shortLabel);
  const buttons = await page.locator(".shares-actions button").count();
  check("每行三个操作按钮都在", buttons >= 3, `${buttons} 个`);
  const lastBtnBox = await page.locator(".shares-actions button").last().boundingBox();
  check("最后一个按钮在屏内", lastBtnBox.x + lastBtnBox.width <= metrics.viewport + 1, `右边缘 ${Math.round(lastBtnBox.x + lastBtnBox.width)} / ${metrics.viewport}`);
  check("手机无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 桌面（不应退化） ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const { page, errors } = await openShares(ctx);
  console.log("\n=== 桌面（回归）===");
  const expTd = await page.locator(".shares-table tbody tr").first().locator("td").nth(3).innerText();
  check("桌面仍显示独立的「过期时间」列", expTd.length > 0, expTd);
  const metaVisible = await page.locator(".shares-key-meta").first().isVisible();
  check("桌面不显示重复的窄屏那行", metaVisible === false);
  const fullLabel = await page.locator(".shares-btn-long").first().isVisible();
  check("桌面按钮用完整文案", fullLabel === true);
  const metrics = await page.evaluate(() => {
    const wrap = document.querySelector(".shares-table-wrap");
    return { client: wrap.clientWidth, scroll: wrap.scrollWidth };
  });
  check("桌面长文件名也不撑宽", metrics.scroll <= metrics.client + 1, `scroll ${metrics.scroll} / client ${metrics.client}`);
  check("桌面无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
