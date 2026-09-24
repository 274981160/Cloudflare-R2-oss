import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions, fixture, artifact } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };

// 每个场景都从干净状态开始
async function reset() {
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_upc`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_upc`, { method: "MKCOL", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_upc/a.txt`, {
    method: "PUT",
    headers: { Authorization: AUTH, "Content-Type": "text/plain" },
    body: "ORIGINAL\n",
  });
}
const listNames = async () => {
  const res = await fetch(`${BASE}/api/list/_upc`, { headers: { Authorization: AUTH } });
  const data = await res.json();
  return data.files.map((f) => f.name);
};
const readFile = async (name) => {
  const res = await fetch(`${BASE}/raw/_upc/${encodeURIComponent(name)}`, { headers: { Authorization: AUTH } });
  return res.ok ? (await res.text()).trim() : `HTTP ${res.status}`;
};

const browser = await chromium.launch(launchOptions());

async function uploadSameFile(choice) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_upc`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 15000 });
  await page.locator(".upload-button").click();
  await page.waitForTimeout(400);
  await page.locator('input[type="file"][accept="*"]').first().setInputFiles(fixture("upsame/a.txt"));
  // 注意：文件名必须与已有的同名
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

// 场景 1：重命名
await reset();
{
  const { ctx, page } = await uploadSameFile();
  await page.waitForSelector(".form-dialog .dialog-title", { timeout: 10000 });
  const text = await page.locator(".form-dialog").innerText();
  check("弹出同名提示", /同名文件/.test(text), text.replace(/\n/g, "|").slice(0, 70));
  check("说明覆盖会进回收站", /回收站/.test(text));
  await page.locator(".form-dialog button", { hasText: "重命名保留两份" }).click();
  await page.waitForTimeout(3000);
  const names = await listNames();
  check("重命名后两个文件都在", names.length === 2 && names.includes("a.txt"), names.join(","));
  check("原文件未被覆盖", (await readFile("a.txt")) === "ORIGINAL", await readFile("a.txt"));
  const trash = await (await fetch(`${BASE}/api/trash`, { headers: { Authorization: AUTH } })).json();
  check("重命名不会产生回收站记录", trash.items.length === 0, `${trash.items.length} 条`);
  await ctx.close();
}

// 场景 2：覆盖
await reset();
{
  const { ctx, page } = await uploadSameFile();
  await page.waitForSelector(".form-dialog .dialog-title", { timeout: 10000 });
  await page.locator(".form-dialog button", { hasText: "覆盖" }).click();
  await page.waitForTimeout(3000);
  const names = await listNames();
  check("覆盖后只有一个文件", names.length === 1, names.join(","));
  const trash = await (await fetch(`${BASE}/api/trash`, { headers: { Authorization: AUTH } })).json();
  check("被覆盖的旧文件进了回收站", trash.items.some((i) => i.key === "_upc/a.txt"), JSON.stringify(trash.items.map((i) => i.key)));
  const oldName = trash.items.length ? `${trash.items[0].key}` : "";
  void oldName;
  await ctx.close();
}

// 场景 3：取消
await reset();
{
  const { ctx, page } = await uploadSameFile();
  await page.waitForSelector(".form-dialog .dialog-title", { timeout: 10000 });
  await page.locator(".form-dialog button", { hasText: "取消上传" }).click();
  await page.waitForTimeout(2000);
  const names = await listNames();
  check("取消后没有新增文件", names.length === 1, names.join(","));
  const trash = await (await fetch(`${BASE}/api/trash`, { headers: { Authorization: AUTH } })).json();
  check("取消后回收站为空", trash.items.length === 0);
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
