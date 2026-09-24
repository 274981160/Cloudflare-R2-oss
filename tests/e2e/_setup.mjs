/**
 * 端到端测试的公共配置。
 *
 * 这些测试跑在**真实的本地实例**上（wrangler pages dev），用真实浏览器点真实界面。
 * 用法见 tests/e2e/README.md。
 *
 * 全部通过环境变量配置，默认值对应「本地起好实例 + 默认账号」：
 *   FD_BASE      被测地址，默认 http://127.0.0.1:8788
 *   FD_USER      账号，默认 admin
 *   FD_PASS      密码，默认 secret
 *   FD_CHROMIUM  浏览器可执行文件路径；留空则交给 Playwright 自己找
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASE = process.env.FD_BASE || "http://127.0.0.1:8788";
export const USER = process.env.FD_USER || "admin";
export const PASS = process.env.FD_PASS || "secret";

/** 用户名:密码（明文），用于往页面里塞 localStorage 的 btoa(...) */
export const RAW = `${USER}:${PASS}`;
/** 裸 base64 —— 注意 App 的 localStorage.fd_auth 存的是这个（它自己拼 "Basic "） */
export const CREDS = Buffer.from(RAW).toString("base64");
/** 完整请求头值，用于 Node 侧 fetch */
export const AUTH = `Basic ${CREDS}`;

/**
 * 测试用的素材目录（输入文件）与产物目录（截图）。
 * 默认都放在系统临时目录下，不会污染仓库。
 *   FD_FIXTURES  素材目录，默认 <tmp>/fd-e2e
 *   FD_ARTIFACTS 截图目录，默认 <tmp>/fd-e2e/artifacts
 */
export const FIXTURES = process.env.FD_FIXTURES || path.join(os.tmpdir(), "fd-e2e");
export const ARTIFACTS = process.env.FD_ARTIFACTS || path.join(FIXTURES, "artifacts");
for (const dir of [FIXTURES, ARTIFACTS]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { /* 忽略 */ }
}
/** 素材文件路径 */
export const fixture = (name) => path.join(FIXTURES, name);
/** 截图输出路径 */
export const artifact = (name) => path.join(ARTIFACTS, name);

const chromiumPath = (process.env.FD_CHROMIUM || "").trim();

/** 统一的启动参数：环境里没有可用浏览器时用 FD_CHROMIUM 指定 */
export function launchOptions(extra = {}) {
  const options = { args: ["--no-sandbox"], ...extra };
  if (chromiumPath) options.executablePath = chromiumPath;
  return options;
}

/** 统一的断言（各测试脚本自己也会定义，这里给新脚本用） */
export function createChecker(label) {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra) => {
    if (ok) pass += 1;
    else fail += 1;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? `  → ${extra}` : ""}`);
  };
  const summary = () => {
    console.log(`\n${label ? `[${label}] ` : ""}结果: ${pass} 通过, ${fail} 失败`);
    return fail;
  };
  return { check, summary, counts: () => ({ pass, fail }) };
}
