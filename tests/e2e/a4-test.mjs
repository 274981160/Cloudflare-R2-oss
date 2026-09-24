import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
await page.goto(`${BASE}/?p=_a4`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });

await page.locator(".file-item", { hasText: "doc.txt" }).first().locator(".file-more").click();
await page.waitForTimeout(400);
const menuText = await page.locator(".contextmenu").innerText();
check("菜单里有「分享（设有效期）」", menuText.includes("分享（设有效期）"), menuText.replace(/\n/g, "|"));
await page.locator(".contextmenu button", { hasText: "分享（设有效期）" }).click();
await page.waitForTimeout(500);

const dialogText = await page.locator(".form-dialog").innerText().catch(() => "");
check("弹窗出现并显示对象名", dialogText.includes("doc.txt"), dialogText.replace(/\n/g, "|").slice(0, 60));
const options = await page.locator(".form-dialog select option").allInnerTexts();
check("有 1天/7天/30天/永久 四个选项", options.length === 4 && options.join(",").includes("永久"), options.join(","));

// 选「1 天」并生成
await page.locator(".form-dialog select").selectOption("1");
await page.locator(".form-dialog button", { hasText: "生成并复制链接" }).click();
await page.waitForTimeout(1500);
check("弹窗已关闭", (await page.locator(".form-dialog").count()) === 0);
const notice = await page.locator(".notice").innerText({ timeout: 1000 }).catch(() => "");
check("提示里说明了有效期", /有效期\s*1\s*天/.test(notice) || /复制失败/.test(notice), notice);

check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
