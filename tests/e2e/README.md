# 端到端测试（真实浏览器点真实界面）

这些测试跑在**真实运行的本地实例**上：起一个 `wrangler pages dev`，用 Chromium 打开页面，
点真实的按钮、上传真实的文件、检查服务端真的写对了。它们覆盖了「纯函数测试」和
「接口冒烟测试」都碰不到的部分——界面交互、布局、上传/解压/预览的完整链路。

## 需要什么

| 依赖 | 说明 |
| --- | --- |
| Node.js | 20+（用内置 `fetch`、`node:test` 之类） |
| Playwright | **需要自己装**（仓库刻意不写进依赖，保持运行时零依赖）：<br>`npm i -D playwright && npx playwright install chromium`<br>已经有安装想直接复用，见下面「Playwright 从哪来」 |
| 本地实例 | 默认 `http://127.0.0.1:8788`，见下面「怎么跑」 |
| ffmpeg | 可选。没有就跳过测试视频的生成（相关断言会少几条） |

## 怎么跑

```bash
# 1) 起本地实例（另开一个终端；注意一次只跑一个实例）
npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state-e2e --port 8788

# 2) 准备测试数据（幂等，可以反复跑）
node tests/e2e/seed.mjs        # 或 npm run test:e2e:seed

# 3) 跑全部
node tests/e2e/run.mjs         # 或 npm run test:e2e

# 只跑关心的几个（按名字匹配）
node tests/e2e/run.mjs f5 tap
node tests/e2e/run.mjs --list      # 看有哪些
```

## Playwright 从哪来

`tests/e2e/_pw.mjs` 负责找 playwright，按顺序试：

1. `FD_PLAYWRIGHT` 指向的包目录，或它下面的 `playwright` 子目录
2. `NODE_PATH` 里的 playwright（用 `createRequire` 解析，所以这里 `NODE_PATH` 是生效的；
   注意 ESM 的 `import "playwright"` 本身**不认** `NODE_PATH`）
3. 项目 `node_modules` 里自己装的

都没有就打印安装命令并以退出码 2 结束，不会只抛一句 `Cannot find module`。

```bash
# 复用一个已有的安装，不用往项目里装
FD_PLAYWRIGHT=/path/to/node_modules/playwright node tests/e2e/run.mjs
NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FD_BASE` | `http://127.0.0.1:8788` | 被测地址 |
| `FD_USER` / `FD_PASS` | `admin` / `secret` | 账号（要和实例的环境变量一致） |
| `FD_PLAYWRIGHT` | 空 | playwright 包目录（见上） |
| `FD_CHROMIUM` | 空 | 浏览器可执行文件路径；留空交给 Playwright 自己找 |
| `FD_FIXTURES` | `<临时目录>/fd-e2e` | 测试素材目录（输入文件） |
| `FD_ARTIFACTS` | `<临时目录>/fd-e2e/artifacts` | 截图等产物目录 |

## 约定

- 每个套件**自己准备和清理数据**，可以单独跑、反复跑（`seed.mjs` 也是幂等的）。
- 断言失败的会打印 `FAIL`，脚本最后打印 `结果: N 通过, M 失败` 并以非零码退出。
- **失败会自动重试**（默认每个套件最多试 3 次，`run.mjs --retry=1` 可关掉）。
  原因是本地实例的脾气：`wrangler pages dev` 连着跑十几个套件之后会间歇性卡住，
  日志里的表现是请求随机慢到几秒（`MOVE ... 6629ms`、`GET /api/list ... 4336ms`），
  偶尔还冒 `Error inside ProxyWorker ... Network connection lost`，攒够几次就把页面
  `goto` 的 30 秒超时撑爆了。这和被测代码无关，重试基本都能过；重试前还会探一下
  实例是否还在响应，不响应就提示你重启它。汇总里会标出「重试第 N 次才过」。
- **套件跑完会自动清空回收站**，免得每个套件删的东西都堆在里面。
- 如果**大批套件连续超时**（不是零星一两个），别怀疑代码，重启 `wrangler pages dev`
  再接着跑；也可以分批跑，比如 `node tests/e2e/run.mjs f2 f3 f4`。
- 写测试时注意两点教训（都是真踩过的坑）：
  1. **不光要测「操作后是什么」，也要测「没操作时不该是什么」**——
     比如拖拽高亮，只测「拖拽时该高亮」会漏掉「初始状态一直高亮」的 bug。
  2. **往 `localStorage.fd_auth` 塞的是裸 base64**（App 自己拼 `Basic ` 前缀），
     塞成 `Basic xxx` 会导致双重前缀、401、页面被重载，看起来像「浏览器莫名关闭」。
  3. **别用 `includes("同名文件")` 之类的宽条件去认对话框**。上传压缩包后的询问是
     「刚上传的「x.zip」是压缩包，要解压到当前目录吗？…（遇到同名文件会再问一次…）」，
     它本身就含「同名文件」四个字，会被误当成冲突框，于是「跳过」那一路把整个解压取消了。
     真正的冲突框文案是「目标里已有 N 个同名文件」。
  4. **`page.addInitScript` 里的函数是序列化到浏览器执行的**，不能闭包引用 Node 侧变量
     （`btoa(RAW)` 会报 `RAW is not defined`），要当参数传进去：`addInitScript((auth) => …, CREDS)`。

## 套件一览

用 `node tests/e2e/run.mjs --list` 看最新列表。大致分组：

- **基础交互**：`tap-test`（单击打开/长按菜单/多选）、`uitest-editor`（编辑器）
- **A 组**：`a1-ui2` 解压同名冲突、`a2-test` 缩略图按需、`a3-test*` 上传即解压、`a4-test` 分享有效期、`a5-test` 图片滑动
- **E 组**：`e1-test` 流式预览、`e1-pdf`、`perf-test` 请求数与缓存、`e2-test*` 补缩略图
- **F 组**：`f2-test` 断点续传、`f3-test` 逐文件状态、`f4-test` 解压进度、`f5-test` 拖拽移动、`highlight-test` 拖拽高亮
- **其它**：`search-test` 全局搜索、`trash-ui` 回收站、`conflict-ui` 同名覆盖、`shares-mobile` 分享管理手机端
- **体检**：`ui-audit` 手机端溢出与触摸目标、`ui-desktop-check` 桌面不退化
