import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

async function openPreview(fileName, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  const ranges = [];
  const blobFetches = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/raw/") && r.headers()["range"]) ranges.push(r.headers()["range"]);
    if (u.includes("/raw/") && !r.headers()["range"] && opts.watchFull) blobFetches.push(u);
  });
  if (opts.failSign) {
    await page.route("**/api/sign**", (route) => route.fulfill({ status: 500, body: "nope" }));
  }
  if (opts.failPreviewToken) {
    // 模拟预览 token 过期：带 ?pt= 的直链一律 401
    await page.route("**/raw/**", (route) =>
      route.request().url().includes("pt=")
        ? route.fulfill({ status: 401, body: "expired" })
        : route.continue()
    );
  }
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_e1`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  // 双击打开（桌面行为）
  await page.locator(".file-item", { hasText: fileName }).first().dblclick();
  await page.waitForSelector(".preview-mask", { timeout: 15000 });
  return { ctx, page, errors, ranges, blobFetches };
}

/* ---------- 1. 大图：签名直链流式 ---------- */
{
  const { ctx, page, errors } = await openPreview("bigphoto.png", { watchFull: true });
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview-image");
    return img && img.naturalWidth > 0;
  }, { timeout: 15000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const img = document.querySelector(".preview-image");
    return img ? { src: img.getAttribute("src"), w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  console.log("\n=== 大图（1.8MB）===");
  check("预览图片已渲染", Boolean(info && info.w > 0), info ? `${info.w}x${info.h}` : "无 img");
  check("用的是直链（不再是整包 blob）", Boolean(info && /^\/raw\//.test(info.src) && (info.src.includes("pt=") || info.src.includes("sig="))), info ? info.src.slice(0, 60) : "");
  check("不是 blob: 地址", Boolean(info && !info.src.startsWith("blob:")));
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 2. 视频：签名直链 + Range（可拖动进度）---------- */
{
  const { ctx, page, errors, ranges } = await openPreview("test-video.webm");
  await page.waitForFunction(() => {
    const v = document.querySelector(".preview-video");
    return v && v.readyState >= 1 && v.duration > 0;
  }, { timeout: 20000 }).catch(() => {});
  const info = await page.evaluate(() => {
    const v = document.querySelector(".preview-video");
    return v ? { src: v.getAttribute("src"), duration: v.duration, readyState: v.readyState, canSeek: v.seekable.length > 0 } : null;
  });
  console.log("\n=== 视频（mp4）===");
  check("视频元素已就绪（能读到时长）", Boolean(info && info.duration > 0), info ? `时长 ${info.duration}s / readyState ${info.readyState}` : "无 video");
  check("视频用直链", Boolean(info && /^\/raw\//.test(info.src) && (info.src.includes("pt=") || info.src.includes("sig="))), info ? info.src.slice(0, 60) : "");
  check("浏览器发了 Range 请求（流式）", ranges.length > 0, ranges.slice(0, 2).join(" / "));
  check("可 seek（拖动进度前提）", Boolean(info && info.canSeek));
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 3. 兜底：预览 token 失效（过期）也要能预览 ---------- */
{
  const { ctx, page, errors } = await openPreview("bigphoto.png", { failPreviewToken: true });
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview-image");
    return img && img.naturalWidth > 0;
  }, { timeout: 20000 }).catch(() => {});
  const src = await page.evaluate(() => {
    const img = document.querySelector(".preview-image");
    return img ? img.getAttribute("src") : "";
  });
  console.log("\n=== 兜底：预览 token 失效 ===");
  check("token 失效时仍能预览（回退整包）", Boolean(src), src.slice(0, 40));
  check("回退时用的是 blob 地址", src.startsWith("blob:"), src.slice(0, 30));
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
