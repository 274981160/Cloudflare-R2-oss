import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

const H = { Authorization: AUTH };

/**
 * 把 _a1f 恢复成干净状态：目录里只有一个用户改过的 tree/a.txt。
 *
 * 走的是真实入口——上传一个含同名文件的压缩包，上传完成后 App 会问
 * 「要解压到当前目录吗」，确认之后才会因为同名而追问「跳过还是覆盖」。
 * 右键菜单里的「在线解压」是解压到新建文件夹，永远不会撞名，测不到这条逻辑。
 */
async function reset() {
  // 清掉上一次上传留下的压缩包，否则这次上传会先撞「上传同名」
  await fetch(`${BASE}/webdav/_a1f/a1conflict.zip`, { method: "DELETE", headers: H });
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: H });
  await fetch(`${BASE}/webdav/_a1f/tree/a.txt`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "text/plain" },
    body: "user-edited\n",
  });
}

/**
 * 两个对话框长得很像，判断条件必须精确：
 *   「刚上传的「x.zip」是压缩包，要解压到当前目录吗？…（遇到同名文件会再问一次…）」
 *        → 这是解压询问，一律确定
 *   「目标里已有 N 个同名文件：…」  → 这才是冲突框，按 conflictAnswer 决定跳过还是覆盖
 * 早先这里用 includes("同名文件") 判断，结果把解压询问也当成了冲突框，
 * 「跳过」那一路直接取消了整个解压，什么都没发生。
 */
async function extract(conflictAnswer) {   // "dismiss" = 跳过同名, "accept" = 覆盖
  await reset();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const seen = [];
  page.on("dialog", async (d) => {
    const msg = d.message();
    seen.push(msg);
    if (msg.includes("目标里已有")) {
      if (conflictAnswer === "accept") await d.accept(); else await d.dismiss();
    } else {
      await d.accept();
    }
  });
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_a1f`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });

  await page.locator(".upload-button").click();
  await page.waitForTimeout(500);
  await page.locator('input[type="file"][accept="*"]').first().setInputFiles(fixture("a1conflict.zip"));

  // 提示条会自动消失，所以边等边看
  let notice = "";
  for (let i = 0; i < 40; i += 1) {
    notice = await page.locator(".notice").innerText({ timeout: 500 }).catch(() => "");
    if (/解压完成/.test(notice)) break;
    await page.waitForTimeout(400);
  }
  await ctx.close();
  return { seen, notice };
}

const conflictsOf = (seen) => seen.filter((m) => m.includes("目标里已有"));

console.log("\n=== A) 有同名 → 选「取消」= 跳过 ===");
const a = await extract("dismiss");
check("弹出了同名冲突框", conflictsOf(a.seen).length === 1, `冲突框 ${conflictsOf(a.seen).length} 个 / 对话框共 ${a.seen.length} 个`);
check("提示里给出文件示例", conflictsOf(a.seen).some((m) => m.includes("tree/a.txt")));
check("结果提示说明跳过 1 个", /跳过同名\s*1\s*个/.test(a.notice), a.notice);

console.log("\n=== B) 有同名 → 选「确定」= 覆盖 ===");
const b = await extract("accept");
check("同样弹出同名冲突框", conflictsOf(b.seen).length === 1);
check("覆盖后提示不含跳过", !/跳过同名/.test(b.notice), b.notice);
check("覆盖后写出 1 个文件", /共\s*1\s*个文件/.test(b.notice), b.notice);

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
