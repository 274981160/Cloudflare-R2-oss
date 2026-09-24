// Playwright 的加载器。
//
// 仓库刻意不把 playwright 写进依赖（运行时零依赖是这个项目的卖点），所以这里做运行时解析：
//   1. 环境变量 FD_PLAYWRIGHT —— 指向 playwright 包目录或它的 node_modules 目录
//   2. NODE_PATH 里能找到的 playwright（注意：ESM 的 `import "playwright"` 不认 NODE_PATH，
//      但下面用 createRequire 解析，所以 NODE_PATH 是生效的）
//   3. 本地 node_modules 里装的 playwright（如果你按 README 自己 npm i -D playwright 了）
//
// 找不到就给出可照抄的安装命令，而不是抛一句 "Cannot find module"。

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

function resolvePlaywright() {
  const tried = [];
  const env = process.env.FD_PLAYWRIGHT;
  if (env) {
    // 允许两种写法：playwright 包目录本身，或包含它的 node_modules 目录
    tried.push(env, path.join(env, "playwright"));
  }
  tried.push("playwright");

  for (const candidate of tried) {
    try {
      return require.resolve(candidate);
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

const resolved = resolvePlaywright();

if (!resolved) {
  console.error(
    [
      "",
      "找不到 playwright，端到端测试跑不起来。",
      "",
      "  方式一（推荐）：在项目里装一次",
      "    npm i -D playwright && npx playwright install chromium",
      "",
      "  方式二：复用已有的安装",
      "    FD_PLAYWRIGHT=/path/to/node_modules/playwright node tests/e2e/run.mjs",
      "    NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs",
      "",
      "浏览器可执行文件不在默认位置时，再用 FD_CHROMIUM 指定（见 _setup.mjs 的 launchOptions）。",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const mod = await import(pathToFileURL(resolved).href);

export const chromium = mod.chromium ?? mod.default?.chromium;
export const devices = mod.devices ?? mod.default?.devices;

if (!chromium) {
  console.error(`playwright 加载了但拿不到 chromium（${resolved}）`);
  process.exit(2);
}
