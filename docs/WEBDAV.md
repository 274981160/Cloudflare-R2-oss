# WebDAV 兼容性与使用说明

本文面向两个读者：想用第三方客户端（Windows 资源管理器、RaiDrive、rclone、
Cyberduck、手机文件管理器等）连这个网盘的人，以及想确认"WebDAV 到底支持到什么
程度"的人。

## 一、连接信息

| 项 | 值 |
| --- | --- |
| 服务地址 | `https://你的域名/webdav`（注意带 `/webdav` 前缀） |
| 协议 | RFC 4918（Class 1 + 2，支持 LOCK/UNLOCK） |
| 认证 | HTTP Basic：用户名 + 密码（与网页登录一致） |
| 备选凭据 | API Key 也可当密码用（用户名随意填，密码位填 `fd_...` 密钥） |

一个账号能否读写某个目录由它的权限前缀决定（`WEBDAV_USERS` 里配置），
超权读写一律 401/403，目录列表会自动过滤无权限的条目。

## 二、已验证可用的客户端

- **Windows 文件资源管理器**（映射网络驱动器）——需注意 Windows 对 Basic 认证
  over HTTP 默认关闭，HTTPS 下正常；个别版本要改注册表
  `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`
  的 `BasicAuthLevel`（本服务在 HTTPS 后无此问题）。
- **RaiDrive**
- **Cyberduck / WinSCP**
- **rclone**（`rclone config` 选 webdav，vendor 留空或选 other）
- **macOS Finder**（前往 → 连接服务器）
- **iOS「文件」App / ES 文件浏览器 / Solid Explorer**（Android）

> 没列出的客户端不代表不能用：本实现按 RFC 4918 走，标准行为都有。
> 遇到问题先看第三节「行为细节」，很多差异源于客户端的激进假设。

## 三、行为细节（客户端作者与排障需要知道的）

### 删除（DELETE）

- **默认进回收站**：`DELETE` 只写一条回收站记录、内容原地隐藏，瞬间完成，
  返回 `204` 并带 `X-FlareDrive-Trash: {id}` 头；恢复/彻底删除走网页端回收站。
  配 `WEBDAV_TRASH=0` 可关闭（关闭后是真删除，大目录会递归逐个删）。
- **幂等**：删除已删除/已回收的路径返回 `204` 而不是 404。批量删除时客户端
  对同一路径的重复请求、并发请求都不会把整批任务标成失败。真正不存在的路径
  仍返回 404。
- 已在回收站里的路径不允许被再次"硬删"（那是回收站里的「彻底删除」），
  返回 409。

### 上传（PUT）

- 单次 PUT 上限默认 **100MB**（`WEBDAV_MAX_PUT_SIZE` 可调，配额随部署平台调整），
  超限返回 `413`。大文件请用网页端上传（分片、断点续传）。
- **分片续传是网页端专有能力**（`?uploads` 分片协议），WebDAV 客户端用不上，
  也不会自动获得——这是平台限制，不是客户端配置问题。
- 往一个"已删除但还没从回收站清理"的同名文件夹里写文件是允许的：新文件正常
  可见，旧内容仍被回收站藏住，互不影响。
- Windows 资源管理器上传时会先写 `Desktop.ini`、Thumbs.db 一类文件——目前没有
  特判拦截，建议在客户端侧关掉"隐藏系统文件"或忽略这些上传失败。

### 分段 PUT（Content-Range）

`PUT` 携带 `Content-Range` 的部分写入会被拒绝并返回 `501`（允许
`bytes 0-(size-1)/size` 的"整文件声明"通过）。这是刻意行为：R2 对象不可随机写，
部分写入历史上会造成文件静默截断损坏。需要断点续传请用网页端。

### 读取与列出（GET / PROPFIND）

- `PROPFIND` 支持 `Depth: 0/1`；`Depth: infinity` 列整棵子树（受
  `WEBDAV_MAX_DEPTH_ITEMS` 上限保护）。
- 大文件 GET 支持 `Range`/`If-Range`（206/416），视频拖动播放、下载器断点
  都依赖它。
- 私有模式下所有读取都要认证；公开读模式（`WEBDAV_PUBLIC_READ=1`）下匿名可读。

### 移动 / 复制（MOVE / COPY）

- 目标用 `Destination` 头（本站 `/webdav/` 下的绝对 URL）。
- `MOVE` = 复制 + 删除源；源清理失败会如实返回 4xx，不会静默留下两份。
- 覆盖已有目标时，旧内容自动进回收站（与网页端覆盖保护同一套逻辑），
  `Overwrite: F` 时目标已存在返回 `412`。

### 锁（LOCK / UNLOCK）

Class 2 锁已实现（`WEBDAV_LOCKING=1` 默认开启），Windows 映射驱动器等需要
锁的客户端可用。锁是软锁：到期自动失效，`UNLOCK` 即时释放。

### 登录限流

同一 IP+用户名 的认证失败会累积：15 分钟窗口内前 5 次免惩罚，之后每次要求
指数递增的等待（封顶 15 分钟），期间**正确密码也会被拒**并带 `Retry-After` 头。
写自动化脚本时遇到 `401 + Retry-After` 请按头等待，不要加重试风暴。

## 四、环境变量速查（与 WebDAV 相关）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | - | 主账号 |
| `WEBDAV_USERS` | - | 多账号 `user:pass:perm;...` |
| `WEBDAV_PERMISSIONS` | `*` | 主账号权限前缀 |
| `WEBDAV_PUBLIC_READ` | `0` | 匿名可读 |
| `WEBDAV_TRASH` | `1` | 删除进回收站；`0` = 真删除 |
| `WEBDAV_TRASH_DAYS` | `30` | 回收站保留天数 |
| `WEBDAV_MAX_PUT_SIZE` | 100MB | 单次 PUT 上限 |
| `WEBDAV_MAX_ZIP_SIZE` | 1GB | 打包下载上限 |
| `WEBDAV_MAX_DEPTH_ITEMS` | - | 子树列出的条目上限 |
| `WEBDAV_LOGIN_THROTTLE` | `1` | 登录限流开关 |

## 五、排障速查

| 现象 | 大概率原因 |
| --- | --- |
| 401 但密码正确 | 触发了登录限流（看响应头 `Retry-After`），等一会儿再试 |
| PUT 413 | 单文件超过 100MB，用网页端传 |
| PUT 501 | 客户端在发 Content-Range 分段写；换网页端或让客户端整文件上传 |
| 删除后空间没释放 | 回收站还留着（默认 30 天）；网页端回收站里彻底删除 |
| 删除时报 409 | 目标在回收站里，去回收站恢复或彻底删除后再操作 |
| Windows 映射驱动器连不上 | 确认走 HTTPS；确认 WebClient 服务已启动 |
