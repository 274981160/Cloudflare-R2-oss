import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

const title = (page) => page.locator(".preview-title").innerText();

/* ---------------- 桌面 ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_a2`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  console.log("\n=== 桌面 ===");
  await page.locator(".file-item", { hasText: "img001.jpg" }).first().dblclick();
  await page.waitForSelector(".preview-image", { timeout: 15000 });
  await page.waitForTimeout(500);
  check("打开第一张", (await title(page)) === "img001.jpg", await title(page));
  const toolbarText = await page.locator(".preview-toolbar").innerText();
  check("显示位置计数 1/120", toolbarText.includes("1/120"), toolbarText.replace(/\n/g, "|"));
  const prevBtn = page.locator(".preview-button", { hasText: "上一张" }).first();
  const nextBtn = page.locator(".preview-button", { hasText: "下一张" }).first();
  check("第一张时「上一张」不可点", await prevBtn.isDisabled());
  await nextBtn.click();
  await page.waitForTimeout(800);
  check("点「下一张」切到第二张", (await title(page)) === "img002.jpg", await title(page));
  check("计数变成 2/120", (await page.locator(".preview-toolbar").innerText()).includes("2/120"));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(800);
  check("方向键 → 切到第三张", (await title(page)) === "img003.jpg", await title(page));
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(800);
  check("方向键 ← 退回第二张", (await title(page)) === "img002.jpg", await title(page));
  // 图片现在走签名直链流式加载（E1），不再是 blob: 地址
  const rendered = await page.evaluate(() => {
    const img = document.querySelector(".preview-image");
    return img ? { w: img.naturalWidth, src: img.getAttribute("src") || "" } : null;
  });
  check("图片仍然渲染", Boolean(rendered && rendered.w > 0), rendered ? `${rendered.w}px` : "无 img");
  check("走的是直链（pt/sig）", Boolean(rendered && (rendered.src.includes("pt=") || rendered.src.includes("sig="))), rendered ? rendered.src.slice(0, 40) : "");
  check("切换后缩放已复位", !(await page.locator(".preview-image.zoomed").count()));
  check("桌面无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------------- 手机（滑动） ---------------- */
{
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_a2`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  console.log("\n=== 手机 ===");
  await page.locator(".file-item", { hasText: "img010.jpg" }).first().tap();   // 触屏单击即打开
  await page.waitForSelector(".preview-image", { timeout: 15000 });
  await page.waitForTimeout(600);
  check("轻触打开图片预览", (await title(page)) === "img010.jpg", await title(page));

  const cdp = await ctx.newCDPSession(page);
  const box = await page.locator(".preview-stage").boundingBox();
  const y = box.y + box.height / 2;
  const swipe = async (fromX, toX) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: toX, y }] });
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(900);
  };
  await swipe(box.x + box.width * 0.8, box.x + box.width * 0.2);   // 左滑
  check("左滑切到下一张", (await title(page)) === "img011.jpg", await title(page));
  await swipe(box.x + box.width * 0.2, box.x + box.width * 0.8);   // 右滑
  check("右滑退回上一张", (await title(page)) === "img010.jpg", await title(page));
  check("手机无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------------- 非图片文件不应有切换 ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_a5mix`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  console.log("\n=== 混合目录（1 张图 + 1 个文本）===");
  await page.locator(".file-item", { hasText: "note.txt" }).first().dblclick();
  await page.waitForTimeout(1500);
  const toolbar = await page.locator(".preview-toolbar").innerText().catch(() => "");
  check("文本文件预览没有切换按钮", !toolbar.includes("上一张"), toolbar.replace(/\n/g, "|"));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
