import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
const reqs = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/sign") || u.includes("/raw/")) reqs.push({ url: u.replace(BASE, "").slice(0, 60), range: r.headers()["range"] || "" });
});
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_e1`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.waitForTimeout(2500);

// 打开大图预览
reqs.length = 0;
await page.locator(".file-item", { hasText: "bigphoto.png" }).first().dblclick();
await page.waitForSelector(".preview-mask", { timeout: 15000 });
await page.waitForFunction(() => {
  const img = document.querySelector(".preview-image");
  return img && img.naturalWidth > 0;
}, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);

const imgSrc = await page.evaluate(() => {
  const img = document.querySelector(".preview-image");
  return img ? img.getAttribute("src") : "";
});
console.log("=== 图片预览 ===");
check("预览用的是预览 token 直链（零额外请求）", imgSrc.includes("?pt="), imgSrc.slice(0, 55));
check("没有多请求一次 /api/sign", reqs.filter((r) => r.url.includes("/api/sign")).length === 0,
  `sign 请求 ${reqs.filter((r) => r.url.includes("/api/sign")).length} 次`);
check("图片请求只有 1 个", reqs.filter((r) => r.url.includes("/raw/")).length === 1,
  `raw 请求 ${reqs.filter((r) => r.url.includes("/raw/")).length} 次：${reqs.map((r) => r.url).join(" | ")}`);

// 关掉再打开同一张：应命中浏览器缓存（零请求）
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
reqs.length = 0;
await page.locator(".file-item", { hasText: "bigphoto.png" }).first().dblclick();
await page.waitForSelector(".preview-mask", { timeout: 15000 });
await page.waitForTimeout(2500);
check("二次打开命中浏览器缓存（零网络请求）", reqs.length === 0,
  `${reqs.length} 个请求：${reqs.map((r) => r.url).join(" | ")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 视频
reqs.length = 0;
await page.locator(".file-item", { hasText: "test-video.webm" }).first().dblclick();
await page.waitForSelector(".preview-video", { timeout: 15000 });
await page.waitForFunction(() => {
  const v = document.querySelector(".preview-video");
  return v && v.readyState >= 1 && v.duration > 0;
}, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const vinfo = await page.evaluate(() => {
  const v = document.querySelector(".preview-video");
  return v ? { src: v.getAttribute("src"), duration: v.duration } : null;
});
console.log("\n=== 视频预览 ===");
check("视频用预览 token 直链", Boolean(vinfo && vinfo.src.includes("?pt=")), vinfo ? vinfo.src.slice(0, 55) : "");
check("视频可播放（读到时长）", Boolean(vinfo && vinfo.duration > 0), vinfo ? `${vinfo.duration}s` : "");
check("视频没有多余的 sign 请求", reqs.filter((r) => r.url.includes("/api/sign")).length === 0);
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
