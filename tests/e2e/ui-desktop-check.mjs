import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_ui2`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 20000 });
await page.waitForTimeout(1200);

await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
await page.waitForTimeout(400);
await page.locator(".menu-content li", { hasText: "API 密钥" }).first().click();
await page.waitForSelector(".apikeys-table", { timeout: 15000 });
await page.waitForTimeout(1000);

console.log("=== 桌面：API 密钥 ===");
const cols = await page.locator(".apikeys-table thead th").evaluateAll((els) => els.map((e) => ({ text: e.innerText, display: getComputedStyle(e).display })));
check("桌面仍显示全部 7 列", cols.filter((c) => c.display !== "none").length === 7, cols.map((c) => c.text).join(","));
const metaVisible = await page.locator(".apikeys-meta").first().isVisible();
check("桌面不显示重复的窄屏那行", metaVisible === false);
const m = await page.evaluate(() => {
  const wrap = document.querySelector(".apikeys-table-wrap") || document.querySelector(".apikeys-table").parentElement;
  return { client: wrap.clientWidth, scroll: wrap.scrollWidth, doc: document.documentElement.scrollWidth, vw: window.innerWidth };
});
check("桌面表格不溢出", m.scroll <= m.client + 1, `${m.scroll}/${m.client}`);
check("桌面页面不横向溢出", m.doc <= m.vw + 1, `${m.doc}/${m.vw}`);
await page.screenshot({ path: artifact("ui-desktop-apikeys.png") });
await page.locator(".apikeys-dialog button", { hasText: "关闭" }).first().click();
await page.waitForTimeout(600);

// 桌面预览工具条：应保持单行
await page.locator(".file-item", { hasText: "photo.png" }).first().dblclick();
await page.waitForSelector(".preview-mask", { timeout: 15000 });
await page.waitForTimeout(1000);
const tb = await page.evaluate(() => {
  const t = document.querySelector(".preview-toolbar");
  const r = t.getBoundingClientRect();
  return { h: Math.round(r.height), buttons: t.querySelectorAll("button").length };
});
console.log("=== 桌面：预览工具条 ===");
check("工具条仍是单行（高度 < 70px）", tb.h < 70, `${tb.h}px，${tb.buttons} 个按钮`);
const hint = await page.locator(".preview-hint").innerText().catch(() => "");
check("桌面提示仍含「滚轮」", /滚轮/.test(hint), hint.replace(/\n/g, " ").slice(0, 50));
await page.screenshot({ path: artifact("ui-desktop-preview.png") });
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
