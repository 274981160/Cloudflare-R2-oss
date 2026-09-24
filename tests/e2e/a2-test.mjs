import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let thumbRequests = 0;
page.on("request", (r) => { if (r.url().includes("/thumbnails/")) thumbRequests++; });
await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);

await page.goto(`${BASE}/?p=_a2`, { waitUntil: "load" });
await page.waitForSelector(".file-item", { timeout: 15000 });
await page.waitForTimeout(2000);

const total = await page.locator(".file-item").count();
const initial = thumbRequests;
console.log(`共 ${total} 个文件，首屏缩略图请求 ${initial} 个`);
check("列表里有 120 个文件", total >= 120, `${total}`);
check("首屏只请求了部分缩略图（不是全部）", initial > 0 && initial < total, `${initial}/${total}`);
check("首屏请求量远小于总数（按需加载生效）", initial <= 60, `${initial}/120`);

const rendered = await page.locator('.file-icon img[src^="blob:"]').count();
check("可见行的缩略图确实渲染出来了", rendered > 0, `${rendered} 张`);

// 逐步往下滚：沿途的行才加载（跳到底部会跳过中间行，属正确行为）
let afterScroll = initial;
for (let step = 0; step < 40; step++) {
  const before = thumbRequests;
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(250);
  afterScroll = thumbRequests;
  if (afterScroll === before && step > 4) break; // 不再增长说明到底了
}
console.log(`逐步滚动后累计请求 ${afterScroll} 个`);
check("滚动过程中继续按需加载", afterScroll > initial, `${initial} → ${afterScroll}`);
check("滚完整页后全部加载", afterScroll >= 120, `${afterScroll}/120`);

// 搜索过滤后不应重复请求
await page.fill('input[type="search"]', "img01");
await page.waitForTimeout(1500);
const afterSearch = thumbRequests;
check("搜索过滤不重复请求已缓存的缩略图", afterSearch - afterScroll <= 2, `新增 ${afterSearch - afterScroll}`);

check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
