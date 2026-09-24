import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ ...devices["Pixel 5"] });
const page = await ctx.newPage();
const problems = [];
const notes = [];

/** 通用体检：横向溢出、元素出界、触摸目标过小 */
async function audit(label, scope) {
  const result = await page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return { missing: true };
    const vw = window.innerWidth;
    const out = {
      vw,
      docScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      overflowers: [],
      outOfView: [],
      smallTargets: [],
    };
    const all = root.querySelectorAll("*");
    for (const el of all) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // 内部横向溢出
      if (el.scrollWidth > el.clientWidth + 2 && style.overflowX === "visible") {
        out.overflowers.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || "").slice(0, 40),
          scroll: el.scrollWidth,
          client: el.clientWidth,
        });
      }
      // 超出视口右侧
      if (r.right > vw + 1 && r.width > 4) {
        out.outOfView.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 40), right: Math.round(r.right), w: Math.round(r.width) });
      }
      // 触摸目标过小（只看可点元素）
      if (/^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName)) {
        // 复选框/单选框的可点区域由包裹它的 label 决定，量 label 才准
        let target = el;
        if (/^(checkbox|radio)$/.test(el.type || "")) {
          const wrap = el.closest("label");
          if (wrap) target = wrap;
        }
        const tr = target.getBoundingClientRect();
        const label = (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 14);
        if (label && (tr.height < 32 || tr.width < 32)) {
          out.smallTargets.push({ tag: el.tagName.toLowerCase(), label, w: Math.round(tr.width), h: Math.round(tr.height) });
        }
      }
    }
    out.overflowers = out.overflowers.slice(0, 6);
    out.outOfView = out.outOfView.slice(0, 6);
    out.smallTargets = out.smallTargets.slice(0, 8);
    return out;
  }, scope);

  console.log(`\n=== ${label} ===`);
  if (result.missing) { console.log("  (未找到界面)"); problems.push(`${label}: 未找到`); return; }
  const docOverflow = result.docScroll > result.vw + 1;
  console.log(`  页面宽度: 视口 ${result.vw} / 文档 ${result.docScroll} ${docOverflow ? "❌ 横向溢出" : "✓"}`);
  if (docOverflow) problems.push(`${label}: 页面横向溢出 ${result.docScroll} > ${result.vw}`);
  if (result.overflowers.length) {
    console.log("  内部溢出:");
    for (const o of result.overflowers) {
      console.log(`    ❌ ${o.tag}.${o.cls}  scrollWidth ${o.scroll} > client ${o.client}`);
      problems.push(`${label}: ${o.tag}.${o.cls} 内部溢出 ${o.scroll}>${o.client}`);
    }
  }
  if (result.outOfView.length) {
    console.log("  元素出界:");
    for (const o of result.outOfView) {
      console.log(`    ❌ ${o.tag}.${o.cls} 右边缘 ${o.right} (宽 ${o.w})`);
      problems.push(`${label}: ${o.tag}.${o.cls} 出界右缘 ${o.right}`);
    }
  }
  if (result.smallTargets.length) {
    console.log("  触摸目标偏小:");
    for (const t of result.smallTargets) {
      console.log(`    ⚠ ${t.tag}「${t.label}」${t.w}×${t.h}`);
      notes.push(`${label}: ${t.label} 触摸目标 ${t.w}×${t.h}`);
    }
  }
  if (!result.overflowers.length && !result.outOfView.length && !docOverflow) console.log("  ✓ 无溢出/出界");
}

await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_ui2`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 20000 });
await page.waitForTimeout(1500);

await audit("① 主界面（列表+工具栏）", "#app");
await page.screenshot({ path: artifact("ui-audit-1-main.png") });

// 预览工具条
await page.locator(".file-item", { hasText: "photo.png" }).first().dblclick();
await page.waitForSelector(".preview-mask", { timeout: 15000 });
await page.waitForTimeout(1200);
await audit("② 图片预览（工具条）", ".preview-mask");
await page.screenshot({ path: artifact("ui-audit-2-preview.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(700);

// API 密钥
await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
await page.waitForTimeout(500);
await page.locator(".menu-content li", { hasText: "API 密钥" }).first().click();
await page.waitForSelector(".apikeys-dialog", { timeout: 15000 });
await page.waitForTimeout(1200);
await audit("③ API 密钥", ".apikeys-dialog");
await page.screenshot({ path: artifact("ui-audit-3-apikeys.png") });
await page.locator(".apikeys-dialog button", { hasText: "关闭" }).first().click();
await page.waitForTimeout(700);

// 分享管理（复核）
await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
await page.waitForTimeout(400);
await page.locator(".menu-content li", { hasText: "分享管理" }).first().click();
await page.waitForSelector(".shares-dialog", { timeout: 15000 });
await page.waitForTimeout(1000);
await audit("④ 分享管理（复核）", ".shares-dialog");
await page.locator(".shares-dialog button", { hasText: "关闭" }).first().click();
await page.waitForTimeout(600);

// 回收站（复核）
await page.locator('.menu-button button, button[aria-label="菜单"]').first().click();
await page.waitForTimeout(400);
await page.locator(".menu-content li", { hasText: "回收站" }).first().click();
await page.waitForSelector(".trash-dialog", { timeout: 15000 });
await page.waitForTimeout(1000);
await audit("⑤ 回收站（复核）", ".trash-dialog");
await page.locator(".trash-close").first().click();
await page.waitForTimeout(600);

// 上传弹窗
await page.locator(".upload-button").click();
await page.waitForTimeout(1200);
await audit("⑥ 上传弹窗", ".popup-content");
await page.screenshot({ path: artifact("ui-audit-6-upload.png") });
await page.locator(".popup-modal").first().click({ position: { x: 200, y: 60 } });
await page.waitForTimeout(900);

// 编辑器（文本文件）：手机上点 ⋯ → 编辑
await page.locator(".file-item", { hasText: "config.json" }).first().locator(".file-more").click();
await page.waitForTimeout(600);
await page.locator(".contextmenu button", { hasText: "编辑" }).first().click();
await page.waitForTimeout(2500);
await audit("⑦ 文本编辑器", ".editor-mask");
await page.screenshot({ path: artifact("ui-audit-7-editor.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(800);

// 文件夹选择器（移动）
await page.locator(".file-item", { hasText: "config.json" }).first().locator(".file-more").click();
await page.waitForTimeout(500);
await page.locator(".contextmenu button", { hasText: "移动" }).first().click();
await page.waitForTimeout(1500);
await audit("⑧ 文件夹选择器", ".dialog-mask .dialog, .dialog-mask");
await page.screenshot({ path: artifact("ui-audit-8-picker.png") });

console.log(`\n\n========== 问题汇总：${problems.length} 项 ==========`);
for (const p of problems) console.log("  ❌ " + p);
console.log(`\n========== 触摸目标偏小：${notes.length} 项 ==========`);
for (const n of notes) console.log("  ⚠ " + n);
await browser.close();
