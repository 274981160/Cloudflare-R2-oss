import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_e1`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.locator(".file-item", { hasText: "mini.pdf" }).first().dblclick();
await page.waitForSelector(".preview-frame", { timeout: 15000 });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => {
  const f = document.querySelector(".preview-frame");
  return f ? { src: f.getAttribute("src"), visible: f.getBoundingClientRect().width > 0 } : null;
});
console.log("=== PDF ===");
check("PDF 用 iframe 渲染", Boolean(info && info.visible));
check("PDF 用直链", Boolean(info && /^\/raw\//.test(info.src) && (info.src.includes("pt=") || info.src.includes("sig="))), info ? info.src.slice(0, 55) : "");
// 直链必须是 inline（不能是 attachment），否则 iframe 会变成下载
const res = await page.request.get(`${BASE}${info.src}`);
const cd = res.headers()["content-disposition"] || "";
check("直链是 inline（不会被当下载）", !/attachment/i.test(cd), cd || "(无该头)");
check("直链 Content-Type 正确", (res.headers()["content-type"] || "").includes("pdf"), res.headers()["content-type"]);
// 已知既有问题：Vue <Transition> 与 iframe 组合时内部报 _vtc 为 null，
// 流式与整包两种加载方式都会报（对照实验确认），不影响 PDF 渲染与开关
const KNOWN = /reading 'clear'/;
const unexpected = errors.filter((m) => !KNOWN.test(m));
check("无新增 JS 错误", unexpected.length === 0, unexpected.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
