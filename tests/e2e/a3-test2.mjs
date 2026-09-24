import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_a3`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.locator(".upload-button").click();
await page.waitForTimeout(400);
await page.locator('input[type="file"][accept="*"]').first().setInputFiles(fixture("a3-normal.txt"));
let notice = "";
for (let i = 0; i < 25; i++) {
  notice = await page.locator(".notice").innerText({ timeout: 500 }).catch(() => "");
  if (/上传完成/.test(notice)) break;
  await page.waitForTimeout(300);
}
check("普通文件上传完成后提示上传完成", /上传完成/.test(notice), notice);
check("普通文件不会弹出解压询问", dialogs.length === 0, dialogs.join(" / ") || "(没有弹窗)");
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
