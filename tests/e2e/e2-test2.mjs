import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
import { keyThumbnailDigest } from "../../assets/main.mjs";
// 打开页面之前先把可能已生成的缩略图删掉（用 Node 直连，避免浏览器缓存干扰）
for (const key of ["_th2/no-type.png"]) {
  const digest = keyThumbnailDigest(key);
  await fetch(`${BASE}/webdav/_%24flaredrive%24/thumbnails/${digest}.png`, {
    method: "DELETE",
    headers: { Authorization: AUTH },
  }).catch(() => {});
}

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };

// 自清理：先删掉可能已生成的缩略图，保证从「没有缩略图」的干净状态开始
async function clearGeneratedThumbnails(page, keys) {
  await page.evaluate(async (list) => {
    const m = await import("/assets/main.mjs");
    const auth = `Basic ${localStorage.getItem("fd_auth")}`;
    for (const key of list) {
      const digest = m.keyThumbnailDigest(key);
      await fetch(m.webdavUrl(`_$flaredrive$/thumbnails/${digest}.png`), {
        method: "DELETE",
        headers: { Authorization: auth },
      }).catch(() => {});
    }
  }, keys);
}
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", async (d) => { await d.accept(); });
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_th2`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.waitForTimeout(1200);

check("已有元数据缩略图的文件：直接显示", (await page.locator('.file-item:has-text("has-thumb.png") .file-icon img[src^="blob:"]').count()) === 1);
check("octet-stream 图片：暂未显示缩略图", (await page.locator('.file-item:has-text("no-type.png") .file-icon img[src^="blob:"]').count()) === 0);

await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
await page.waitForTimeout(400);
const menuText = await page.locator(".menu-content").innerText();
check("待生成只算 octet 那张（带缩略图的不算）", /生成缩略图（1）/.test(menuText), menuText.replace(/\n/g, "|").slice(0, 80));
await page.locator(".menu-content li", { hasText: "生成缩略图" }).first().click();
let notice = "";
for (let i = 0; i < 40; i++) {
  notice = await page.locator(".notice").innerText({ timeout: 400 }).catch(() => "");
  if (/已生成/.test(notice)) break;
  await page.waitForTimeout(300);
}
check("octet-stream 也能生成（靠扩展名兜底）", /已生成\s*1\s*个缩略图/.test(notice), notice);
let rendered = 0;
for (let i = 0; i < 20; i++) {
  rendered = await page.locator('.file-item:has-text("no-type.png") .file-icon img[src^="blob:"]').count();
  if (rendered) break;
  await page.waitForTimeout(300);
}
check("生成后 octet 那张显示缩略图", rendered === 1);
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
