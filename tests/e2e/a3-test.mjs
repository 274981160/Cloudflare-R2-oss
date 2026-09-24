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

// 打开上传弹窗 → 选「文件」→ 选 zip
await page.locator(".upload-button").click();
await page.waitForTimeout(500);
// 「文件」那个输入框（accept="*"、非目录选择），隐藏元素也能直接塞文件
await page.locator('input[type="file"][accept="*"]').first().setInputFiles(fixture("a3.zip"));

// 提示条 3 秒后会自动消失，所以要边等边看
let notice = "";
for (let i = 0; i < 30; i++) {
  notice = await page.locator(".notice").innerText({ timeout: 500 }).catch(() => "");
  if (/解压完成/.test(notice)) break;
  await page.waitForTimeout(400);
}
check("提示解压完成", /解压完成/.test(notice), notice || "(提示已消失)");
check("上传后弹出了「要解压吗」", dialogs.some((m) => m.includes("压缩包") && m.includes("解压到当前目录")), dialogs.map((m) => m.slice(0, 30)).join(" / "));
check("新解压没有触发同名冲突追问", !dialogs.some((m) => m.includes("目标里已有")), dialogs.length + " 个对话框");
check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
