# Cloudflare R2 网盘

一个跑在 Cloudflare 上的自建网盘：**Cloudflare Pages（静态前端 + Pages Functions 后端） + 一个 R2 存储桶**。
不需要服务器，不需要数据库，前端也没有构建步骤——把仓库连到 Pages 上就能用。

本仓库的前身是 [longern/FlareDrive](https://github.com/longern/FlareDrive)，在此基础上融合了两条分支的优点：

- 来自汉化分支：**无构建步骤的前端**（Vue 3 通过 CDN 引入，用 `vue3-sfc-loader` 直接在浏览器里加载 `.vue`）、中文界面、**多账号 + 按目录授权**的权限系统。
- 来自上游：**完整 WebDAV 服务端**（标准客户端可直接挂载）、目录即对象、递归分页列举、PDF 缩略图。
- 本次新增的改进：WebDAV 支持 `LOCK` / `UNLOCK`（DAV class 2）、`PROPPATCH`、`Range` 与条件请求、配额属性、目录 HTML 浏览页、目录 zip 打包下载、文件夹选择器式移动、缩略图始终可公开引用、**兼容旧版 `_$folder$` 目录标记**。

---

## 功能特性

| 类别 | 能力 |
| --- | --- |
| 文件管理 | 浏览、上传、下载、重命名、移动、复制、删除、新建文件夹 |
| 回收站 | **删除默认进回收站**（软删除，可恢复）：删除瞬间完成、不会因为目录大而失败；可单个恢复（原位置被占用时自动改名）、彻底删除、清空；超过保留天数自动清理。`WEBDAV_TRASH=0` 可关掉改成直接删除 |
| 覆盖保护 | 上传/复制时遇到同名文件会先问「**覆盖（旧的进回收站）** / 重命名保留两份 / 取消」；选覆盖时**被覆盖的旧文件先进回收站**，传错版本也能找回来（WebDAV 客户端直接 PUT 覆盖同样受保护） |
| 单击行为 | **手机（触屏）**：单击即打开（文件夹进入、文件预览），长按出菜单，多选从 ⋮ 菜单或长按菜单的「多选」进入（勾选圈 + 底部工具条 + 完成）；**桌面**：单击选中/取消选中、双击打开、右键菜单，行为与原来完全一致 |
| 上传 | 拖拽上传、**拖入/选择整个文件夹并保留目录结构（含空目录）**、上传进度与并发控制、上传中可取消 |
| 上传状态 | 底部面板显示**每个文件的状态**（等待/上传中 X%/已完成/失败+原因），失败项可**单独重试**或**一键重试全部**；全部成功后自动收起 |
| 断点续传 | 大文件走 25MB 分片上传：**单片失败自动重试**（指数退避），网络中断/误刷新后重新选同一个文件会**接着传已传完的分片**（进度存在本机，最多留 7 天）；取消上传会放弃服务端分片任务，不留垃圾 |
| 在线编辑 | 直接编辑 txt / js / py / json / md / yaml… 等文本文件；识别 20+ 种语言做语法着色，JSON 有实时校验与一键整理缩进；任何文件都能「以文本方式打开」兜底 |
| JSON 整理缩进 | 一键把 JSON 排成规范缩进；**只动空白**——注释（JSONC / tsconfig.json）、数字写法（`1.0` / `1e2` / 大整数）、重复键、字符串原文全部原样保留；沿用文件已有缩进风格，兼容 BOM 与 CRLF |
| 编辑体验 | 查找与**替换**（单个 / 全部，可区分大小写）、Tab 缩进与 Shift+Tab 反缩进（支持多行整块）、回车自动缩进、自动换行开关、字号调节、光标行列与字符统计 |
| 编辑内搜索 | 编辑时按关键词高亮全部匹配、上一个/下一个跳转、显示 `n/m` 计数、可切换区分大小写 |
| 预览 | 图片、视频缩略图，PDF 缩略图，无缩略图时按 MIME 类型显示图标 |
| 批量操作 | 多选文件与目录，批量移动、复制、删除、下载 |
| 浏览体验 | 按名称/大小排序、面包屑导航、当前目录写进 URL（可前进后退/分享定位） |
| 搜索 | 顶部搜索框**即时过滤当前目录**（零请求，不打扰慢网络）；点「搜索全部目录」才**跨目录递归搜文件名**，结果显示所在路径，可一键跳到该文件所在目录 |
| 权限感知 | 无写权限的账号自动进入只读模式：隐藏上传与改动入口，列表上标注「只读」 |
| 打包下载 | 目录一键递归打包为 zip 下载；小对象预取并发，文件夹里很多小文件也快 |
| 在线压缩/解压 | 选中文件/文件夹右键「压缩为 zip」直接存回网盘；zip 右键「在线解压」（内置 DEFLATE 解压器，不依赖第三方）；**解压遇到同名文件默认跳过、绝不静默覆盖**，会先问你要不要覆盖；解压时**实时显示进度**（已处理 n/总数），并发写入可配 |
| 上传即解压 | 上传压缩包后主动问一句「要解压到当前目录吗」——手机选不了整个文件夹时，这是最实用的替代路径 |
| 缩略图 | **按需加载**：只拉进入视口的行，照片多的目录在手机上不再一次性请求上百张；用 WebDAV / 手机文件管理器传上来的图片原本没有缩略图，可从 ⋮ 菜单一键「生成缩略图」补齐（浏览器内 canvas 生成，存回网盘，之后打开即显） |
| 图片浏览 | 预览里左右滑动（或 ← →）切换同目录图片，显示 `n/N`；双击/滚轮缩放；放大时不误切图 |
| 流式预览 | 图片 / 视频 / 音频 / PDF 由浏览器原生加载：不用等整包下载完就能看，视频还能直接拖进度（服务端支持 Range/206）。登录时下发一个**只读预览 token** 直接拼进直链，**预览不额外多一次请求**（慢网络里每次往返 1~2 秒）；普通文件带 `private` 缓存头，**同一张图/同一个视频二次打开零请求**。token 失效时自动回退整包取回 |
| 下载体验 | 点下载由浏览器原生下载（有进度条、立刻弹保存框）；私有模式下用短时效签名直链实现，不需要公开文件 |
| 开放接口 | 生成式 **API Key**（只存摘要、可限定目录与有效期、随时吊销），`POST /api/upload/{path}` 一行 curl 上传 |
| WebDAV | 标准 WebDAV 服务端，Windows / macOS / rclone 等客户端可直接挂载，支持锁（class 2） |
| 权限 | 多账号，每个账号按**路径前缀白名单**授权，读写都受约束；API Key 另有独立白名单 |
| 分享链接 | 点「复制分享链接」生成 `/s/{token}` 只读链接；也可以在右键菜单选「分享（设有效期）」按 1 天 / 7 天 / 30 天 / 永久签发（改已有分享的有效期同样生效）；页面可预览/下载，**没有任何写入口**，随时可吊销 |
| 编辑内撤销 | 编辑器里 `Ctrl+Z` / `Ctrl+Y`（或工具栏按钮）撤销重做上一次修改，连续输入合并成一步 |

> **移动端说明**：手机浏览器内核不提供「选择整个文件夹」的能力（不是本项目的问题），
> 因此移动端会把「上传文件夹」按钮换成一句提示，建议用「文件」多选，或安装 WebDAV 客户端
> （如 Cx 文件管理器）挂载本网盘后上传文件夹。桌面端不受影响。
> 在线编辑与语法着色属于网页端功能，需要联网加载 CDN 上的 Vue 与 pdf.js。

---

## 部署到 Cloudflare Pages

### 0. 前提

- 有一个 Cloudflare 账号。
- 账号下已经开通 **R2**（首次开通需要绑定付款方式，免费额度内不收费）。
- 已经建好**至少一个 R2 存储桶**（在 Cloudflare 控制台 → R2 → 创建存储桶）。

### 1. 连接 Git 仓库并创建 Pages 项目

1. 把本仓库 fork 或推送到你自己的 GitHub / GitLab 账号。
2. 进入 Cloudflare 控制台 → **Workers 和 Pages** → **创建** → **Pages** → **连接到 Git**。
3. 选择刚才的仓库，点击**开始设置**。
4. 项目名称可以自定义，**生产分支**选你的主分支（一般是 `main`）。

### 2. 构建配置：框架预设选 `None`

| 配置项 | 填写内容 |
| --- | --- |
| 框架预设 | `None` |
| 构建命令 | **留空** |
| 构建输出目录 | `/` |

> 本项目**没有构建步骤**：`index.html` 直接通过 CDN 加载 Vue 3，并用 `vue3-sfc-loader` 在浏览器里实时编译 `assets/*.vue`。
> **不要照抄上游的 Docusaurus 预设**，也不要填 `build`、`dist` 之类的命令或目录。

设置好后点击**保存并部署**，先完成一次部署。

> 本项目**不需要任何 npm 依赖**（打包下载用的 ZIP 写入器是自带的），所以这里不需要跑依赖安装，
> 也不存在「Functions 找不到模块导致整个后端构建失败」的风险。

部署完成后可以顺手验证两点：

- 打开首页能看到登录界面或文件列表；
- 访问 `https://<你的域名>/package.json`、`/utils/config.ts` 应该返回 **404**
  （仓库里的源码/脚本/文档由 `functions/_middleware.ts` 统一屏蔽，不会当成站点资源发布）。

### 3. 绑定 R2 存储桶

首次部署完成后：

1. 进入 Pages 项目 → **设置** → **函数** → **R2 存储桶绑定** → **添加绑定**。
2. **变量名必须填 `BUCKET`**（代码按这个名字读取桶，写错会直接 404）。
3. 选择你要使用的 R2 存储桶。
4. 保存。

> 绑定按环境区分：生产环境和预览环境需要分别绑定，否则预览部署会拿不到桶。

### 4. 配置环境变量

进入 Pages 项目 → **设置** → **环境变量**（生产环境，按需也给预览环境配一份），把下面的变量填进去。
至少要先配 `WEBDAV_USERNAME` 和 `WEBDAV_PASSWORD`，否则你连登录都进不去。

### 5. 重新部署

绑定和环境变量**只对之后的部署生效**：

回到项目的**部署**页面，找到最新一次部署，点**重新部署**（或向仓库推一个新提交触发部署）。
部署完成后打开站点，应该就能看到登录界面了。

### 6. 可选：绑定自定义域名

Pages 项目 → **自定义域** → 添加你的域名（域名需已托管在 Cloudflare）。绑定后 WebDAV 地址就是 `https://<你的域名>/webdav`。

### 7. 提示

- **不要把存储桶设成公开访问**。本项目通过 Pages 的 R2 绑定读写对象，不需要存储桶的公共 URL，也不需要 `r2.dev` 公共域名。保持桶为私有更安全。
- 环境变量里不要提交任何密钥到仓库；所有配置都在 Cloudflare 控制台里填。
- 站点默认是**全私有**的：匿名访问任何文件都是 `401`，公开内容只能通过「复制分享链接」生成的 `/s/{token}` 访问。
- `functions/_middleware.ts` 会在每个请求上跑一次（用于屏蔽源码路径并补安全头），静态资源也会计入
  Functions 调用次数。个人网盘这个量级完全够用；如果你更在意静态资源不计入调用，
  删掉这个文件即可（代价是 `/utils/*`、`/scripts/*` 等仓库文件会变成可下载，而仓库本身是公开的，影响有限）。

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BUCKET` | 是（R2 绑定） | — | R2 存储桶绑定，变量名必须是 `BUCKET` |
| `WEBDAV_USERNAME` | 推荐 | — | 主账号用户名 |
| `WEBDAV_PASSWORD` | 推荐 | — | 主账号密码 |
| `WEBDAV_PERMISSIONS` | 否 | `*` | 主账号可访问的路径前缀，逗号分隔；`*` 表示全部 |
| `WEBDAV_USERS` | 否 | — | 多账号，格式 `用户名:密码:权限1,权限2;用户名2:密码2:*` |
| `WEBDAV_PUBLIC_READ` | 否 | `0` | **默认全私有**：匿名读任何路径都是 `401`。设为 `1` 才允许匿名读全部（谨慎） |
| `WEBDAV_PUBLIC_THUMBNAILS` | 否 | `0` | `1` 缩略图可匿名引用。默认 `0`，网页端带认证取回后转 blob URL 显示 |
| `WEBDAV_LOCKING` | 否 | `1` | 启用 `LOCK`/`UNLOCK` 与写操作锁校验（DAV class 2） |
| `WEBDAV_AUTO_MKDIR` | 否 | `1` | `PUT` 时父目录不存在就自动创建，兼容不先 `MKCOL` 的客户端 |
| `WEBDAV_MAX_PUT_SIZE` | 否 | `104857600` | 单次 `PUT` 与分片大小上限（字节），超过会返回 `413` |
| `WEBDAV_MAX_DEPTH_ITEMS` | 否 | `10000` | `PROPFIND` 带 `Depth: infinity` 时最多返回的条目数，超出返回 `507` |
| `WEBDAV_UNZIP_CONCURRENCY` | 否 | `4` | 解压时的并发写入数（1~16）。本地开发环境（miniflare 的 R2 是单文件 SQLite）并发写会争锁、看不出收益，线上 R2 是网络服务、并发能重叠延迟；若实际感觉更慢，设为 `1` 回到串行 |
| `WEBDAV_TRASH` | 否 | `1` | 删除是否进回收站。默认开启；设 `0` 则恢复成「直接删除」 |
| `WEBDAV_TRASH_DAYS` | 否 | `30` | 回收站保留天数，超期在下次访问回收站/删除时自动彻底删除 |
| `WEBDAV_MAX_ZIP_SIZE` | 否 | `1073741824` | 目录 zip 打包的总大小上限（字节） |
| `WEBDAV_MAX_UNZIP_ENTRIES` | 否 | `5000` | 在线解压时允许的 zip 条目总数上限 |
| `WEBDAV_MAX_UNZIP_FILE_SIZE` | 否 | `104857600` | 在线解压时单个文件解压后的大小上限（字节，受运行时内存限制） |
| `DOWNLOAD_SECRET` | 否 | 由账号变量派生 | 下载签名密钥。默认从账号环境变量派生，一般不用配；换掉它会让已签发的下载链接立即失效 |
| `GUEST` | 否 | — | 匿名可写的前缀，逗号分隔；不配则匿名只读 |
| `账号:密码` | 否 | — | 旧版兼容写法：环境变量名直接用 `账号:密码`，值是可写前缀 |

补充说明：

- **权限是路径前缀白名单，读写都受约束**。这是相对旧版的**行为变化**：旧版只限制写权限，本版连读也限制，所以老配置里的 `user1:123456 = user1/,userPublic/` 账号，现在只能读写这两个目录。
- 逗号分隔的列表里，**空项会被忽略**：写 `user1/,` 等价于 `user1/`，不会像旧版那样意外放行全部目录。
- 多账号推荐用 `WEBDAV_USERS`，因为个别环境对「变量名里带冒号」支持不一致。

示例：

```ini
WEBDAV_USERNAME = admin
WEBDAV_PASSWORD = 改成你自己的强密码
WEBDAV_PERMISSIONS = *
WEBDAV_USERS = alice:alicepw:alice/,team/;bob:bobpw:*
WEBDAV_PUBLIC_READ = 0
GUEST = public/,upload/
```

上面的配置含义：`admin` 可以读写全部；`alice` 只能读写 `alice/` 和 `team/`；`bob` 可以读写全部；匿名用户禁止读取，但可以向 `public/` 和 `upload/` 写入。

---

## WebDAV 使用

### 地址与账号

```
https://<你的域名>/webdav
```

用户名、密码就是上面配置的账号（`WEBDAV_USERNAME` / `WEBDAV_PASSWORD`，或 `WEBDAV_USERS` 里的任意一个）。认证方式是 HTTP Basic。

- 根目录：`https://<你的域名>/webdav/`
- 子目录：`https://<你的域名>/webdav/<路径>/`

### 支持的方法

| 方法 | 说明 |
| --- | --- |
| `OPTIONS` | 能力探测，无需认证，返回 `Allow` 与 `DAV: 1, 2` |
| `PROPFIND` | 列举目录、读取属性，支持 `Depth: 0/1/infinity` |
| `PROPPATCH` | 修改属性 |
| `MKCOL` | 新建目录 |
| `GET` / `HEAD` | 下载文件，支持 `Range` 与条件请求 |
| `PUT` | 上传文件 |
| `POST` | 分片上传（`?uploads` 创建、`?uploadId=..` 完成） |
| `COPY` / `MOVE` | 复制 / 移动，靠 `Destination` 头指定目标 |
| `DELETE` | 删除（目录递归删除） |
| `LOCK` / `UNLOCK` | 文件锁，兼容 DAV class 2 |

兼容 **DAV class 1** 与 **DAV class 2**（带锁）。`WEBDAV_LOCKING=1`（默认）时，写操作会校验锁令牌。

### 推荐的客户端

| 平台 | 客户端 |
| --- | --- |
| Windows | 资源管理器「映射网络驱动器」 |
| macOS | Finder「前往 → 连接到服务器」（`⌘K`） |
| 跨平台命令行 | rclone |
| Windows 图形界面 | RaiDrive |
| Android | Cx 文件管理器、Solid Explorer |
| iOS | Documents |

以 Windows 为例：资源管理器 → 右键「此电脑」→ **映射网络驱动器** → 文件夹填 `https://<你的域名>/webdav` → 勾选「使用其他凭据连接」→ 填账号密码。
macOS：Finder 按 `⌘K`，服务器地址填 `https://<你的域名>/webdav`。

### 重要限制：超大文件请用网页端

Cloudflare Workers 对单个请求体有大小上限（免费版约 **100MB**），所以标准 WebDAV 客户端**无法直接上传超大文件**——超过阈值会返回 `413`。

**超大文件请用网页端上传**，网页端会自动走 WebDAV 分片上传（`POST /webdav/{key}?uploads` → 逐片 `PUT` → 合并），不受单请求体上限限制。
分片大小 25MB（R2 要求除最后一片外每片 ≥5MB），单个分片失败会自动重试；
网络中断后重新选同一个文件即可**续传**，不必从头再来。

> **分片与续传只对网页端有效**：分片接口（`POST ?uploads` 等）是 S3 风格的自定义扩展，
> 标准 WebDAV 客户端不会调用，它们只发单次 `PUT`（受 `WEBDAV_MAX_PUT_SIZE` 限制，默认 100MB，超了返回 `413`）。
> 另外，Windows 资源管理器 / macOS Finder 挂载上传大文件时会发**分段 PUT**（`Content-Range`），
> 而 R2 不支持随机写入——本服务会**明确拒绝（501）**并提示改用网页端，
> 而不是逐段覆盖导致文件静默损坏。

`WEBDAV_MAX_PUT_SIZE` 可以调整这个阈值（单位字节，默认 `104857600`，即 100MB）。

### 内部保留目录

`_$flaredrive$/` 是内部保留目录（存放缩略图等），**不会出现在任何列表里**。正常使用不要往里放文件。

---

## API Key 与脚本上传

网页端顶部菜单里有「API 密钥」（需要主账号且拥有全部目录权限），可以直接在界面上生成密钥。
密钥只在生成时显示一次，服务端只保存 SHA-256 摘要，泄露了随时可以吊销；
生成时还可以限定目录范围与有效期，例如只允许写入 `backup/`、90 天后自动失效。

### 密钥怎么带

| 方式 | 示例 |
| --- | --- |
| 自定义头（推荐） | `-H "X-Api-Key: fd_xxxxxxxxxx_yyyy..."` |
| Bearer | `-H "Authorization: Bearer fd_xxxxxxxxxx_yyyy..."` |
| WebDAV 客户端的密码位 | 用户名随便填，密码填密钥（兼容只支持 Basic 的客户端） |

密钥对 `/webdav/*`、`/api/list`、`/api/zip`、`/raw`、`/api/upload` 全部生效：
既能**上传**，也能**读取**（列目录、下载、直链访问），可操作范围就是创建时指定的路径前缀白名单。

### 一行 curl 上传

```bash
# 上传到 backup/ 目录，对象名沿用本地文件名
curl -X POST https://<域名>/api/upload/backup/ \
  -H "X-Api-Key: fd_xxxxxxxxxx_yyyy..." \
  -F "file=@backup.zip"

# 指定完整对象名，原始字节流
curl -X PUT https://<域名>/api/upload/backup/today.bin \
  -H "X-Api-Key: fd_xxxxxxxxxx_yyyy..." \
  --data-binary @today.bin
```

父目录不存在会自动创建；成功返回 `{key, size, uploaded, url}`。
单请求体上限由 `WEBDAV_MAX_PUT_SIZE` 控制（默认 100MB），更大的文件请走网页端分片上传。

### 管理接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/keys` | `GET` | 列出密钥（只返回备注名、前缀提示、权限与时间，拿不回明文） |
| `/api/keys` | `POST` | 创建密钥，body 形如 `{"name":"备份脚本","permissions":"backup/","expiresInDays":90}` |
| `/api/keys/{id}` | `DELETE` | 吊销密钥 |

> 管理密钥要求**主账号且权限为 `*`**，API Key 本身不能用来签发新密钥。
> 密钥记录存在 R2 的内部目录 `_$flaredrive$/` 下，**不需要任何额外环境变量或绑定**。

---

## 目录的数据表示

R2 是对象存储，没有真正的目录。本项目用三种形式表示目录，读取时都能识别：

| 形式 | 说明 |
| --- | --- |
| 目录对象（新格式，推荐） | 一个 key 等于目录路径、`Content-Type: application/x-directory`、大小为 0 的零字节对象 |
| `_$folder$` 标记（旧格式） | key 形如 `X/_$folder$` 的对象，等价于目录 `X`；兼容旧版数据 |
| 纯前缀目录 | 没有任何标记对象，仅由 `X/...` 的子对象隐式形成的目录 |

- 新建目录会写入新格式的目录对象。
- 空目录必须依赖前两种形式之一才能存在（纯前缀目录在子对象被删光后就会消失）。
- **复制 / 移动**时，会把源目录的旧版 `_$folder$` 标记**迁移成新格式**，不会把旧标记带到目标位置。

---

## 权限模型

| 身份 | 可读范围 | 可写范围 |
| --- | --- | --- |
| 匿名用户 | `WEBDAV_PUBLIC_READ=1` 时全部可读；`=0` 时不可读 | `GUEST` 列出的前缀（未配置则不可写） |
| 匿名用户（缩略图） | `_$flaredrive$/thumbnails/` 始终可读（除非关掉 `WEBDAV_PUBLIC_THUMBNAILS`） | — |
| 主账号 | `WEBDAV_PERMISSIONS` 列出的前缀，`*` 为全部 | 同左（读写共用同一份白名单） |
| `WEBDAV_USERS` 多账号 | 每个账号各自的权限列表，`*` 为全部 | 同左 |
| 旧版 `账号:密码` 变量 | 变量值列出的前缀（读写共用同一份白名单） | 同左 |
| 任何已认证账号 | — | `_$flaredrive$/thumbnails/`（不受前缀白名单限制） |

补充规则：

- 权限项是**路径前缀**匹配，例如 `alice/` 表示 `alice/` 及其所有子目录。
- 列目录时：只要账号对目录内任意前缀有权限就允许列举，返回结果会按权限过滤。
- `*` 表示全部目录；`*` 与具体前缀可以混用（如 `*,tmp/`）。

---

## 安全建议

1. **默认就是全私有**：`WEBDAV_PUBLIC_READ` 默认 `0`，匿名访问 `/raw/{key}`、`/webdav/*`、`/api/list`
   一律 `401`——**就算知道完整路径也读不到**。只有 `WEBDAV_PUBLIC_READ=1` 才会整站公开，除非你确实要做公共盘，否则不要开。
2. **公开只能靠分享链接**：点「复制分享链接」生成 `/s/{token}`，匿名只能读到**被分享的那一个文件或那一棵子树**；
   越权路径（`..`、编码绕过、兄弟目录、内部目录）一律 `404`。分享可以随时吊销，吊销后立即失效。
3. **预览 token 的边界**：登录时下发的只读 token 用于让 `<img>` / `<video>` 直链带上凭据
   （省掉每次预览先请求一次签名接口）。它**只对 `/raw` 的 GET/HEAD 生效**——当认证头用、
   或用在 `/api/*`、`/webdav` 上一律 `401`；**只读**，不能写、不能列目录；**不越权**，
   受限账号的 token 读别人的文件同样 `401`；篡改账号名 / 伪造签名 / 过期一律 `401`，有效期 12 小时。
   分享给别人的链接走的仍是**单文件、10 分钟**的短时效签名，不是这个 token。
4. 分享页是只读的：只有预览与下载，没有任何上传/修改/删除入口。
5. **`GUEST` 目录是匿名可写的，匿名也能删除里面的文件**（无法区分访客身份）。不要把重要文件放进 `GUEST` 指定的目录。
5. 缩略图默认不公开：网页端用带认证的请求取回再转 `blob:` URL 显示，不会把内部目录路径暴露给无认证请求。
6. `_$flaredrive$/` 内部目录（锁、API Key、分享记录）**任何身份都不能通过 HTTP 直接读取**。
7. 使用**强密码**；API Key 按最小权限授权并设置有效期；定期在「分享管理」里清理不再需要的分享。
8. 建议绑定自定义域名并加一层 **Cloudflare Access**；不要开启存储桶公开访问 / `r2.dev`。
9. **不要提交任何密钥到仓库**：账号密码只放在 Cloudflare 环境变量里，本地开发用 `.dev.vars`（已忽略）。

---

## 分享链接

在网页端右键任意文件或文件夹 → **复制分享链接**，即会创建（或复用）一条分享并把
`https://<域名>/s/<token>` 写进剪贴板。拿到链接的人不需要登录，只能看到被分享的这一项：

- 分享的是**文件**：直接打开该文件（图片/视频/音频/PDF/文本可在页面内预览，也可下载）。
- 分享的是**目录**：一个只读的浏览页，能进子目录、预览与下载，也能一键「打包下载」整个目录；页面里**没有任何写入口**。
- 顶部菜单 → **分享管理**：列出全部分享，可复制链接、直接打开、或一键吊销。

> 安全设计：token 是 20 位十六进制随机串，服务端只以 token 为文件名存放记录；越权访问、`..`、
> `%2e%2e`、指向兄弟目录或内部目录的请求全部返回 `404`（不区分「不存在」与「无权限」，避免探测）。
> 分享页面带 `X-Robots-Tag: noindex` 与 `Referrer-Policy: no-referrer`，不会被搜索引擎收录。

---

---

## 接口一览

网页端与后端之间的完整契约见 [`docs/API.md`](docs/API.md)，改接口时必须同步更新该文件。常用入口：

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/whoami` | `GET` | 登录状态与能力探测：用户名、权限、是否公开读、是否只读、单次上传上限、是否启用锁、是否 API Key 登录 |
| `/api/list/{path}` | `GET` | 列出目录**直接子项**（不递归），返回 `files` 与 `folders`；无权限 `403`、不存在 `404` |
| `/api/zip/{path}` | `GET` | 把目录（递归）或单个文件打包为 zip 下载；超过 `WEBDAV_MAX_ZIP_SIZE` 返回 `413` |
| `/api/unzip/{zipKey}` | `POST` | 在线解压 zip 到指定目录（`body: {"target":"dir"}`） |
| `/api/compress/{targetKey}` | `POST` | 在线压缩：把选中的文件/文件夹打包成 zip 存回网盘（`body: {"sources":[...]}`） |
| `/api/upload/{path}` | `POST` / `PUT` | 脚本上传接口，支持 API Key；`multipart/form-data` 或原始字节流 |
| `/api/keys` | `GET` / `POST` | 列举 / 创建 API Key（仅主账号） |
| `/api/keys/{id}` | `DELETE` | 吊销 API Key（仅主账号） |
| `/api/shares` | `GET` / `POST` | 列出 / 创建分享链接（需读权限） |
| `/api/shares/{token}` | `DELETE` | 吊销分享（创建者或 `*` 权限账号） |
| `/api/sign` | `GET` | 签发短时效下载直链（需登录），让下载走浏览器原生下载 |
| `/s/{token}` | `GET` | **公开**分享入口：文件直出、目录只读浏览页，`?zip=1` 打包 |
| `/raw/{key}` | `GET` | 直接返回对象字节，支持 `Range` 与条件请求；缩略图带长缓存头 |
| `/webdav/*` | 全部 WebDAV 方法 | WebDAV 服务端，网页端的写操作也走这里，与标准客户端同一套实现 |

所有响应都可能是 `401`（未认证）/ `403`（无权限）/ `404`（不存在）/ `500`（服务端错误）。
认证统一为 HTTP Basic：`Authorization: Basic base64("用户名:密码")`。

---

## 本地开发

```bash
npm install
npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state
```

- `--r2 BUCKET` 在本地模拟 R2 绑定，变量名必须是 `BUCKET`。
- `--persist-to .wrangler/state` 把本地对象持久化到磁盘，重启后数据还在（不写的话每次重启都是空桶）。
- `npm run dev` 等价于 `wrangler pages dev . --r2 BUCKET`。

环境变量有两种传法：

1. **环境变量文件**：在项目根目录建 `.dev.vars`，按 `KEY=VALUE` 一行一个写，`wrangler pages dev` 会自动读取：

   ```ini
   WEBDAV_USERNAME=admin
   WEBDAV_PASSWORD=devpassword
   WEBDAV_PERMISSIONS=*
   WEBDAV_PUBLIC_READ=1
   ```

2. **命令行 `--binding`**：直接追加参数，可重复：

   ```bash
   npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state \
     --binding WEBDAV_USERNAME=admin --binding WEBDAV_PASSWORD=devpassword
   ```

启动后访问 Wrangler 输出的本地地址即可。前端没有构建步骤，改完 `assets/*.vue` 刷新页面就生效。

### 冒烟测试

仓库自带一套 WebDAV / API 冒烟测试（290 项断言，覆盖全部 WebDAV 方法、锁、Range、权限、API Key、旧格式兼容、zip 打包完整性、在线解压/压缩与重名保护、回收站、覆盖保护、预览直链与缓存、全局搜索、分片续传与放弃、分段 PUT 防护、解压进度流等），本地起好服务后直接跑：

```bash
bash scripts/smoke-test.sh
```

它默认使用下面这组测试账号，所有增删改都发生在 `_smoke` 目录内，脚本开始与结束都会自动清理，可以反复执行：

```ini
WEBDAV_USERNAME=admin
WEBDAV_PASSWORD=secret
WEBDAV_USERS=user1:pass1:user1/,public/;user2:pass2:*
GUEST=public/
WEBDAV_PUBLIC_READ=1
```

也可以指定别的地址：`bash scripts/smoke-test.sh https://你的域名`。

### 安全模型测试

上面那套跑的是**公开读模式**；另有一套针对**默认私有模式**的安全测试（分享链接、越权防护、下载签名、PROPFIND 兼容性）：

```bash
# 另起一个私有实例（给独立存储目录，避免与上面实例抢同一个 SQLite）
npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state-private --port 8789 \
  --binding WEBDAV_PUBLIC_READ=0 --binding WEBDAV_PUBLIC_THUMBNAILS=0
bash scripts/security-test.sh http://127.0.0.1:8789
```

### 前端纯函数测试

编辑器的「整理缩进」会直接改写用户的文件，所以「**只动空白、绝不动内容**」这条底线有独立的回归测试。
它不依赖浏览器和任何 npm 包，直接跑：

```bash
node scripts/frontend-test.mjs
```

覆盖：整理缩进的重排与幂等、注释（JSONC）与尾逗号保留、BOM 与 CRLF 保留、
数字写法 / 重复键 / 字符串原文不被改写、缩进风格探测、严格程度判定、缩略图路径摘要与可缩略判定等 48 项断言。

---

## 目录结构

```text
Cloudflare-R2-oss/
├── index.html          # 唯一的 HTML 入口：CDN 加载 Vue 3 / axios / vue3-sfc-loader，
│                       # 在浏览器里加载并挂载 assets/App.vue。无构建步骤，直接部署
├── 404.html            # Pages 的 404 页面
├── robots.txt          # 爬虫规则
│
├── assets/             # 纯静态前端资源，原样发布，不经打包
│   ├── App.vue         # 应用主组件：列表、导航、上传、多选、右键菜单、各弹窗接线
│   ├── LoginDialog.vue # 登录弹窗（HTTP Basic，凭据存 localStorage）
│   ├── FolderPicker.vue# 可导航的目录选择器：移动目标、API Key 授权目录（支持多选）
│   ├── TextEditor.vue  # 在线文本编辑器：语法着色、查找替换、JSON 校验与整理缩进、
│   │                   # Tab/回车自动缩进、换行开关、字号、撤销重做
│   ├── ApiKeys.vue     # API Key 管理：生成、列举、吊销、复制 curl 示例
│   ├── Shares.vue      # 分享管理：列举、复制链接、打开、吊销
│   ├── Trash.vue       # 回收站：恢复 / 彻底删除 / 清空
│   ├── PreviewOverlay.vue # 应用内预览：图片/视频/音频/PDF（带认证取回，不新开窗口）
│   ├── UploadPopup.vue # 上传弹窗：拍照/图片视频/文件/文件夹/新建文件夹
│   ├── Menu.vue        # 下拉菜单（排序、粘贴、登录、API 密钥…）
│   ├── Dialog.vue      # 通用弹窗容器
│   ├── MimeIcon.vue    # 按 MIME 类型渲染文件图标
│   ├── main.mjs        # 前端逻辑模块：认证、请求封装、路径工具、缩略图、分片上传、
│   │                   # 文本类型判定、语言识别与词法着色、JSON 整理缩进
│   ├── main.css        # 样式
│   ├── manifest.json   # PWA manifest
│   ├── favicon.png     # 站点图标
│   └── homescreen.png  # PWA 主屏图标
│
├── functions/          # Pages Functions 后端，文件路径 = URL 路径
│   ├── _middleware.ts  # 全站中间件：屏蔽源码/脚本/文档路径，补安全响应头
│   ├── webdav/         # WebDAV 服务端：OPTIONS/PROPFIND/PROPPATCH/MKCOL/GET/HEAD/
│   │                   # PUT/POST 分片/COPY/MOVE/DELETE/LOCK/UNLOCK
│   ├── api/            # 网页端与脚本接口
│   │   ├── whoami.ts   # 登录状态与能力探测
│   │   ├── list/       # 目录列举（JSON）
│   │   ├── zip/        # 目录打包下载
│   │   ├── unzip/      # 在线解压 zip 到指定目录
│   │   ├── trash/      # 回收站：列表 / 恢复 / 彻底删除 / 清空
│   │   ├── exists.ts   # 上传前的同名预检
│   │   ├── search.ts   # 全局搜索（跨目录递归，按权限过滤）
│   │   ├── compress/   # 在线压缩：选中文件/文件夹打包成 zip 存回网盘
│   │   ├── upload/     # 给脚本用的上传接口，支持 API Key
│   │   ├── keys/       # API Key 的创建 / 列举 / 吊销
│   │   ├── shares/     # 分享链接的创建 / 列举 / 吊销
│   │   └── sign/       # 下载直链签名（私有模式下让浏览器原生下载）
│   ├── s/              # 公开分享入口（唯一允许匿名读内容的通道）
│   └── raw/            # 对象字节直出：Range、条件请求、缩略图缓存头（需认证）
│
├── utils/              # 后端共享模块
│   ├── config.ts       # 环境变量与常量：前缀、各类上限、功能开关
│   ├── auth.ts         # 账号解析、Basic 认证、API Key 接入、权限判定入口
│   ├── permissions.ts  # 路径规范化和前缀白名单判定（被 auth / apikey 共用）
│   ├── apikey.ts       # API Key 存储与校验（只存 SHA-256 摘要）
│   ├── bucket.ts       # 路由前缀解析、桶选择、统一错误响应
│   ├── core.ts         # R2 文件系统层：列举 / 探测 / 写入 / 复制 / 递归删除
│   ├── lock.ts         # WebDAV 锁存储（锁记录放在 R2 内部目录，跨实例可见）
│   ├── share.ts        # 分享链接存储与越权防护（resolveSharePath）
│   ├── sharepage.ts    # 分享页：只读浏览页 + 预览/下载（自包含，含内联 JSON）
│   ├── serve.ts        # Range 与条件请求输出、目录 HTML 浏览页
│   ├── zip.ts          # 零依赖流式 ZIP 写入器（store 模式）
│   ├── zipserve.ts     # 打包下载（/api/zip 与分享 ?zip=1 共用）
│   ├── trash.ts        # 回收站：软删除记录、恢复、彻底删除、过期清理
│   ├── trashindex.ts   # 回收站索引与「是否被回收」的判定（供 core 层过滤用）
│   ├── zipmake.ts      # 在线压缩：多源收集 + R2 分片上传写回
│   ├── unzip.ts        # 在线解压：R2 Range 读 zip 索引 + 逐条解压写回
│   ├── inflate.ts      # 零依赖 DEFLATE 解压器（在线解压用）
│   └── xml.ts          # XML 转义、multistatus 构造、请求体解析
│
├── docs/
│   └── API.md          # 网页端与后端的接口契约（冻结文件，改动需同步）
│
├── scripts/
│   ├── smoke-test.sh    # WebDAV / API 冒烟测试（公开读模式），290 项断言
│   ├── security-test.sh # 安全模型测试（默认私有模式），90 项断言
│   └── frontend-test.mjs # 前端纯函数测试（JSON 整理缩进等内容安全底线），48 项断言
│
├── package.json        # 没有任何运行时依赖；开发依赖只有 wrangler
├── tsconfig.json       # TypeScript 配置，仅供编辑器类型提示，不参与构建
└── .gitignore          # 忽略 .wrangler/、.dev.vars 等本地文件
```

---

## 致谢与许可

- 上游项目：[longern/FlareDrive](https://github.com/longern/FlareDrive)（MIT）——WebDAV 服务端与 R2 数据模型的基础。
- WebDAV 部分参考：[abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav)。
- 汉化分支：[wulalala66/Cloudflare-R2-oss](https://github.com/wulalala66/Cloudflare-R2-oss)——无构建前端、中文界面与多账号按目录授权。

本项目以 **MIT** 许可发布。
