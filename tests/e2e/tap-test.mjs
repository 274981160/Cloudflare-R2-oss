import { chromium, devices } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

const closeMenu = async (page) => {
  // 菜单刚弹出后 700ms 内的点击会被防误触窗口吞掉，等过去再点遮罩
  await page.waitForTimeout(900);
  const mask = page.locator(".dialog-mask").first();
  if (await mask.count()) { await mask.click({ position: { x: 5, y: 5 } }); }
  await page.waitForTimeout(400);
};

const longPress = async (ctx, page, locator) => {
  const box = await locator.boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const pt = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
};

/* ================= 触屏 ================= */
{
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_tap`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  const row = (n) => page.locator(".file-item", { hasText: n }).first();
  const overlay = async () => (await page.locator(".preview-mask").count()) > 0;
  const selectedCount = () => page.locator(".file-item.selected").count();
  const closePreview = async () => {
    const btn = page.locator(".preview-toolbar button", { hasText: "关闭" }).first();
    if (await btn.count()) { await btn.tap(); await page.waitForTimeout(500); }
  };

  console.log("\n===== 触屏 =====");
  check("默认不在多选模式（无勾选圈）", (await page.locator(".file-check").count()) === 0);

  // 1) 轻触文件 → 打开预览，且能关掉（上次的黑屏关不掉）
  await row("a.txt").tap();
  await page.waitForTimeout(900);
  check("轻触文件即打开预览", await overlay());
  const btns = await page.locator(".preview-toolbar button, .preview-toolbar a").count();
  check("预览工具栏有可见按钮", btns >= 2, `${btns} 个`);
  const closeVisible = await page.locator(".preview-toolbar button", { hasText: "关闭" }).first().isVisible().catch(() => false);
  check("「关闭」按钮可见", closeVisible);
  await closePreview();
  check("轻触后能关掉预览", !(await overlay()));

  // 2) 轻触文件夹 → 进入
  await row("sub").tap();
  await page.waitForTimeout(800);
  check("轻触文件夹即进入", page.url().includes("sub"), page.url());
  await page.goBack();
  await page.waitForSelector(".file-item", { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // 3) 点行内「⋯」按钮不应打开文件
  await row("b.txt").locator(".file-more").tap();
  await page.waitForTimeout(600);
  check("点⋯只弹菜单不打开文件", (await page.locator(".contextmenu").count()) === 1 && !(await overlay()));
  await closeMenu(page);

  // 4) 长按 → 菜单；且长按后的第一下轻触必须正常（上次被吃掉的那一下）
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await longPress(ctx, page, row("c.txt"));
  const menuCount = await page.locator(".contextmenu").count();
  const dlgCount = await page.locator(".dialog-container").count();
  check("长按弹出菜单", menuCount === 1, `menu=${menuCount} dialog=${dlgCount}`);
  check("长按不误开文件", !(await overlay()));
  await closeMenu(page);
  await row("d.txt").tap();
  await page.waitForTimeout(900);
  check("长按之后的第一下轻触仍然有效（关键回归）", await overlay());
  await closePreview();

  // 5) 多选：⋮ 菜单进入 → 第一下就要能选中
  await page.locator(".icon-button, button[aria-label=菜单]").first().tap();
  await page.waitForTimeout(500);
  await page.locator(".menu-content li, .menu-content .menu-item").filter({ hasText: "多选" }).first().tap();
  await page.waitForTimeout(500);
  check("进入多选模式后出现勾选圈", (await page.locator(".file-check").count()) > 0);
  await row("a.txt").tap();
  await page.waitForTimeout(400);
  check("多选模式第一下轻触即选中（关键回归）", (await selectedCount()) === 1, `选中 ${await selectedCount()} 项`);
  const boxOn = await page.locator(".file-item.selected .file-check").first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => "");
  const boxOff = await page.locator(".file-check").nth(2).evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => "");
  check("勾选圈有选中态（填充色不同）", boxOn !== boxOff, `选中 ${boxOn} / 未选 ${boxOff}`);
  const rowBg = await page.locator(".file-item.selected").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const rowBgOther = await page.locator(".file-item").nth(3).evaluate((el) => getComputedStyle(el).backgroundColor);
  check("选中行有明显底色", rowBg !== rowBgOther, `${rowBg} vs ${rowBgOther}`);
  await row("b.txt").tap();
  await page.waitForTimeout(400);
  check("继续轻触可多选", (await selectedCount()) === 2, `选中 ${await selectedCount()} 项`);
  check("底部工具条出现", (await page.locator(".selection-toolbar").count()) === 1);
  await page.locator(".selection-toolbar button", { hasText: "完成" }).tap();
  await page.waitForTimeout(500);
  check("完成退出多选并清空", (await selectedCount()) === 0 && (await page.locator(".selection-toolbar").count()) === 0);
  await row("a.txt").tap();
  await page.waitForTimeout(900);
  check("退出多选后轻触又变回打开", await overlay());
  await closePreview();

  // 6) 长按菜单里的「多选」入口
  await longPress(ctx, page, row("d.txt"));
  await page.locator(".contextmenu button", { hasText: "多选" }).tap();
  await page.waitForTimeout(600);
  check("长按菜单可进入多选并选中该项", (await selectedCount()) === 1, `选中 ${await selectedCount()} 项`);
  await row("c.txt").tap();
  await page.waitForTimeout(400);
  check("随后轻触可继续加选", (await selectedCount()) === 2, `选中 ${await selectedCount()} 项`);

  check("触屏无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ================= 桌面（必须和以前完全一致） ================= */
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_tap`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  const row = (n) => page.locator(".file-item", { hasText: n }).first();
  const selectedCount = () => page.locator(".file-item.selected").count();

  console.log("\n===== 桌面（回归） =====");
  await row("a.txt").click();
  await page.waitForTimeout(250);
  check("单击选中（不打开）", (await selectedCount()) === 1 && (await page.locator(".preview-mask").count()) === 0);
  await row("b.txt").click();
  await page.waitForTimeout(250);
  check("再点一项是累加选中（保持老习惯）", (await selectedCount()) === 2, `选中 ${await selectedCount()} 项`);
  await row("a.txt").click();
  await page.waitForTimeout(250);
  check("点已选中的项取消选中", (await selectedCount()) === 1);
  check("桌面不显示勾选圈", (await page.locator(".file-check").count()) === 0);
  await row("c.txt").dblclick();
  await page.waitForTimeout(900);
  check("双击打开", (await page.locator(".preview-mask").count()) > 0);
  await page.locator(".preview-toolbar button", { hasText: "关闭" }).first().click();
  await page.waitForTimeout(500);
  check("桌面预览可关闭", (await page.locator(".preview-mask").count()) === 0);
  await row("d.txt").click({ button: "right" });
  await page.waitForTimeout(400);
  check("右键菜单可用", (await page.locator(".contextmenu").count()) === 1);
  check("长按菜单含多选入口", (await page.locator(".contextmenu").innerText()).includes("多选"));
  await closeMenu(page);
  // 用工具条的「取消选择」清空（原版就是这么清的，点列表下方空白并不属于列表容器）
  const toolbarBtn = page.locator(".selection-toolbar button", { hasText: "取消选择" }).first();
  if (await toolbarBtn.count()) { await toolbarBtn.click(); await page.waitForTimeout(300); }
  check("取消选择可清空", (await selectedCount()) === 0, `选中 ${await selectedCount()} 项`);
  check("桌面无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
