# FlareDrive R2 API 契约 v1

本文件是网页端与后端之间的冻结接口。任何一方改动都必须同步更新本文件。

## 0. 基本约定

- 所有路径都是 **R2 对象键（key）**，**不带前导斜杠**。根目录用空串 `""` 表示。
- URL 中的路径按 `/` 分段，每段单独做 `encodeURIComponent`。
- 目录（collection）在 R2 中用「目录对象」表示：key = 目录路径，`Content-Type: application/x-directory`，size 0。
- 兼容旧数据：key 形如 `X/_$folder$` 的对象等价于目录 `X`；只由子对象隐式形成的 `X/` 前缀也算目录。
- 内部保留目录 `_$flaredrive$/` 不出现在任何列表里。
- 认证：HTTP Basic。请求头 `Authorization: Basic base64("用户名:密码")`。
- 所有响应都可能是 `401`（未认证）/`403`（无权限）/`404`/`500`。

## 1. `GET /api/whoami`

永远返回 200，用于登录状态与能力探测。

```json
{
  "authenticated": true,
  "username": "admin",
  "permissions": ["*"],
  "publicRead": true,
  "readOnly": false,
  "canWriteAny": true,
  "maxUploadSize": 104857600,
  "locking": true,
  "version": "1.0.0"
}
```

- `permissions`：该账号可访问的路径前缀数组，`["*"]` 表示全部。
- `publicRead`：匿名可读。
- `canWriteAny`：该账号是否有任何写权限（前端据此决定是否显示上传按钮）。
- `maxUploadSize`：单次 PUT 允许的最大字节数（超过要走分片）。

## 2. `GET /api/list/{path}`

列出目录**直接子项**（不递归）。`/api/list/` 或 `/api/list` 表示根目录。

```json
{
  "path": "a/b",
  "canRead": true,
  "canWrite": true,
  "files": [
    {
      "key": "a/b/c.txt",
      "name": "c.txt",
      "size": 123,
      "uploaded": "2026-01-01T00:00:00.000Z",
      "etag": "abc",
      "contentType": "text/plain",
      "thumbnail": "/raw/_$flaredrive$/thumbnails/<sha1>.png",
      "writable": true
    }
  ],
  "folders": [{ "key": "a/b/sub", "name": "sub", "writable": true }]
}
```

- `files[].thumbnail` 是**缩略图摘要**（sha1 十六进制）或 `null`。
  缩略图 URL 为 `/raw/_$flaredrive$/thumbnails/{thumbnail}.png`，**需要认证**，
  前端要带认证头取回后转成 `blob:` URL 再给 `<img>` 用；不要直接把它塞进 `src`。
  返回摘要而不是完整 URL，就是为了避免把内部目录路径泄露到无认证的引用里。
- 目录不存在（既不是目录对象，也没有任何子对象）→ `404`。
- 无读权限 → `403`；未认证且未开公开读 → `401`。

## 3. 写操作（走 WebDAV，与标准客户端同一套实现）

前端对 `/webdav/{key}` 发起真实 WebDAV 请求，并同样带 Basic 认证头。

| 操作 | 请求 | 成功响应 |
| --- | --- | --- |
| 新建文件夹 | `MKCOL /webdav/{folder}` | `201` |
| 上传小文件（< maxUploadSize） | `PUT /webdav/{key}`，body 为文件，`Content-Type`，可选 `fd-thumbnail: <sha1>` | `201` |
| 分片上传-创建 | `POST /webdav/{key}?uploads` | `200` `{"key":"...","uploadId":"..."}` |
| 分片上传-单片 | `PUT /webdav/{key}?uploadId=..&partNumber=N`，body 为分片 | `200`，响应头 `etag` |
| 分片上传-完成 | `POST /webdav/{key}?uploadId=..`，body `{"parts":[{"partNumber":1,"etag":"..."}]}` | `200` |
| 删除 | `DELETE /webdav/{key}` | `204`（目录递归删除） |
| 移动 | `MOVE /webdav/{src}`，头 `Destination: <绝对 URL，指向 /webdav/{dst}>` | `201`/`204` |
| 复制 | `COPY /webdav/{src}`，头同上 | `201`/`204` |
| 上传缩略图 | `PUT /webdav/_$flaredrive$/thumbnails/{sha1}.png` | `201` |

- 分片大小固定 `100 * 1000 * 1000` 字节，并发 2。
- 任何账号（已认证）都可写 `_$flaredrive$/thumbnails/`。
- MOVE/COPY 的 `Destination` 必须是同源 `/webdav/` 下的绝对 URL。

## 4. `GET /api/zip/{path}`

- 目录：递归打包为 zip，`Content-Type: application/zip`，`Content-Disposition: attachment; filename="<目录名>.zip"`。
- 文件：单个文件打成 zip。
- 需要在请求头带认证；前端用 `fetch` + Blob 触发下载。
- 超过 `WEBDAV_MAX_ZIP_SIZE` 返回 `413`。
- 打包是小对象并发预取（默认 8 个批次 + 1MB 以下整读），文件夹里很多小文件时下载明显更快。

## 4.1 `POST /api/unzip/{zipKey}` — 在线解压

把网盘里的 zip 解压到指定目录（默认解到 zip 所在目录）。需要认证，
zip 本身要可读，落盘位置要可写；恶意条目名（`..` 跳级、绝对路径）会被拒绝。

```json
// 请求体（可选）；target 是想解压到的目标目录 key
// mode: check=只查同名冲突不写盘；skip=跳过同名（默认）；overwrite=覆盖同名
{ "target": "docs/out", "mode": "skip" }
```

- 响应 `200`（解压）：
  ```json
  { "target": "docs/out", "files": 12, "skipped": 3, "errors": [] }
  ```
- `mode: "check"` 只做预检、不写任何东西，用于先问用户「跳过还是覆盖」：
  ```json
  { "target": "docs/out", "total": 15, "conflictCount": 3, "conflicts": ["a.txt", "b/c.md"] }
  ```
- `mode` 默认 `skip`：目标里已存在的同名文件会被跳过并计入 `skipped`，
  **不会静默覆盖**；目录对象与目录条目不算冲突。非法 mode 按 `skip` 处理。
- `errors` 数组收集个别失败条目（如不支持的压缩算法、超限）；整体不是合法 zip 返回 `400`。
- 上限：`WEBDAV_MAX_UNZIP_ENTRIES`（默认 5000 条）、`WEBDAV_MAX_UNZIP_FILE_SIZE`（默认 100MB/条）。
- 只支持 store 与 deflate（zip 最常用的两种）；ZIP64 / 多盘暂不支持。

## 4.2 `POST /api/compress/{targetZipKey}` — 在线压缩

把选中的若干文件/文件夹打包成一个 zip 存回网盘（不下载）。需要认证，
目标 key 要可写，每个源要可读。

```json
{ "sources": ["docs/a.txt", "docs/归档目录"] }
```

- 目标 key 会带上 JSON 里的 `sources` 对应的顶层名字，例如上面会生成
  `docs/归档目录/... 与 docs/a.txt`。
- 响应 `200`：
  ```json
  { "key": "docs/打包.zip", "size": 10240, "count": 5 }
  ```
- 打包体积超过 `WEBDAV_MAX_ZIP_SIZE` 返回 `413`；无权限返回 `403`。
- 通过 R2 分片上传实现，不把整包读进内存。

## 5. `GET /raw/{key}`

- 直接返回对象字节，支持 `Range` 与条件请求。
- **默认需要认证**：只有开启 `WEBDAV_PUBLIC_READ=1` 时才允许匿名读取，
  或者把 key 交给分享链接（`/s/{token}`）去公开。缩略图同样默认不公开
  （`WEBDAV_PUBLIC_THUMBNAILS=1` 才放行 `_$flaredrive$/thumbnails/`）。
- `_$flaredrive$/` 下的非缩略图内容（锁、密钥、分享记录）**任何情况下都不允许匿名读取**。
- `_$flaredrive$/thumbnails/` 带 `Cache-Control: max-age=31536000`。

## 6. `/webdav/*` 认证与权限

- `OPTIONS` 不需要认证，返回 `Allow` 与 `DAV: 1, 2`。
- `GET`/`HEAD`/`PROPFIND` 在公开读开启时可匿名访问。
- 其他方法必须认证。
- 账号权限是路径前缀白名单，读写都受约束；`*` 表示全部。
- 写 `_$flaredrive$/thumbnails/` 不受前缀白名单限制（已认证即可）。
- 目录列表：只要账号对目录内任意前缀有权限就允许列目录，返回结果按权限过滤。

## 7. HTTP 状态码约定

| 码 | 含义 |
| --- | --- |
| 200 / 201 / 204 | 成功 |
| 207 | PROPFIND / PROPPATCH 多状态 |
| 401 | 未认证（带 `WWW-Authenticate`） |
| 403 | 已认证但无权限 |
| 404 | 对象/目录不存在 |
| 405 | 方法不允许（如对已存在资源 MKCOL） |
| 409 | 父目录不存在 |
| 412 | 条件请求失败 / `Overwrite: F` 且目标存在 |
| 413 | 超过大小上限 |
| 423 | 资源被锁定且未提供锁令牌 |
| 507 | 深度遍历超过条目上限 |

## 8. API Key（生成式密钥）

用于给脚本 / 第三方程序上传，而不必交出主账号密码。密钥只在创建时明文返回一次，
服务端只保存 SHA-256 摘要。

密钥格式：`fd_<id>_<secret>`，其中 `id` 为 10 位十六进制，`secret` 为 32 位十六进制。

### 携带方式（任选其一）

| 方式 | 示例 |
| --- | --- |
| 自定义头 | `X-Api-Key: fd_xxxxxxxxxx_yyyy...` |
| Bearer | `Authorization: Bearer fd_xxxxxxxxxx_yyyy...` |
| Basic 密码位 | `Authorization: Basic base64("apikey:fd_xxxxxxxxxx_yyyy...")` |

第三种是为了兼容只支持 Basic 的 WebDAV 客户端：用户名随便填，密码填密钥即可。
密钥对 `/webdav/*`、`/api/list`、`/api/zip`、`/raw`、`/api/upload` 全部生效，
权限就是创建该密钥时指定的路径前缀白名单。

### `GET /api/keys`

列出全部密钥（不含明文，也不能反推）。需要**主账号**且权限含 `*`。
API Key 本身没有管理密钥的权限。

```json
{
  "keys": [
    {
      "id": "a1b2c3d4e5",
      "name": "备份脚本",
      "hint": "fd_a1b2c3d4e5",
      "permissions": ["backup/"],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastUsedAt": "2026-01-02T03:04:05.000Z",
      "expiresAt": null,
      "createdBy": "admin"
    }
  ]
}
```

### `POST /api/keys`

创建密钥，需要**主账号**且权限含 `*`。请求体：

```json
{ "name": "备份脚本", "permissions": "backup/,public/", "expiresInDays": 90 }
```

- `name`：备注名，必填。
- `permissions`：字符串（逗号分隔）或数组，默认 `*`。
- `expiresInDays`：可选，正整数，不填表示永不过期。

响应 `201`：

```json
{
  "id": "a1b2c3d4e5",
  "key": "fd_a1b2c3d4e5_0123456789abcdef0123456789abcdef",
  "name": "备份脚本",
  "permissions": ["backup/", "public/"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": null
}
```

**`key` 字段只在此响应中出现一次，请立即保存。**

### `DELETE /api/keys/{id}`

吊销密钥。需要**主账号**且权限含 `*`。成功返回 `204`，不存在返回 `404`。

## 9. `POST /api/upload/{path}`

给脚本用的上传接口，支持 API Key 认证。

- `{path}` 以 `/` 结尾（或以 `/api/upload/` 空路径调用）时，使用上传文件名作为对象名，
  落到该目录下；否则把 `{path}` 当作完整对象键。
- 请求体二选一：
  - `multipart/form-data`，文件字段名 `file`（也接受任意单文件字段）；
  - 原始字节流，此时对象名必须由路径给出。
- 需要该路径的写权限（按账号或密钥的前缀白名单判定）。
- 父目录不存在时会自动创建。
- 响应 `201`：

```json
{
  "key": "backup/2026-01-01.zip",
  "size": 1048576,
  "uploaded": "2026-01-01T00:00:00.000Z",
  "url": "/raw/backup/2026-01-01.zip"
}
```

示例：

```bash
curl -X POST https://<域名>/api/upload/backup/ \
  -H "X-Api-Key: fd_xxxxxxxxxx_yyyyyyyy" \
  -F "file=@backup.zip"

curl -X PUT https://<域名>/webdav/backup/raw.bin \
  -H "X-Api-Key: fd_xxxxxxxxxx_yyyyyyyy" \
  --data-binary @raw.bin
```

## 10. 分享链接（唯一允许匿名读取的通道）

**默认全站私有**：`WEBDAV_PUBLIC_READ` 默认 `0`，`WEBDAV_PUBLIC_THUMBNAILS` 默认 `0`。
也就是说匿名访问 `/raw/{key}`、`/webdav/*`、`/api/list` **一律 401**，直接猜路径也拿不到任何内容。
只有通过分享链接才能匿名读取，且**只能读到被分享的那一个对象或那一棵子树**。

### `POST /api/shares`

需要认证，且调用者对被分享的 key 必须有读权限。请求体：

```json
{ "key": "photos/2026", "expiresInDays": 30 }
```

- `key`：要分享的文件或目录的对象键（目录不带尾斜杠）。
- `expiresInDays`：可选，正整数；不填表示长期有效。
- 同一个 key 已有分享且未过期时，直接返回既有的那条（`200`），不会重复创建；
  新建返回 `201`。

```json
{
  "token": "s_9f2c1ab34d5e6f708192",
  "key": "photos/2026",
  "type": "folder",
  "url": "/s/s_9f2c1ab34d5e6f708192",
  "absoluteUrl": "https://<域名>/s/s_9f2c1ab34d5e6f708192",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "createdBy": "admin",
  "expiresAt": null
}
```

`type` 为 `file` 或 `folder`，由服务端探测得出。

### `GET /api/shares`

列出分享。普通账号只能看到自己创建的；权限为 `*` 的账号能看到全部。

```json
{ "shares": [ { "token": "...", "key": "...", "type": "folder", "createdAt": "...", "createdBy": "admin", "expiresAt": null, "url": "/s/..." } ] }
```

### `DELETE /api/shares/{token}`

吊销分享，立即失效。需要认证：创建者本人，或权限为 `*` 的账号。成功 `204`，不存在 `404`。

### `GET /s/{token}` 与 `GET /s/{token}/{相对路径}`

**匿名可访问**（这是唯一例外），无需任何认证头。

- token 不存在或已过期 → `404`（不区分「不存在」与「已过期」，避免探测）。
- 分享的是文件：只能访问 `/s/{token}` 本身，返回内容，支持 `Range` 与条件请求；
  带 `?download=1` 时强制下载。
- 分享的是目录：`/s/{token}` 返回一个只读的 HTML 目录页（只列出该目录下的内容）；
  `/s/{token}/子路径` 可以继续访问该目录下的文件或子目录。
- **越权防护**：解析后的对象键必须等于被分享的 key，或位于 `被分享key + "/"` 之下，
  否则一律 `404`。任何 `..` 段、绝对路径、指向 `_$flaredrive$/` 的路径都会被拒绝。
- `/s/{token}?zip=1`：把被分享的目录打包成 zip 下载。

## 11. 下载直链签名

私有模式下浏览器直链带不上认证头，前端只能「先取回整文件再存成 Blob」——
既没有进度，又可能被浏览器（尤其 Safari）在异步之后拦掉下载。
所以这里签发**短时效签名直链**，让下载走浏览器原生下载（有进度条、立刻弹保存框）。

### `POST /api/shares` 的有效期

```json
{ "key": "docs/a.txt", "expiresInDays": 7 }
```

- `expiresInDays`：正整数 = 多少天；`null` / 空串 / `0` = 永久；非法值 `400`。
- **不带**该字段时不改动已有分享；带了就会按请求更新（同一个 key 同一条记录，
  不会新增），所以「给已有分享改成 7 天」或「改回永久」都会生效。
- 到期后 `/s/{token}` 一律 404。

### `GET /api/sign?key={key}&ttl={秒}`

需要认证，且调用者对被签的 key 有读权限。`ttl` 可选，范围 60–3600 秒，默认 600。

```json
{
  "key": "photos/2026/a.jpg",
  "isDirectory": false,
  "url": "/raw/photos/2026/a.jpg?exp=1790080000&sig=9f2c...",
  "expiresAt": "2026-01-01T00:10:00.000Z"
}
```

目录会签成 `/api/zip/{key}?exp=..&sig=..`，拿到就能直接打包下载。
服务端没有可用密钥时返回 `501`（前端会退回「取回 Blob」的方式）。

### 签名如何生效

`GET /raw/{key}?exp=..&sig=..` 与 `GET /api/zip/{key}?exp=..&sig=..` 接受签名作为
**替代认证**：签名有效即可匿名访问，且**只对签名里那一个 key（或那棵子树）有效**。

- 签名 = `HMAC-SHA256(secret, "{key}\n{exp}")`，密钥取 `DOWNLOAD_SECRET`，
  没配则由账号相关环境变量派生（同一份变量在所有实例上结果一致）。
- 过期、篡改、缺参数、把签名用到别的对象上一律 `401`，比较用定长比较。
- 签名是**读**权限，且只能读被签的那一项；它不会通过权限白名单的其它检查。

