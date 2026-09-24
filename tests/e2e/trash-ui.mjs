import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
// 预清理：清空回收站并重建测试数据，保证脚本可反复执行
await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
await fetch(`${BASE}/webdav/_ui`, { method: "DELETE", headers: { Authorization: AUTH } });
await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
for (const [method, url, body, type] of [
  ["MKCOL", `${BASE}/webdav/_ui`, null, null],
  ["MKCOL", `${BASE}/webdav/_ui/sub`, null, null],
  ["PUT", `${BASE}/webdav/_ui/sub/b.txt`, "inner file\n", "text/plain"],
]) {
  await fetch(url, {
    method,
    headers: type ? { Authorization: AUTH, "Content-Type": type } : { Authorization: AUTH },
    body: body ?? undefined,
  });
}
const browser = await chromium.launch(launchOptions());

async function run(label, ctxOpts, isTouch) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_ui`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  console.log(`\n=== ${label} ===`);

  const row = (n) => page.locator(".file-item", { hasText: n }).first();
  const tapOrClick = async (loc) => { if (isTouch) await loc.tap(); else await loc.click(); };

  // 删除 sub（走 ⋯ 菜单，触屏与桌面都可用）
  await tapOrClick(row("sub").locator(".file-more"));
  await page.waitForTimeout(400);
  await tapOrClick(page.locator(".contextmenu button", { hasText: "删除" }).first());
  await page.waitForTimeout(1200);
  check("删除后列表里消失", (await page.locator(".file-item", { hasText: "sub" }).count()) === 0);
  const delNotice = await page.locator(".notice").innerText({ timeout: 500 }).catch(() => "");
  check("提示说明已移入回收站", /回收站/.test(delNotice), delNotice);
  check("确认框提到可恢复", dialogs.some((m) => m.includes("回收站")), dialogs.map((m) => m.slice(0, 24)).join(" / "));

  // 打开回收站
  await tapOrClick(page.locator('.menu-button button, button[aria-label="菜单"]').first());
  await page.waitForTimeout(400);
  await tapOrClick(page.locator(".menu-content li", { hasText: "回收站" }).first());
  await page.waitForSelector(".trash-table tbody tr", { timeout: 15000 });
  await page.waitForTimeout(400);
  const trashText = await page.locator(".trash-dialog").innerText();
  check("回收站里列出被删的项", trashText.includes("sub"), trashText.replace(/\n/g, "|").slice(0, 80));
  check("显示原位置", trashText.includes("_ui/sub"));
  check("说明保留天数", /天/.test(trashText));

  if (isTouch) {
    const m = await page.evaluate(() => {
      const wrap = document.querySelector(".trash-table-wrap");
      return { client: wrap.clientWidth, scroll: wrap.scrollWidth, viewport: window.innerWidth };
    });
    check("手机上表格不溢出", m.scroll <= m.client + 1, `${m.scroll}/${m.client}`);
  }

  // 恢复
  await tapOrClick(page.locator(".trash-button", { hasText: "恢复" }).first());
  await page.waitForTimeout(1500);
  const afterRestore = await page.locator(".trash-dialog").innerText();
  check("恢复后回收站里没有了", afterRestore.includes("回收站是空的") || !afterRestore.includes("_ui/sub"), afterRestore.replace(/\n/g, "|").slice(0, 60));
  await tapOrClick(page.locator(".trash-close"));
  await page.waitForTimeout(800);
  check("恢复后列表里又出现", (await page.locator(".file-item", { hasText: "sub" }).count()) >= 1);
  check(`无 JS 错误（${label}）`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await run("手机", { ...devices["Pixel 5"] }, true);
await run("桌面", { viewport: { width: 1200, height: 800 } }, false);

// 清掉测试残留
{
  const ctx = await browser.newContext({});
  const page = await ctx.newPage();
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_ui`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  await page.locator(".file-item", { hasText: "sub" }).first().locator(".file-more").click();
  await page.waitForTimeout(300);
  await page.locator(".contextmenu button", { hasText: "删除" }).first().click();
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const m = await import("/assets/main.mjs");
    await m.emptyTrash();
  });
  await ctx.close();
}
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
