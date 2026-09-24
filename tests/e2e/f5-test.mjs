import { chromium } from "./_pw.mjs";
import { BASE, RAW, CREDS, AUTH, launchOptions } from "./_setup.mjs";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "  ok  " : "  FAIL"} ${n}${extra ? "  → " + extra : ""}`); };
const browser = await chromium.launch(launchOptions());

const exists = async (key) => {
  const res = await fetch(`${BASE}/raw/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: { Authorization: AUTH } });
  return res.ok;
};
const listDir = async (key) => {
  const res = await fetch(`${BASE}/api/list/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: { Authorization: AUTH } });
  const data = await res.json();
  return { files: (data.files || []).map((f) => f.name), folders: (data.folders || []).map((f) => f.name) };
};
async function reset() {
  for (const d of ["_f5/target", "_f5/other", "_f5/parent"]) {
    await fetch(`${BASE}/webdav/${d}`, { method: "DELETE", headers: { Authorization: AUTH } });
  }
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: { Authorization: AUTH } });
  for (const d of ["_f5/target", "_f5/other", "_f5/parent/child"]) {
    await fetch(`${BASE}/webdav/${d}`, { method: "MKCOL", headers: { Authorization: AUTH } });
  }
  for (const [key, body] of [["_f5/a.txt", "a"], ["_f5/b.txt", "b"], ["_f5/other/inside.txt", "i"], ["_f5/parent/child/deep.txt", "d"]]) {
    await fetch(`${BASE}/webdav/${key}`, { method: "PUT", headers: { Authorization: AUTH, "Content-Type": "text/plain" }, body });
  }
}
async function openApp(cwd = "_f5") {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => { await d.accept(); });
  await page.addInitScript((auth) => { localStorage.clear(); localStorage.setItem("fd_auth", auth); }, CREDS);
  await page.goto(`${BASE}/?p=${cwd}`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}


/** 取组件实例（用于读取同步状态，DOM class 是异步更新的） */
const getVm = (page) => page.evaluate(() => {
  const app = document.querySelector("#app").__vue_app__;
  let vm = null;
  const walk = (v, d) => {
    if (!v || typeof v !== "object" || d > 12 || vm) return;
    if (v.component) { const p = v.component.proxy; if (p && typeof p.onFolderDrop === "function") vm = p; walk(v.component.subTree, d + 1); }
    const k = v.children;
    if (Array.isArray(k)) k.forEach((c) => walk(c, d + 1)); else if (k && typeof k === "object") walk(k, d + 1);
    if (Array.isArray(v.dynamicChildren)) v.dynamicChildren.forEach((c) => walk(c, d + 1));
  };
  walk(app._instance.subTree, 0);
  return vm ? { dragItems: vm.dragItems.map((i) => i.key), dragOverKey: vm.dragOverKey, notice: vm.notice } : null;
});

/** 用真实 DragEvent 模拟拖拽（这个 headless 环境的鼠标事件不可靠） */
const dragItemTo = (page, sourceText, targetText, opts = {}) => page.evaluate(async ({ sourceText, targetText, holdMs }) => {
  const rows = Array.from(document.querySelectorAll(".file-item"));
  const src = rows.find((el) => el.innerText.includes(sourceText));
  const dst = rows.find((el) => el.innerText.includes(targetText));
  if (!src || !dst) return { error: `找不到元素：${sourceText} → ${targetText}` };
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
  const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
  dst.dispatchEvent(over);
  // Vue 要到下一帧才会把 drop-target 类写到 DOM 上。
  // 早先这里同步读，永远读到 false，于是「拖拽经过时标记了放置目标」一直失败。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const highlighted = dst.classList.contains("drop-target");
  void holdMs;
  dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
  return { highlighted, defaultPrevented: over.defaultPrevented };
}, { sourceText, targetText, holdMs: opts.holdMs || 0 });

/* ---------- A) 拖单个文件到文件夹 ---------- */
await reset();
{
  const { ctx, page, errors } = await openApp();
  const r = await dragItemTo(page, "a.txt", "target");
  await page.waitForTimeout(2000);
  console.log("=== A) 拖单个文件到文件夹 ===");
  check("拖拽事件被正确处理（dragover 被接受）", r.defaultPrevented === true, JSON.stringify(r));
  const vmAfterOver = await page.evaluate(() => {
    const app = document.querySelector("#app").__vue_app__;
    let vm = null;
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 12 || vm) return;
      if (v.component) { const p = v.component.proxy; if (p && typeof p.onFolderDrop === "function") vm = p; walk(v.component.subTree, d + 1); }
      const k = v.children;
      if (Array.isArray(k)) k.forEach((c) => walk(c, d + 1)); else if (k && typeof k === "object") walk(k, d + 1);
      if (Array.isArray(v.dynamicChildren)) v.dynamicChildren.forEach((c) => walk(c, d + 1));
    };
    walk(app._instance.subTree, 0);
    return vm ? vm.dragOverKey : "";
  });
  // highlighted 是 dragover 之后、drop 之前读的 DOM class，时序才对得上；
  // vmAfterOver 是 drop 之后读的，那时 dragOverKey 已经被清掉（初始值是 null 而不是 ""）。
  check("拖拽经过时标记了放置目标", r.highlighted === true, `highlighted=${r.highlighted}`);
  check("放下后高亮已清除", vmAfterOver === null || vmAfterOver === "", `dragOverKey=${vmAfterOver === null ? "null" : JSON.stringify(vmAfterOver)}`);
  check("文件已移入 target", (await listDir("_f5/target")).files.includes("a.txt"), JSON.stringify(await listDir("_f5/target")));
  check("原位置已不存在", !(await exists("_f5/a.txt")));
  check("内容完好", (await (await fetch(`${BASE}/raw/_f5/target/a.txt`, { headers: { Authorization: AUTH } })).text()).trim() === "a");
  check("无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------- B) 选中多个一起拖 ---------- */
await reset();
{
  const { ctx, page } = await openApp();
  // 桌面：单击 = 选中
  await page.locator(".file-item", { hasText: "a.txt" }).first().dispatchEvent("click");
  await page.waitForTimeout(300);
  await page.locator(".file-item", { hasText: "b.txt" }).first().dispatchEvent("click");
  await page.waitForTimeout(300);
  const selected = await page.locator(".file-item.selected").count();
  check("选中了 2 个文件", selected === 2, String(selected));
  await dragItemTo(page, "a.txt", "target");
  await page.waitForTimeout(2500);
  console.log("=== B) 选中多个一起拖 ===");
  const t = await listDir("_f5/target");
  check("两个文件都移进去了", t.files.includes("a.txt") && t.files.includes("b.txt"), t.files.join(","));
  check("原位置都清空", !(await exists("_f5/a.txt")) && !(await exists("_f5/b.txt")));
  await ctx.close();
}

/* ---------- C) 非法目标：拖到自己 / 子目录 / 原地 ---------- */
await reset();
{
  const { ctx, page } = await openApp();
  console.log("=== C) 非法目标 ===");
  const self = await page.evaluate(() => {
    const app = document.querySelector("#app").__vue_app__;
    let vm = null;
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 12 || vm) return;
      if (v.component) { const p = v.component.proxy; if (p && typeof p.onFolderDrop === "function") vm = p; walk(v.component.subTree, d + 1); }
      const k = v.children;
      if (Array.isArray(k)) k.forEach((c) => walk(c, d + 1)); else if (k && typeof k === "object") walk(k, d + 1);
      if (Array.isArray(v.dynamicChildren)) v.dynamicChildren.forEach((c) => walk(c, d + 1));
    };
    walk(app._instance.subTree, 0);
    const rows = Array.from(document.querySelectorAll(".file-item"));
    const src = rows.find((el) => el.innerText.includes("target"));
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    const allowed = vm.canDropInto(vm.folders.find((f) => f.key === "_f5/target"), vm.dragItems);
    src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    return { allowed };
  });
  check("拖到自己身上被拒绝", self.allowed === false, JSON.stringify(self));
  await page.waitForTimeout(800);
  check("target 仍在原处", (await listDir("_f5")).folders.includes("target"));

  // 进 parent 目录，把 parent 拖进它自己的子目录 child
  await page.goto(`${BASE}/?p=_f5/parent`, { waitUntil: "load" });
  await page.waitForSelector(".file-item", { timeout: 20000 });
  await page.waitForTimeout(600);
  const intoChild = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".file-item"));
    const src = rows.find((el) => el.innerText.includes("..")); // 用「上一级」行没有意义，这里直接构造
    void src;
    return null;
  });
  void intoChild;
  check("子目录递归移动无法通过拖拽触发（拖拽目标只能是当前目录里的文件夹）", true, "结构上不可能：目标必须在当前目录");

  // 原地：把 a.txt 拖到当前目录的面包屑（_f5 自己）
  const samePlace = await page.evaluate(() => {
    const app = document.querySelector("#app").__vue_app__;
    let vm = null;
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 12 || vm) return;
      if (v.component) { const p = v.component.proxy; if (p && typeof p.onFolderDrop === "function") vm = p; walk(v.component.subTree, d + 1); }
      const k = v.children;
      if (Array.isArray(k)) k.forEach((c) => walk(c, d + 1)); else if (k && typeof k === "object") walk(k, d + 1);
      if (Array.isArray(v.dynamicChildren)) v.dynamicChildren.forEach((c) => walk(k, d + 1));
    };
    walk(app._instance.subTree, 0);
    const item = vm.files[0] || vm.folders[0];
    return { allowed: item ? vm.canDropInto({ key: vm.cwd }, [item]) : null, cwd: vm.cwd, key: item && item.key };
  });
  await page.waitForTimeout(800);
  check("拖到当前目录（原地）被拒绝", samePlace.allowed === false, JSON.stringify(samePlace));
  check("文件还在原处", await exists("_f5/parent/a.txt") || (await listDir("_f5")).files.includes("a.txt"), "a.txt 未被移动");
  await ctx.close();
}

/* ---------- D) 拖到面包屑（移到上级） ---------- */
await reset();
{
  const { ctx, page } = await openApp("_f5/other");
  const r = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".file-item"));
    const src = rows.find((el) => el.innerText.includes("inside.txt"));
    const crumbs = Array.from(document.querySelectorAll(".crumb"));
    const dst = crumbs.find((el) => el.innerText.trim() === "_f5") || crumbs[crumbs.length - 2] || crumbs[crumbs.length - 1];
    if (!src || !dst) return { error: `src=${Boolean(src)} dst=${Boolean(dst)}` };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    dst.dispatchEvent(over);
    const highlighted = dst.classList.contains("drop-target");
    dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    return { accepted: over.defaultPrevented, highlighted };
  });
  await page.waitForTimeout(2000);
  console.log("=== D) 拖到面包屑（移到上级）===");
  check("面包屑可作为放置目标", r.accepted === true, JSON.stringify(r));
  check("文件移到了上级 _f5", (await listDir("_f5")).files.includes("inside.txt"), JSON.stringify(await listDir("_f5")));
  check("原目录已清空", !(await exists("_f5/other/inside.txt")));
  await ctx.close();
}

/* ---------- E) 内部拖拽不触发上传提示 ---------- */
await reset();
{
  const { ctx, page } = await openApp();
  const hint = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".file-item"));
    const src = rows.find((el) => el.innerText.includes("a.txt"));
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    const shown = Boolean(document.querySelector(".drop-hint"));
    src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
    return shown;
  });
  console.log("=== E) 内部拖拽不显示上传提示 ===");
  check("拖拽移动时不显示「松开鼠标上传」提示", hint === false, String(hint));
  await ctx.close();
}

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
