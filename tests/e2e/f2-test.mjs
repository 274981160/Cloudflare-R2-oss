import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
// localStorage 存**裸 base64**（App 自己拼 Basic），fetch 头才需要完整前缀
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

const FILE_MB = 18, PART_MB = 6;          // 18MiB / 6MB → 4 片（R2 要求除末片外 ≥5MB）          // 12MiB / 4MB → 4 片
const SIZE = FILE_MB * 1024 * 1024;

async function fresh() {
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_f2`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  await fetch(`${BASE}/webdav/_f2`, { method: "MKCOL", headers: { Authorization: AUTH } });
}
const headSize = async (name) => {
  const res = await fetch(`${BASE}/raw/_f2/${encodeURIComponent(name)}`, { headers: { Authorization: AUTH } });
  return res.ok ? Number(res.headers.get("content-length")) : 0;
};
async function openApp() {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("crash", () => console.log("  !! 页面崩溃"));
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=_f2`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}
// 在页面里跑一次分片上传；返回结果与本地进度状态
const runUpload = (page, name, stamp, opts) => page.evaluate(
  async ({ name, stamp, fileMb, partMb, signalDelayMs }) => {
    const m = await import("/assets/main.mjs");
    const chunk = new Uint8Array(1024 * 1024).fill(68);
    const blob = new Blob(new Array(fileMb).fill(chunk), { type: "application/octet-stream" });
    const file = new File([blob], name, { type: "application/octet-stream", lastModified: stamp });
    const controller = signalDelayMs ? new AbortController() : null;
    if (controller) setTimeout(() => controller.abort(), signalDelayMs);
    const started = performance.now();
    try {
      const r = await m.multipartUpload(`_f2/${name}`, file, {
        partSize: partMb * 1000 * 1000,
        signal: controller ? controller.signal : undefined,
      });
      return { ok: true, parts: r.parts.length, resumed: r.resumed === true, ms: Math.round(performance.now() - started) };
    } catch (e) {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("fd_upload_"));
      const session = keys.length ? JSON.parse(localStorage.getItem(keys[0])) : null;
      return {
        ok: false, error: String(e.message), aborted: controller ? controller.signal.aborted : false,
        savedParts: session ? session.parts.map((p) => p.partNumber).sort((a, b) => a - b) : [],
        ms: Math.round(performance.now() - started),
      };
    }
  },
  { name, stamp, fileMb: FILE_MB, partMb: PART_MB, signalDelayMs: opts && opts.signalDelayMs }
);

/* ---------- 场景 1：某个分片先失败一次，应自动重试 ---------- */
await fresh();
{
  const { ctx, page, errors } = await openApp();
  const calls = [];
  let failedOnce = false;
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "PUT" && url.includes("partNumber=")) {
      const n = url.match(/partNumber=(\d+)/)[1];
      calls.push(n);
      if (n === "1" && !failedOnce) { failedOnce = true; return route.fulfill({ status: 500, body: "boom" }); }
    }
    return route.continue();
  });
  const r = await runUpload(page, "retry.bin", 101, {});
  console.log("=== 场景 1：分片失败自动重试 ===");
  check("第一次失败后仍上传成功", r.ok === true, JSON.stringify(r));
  check("失败的分片被重试过", calls.filter((n) => n === "1").length >= 2, `片1 共 ${calls.filter((n) => n === "1").length} 次`);
  check("对象大小正确", (await headSize("retry.bin")) === SIZE, `${await headSize("retry.bin")} 字节`);
  check("成功后清掉了本地进度", (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fd_upload_")).length)) === 0);
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- 场景 2：分片持续失败 → 保留进度 → 只补缺失分片 ---------- */
await fresh();
{
  const { ctx, page } = await openApp();
  let blocking = true;
  const calls2 = [];
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "PUT" && url.includes("partNumber=")) {
      const n = url.match(/partNumber=(\d+)/)[1];
      calls2.push(n);
      if (blocking && n === "2") return route.fulfill({ status: 500, body: "boom" });
    }
    return route.continue();
  });
  const first = await runUpload(page, "resume.bin", 202, {});
  console.log("=== 场景 2：断点续传 ===");
  check("片 2 持续失败导致整体失败", first.ok === false, first.error || "");
  check("失败后保留了续传进度", first.savedParts.length > 0, `已存分片 ${first.savedParts.join(",") || "无"}`);

  blocking = false;
  calls2.length = 0;
  const second = await runUpload(page, "resume.bin", 202, {});
  check("重试后上传成功", second.ok === true, JSON.stringify(second));
  check("确实走了续传路径（跳过已传分片）", second.resumed === true, `resumed=${second.resumed}`);
  const repeated = calls2.filter((n) => first.savedParts.includes(Number(n)));
  check("已传完的分片没有重传", repeated.length === 0, `上次已传 ${first.savedParts.join(",")}；本次重传 ${repeated.join(",") || "无"}`);
  // 允许个别分片重试，但请求数不该达到「从头传一遍」的量级
  const missing = 4 - first.savedParts.length;
  // 关键保证是「已传的不重传」；这里只确认没有把整份重传一遍（允许个别分片重试）
  check("补的是缺失分片而非整份重传", calls2.length >= missing && calls2.length < 8, `缺失 ${missing} 片，本次请求 ${calls2.join(",")}`);
  check("对象大小正确", (await headSize("resume.bin")) === SIZE, `${await headSize("resume.bin")} 字节`);
  check("成功后清掉本地进度", (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fd_upload_")).length)) === 0);
  await ctx.close();
}

/* ---------- 场景 3：取消上传（中断请求 + 清本地进度） ---------- */
await fresh();
{
  const { ctx, page } = await openApp();
  await page.route("**/webdav/**", async (route) => {
    const url = route.request().url();
    if (route.request().method() === "PUT" && url.includes("partNumber=")) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    return route.continue();
  });
  const r = await runUpload(page, "cancel.bin", 303, { signalDelayMs: 2500 });
  console.log("=== 场景 3：取消上传 ===");
  check("取消能中断分片上传", r.ok === false && r.aborted === true, JSON.stringify(r));
  check("取消后不保留本地进度", (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fd_upload_")).length)) === 0, `${r.savedParts.length} 片`);
  check("对象没有落地", (await headSize("cancel.bin")) === 0);
  await ctx.close();
}

/* ---------- 场景 4：后端放弃分片任务（abort 路由） ---------- */
{
  const create = await fetch(`${BASE}/webdav/_f2/abort.bin?uploads`, { method: "POST", headers: { Authorization: AUTH } });
  const { uploadId } = await create.json();
  await fetch(`${BASE}/webdav/_f2/abort.bin?uploadId=${uploadId}&partNumber=1`, { method: "PUT", headers: { Authorization: AUTH }, body: new Uint8Array(1024) });
  const abortRes = await fetch(`${BASE}/webdav/_f2/abort.bin?uploadId=${uploadId}`, { method: "DELETE", headers: { Authorization: AUTH } });
  const afterAbort = await fetch(`${BASE}/webdav/_f2/abort.bin?uploadId=${uploadId}&partNumber=1`, { method: "PUT", headers: { Authorization: AUTH }, body: new Uint8Array(1024) });
  const idempotent = await fetch(`${BASE}/webdav/_f2/abort.bin?uploadId=nope`, { method: "DELETE", headers: { Authorization: AUTH } });
  console.log("=== 场景 4：放弃分片任务 ===");
  check("放弃任务返回 204", abortRes.status === 204, String(abortRes.status));
  check("放弃后同一任务不能再传片", afterAbort.status >= 400, String(afterAbort.status));
  check("放弃不存在的任务是幂等的", idempotent.status === 204, String(idempotent.status));
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
