import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
import { keyThumbnailDigest } from "../../assets/main.mjs";
// 打开页面之前先把可能已生成的缩略图删掉（用 Node 直连，避免浏览器缓存干扰）
for (const key of ["_th/via-webdav.png"]) {
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
const dialogs = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_th`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.waitForTimeout(800);

const row = page.locator(".file-item", { hasText: "via-webdav.png" }).first();
const thumbImg = row.locator('.file-icon img[src^="blob:"]');
check("补之前：图片没有缩略图", (await thumbImg.count()) === 0);

const menuBtn = page.locator('.menu-button button, button[aria-label="菜单"]').first();
await menuBtn.click();
await page.waitForTimeout(400);
const menuText = await page.locator(".menu-content").innerText();
check("菜单出现「生成缩略图（1）」且只算图片不算 txt", /生成缩略图（1）/.test(menuText), menuText.replace(/\n/g, "|").slice(0, 90));
await page.locator(".menu-content li", { hasText: "生成缩略图" }).first().click();

let notice = "";
for (let i = 0; i < 40; i++) {
  notice = await page.locator(".notice").innerText({ timeout: 400 }).catch(() => "");
  if (/已生成/.test(notice)) break;
  await page.waitForTimeout(300);
}
check("提示生成结果", /已生成\s*1\s*个缩略图/.test(notice), notice || "(提示已消失)");
check("弹过确认框并说明会耗流量", dialogs.some((m) => m.includes("生成缩略图") && m.includes("流量")), dialogs.map((m) => m.slice(0, 24)).join(" / "));

// 生成后列表应重新取到缩略图
let rendered = 0;
for (let i = 0; i < 20; i++) {
  rendered = await row.locator('.file-icon img[src^="blob:"]').count();
  if (rendered) break;
  await page.waitForTimeout(300);
}
check("生成后立刻显示缩略图", rendered === 1, `${rendered} 张`);
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
