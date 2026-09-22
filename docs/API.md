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

- `files[].thumbnail` 为 `null` 时前端用 MIME 图标。
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

## 5. `GET /raw/{key}`

- 直接返回对象字节，支持 `Range` 与条件请求。
- 匿名可读的条件：开启公开读，或 key 属于 `_$flaredrive$/thumbnails/`（缩略图默认始终公开，便于 `<img>` 直接引用）。
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
