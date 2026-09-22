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
| 文件管理 | 浏览、上传、下载、重命名、移动、复制、删除（目录递归删除）、新建文件夹 |
| 上传 | 拖拽上传、文件夹拖入、大文件分片上传、上传进度与并发控制 |
| 预览 | 图片、视频缩略图，PDF 缩略图，无缩略图时按 MIME 类型显示图标 |
| 批量操作 | 多选文件与目录，批量移动、复制、删除、下载 |
| 浏览体验 | 搜索当前目录、按名称/大小排序、面包屑导航、当前目录写进 URL（可前进后退/分享定位） |
| 权限感知 | 无写权限的账号自动进入只读模式：隐藏上传与改动入口，列表上标注「只读」 |
| 打包下载 | 目录一键递归打包为 zip 下载 |
| WebDAV | 标准 WebDAV 服务端，Windows / macOS / rclone 等客户端可直接挂载，支持锁（class 2） |
| 权限 | 多账号，每个账号按**路径前缀白名单**授权，读写都受约束 |
| 分享 | 公开只读分享（匿名可读），根目录 HTML 浏览页 |

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

---

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BUCKET` | 是（R2 绑定） | — | R2 存储桶绑定，变量名必须是 `BUCKET` |
| `WEBDAV_USERNAME` | 推荐 | — | 主账号用户名 |
| `WEBDAV_PASSWORD` | 推荐 | — | 主账号密码 |
| `WEBDAV_PERMISSIONS` | 否 | `*` | 主账号可访问的路径前缀，逗号分隔；`*` 表示全部 |
| `WEBDAV_USERS` | 否 | — | 多账号，格式 `用户名:密码:权限1,权限2;用户名2:密码2:*` |
| `WEBDAV_PUBLIC_READ` | 否 | `1` | `1` 允许匿名读取，`0` 必须登录才能读 |
| `WEBDAV_PUBLIC_THUMBNAILS` | 否 | `1` | `1` 缩略图始终可匿名引用（否则登录后网页缩略图会碎图） |
| `WEBDAV_LOCKING` | 否 | `1` | 启用 `LOCK`/`UNLOCK` 与写操作锁校验（DAV class 2） |
| `WEBDAV_AUTO_MKDIR` | 否 | `1` | `PUT` 时父目录不存在就自动创建，兼容不先 `MKCOL` 的客户端 |
| `WEBDAV_MAX_PUT_SIZE` | 否 | `104857600` | 单次 `PUT` 与分片大小上限（字节），超过会返回 `413` |
| `WEBDAV_MAX_DEPTH_ITEMS` | 否 | `10000` | `PROPFIND` 带 `Depth: infinity` 时最多返回的条目数，超出返回 `507` |
| `WEBDAV_MAX_ZIP_SIZE` | 否 | `1073741824` | 目录 zip 打包的总大小上限（字节） |
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

`WEBDAV_MAX_PUT_SIZE` 可以调整这个阈值（单位字节，默认 `104857600`，即 100MB）。

### 内部保留目录

`_$flaredrive$/` 是内部保留目录（存放缩略图等），**不会出现在任何列表里**。正常使用不要往里放文件。

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

1. **默认 `WEBDAV_PUBLIC_READ=1` 是继承旧版行为——任何人都能读你的所有文件。**
   如果存放私密文件，请务必把它设为 `0`，这样访问任何内容都需要登录。
2. **`GUEST` 目录是匿名可写的，匿名也能删除里面的文件**（与旧版语义一致，因为无法区分访客身份）。不要把重要文件放进 `GUEST` 指定的目录。
3. `WEBDAV_PUBLIC_THUMBNAILS=1` 会让缩略图目录匿名可读。缩略图本身可能泄露文件名/内容信息，介意的话设为 `0`（代价是登录后网页缩略图会碎图）。
4. 使用**强密码**，不要用 `123456` 之类的弱口令；不要多个账号共用密码。
5. 建议给 Pages 绑定**自定义域名**，并在前面加一层 **Cloudflare Access**（Zero Trust）做额外身份校验，避免站点被公开扫描。
6. 遵循最小权限：能只给某个子目录就别给 `*`。
7. **不要提交任何密钥到仓库**：账号密码只放在 Cloudflare 的环境变量里，本地开发用 `.dev.vars`（已在 `.gitignore` 中忽略）。
8. 不要开启存储桶的公开访问 / `r2.dev` 公共域名，本项目不需要它。

---

## 接口一览

网页端与后端之间的完整契约见 [`docs/API.md`](docs/API.md)，改接口时必须同步更新该文件。常用入口：

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/whoami` | `GET` | 登录状态与能力探测：用户名、权限、是否公开读、是否只读、单次上传上限、是否启用锁 |
| `/api/list/{path}` | `GET` | 列出目录**直接子项**（不递归），返回 `files` 与 `folders`；无权限 `403`、不存在 `404` |
| `/api/zip/{path}` | `GET` | 把目录（递归）或单个文件打包为 zip 下载；超过 `WEBDAV_MAX_ZIP_SIZE` 返回 `413` |
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

仓库自带一套 WebDAV / API 冒烟测试（140 项断言，覆盖全部 WebDAV 方法、锁、Range、权限、旧格式兼容、zip 打包等），本地起好服务后直接跑：

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
│   ├── App.vue         # 应用主组件：列表、导航、上传、多选、WebDAV 请求封装
│   ├── Menu.vue        # 右键/操作菜单（重命名、移动、复制、删除、下载…）
│   ├── Dialog.vue      # 通用弹窗
│   ├── UploadPopup.vue # 上传弹窗：拖拽、分片、进度
│   ├── MimeIcon.vue    # 按 MIME 类型渲染文件图标
│   ├── main.mjs        # 前端逻辑模块，被 App.vue 引用
│   ├── main.css        # 样式
│   ├── manifest.json   # PWA manifest
│   ├── favicon.png     # 站点图标
│   └── homescreen.png  # PWA 主屏图标
│
├── functions/          # Pages Functions 后端，文件路径 = URL 路径
│   ├── webdav/         # WebDAV 服务端：OPTIONS/PROPFIND/PROPPATCH/MKCOL/GET/HEAD/
│   │                   # PUT/POST 分片/COPY/MOVE/DELETE/LOCK/UNLOCK
│   ├── api/            # 网页端 JSON 接口：whoami、list、zip
│   └── raw/            # 对象字节直出：Range、条件请求、缩略图缓存头
│
├── utils/              # 后端共享模块
│   ├── config.ts       # 环境变量与常量：前缀、各类上限、功能开关
│   ├── auth.ts         # 账号解析、Basic 认证、路径前缀权限判定
│   ├── bucket.ts       # 路由前缀解析、桶选择、统一错误响应
│   ├── core.ts         # R2 文件系统层：列举 / 探测 / 写入 / 复制 / 递归删除
│   ├── lock.ts         # WebDAV 锁存储（锁记录放在 R2 内部目录，跨实例可见）
│   ├── serve.ts        # Range 与条件请求输出、目录 HTML 浏览页
│   └── xml.ts          # XML 转义、multistatus 构造、请求体解析
│
├── docs/
│   └── API.md          # 网页端与后端的接口契约（冻结文件，改动需同步）
│
├── scripts/
│   └── smoke-test.sh   # WebDAV / API 冒烟测试，140 项断言
│
├── package.json        # 运行依赖：fflate（目录打包）；开发依赖：wrangler
├── tsconfig.json       # TypeScript 配置，仅供编辑器类型提示，不参与构建
└── .gitignore          # 忽略 .wrangler/、.dev.vars 等本地文件
```

---

## 致谢与许可

- 上游项目：[longern/FlareDrive](https://github.com/longern/FlareDrive)（MIT）——WebDAV 服务端与 R2 数据模型的基础。
- WebDAV 部分参考：[abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav)。
- 汉化分支：[wulalala66/Cloudflare-R2-oss](https://github.com/wulalala66/Cloudflare-R2-oss)——无构建前端、中文界面与多账号按目录授权。

本项目以 **MIT** 许可发布。
