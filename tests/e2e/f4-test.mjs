import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

// 准备：清掉解压产物，只留 zip
for (const d of ["batch0", "batch1", "batch2", "batch3"]) {
  await fetch(`${BASE}/webdav/_f4/${d}`, { method: "DELETE", headers: { Authorization: AUTH } });
}
await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("crash", () => console.log("  !! 页面崩溃"));
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("  导航 →", f.url().slice(0, 50)); });
page.on("dialog", async (d) => { console.log("  对话框:", d.message().slice(0, 40)); await d.accept(); });
page.on("response", (r) => { if (r.status() === 401) console.log("  401:", r.url().replace(BASE, "").slice(0, 50)); });
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_f4`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 20000 });
await page.waitForTimeout(800);

// 长按/菜单打开 big.zip 的「在线解压」
await page.locator(".file-item", { hasText: "big.zip" }).first().locator(".file-more").dispatchEvent("click");
await page.waitForTimeout(600);
const menuText = await page.locator(".contextmenu").innerText();
check("菜单里有「在线解压」", menuText.includes("在线解压"), menuText.replace(/\n/g, "|").slice(0, 60));
await page.locator(".contextmenu button", { hasText: "在线解压" }).dispatchEvent("click");
await page.waitForTimeout(1500);

// 解压中应看到进度条（200 条目 / 本地约 6~12 秒，够采样）
console.log("=== 解压进度 ===");
let sawProgress = false, sample = "";
for (let i = 0; i < 40; i++) {
  const text = await page.locator(".upload-status-text").first().innerText().catch(() => "");
  if (/正在解压/.test(text)) {
    sawProgress = true;
    sample = text;
    const bar = await page.locator("progress").count();
    if (bar > 0 && /\d+\/200/.test(text)) break;
  }
  await page.waitForTimeout(400);
}
check("解压过程中显示进度", sawProgress, sample || "(没采到)");
check("进度里有「已完成/总数」", /\d+\/200/.test(sample), sample);

// 等解压结束
let done = "";
for (let i = 0; i < 60; i++) {
  done = await page.locator(".notice").innerText({ timeout: 400 }).catch(() => "");
  if (/解压完成/.test(done)) break;
  await page.waitForTimeout(500);
}
check("完成提示", /解压完成/.test(done), done.replace(/\n/g, " ").slice(0, 70));
await page.waitForTimeout(800);
check("结束后进度条消失", (await page.locator(".upload-status").count()) === 0);
const landed = await (await fetch(`${BASE}/api/list/_f4/big/batch0`, { headers: { Authorization: AUTH } })).json();
check("文件都落地了", (landed.files || []).length === 50, `${(landed.files || []).length}/50`);
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
