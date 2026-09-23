/**
 * 运行时配置：全部通过 Pages 环境变量读取，未配置时给出安全且合理的默认值。
 */

/** Pages 环境变量与绑定的集合，值可能是字符串（变量）或对象（绑定）。 */
export type Env = Record<string, any>;

/** 内部保留目录，不出现在任何列表中。 */
export const INTERNAL_PREFIX = "_$flaredrive$/";
/** 缩略图存放目录，位于内部保留目录之下。 */
export const THUMBNAILS_PREFIX = "_$flaredrive$/thumbnails/";
/** 分享链接记录存放目录。 */
export const SHARES_PREFIX = "_$flaredrive$/shares/";
/** 目录对象使用的 Content-Type。 */
export const DIRECTORY_CONTENT_TYPE = "application/x-directory";
/** 旧版汉化分支使用的目录标记后缀，形如 `X/_$folder$`。 */
export const LEGACY_DIR_MARKER = "_$folder$";

export const WEBDAV_ENDPOINT = "/webdav/";
/** 分享链接的公开入口。 */
export const SHARE_ENDPOINT = "/s/";

/** 目录打包下载时使用的 zip 条目名不允许出现这些字符。 */
export const DEFAULT_MAX_PUT_SIZE = 100 * 1000 * 1000; // 100MB
export const DEFAULT_MAX_DEPTH_ITEMS = 10000;
export const DEFAULT_MAX_ZIP_SIZE = 1024 * 1024 * 1024; // 1GB
export const DEFAULT_MAX_UNZIP_ENTRIES = 5000;
export const DEFAULT_MAX_UNZIP_FILE_SIZE = 100 * 1000 * 1000; // 100MB

/** 上报给 WebDAV 客户端的“可用空间”，避免客户端因空间检查而拒绝写入。 */
export const REPORTED_AVAILABLE_BYTES = 1024 * 1024 * 1024 * 1024; // 1TB

function readInt(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFlag(value: unknown, defaultValue: boolean): boolean {
  if (typeof value !== "string" || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

/**
 * 匿名读取总开关。**默认关闭**：默认情况下整个网盘都是私有的，
 * 直接猜路径访问 /raw/{key}、/webdav/*、/api/list 一律 401。
 * 只有显式创建分享链接（/s/{token}）才会公开，且只公开被分享的那一项。
 */
export function isPublicRead(env: Env): boolean {
  return readFlag(env.WEBDAV_PUBLIC_READ, false);
}

/** 缩略图是否允许匿名引用。默认关闭；关闭时前端用带认证的请求取回再转 blob URL。 */
export function isPublicThumbnails(env: Env): boolean {
  return readFlag(env.WEBDAV_PUBLIC_THUMBNAILS, false);
}

/** 是否启用 LOCK/UNLOCK（DAV class 2）与写操作锁校验。 */
export function isLockingEnabled(env: Env): boolean {
  return readFlag(env.WEBDAV_LOCKING, true);
}

/** PUT 时父目录不存在是否自动创建。 */
export function isAutoMkdirEnabled(env: Env): boolean {
  return readFlag(env.WEBDAV_AUTO_MKDIR, true);
}

export function maxPutSize(env: Env): number {
  return readInt(env.WEBDAV_MAX_PUT_SIZE, DEFAULT_MAX_PUT_SIZE);
}

export function maxDepthItems(env: Env): number {
  return readInt(env.WEBDAV_MAX_DEPTH_ITEMS, DEFAULT_MAX_DEPTH_ITEMS);
}

export function maxZipSize(env: Env): number {
  return readInt(env.WEBDAV_MAX_ZIP_SIZE, DEFAULT_MAX_ZIP_SIZE);
}

/** 在线解压时允许的 zip 条目总数上限。 */
export function maxUnzipEntries(env: Env): number {
  return readInt(env.WEBDAV_MAX_UNZIP_ENTRIES, DEFAULT_MAX_UNZIP_ENTRIES);
}

/** 在线解压时单个文件解压后的大小上限（受内存限制，默认 100MB）。 */
export function maxUnzipFileSize(env: Env): number {
  return readInt(env.WEBDAV_MAX_UNZIP_FILE_SIZE, DEFAULT_MAX_UNZIP_FILE_SIZE);
}

export function webdavVersion(): string {
  return "1.0.0";
}
