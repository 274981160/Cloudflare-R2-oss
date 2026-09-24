/**
 * 端到端测试的统一入口。
 *
 * 用法：
 *   node tests/e2e/seed.mjs            # 先准备数据（幂等）
 *   node tests/e2e/run.mjs             # 跑全部
 *   node tests/e2e/run.mjs f5 tap      # 只跑名字里含 f5 / tap 的
 *   node tests/e2e/run.mjs --list      # 列出所有测试
 *   node tests/e2e/run.mjs --retry=1   # 关掉失败自动重试
 *
 * 前置条件：本地已经起好实例（默认 http://127.0.0.1:8788），
 * 并且装了 playwright（见 tests/e2e/README.md 的「Playwright 从哪来」）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, USER, PASS } from "./_setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

/** 按功能分组，顺序即执行顺序（快的、基础的在前） */
const SUITES = [
  { name: "tap-test", desc: "触屏/桌面交互：单击打开、长按菜单、多选" },
  { name: "uitest-editor", desc: "文本编辑器：查找替换、缩进、JSON 整理" },
  { name: "search-test", desc: "全局搜索：跨目录、权限、打开所在目录" },
  { name: "a1-ui2", desc: "解压同名冲突：默认跳过 / 可选覆盖" },
  { name: "a2-test", desc: "缩略图按需加载" },
  { name: "a3-test", desc: "上传 zip 后询问解压" },
  { name: "a3-test2", desc: "上传普通文件不打扰" },
  { name: "a4-test", desc: "分享可设有效期" },
  { name: "a5-test", desc: "图片预览左右滑动切换" },
  { name: "e1-test", desc: "预览流式加载（直链 + Range）" },
  { name: "e1-pdf", desc: "PDF 预览" },
  { name: "perf-test", desc: "预览请求数与浏览器缓存" },
  { name: "e2-test", desc: "给已有图片补缩略图" },
  { name: "e2-test2", desc: "octet-stream 图片也能补缩略图" },
  { name: "trash-ui", desc: "回收站：恢复 / 彻底删除" },
  { name: "conflict-ui", desc: "上传同名：覆盖 / 重命名 / 取消" },
  { name: "f2-test", desc: "分片上传：重试 / 断点续传 / 取消" },
  { name: "f3-test", desc: "上传逐文件状态与失败重试" },
  { name: "f4-test", desc: "解压流式进度" },
  { name: "f5-test", desc: "拖拽移动文件" },
  { name: "highlight-test", desc: "拖拽高亮（含初始状态不该有高亮）" },
  { name: "shares-mobile", desc: "分享管理手机端布局" },
  { name: "ui-audit", desc: "手机 UI 体检：溢出与触摸目标" },
  { name: "ui-desktop-check", desc: "桌面端不退化" },
];

if (args.includes("--list")) {
  console.log("可用测试：");
  for (const s of SUITES) console.log(`  ${s.name.padEnd(20)} ${s.desc}`);
  process.exit(0);
}

const filters = args.filter((a) => !a.startsWith("-"));
const selected = filters.length
  ? SUITES.filter((s) => filters.some((f) => s.name.includes(f)))
  : SUITES;

/** 每个套件最多尝试几次（默认 3 = 失败后最多再试两次）；--retry=1 关掉重试 */
const retryArg = args.find((a) => a.startsWith("--retry="));
const MAX_ATTEMPTS = retryArg ? Math.max(1, Number(retryArg.split("=")[1]) || 1) : 3;

if (!selected.length) {
  console.error(`没有匹配的测试：${filters.join(", ")}`);
  process.exit(1);
}

function runOne(suite) {
  return new Promise((resolve) => {
    const file = path.join(here, `${suite.name}.mjs`);
    if (!fs.existsSync(file)) {
      console.log(`\n— ${suite.name}：文件不存在，跳过`);
      return resolve({ name: suite.name, skipped: true });
    }
    const started = Date.now();
    const child = spawn(process.execPath, [file], { stdio: "inherit", cwd: here });
    child.on("close", (code) => {
      resolve({ name: suite.name, code, ms: Date.now() - started });
    });
  });
}

/** 探一下本地实例还活着没（卡住时首页请求会挂起或超时） */
async function instanceAlive() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 清空回收站：套件之间顺手做一次，免得每个套件删除的东西都堆在回收站里 */
async function clearTrash() {
  try {
    await fetch(`${BASE}/api/trash`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    /* 清不掉也无所谓，不影响下一个套件 */
  }
}

/**
 * 跑一个套件，失败就再试。
 *
 * 为什么需要重试：`wrangler pages dev` 连着跑十几个套件之后会间歇性卡住。
 * 日志里的表现是请求随机慢到几秒（`MOVE ... 6629ms`、`GET /api/list ... 4336ms`），
 * 偶尔还冒出 `Error inside ProxyWorker ... Network connection lost`，
 * 攒够几次就把页面 goto 的 30 秒超时撑爆了。和被测代码没关系，重试基本都能过。
 * 用 `--retry=1` 关掉重试。
 */
async function runSuite(suite) {
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const alive = await instanceAlive();
      console.log(
        `\n↻ ${suite.name} 第 ${attempt} 次尝试（上次退出码 ${attempts[attempts.length - 1].code}）`
      );
      if (!alive) {
        console.log(
          `  ⚠ 本地实例 ${BASE} 没有响应，多半是它卡住了 —— 重试大概率还是超时，建议重启 wrangler pages dev`
        );
      }
      // 卡住有时是暂时的，多等一会儿比立刻重试更容易过
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const result = await runOne(suite);
    attempts.push(result);
    if (result.code === 0 || result.skipped) break;
  }
  const last = attempts[attempts.length - 1];
  return { ...last, attempts: attempts.length };
}

console.log(`将运行 ${selected.length} 个测试套件（每个套件里会打印明细）\n`);
const results = [];
for (const suite of selected) {
  console.log(`\n${"=".repeat(60)}\n▶ ${suite.name} —— ${suite.desc}\n${"=".repeat(60)}`);
  results.push(await runSuite(suite));
  await clearTrash();
  // 给实例留一点喘息时间，能少卡几次
  if (suite !== selected[selected.length - 1]) await new Promise((resolve) => setTimeout(resolve, 1500));
}

const failed = results.filter((r) => r.code !== 0 && !r.skipped);
console.log(`\n${"=".repeat(60)}\n汇总\n${"=".repeat(60)}`);
for (const r of results) {
  const mark = r.skipped ? "跳过" : r.code === 0 ? "通过" : "失败";
  let retried = "";
  if (r.attempts > 1) {
    retried = r.code === 0 ? `（重试第 ${r.attempts} 次才过）` : `（试了 ${r.attempts} 次仍失败）`;
  }
  console.log(`  ${mark}  ${r.name.padEnd(20)} ${r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ""}${retried}`);
}
console.log(`\n${results.length - failed.length} / ${results.length} 个套件通过`);
process.exit(failed.length ? 1 : 0);
