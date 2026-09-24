/**
 * 给端到端测试准备数据（幂等：可以反复跑）。
 *
 * 用法：node tests/e2e/seed.mjs
 *
 * 只依赖 Node 内置模块：PNG 用 zlib 现场生成、zip 用内置 store 格式手写，
 * 所以不需要装任何东西。**视频**需要本机有 ffmpeg，没有就跳过相关测试数据。
 */
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, AUTH, FIXTURES } from "./_setup.mjs";

const H = { Authorization: AUTH };
const tmp = FIXTURES;

const log = (msg) => console.log(`  ${msg}`);

async function put(key, body, type = "application/octet-stream", extra = {}) {
  const url = `${BASE}/webdav/${key.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...H, "Content-Type": type, ...extra },
    body,
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`PUT ${key} → ${res.status}`);
  }
}
async function mkcol(key) {
  const url = `${BASE}/webdav/${key.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { method: "MKCOL", headers: H });
  if (![201, 204, 405].includes(res.status)) throw new Error(`MKCOL ${key} → ${res.status}`);
}

async function post(apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (![200, 201].includes(res.status)) {
    throw new Error(`POST ${apiPath} → ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
  return res.json().catch(() => ({}));
}
async function wipe(key) {
  const url = `${BASE}/webdav/${key.split("/").map(encodeURIComponent).join("/")}`;
  await fetch(url, { method: "DELETE", headers: H });
}
/** 清空回收站（删除现在进回收站，不清会挡住同名重建） */
async function emptyTrash() {
  await fetch(`${BASE}/api/trash`, { method: "DELETE", headers: H });
}

/* ---------------- 生成素材 ---------------- */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 生成一张纯色 PNG（size 越大文件越大，用来测流式加载） */
function makePng(width, height, rgb = [60, 140, 220]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter
    for (let x = 0; x < width; x++) {
      raw[offset++] = rgb[0];
      raw[offset++] = rgb[1];
      raw[offset++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 手写 store 模式的 zip（不压缩，服务端的解压器直接支持） */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- 各测试需要的数据 ---------------- */

async function seedTap() {
  await mkcol("_tap");
  await mkcol("_tap/sub");
  for (const n of ["a", "b", "c", "d"]) await put(`_tap/${n}.txt`, `content ${n}\n`, "text/plain");
  await put("_tap/j.json", '{"k":1}', "application/json");
}

async function seedEdit() {
  await mkcol("_edit");
  // 这一份专门给「整理缩进」用，刻意塞了 JSON.parse 会破坏的东西：
  //   f: 1.0                      小数精度不能被吃掉
  //   big: 123456789012345678901  超出 double 精度的大整数要原样保留
  //   s: "hello   world"          连续空格不能被压缩
  //   a 出现两次                   重复键不能被合并
  //   empty / arr                 空对象与空数组保持内联
  //   nested.ok                   嵌套层缩进 4 空格
  await put(
    "_edit/test.json",
    '{"name":"demo","a":1,"a":2,"list":[1,2,3],"f":1.0,"big":123456789012345678901,"s":"hello   world","empty":{},"arr":[],"nested":{"ok":true}}',
    "application/json"
  );
  // 带注释的 JSON：行注释、块注释、尾逗号都要在「整理缩进」后原样保留
  await put(
    "_edit/tsconfig.json",
    '{\n// 这是注释\n"compilerOptions": {\n/* 块注释 */\n"strict": true,\n},\n}\n',
    "application/json"
  );
  await put("_edit/real.jsonc", '{\n  // 注释\n  "a": 1,\n}\n', "application/json");
  await put("_edit/plain.txt", "plain text file\n", "text/plain");
}

async function seedA1() {
  await mkcol("_a1f");
  const zip = makeZip([
    ["tree/a.txt", "from zip\n"],
  ]);
  // 压缩包不放进盘里，而是作为「上传素材」，这样才走得到「上传后解压到当前目录」的流程
  fs.writeFileSync(path.join(tmp, "a1conflict.zip"), zip);
  // 预先放一个同名文件（内容与包内不同），用来验证「默认跳过、不覆盖用户改动」
  await put("_a1f/tree/a.txt", "user-edited\n", "text/plain");
}

async function seedA2() {
  await mkcol("_a2");
  const thumb = makePng(64, 64, [200, 120, 60]);
  const photo = makePng(200, 150, [60, 140, 220]);
  for (let i = 1; i <= 120; i++) {
    const digest = i.toString(16).padStart(40, "0");
    await put(`_$flaredrive$/thumbnails/${digest}.png`, thumb, "image/png");
    await put(`_a2/img${String(i).padStart(3, "0")}.jpg`, photo, "image/jpeg", {
      "fd-thumbnail": digest,
    });
  }
}

async function seedA3() {
  await mkcol("_a3");
  // a3 测试会把这些文件通过界面上传上去
  fs.writeFileSync(path.join(tmp, "a3.zip"), makeZip([["a3dir/hello.txt", "hello from zip\n"]]));
  fs.writeFileSync(path.join(tmp, "a3-normal.txt"), "just a normal file\n");
}

async function seedA4() {
  await mkcol("_a4");
  await put("_a4/doc.txt", "share me\n", "text/plain");
}

async function seedA5() {
  await mkcol("_a5mix");
  await put("_a5mix/only.png", makePng(120, 90, [90, 180, 120]), "image/png");
  await put("_a5mix/note.txt", "hello text", "text/plain");
}

async function seedE1() {
  await mkcol("_e1");
  await put("_e1/bigphoto.png", makePng(700, 700, [30, 90, 160]), "image/png");
  await put("_e1/mini.pdf", Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n", "utf8"), "application/pdf");
  // 视频：需要 ffmpeg，没有就跳过（对应测试会自动少跑几条）
  const target = path.join(tmp, "test-video.webm");
  const ff = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=5",
    "-c:v", "libvpx", "-b:v", "200k", target,
  ], { stdio: "ignore" });
  if (ff.status === 0 && fs.existsSync(target)) {
    await put("_e1/test-video.webm", fs.readFileSync(target), "video/webm");
    return true;
  }
  return false;
}

async function seedE2() {
  await mkcol("_th");
  await put("_th/via-webdav.png", makePng(120, 90, [200, 60, 60]), "image/png");
  await put("_th/note.txt", "note", "text/plain");
  await mkcol("_th2");
  await put("_th2/no-type.png", makePng(120, 90, [60, 200, 90]), "application/octet-stream");
  const digest = "bbccddaabbccddaabbccddaabbccddaabbccddaa";
  await put(`_$flaredrive$/thumbnails/${digest}.png`, makePng(64, 64), "image/png");
  await put("_th2/has-thumb.png", makePng(120, 90), "image/png", { "fd-thumbnail": digest });
}

async function seedSearch() {
  await mkcol("_s1");
  await mkcol("_s2");
  await mkcol("_s2/sub");
  await put("_s1/report-2026.txt", "a\n", "text/plain");
  await put("_s2/sub/report-final.txt", "a\n", "text/plain");
  await put("_s2/REPORT-notes.txt", "a\n", "text/plain");
  await put("_s1/other.txt", "a\n", "text/plain");
}

async function seedFix() {
  // highlight-test 用：一个文件夹当放置目标，一个文件当被拖的东西
  await mkcol("_fix");
  await mkcol("_fix/target");
  await put("_fix/a.txt", "a\n", "text/plain");
}

async function seedF4() {
  // f4-test 用：200 个条目的 zip，解压要跑得够久才看得到流式进度
  await mkcol("_f4");
  const entries = [];
  for (let i = 0; i < 200; i += 1) {
    entries.push([`batch${i % 4}/file${String(i).padStart(3, "0")}.txt`, `content ${i}\n`]);
  }
  await put("_f4/big.zip", makeZip(entries), "application/zip");
}

async function seedShares() {
  // shares-mobile 用：一条 30 天后到期、一条永久，好检查两种有效期文案
  await mkcol("_exp");
  await put("_exp/doc.txt", "shared\n", "text/plain");
  await put("_exp/other.txt", "shared too\n", "text/plain");
  await post("/api/shares", { key: "_exp/doc.txt", expiresInDays: 30 });
  await post("/api/shares", { key: "_exp/other.txt", expiresInDays: null });
}

async function seedApiKey() {
  // ui-desktop-check 用：API 密钥页要至少有一条记录才渲染得出表格
  await post("/api/keys", { name: "e2e 测试密钥" });
}

async function seedUi() {
  await mkcol("_ui2");
  await mkcol("_ui2/sub");
  await put("_ui2/photo.png", makePng(120, 90), "image/png");
  await put("_ui2/config.json", '{"a":1,"list":[1,2,3]}', "application/json");
  await put(
    "_ui2/这是一个非常非常长的文件名用来测试手机端界面会不会被撑宽_2026年度归档备份_最终版_final_v3.tar.gz",
    "long name\n",
    "application/gzip"
  );
}

/* ---------------- 主流程 ---------------- */

console.log(`准备测试数据 → ${BASE}`);
const targets = ["_tap", "_edit", "_a1f", "_a2", "_a3", "_a4", "_a5mix", "_e1", "_th", "_th2", "_s1", "_s2", "_ui2", "_f5", "_ui", "_upc", "_f2", "_f3", "_f4", "_fix"];
for (const key of targets) {
  await wipe(key);
}
await emptyTrash();

await seedTap(); log("_tap（触屏/桌面交互）");
await seedEdit(); log("_edit（编辑器）");
await seedA1(); log("_a1f（解压同名冲突）");
await seedA2(); log("_a2（120 张图 + 缩略图）");
await seedA3(); log("_a3（上传后解压）");
await seedA4(); log("_a4（分享有效期）");
await seedA5(); log("_a5mix（图片滑动）");
const hasVideo = await seedE1(); log(`_e1（流式预览）${hasVideo ? "" : " —— 没找到 ffmpeg，跳过视频文件"}`);
await seedE2(); log("_th / _th2（补缩略图）");
await seedSearch(); log("_s1 / _s2（全局搜索）");
await seedFix(); log("_fix（拖拽高亮）");
await seedF4(); log("_f4（解压流式进度）");
await seedShares(); log("_exp（分享管理）");
await seedApiKey(); log("/api/keys（API 密钥页）");
await seedUi(); log("_ui2（手机 UI 体检）");
// f3（上传逐文件状态）与 conflict-ui（同名覆盖）用的输入文件
fs.writeFileSync(path.join(tmp, "f3a.txt"), "file A\n");
fs.writeFileSync(path.join(tmp, "f3b.txt"), "file B\n");
fs.writeFileSync(path.join(tmp, "f3c.txt"), "file C\n");
fs.mkdirSync(path.join(tmp, "upsame"), { recursive: true });
fs.writeFileSync(path.join(tmp, "upsame", "a.txt"), "NEW VERSION FROM UPLOAD\n");
fs.writeFileSync(path.join(tmp, "keep.txt"), "seed\n");

console.log(`\n完成。素材目录：${tmp}`);
