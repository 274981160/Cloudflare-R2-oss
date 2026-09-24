import { chromium } from "./_pw.mjs";
import { BASE, USER, PASS, CREDS, AUTH, launchOptions } from "./_setup.mjs";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? "  → " + extra : ""}`);
};

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", (d) => d.accept());

// 预置登录凭据（本地实例开了公开读，页面默认匿名浏览 → 只读，写操作会被隐藏）
await page.addInitScript((auth) => {
  localStorage.setItem("fd_auth", auth);
}, CREDS);
await page.goto(`${BASE}/?p=_edit`, { waitUntil: "load" });

// 登录（未登录时弹出登录框）
if (await page.locator("input[name=username]").count()) {
  await page.fill("input[name=username]", USER);
  await page.fill("input[name=password]", PASS);
  await page.click("button[type=submit]");
}
await page.waitForSelector(".file-list .file-item", { timeout: 15000 });
check("页面加载并登录成功", true);

// 通过右键菜单打开编辑器
async function openEditor(fileName) {
  const row = page.locator(".file-item", { hasText: fileName }).first();
  await row.locator(".file-more").click();
  await page.locator(".contextmenu-list button", { hasText: "编辑" }).first().click();
  await page.waitForSelector(".editor-input", { timeout: 10000 });
  await page.waitForTimeout(400);
}
const value = () => page.locator(".editor-input").inputValue();
const closeEditor = async () => {
  await page.locator(".editor-close").click();
  await page.waitForTimeout(300);
};

/* ---------- 1. JSON 整理缩进 ---------- */
await openEditor("test.json");
const before = await value();
check("打开的是压缩成一行的 JSON", before.startsWith('{"name":"demo"') && !before.includes("\n"), before.slice(0, 40));
check("存在「整理缩进」按钮", (await page.locator(".editor-format").count()) === 1);

await page.locator(".editor-format").click();
await page.waitForTimeout(400);
const tidied = await value();
check("整理后变成多行缩进", tidied.includes('\n  "name": "demo",'));
for (const frag of ["1.0", "123456789012345678901", "hello   world"]) {
  check(`数字/字符串原样保留 ${frag}`, tidied.includes(frag));
}
check("重复键 a 未被合并", (tidied.match(/"a":/g) || []).length === 2, `出现 ${(tidied.match(/"a":/g) || []).length} 次`);
check("空对象/数组保持内联", tidied.includes('"empty": {}') && tidied.includes('"arr": []'));
check("嵌套结构缩进正确", tidied.includes('\n    "ok": true'));

/* ---------- 2. 光标行列 ---------- */
const statTexts = await page.locator(".editor-stat").allInnerTexts();
check("状态区显示光标行列", statTexts.some((t) => /第 \d+ 行/.test(t)), statTexts.join(" | "));

/* ---------- 3. Tab / Shift+Tab 缩进 ---------- */
const setCaret = (pos) =>
  page.evaluate((p) => {
    const el = document.querySelector(".editor-input");
    el.focus();
    el.setSelectionRange(p, p);
  }, pos);

await setCaret(0);
await page.keyboard.press("Tab");
await page.waitForTimeout(250);
let text = await value();
check("Tab 插入缩进（不再跳焦点）", text.startsWith('  {'), JSON.stringify(text.slice(0, 6)));

await setCaret(0);
await page.keyboard.press("Shift+Tab");
await page.waitForTimeout(250);
text = await value();
check("Shift+Tab 反缩进", text.startsWith("{"), JSON.stringify(text.slice(0, 6)));

// 撤销：Tab 造成的改动应当可以整体回退
await setCaret(0);
await page.keyboard.press("Tab");
await page.waitForTimeout(250);
const afterTab = await value();
await page.locator(".editor-undo").click();
await page.waitForTimeout(300);
text = await value();
check("撤销可回退 Tab 缩进", text !== afterTab && !text.startsWith("  {"), JSON.stringify(text.slice(0, 8)));

/* ---------- 4. 回车自动缩进 ---------- */
const firstLineEnd = (await value()).indexOf("\n");
await setCaret(firstLineEnd);
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
text = await value();
check("在 { 后回车自动多缩进一级", text.includes("{\n  \n") || text.includes('{\n  \n  "name"'), JSON.stringify(text.slice(0, 14)));

/* ---------- 5. 替换 / 全部替换 ---------- */
await page.fill(".editor-searchinput", "demo");
await page.waitForTimeout(200);
await page.fill(".editor-replaceinput", "demo2");
await page.waitForTimeout(150);
check("匹配计数显示", /1\/\d+/.test(await page.locator(".editor-matchcount").innerText()));
await page.locator(".editor-nav", { hasText: "全部替换" }).click();
await page.waitForTimeout(400);
text = await value();
check("全部替换生效", text.includes('"demo2"') && !text.includes('"demo"'));

// 括号中间回车：展开成三行，光标停在中间
await page.evaluate(() => {
  const el = document.querySelector(".editor-input");
  const idx = el.value.indexOf("[]") + 1; // 空数组内部
  el.focus();
  el.setSelectionRange(idx, idx);
});
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
text = await value();
check("括号中间回车展开成三行", text.includes("[\n  \n]") || /\[\n\s+\n\s*\]/.test(text), JSON.stringify(text.slice(Math.max(0, text.indexOf("[]") - 6), text.indexOf("[]") + 14)));

/* ---------- 6. 自动换行开关 / 字号 ---------- */
const wrapBtn = page.locator(".editor-tool").first();
await wrapBtn.click();
await page.waitForTimeout(250);
check("关闭换行后生效 nowrap", await page.locator(".editor-body.nowrap").count() === 1);
await wrapBtn.click();
await page.waitForTimeout(200);
check("再次打开换行", (await page.locator(".editor-body.nowrap").count()) === 0);

const sizeBefore = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".editor-input")).fontSize));
await page.locator(".editor-tool", { hasText: "A+" }).click();
await page.waitForTimeout(250);
const sizeAfter = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".editor-input")).fontSize));
check("A+ 放大字号", sizeAfter > sizeBefore, `${sizeBefore} → ${sizeAfter}`);
const layerSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".editor-highlight")).fontSize));
check("两层字号一致（不错位）", layerSize === sizeAfter, `${layerSize} vs ${sizeAfter}`);
await closeEditor();

/* ---------- 7. JSONC（带注释）也能整理 ---------- */
await openEditor("tsconfig.json");
const jsoncBefore = await value();
check("JSONC 打开正常", jsoncBefore.includes("// 这是注释"));
await page.locator(".editor-format").click();
await page.waitForTimeout(400);
const jsoncAfter = await value();
check("JSONC 整理后仍保留行注释", jsoncAfter.includes("// 这是注释"));
check("JSONC 整理后仍保留块注释", jsoncAfter.includes("/* 块注释 */"));
check("JSONC 整理后仍保留尾逗号", jsoncAfter.includes("true,"));
check("JSONC 内容无丢失", jsoncAfter.replace(/\s+/g, "") === jsoncBefore.replace(/\s+/g, ""));
check("JSONC 未被判为格式错误", (await page.locator(".editor-json.error").count()) === 0);
const jsonLabel = await page.locator(".editor-json").innerText();
check("JSONC 显示为「含注释」而非错误", /含注释/.test(jsonLabel), jsonLabel);
await closeEditor();

/* ---------- 8. 普通文本不显示整理按钮 ---------- */
await openEditor("plain.txt");
check("普通文本无「整理缩进」按钮", (await page.locator(".editor-format").count()) === 0);
await setCaret(0);
await page.keyboard.press("Tab");
await page.waitForTimeout(200);
check("普通文本 Tab 也能缩进", (await value()).startsWith("  plain"));
await closeEditor();

/* ---------- 9. 真语法错误仍要报错 ---------- */
await openEditor("tsconfig.json");
await page.evaluate(() => {
  const el = document.querySelector(".editor-input");
  el.focus();
  el.setSelectionRange(0, el.value.length);
});
await page.keyboard.type('{"a": }');
await page.waitForTimeout(700);
check("语法错误仍提示 JSON 错误", (await page.locator(".editor-json.error").count()) === 1);
await closeEditor();

/* ---------- 10. .jsonc 扩展名同样支持整理 ---------- */
await openEditor("real.jsonc");
check(".jsonc 显示整理缩进按钮", (await page.locator(".editor-format").count()) === 1);
await page.locator(".editor-format").click();
await page.waitForTimeout(400);
const jsoncExt = await value();
check(".jsonc 整理后保留注释", jsoncExt.includes("// 注释"));
check(".jsonc 整理后仍有缩进", jsoncExt.includes('\n  "a": 1'));
await closeEditor();

check("无 JS 运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length} 通过, ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
