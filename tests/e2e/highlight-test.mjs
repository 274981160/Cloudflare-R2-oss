import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

async function open(opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_fix`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(900);
  return { ctx, page };
}
// 等 Vue 把 class 更新到 DOM
const tick = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

for (const [label, opts] of [["桌面", { viewport: { width: 1200, height: 800 } }], ["手机", { ...devices["Pixel 5"] }]]) {
  const { ctx, page } = await open(opts);
  console.log(`\n=== ${label} ===`);
  // 1) 初始状态绝不能有任何高亮（这就是用户看到的「全部文件」虚线框）
  check("刚打开时没有任何放置高亮", (await page.locator(".drop-target").count()) === 0,
    `高亮 ${await page.locator(".drop-target").count()} 处`);
  const crumbBox = await page.locator(".crumb").first().evaluate((el) => getComputedStyle(el).outlineStyle);
  check("「全部文件」面包屑没有虚线框", crumbBox === "none" || crumbBox === "", `outline-style=${crumbBox}`);

  if (label === "桌面") {
    // 2) 拖拽经过文件夹时该行高亮
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".file-item"));
      const src = rows.find((el) => el.innerText.includes("a.txt"));
      const dst = rows.find((el) => el.innerText.includes("target"));
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
      dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.__dt = dt; window.__src = src; window.__dst = dst;
    });
    await tick(page);
    const hl = await page.locator(".drop-target").count();
    check("拖到文件夹上时该行高亮", hl === 1, `${hl} 处高亮`);
    const hlIsTarget = await page.locator(".file-item.drop-target").innerText().catch(() => "");
    check("高亮的正是目标文件夹", hlIsTarget.includes("target"), hlIsTarget.split("\n")[0]);

    // 3) 拖到根面包屑时该 crumb 高亮
    await page.evaluate(() => {
      const dt = window.__dt;
      const crumbs = Array.from(document.querySelectorAll(".crumb"));
      const root = crumbs[0];
      window.__dst.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true }));
      root.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await tick(page);
    const crumbHl = await page.locator(".crumb.drop-target").count();
    check("拖到「全部文件」面包屑时它高亮", crumbHl === 1, `${crumbHl} 处`);

    // 4) 结束拖拽后高亮清除
    await page.evaluate(() => {
      window.__src.dispatchEvent(new DragEvent("dragend", { dataTransfer: window.__dt, bubbles: true }));
    });
    await tick(page);
    check("结束拖拽后高亮清除", (await page.locator(".drop-target").count()) === 0);
  }
  await page.screenshot({ path: `/tmp/highlight-${label}.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
