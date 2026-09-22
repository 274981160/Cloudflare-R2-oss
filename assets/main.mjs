/**
 * FlareDrive 前端公共模块
 *
 * 纯浏览器 ES 模块：认证（HTTP Basic）、请求封装、路径工具、缩略图、上传（含分片）。
 * 不依赖任何 npm 包，不使用构建步骤；接口契约见 docs/API.md。
 */

/** localStorage / sessionStorage 中存放 `base64("用户名:密码")` 的键名 */
export const AUTH_STORAGE_KEY = "fd_auth";
/** 上次登录用户名的键名（仅用于预填登录框） */
export const AUTH_USER_STORAGE_KEY = "fd_auth_user";
/** 缩略图边长（正方形 canvas） */
export const THUMBNAIL_SIZE = 144;
/** /api/whoami 未给出 maxUploadSize 时的默认值 */
export const DEFAULT_MAX_UPLOAD_SIZE = 100 * 1000 * 1000;
/** 分片大小，与后端约定一致 */
export const SIZE_LIMIT = 100 * 1000 * 1000;
/** 分片上传并发数 */
export const MULTIPART_CONCURRENCY = 2;
/** 内部保留的缩略图目录前缀 */
export const THUMBNAIL_PREFIX = "_$flaredrive$/thumbnails/";

/** pdf.js 候选来源：先 ESM 动态 import，失败再退回 UMD <script> */
const PDFJS_SOURCES = [
  {
    kind: "esm",
    lib: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.min.mjs",
    worker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.worker.min.mjs",
  },
  {
    kind: "umd",
    lib: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    worker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  },
];

/**
 * 模块级共享状态挂在 globalThis 上。
 * vue3-sfc-loader 可能为不同组件分别实例化本模块，共享状态必须放在全局。
 */
function state() {
  if (!globalThis.__fdState) {
    globalThis.__fdState = {
      onUnauthorized: null,
      maxUploadSize: DEFAULT_MAX_UPLOAD_SIZE,
      whoami: null,
      pdfjs: null,
    };
  }
  return globalThis.__fdState;
}

/* ------------------------------------------------------------------ *
 * 错误类型与文案
 * ------------------------------------------------------------------ */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   * @param {string} [url]
   */
  constructor(message, status, url) {
    super(message);
    this.name = "ApiError";
    this.status = Number(status) || 0;
    this.url = url || "";
  }
}

/** 把 HTTP 状态码翻译成中文提示 */
export function statusMessage(status) {
  switch (Number(status)) {
    case 0:
      return "网络错误";
    case 400:
      return "请求无效";
    case 401:
      return "未认证或登录已过期";
    case 403:
      return "没有权限";
    case 404:
      return "资源不存在";
    case 405:
      return "目标已存在或方法不允许";
    case 409:
      return "父目录不存在";
    case 412:
      return "目标已存在";
    case 413:
      return "超过服务端大小限制";
    case 423:
      return "资源被锁定";
    case 507:
      return "目录条目过多";
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

/** 从任意异常里取出可读的中文提示 */
export function errorMessage(error) {
  if (error instanceof ApiError) return error.message || statusMessage(error.status);
  if (error && typeof error.message === "string" && error.message) return error.message;
  if (error == null) return "未知错误";
  return String(error);
}

/* ------------------------------------------------------------------ *
 * 认证
 * ------------------------------------------------------------------ */

function storageGet(storage, key) {
  try {
    return (storage && storage.getItem(key)) || "";
  } catch (error) {
    return "";
  }
}

function storageSet(storage, key, value) {
  try {
    if (storage) storage.setItem(key, value);
  } catch (error) {
    /* 隐私模式下可能写入失败，忽略 */
  }
}

function storageRemove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch (error) {
    /* 忽略 */
  }
}

/** UTF-8 安全的 base64 编码（ASCII 输入与 btoa 结果一致） */
export function encodeBase64(text) {
  const value = String(text == null ? "" : text);
  if (typeof TextEncoder === "function") {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return btoa(unescape(encodeURIComponent(value)));
}

/** 生成 `Basic` 认证头的值对应的 base64 token */
export function basicToken(username, password) {
  return encodeBase64(`${username == null ? "" : username}:${password == null ? "" : password}`);
}

/** 读取凭据 token：localStorage（记住密码）优先，其次 sessionStorage（仅本次会话） */
export function getAuthToken() {
  return (
    storageGet(globalThis.localStorage, AUTH_STORAGE_KEY) ||
    storageGet(globalThis.sessionStorage, AUTH_STORAGE_KEY)
  );
}

/**
 * 保存凭据 token
 * @param {string} token base64(user:pass)
 * @param {boolean} [remember] true → localStorage；false → sessionStorage（关掉标签页即失效）
 */
export function setAuthToken(token, remember = true) {
  clearAuth();
  if (!token) return "";
  if (remember) storageSet(globalThis.localStorage, AUTH_STORAGE_KEY, token);
  else storageSet(globalThis.sessionStorage, AUTH_STORAGE_KEY, token);
  return token;
}

/** 清除全部凭据 */
export function clearAuth() {
  storageRemove(globalThis.localStorage, AUTH_STORAGE_KEY);
  storageRemove(globalThis.sessionStorage, AUTH_STORAGE_KEY);
}

/** 是否勾选了「记住密码」（凭据在 localStorage 中） */
export function isRemembered() {
  return !!storageGet(globalThis.localStorage, AUTH_STORAGE_KEY);
}

/** 保存凭据并返回 token */
export function setCredentials(username, password, remember = true) {
  const token = basicToken(username, password);
  setAuthToken(token, remember);
  setLastUsername(username);
  return token;
}

/** 读取上次登录的用户名（用于预填） */
export function getLastUsername() {
  return storageGet(globalThis.localStorage, AUTH_USER_STORAGE_KEY);
}

/** 记录上次登录的用户名 */
export function setLastUsername(username) {
  if (username) storageSet(globalThis.localStorage, AUTH_USER_STORAGE_KEY, String(username));
}

function hasHeader(headers, name) {
  const target = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

/**
 * 在给定 headers 基础上附加 `Authorization: Basic ...`
 * @param {Record<string,string>} [headers]
 * @returns {Record<string,string>}
 */
export function authHeaders(headers) {
  const result = Object.assign({}, headers || {});
  const token = getAuthToken();
  if (token && !hasHeader(result, "authorization")) {
    result.Authorization = `Basic ${token}`;
  }
  return result;
}

/** 注册 401 处理回调（弹登录框等） */
export function setUnauthorizedHandler(handler) {
  state().onUnauthorized = typeof handler === "function" ? handler : null;
}

/** 清掉凭据并通知 UI */
export function notifyUnauthorized() {
  clearAuth();
  state().whoami = null;
  const handler = state().onUnauthorized;
  if (typeof handler === "function") {
    try {
      handler();
    } catch (error) {
      console.error("unauthorized handler failed", error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 请求封装
 * ------------------------------------------------------------------ */

/**
 * 带认证头的 fetch；收到 401 时清凭据、通知 UI 并抛 ApiError。
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function apiFetch(url, options) {
  const init = Object.assign({}, options || {});
  init.headers = authHeaders(init.headers);
  if (init.body == null) delete init.body;
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new ApiError(`网络错误：${errorMessage(error)}`, 0, url);
  }
  if (response.status === 401) {
    notifyUnauthorized();
    throw new ApiError(statusMessage(401), 401, url);
  }
  return response;
}

async function readErrorDetail(response) {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const data = JSON.parse(text);
      const detail = data && (data.message || data.error || data.detail);
      return detail ? String(detail) : "";
    } catch (error) {
      return text.slice(0, 200);
    }
  } catch (error) {
    return "";
  }
}

/** 读取响应体中的错误说明，拼成中文提示 */
export async function describeResponseError(response) {
  const detail = await readErrorDetail(response);
  const base = statusMessage(response.status);
  return detail ? `${base}：${detail}` : base;
}

/**
 * 带认证的 JSON 请求；非 2xx 抛 ApiError
 * @returns {Promise<any>}
 */
export async function apiFetchJson(url, options) {
  const response = await apiFetch(url, options);
  if (!response.ok) throw new ApiError(await describeResponseError(response), response.status, url);
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError("服务端返回的不是合法 JSON", response.status, url);
  }
}

/* ------------------------------------------------------------------ *
 * /api/whoami
 * ------------------------------------------------------------------ */

/** 把 /api/whoami 的响应整理成稳定结构 */
export function normalizeWhoami(data) {
  const raw = data && typeof data === "object" ? data : {};
  const authenticated = raw.authenticated === true;
  const publicRead = raw.publicRead === true;
  const canWriteAny = raw.canWriteAny === true && raw.readOnly !== true;
  const maxUploadSize =
    Number.isFinite(Number(raw.maxUploadSize)) && Number(raw.maxUploadSize) > 0
      ? Number(raw.maxUploadSize)
      : DEFAULT_MAX_UPLOAD_SIZE;
  return {
    authenticated,
    username: typeof raw.username === "string" ? raw.username : null,
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
    publicRead,
    readOnly: raw.readOnly === true || !canWriteAny,
    canWriteAny,
    maxUploadSize,
    locking: raw.locking === true,
    version: typeof raw.version === "string" ? raw.version : "",
    reachable: raw.reachable !== false,
  };
}

/**
 * 用当前凭据探测登录状态与能力。
 * 契约规定永远返回 200；网络失败会抛 ApiError。
 */
export async function whoami() {
  let response;
  try {
    response = await fetch("/api/whoami", { headers: authHeaders(), cache: "no-store" });
  } catch (error) {
    throw new ApiError(`无法连接服务器：${errorMessage(error)}`, 0, "/api/whoami");
  }
  let data = null;
  if (response.ok) {
    try {
      data = await response.json();
    } catch (error) {
      throw new ApiError("无法解析登录状态响应", response.status, "/api/whoami");
    }
  } else if (response.status === 401) {
    clearAuth();
  }
  const profile = normalizeWhoami(data);
  state().whoami = profile;
  if (profile.maxUploadSize) state().maxUploadSize = profile.maxUploadSize;
  return profile;
}

/** 读取缓存的 whoami 结果（未探测过则为 null） */
export function getWhoami() {
  return state().whoami;
}

/**
 * 用指定用户名口令验证凭据。
 * @returns {Promise<object|null>} 验证通过返回 profile，否则 null
 */
export async function verifyCredentials(username, password) {
  const token = basicToken(username, password);
  let response;
  try {
    response = await fetch("/api/whoami", {
      headers: { Authorization: `Basic ${token}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiError(`无法连接服务器：${errorMessage(error)}`, 0, "/api/whoami");
  }
  if (response.status === 401) throw new ApiError(statusMessage(401), 401, "/api/whoami");
  if (!response.ok) throw new ApiError(statusMessage(response.status), response.status, "/api/whoami");
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError("无法解析登录状态响应", response.status, "/api/whoami");
  }
  if (!data || data.authenticated !== true) return null;
  return normalizeWhoami(data);
}

/** 当前生效的单次 PUT 上限 */
export function getMaxUploadSize() {
  return state().maxUploadSize || DEFAULT_MAX_UPLOAD_SIZE;
}

/** 更新单次 PUT 上限（通常来自 /api/whoami） */
export function setMaxUploadSize(size) {
  const value = Number(size);
  if (Number.isFinite(value) && value > 0) state().maxUploadSize = value;
  return getMaxUploadSize();
}

/* ------------------------------------------------------------------ *
 * 路径 / URL 工具
 * ------------------------------------------------------------------ */

/** 归一化对象键：去掉首尾斜杠与空段（根目录为空串） */
export function normalizePath(path) {
  if (path == null) return "";
  return String(path)
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}

/** 按 `docs/API.md` 约定逐段 encodeURIComponent */
export function encodeKeyPath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  return normalized.split("/").map(encodeURIComponent).join("/");
}

/** 拼接对象键（自动处理斜杠，根目录为空串） */
export function joinKey(...parts) {
  const segments = [];
  for (const part of parts) {
    const normalized = normalizePath(part);
    if (normalized) segments.push(normalized);
  }
  return segments.join("/");
}

/** 取最后一段名字 */
export function basename(key) {
  const normalized = normalizePath(key);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** 取父目录（不含尾部斜杠，根目录为空串） */
export function dirname(key) {
  const normalized = normalizePath(key);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

/** 取扩展名（含点）；没有则返回空串 */
export function fileExtension(name) {
  const value = String(name == null ? "" : name);
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(index) : "";
}

/** 去掉扩展名 */
export function stripExtension(name) {
  const value = String(name == null ? "" : name);
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
}

/** `GET /api/list/{path}` */
export function listUrl(path) {
  const encoded = encodeKeyPath(path);
  return encoded ? `/api/list/${encoded}` : "/api/list/";
}

/** `GET /api/zip/{path}` */
export function zipUrl(path) {
  const encoded = encodeKeyPath(path);
  return encoded ? `/api/zip/${encoded}` : "/api/zip/";
}

/** `GET /raw/{key}` */
export function rawUrl(key) {
  const encoded = encodeKeyPath(key);
  return encoded ? `/raw/${encoded}` : "/raw/";
}

/** `/webdav/{key}`（不带查询串） */
export function webdavPath(key) {
  const encoded = encodeKeyPath(key);
  return encoded ? `/webdav/${encoded}` : "/webdav/";
}

/**
 * `/webdav/{key}` + 查询串
 * @param {string} key
 * @param {string|Record<string,string|number>} [query] 字符串按原样追加；对象用 URLSearchParams 编码
 */
export function webdavUrl(key, query) {
  const base = webdavPath(key);
  if (query == null || query === "") return base;
  if (typeof query === "string") return `${base}?${query.replace(/^\?/, "")}`;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value == null) continue;
    params.set(name, String(value));
  }
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

/** 相对路径转当前站点绝对 URL */
export function absoluteUrl(path) {
  return new URL(String(path), window.location.origin).toString();
}

/** MOVE / COPY 的 Destination 头：`/webdav/{key}` 的绝对 URL */
export function absoluteWebdavUrl(key) {
  return absoluteUrl(webdavPath(key));
}

/** `/raw/{key}` 的绝对 URL，用于「复制链接」 */
export function rawLink(key) {
  return absoluteUrl(rawUrl(key));
}

/* ------------------------------------------------------------------ *
 * 目录列表
 * ------------------------------------------------------------------ */

/** 归一化 `/api/list/{path}` 的响应 */
export function normalizeListing(data, path) {
  const raw = data && typeof data === "object" ? data : {};
  const fallbackPath = normalizePath(path);
  const files = (Array.isArray(raw.files) ? raw.files : []).map((file) => {
    const item = file && typeof file === "object" ? file : {};
    const key = String(item.key || joinKey(fallbackPath, String(item.name || "")));
    return {
      type: "file",
      key,
      name: String(item.name || basename(key)),
      size: Number(item.size) || 0,
      uploaded: item.uploaded || null,
      etag: item.etag ? String(item.etag) : "",
      contentType: item.contentType ? String(item.contentType) : "application/octet-stream",
      thumbnail: item.thumbnail ? String(item.thumbnail) : null,
      writable: item.writable !== false,
    };
  });
  const folders = (Array.isArray(raw.folders) ? raw.folders : []).map((folder) => {
    if (typeof folder === "string") {
      return { type: "folder", key: normalizePath(folder), name: basename(folder), writable: true };
    }
    const item = folder && typeof folder === "object" ? folder : {};
    const key = String(item.key || item.name || "");
    return {
      type: "folder",
      key: normalizePath(key),
      name: String(item.name || basename(key)),
      writable: item.writable !== false,
    };
  });
  return {
    path: typeof raw.path === "string" ? normalizePath(raw.path) : fallbackPath,
    canRead: raw.canRead !== false,
    canWrite: raw.canWrite === true,
    files,
    folders,
    notFound: false,
  };
}

/**
 * 列目录。目录不存在（404）按空目录处理，便于 UI 显示「空文件夹」。
 * 403 抛错；401 由 apiFetch 统一处理（清凭据 + 弹登录）。
 */
export async function listDirectory(path) {
  const normalized = normalizePath(path);
  const url = listUrl(normalized);
  const response = await apiFetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return { path: normalized, canRead: false, canWrite: false, files: [], folders: [], notFound: true };
  }
  if (!response.ok) throw new ApiError(await describeResponseError(response), response.status, url);
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError("目录列表不是合法 JSON", response.status, url);
  }
  return normalizeListing(data, normalized);
}

/* ------------------------------------------------------------------ *
 * 写操作（WebDAV）
 * ------------------------------------------------------------------ */

async function ensureWebdavOk(response, url) {
  if (response.ok) return response;
  throw new ApiError(await describeResponseError(response), response.status, url);
}

/** MKCOL：新建文件夹（名称由调用方保证合法） */
export async function createFolder(key) {
  const url = webdavPath(key);
  const response = await apiFetch(url, { method: "MKCOL" });
  return ensureWebdavOk(response, url);
}

/** DELETE：删除文件或目录（目录递归） */
export async function removeKey(key) {
  const url = webdavPath(key);
  const response = await apiFetch(url, { method: "DELETE" });
  return ensureWebdavOk(response, url);
}

/** MOVE：移动/重命名 */
export async function moveKey(source, destination) {
  const url = webdavPath(source);
  const response = await apiFetch(url, {
    method: "MOVE",
    headers: { Destination: absoluteWebdavUrl(destination), Overwrite: "T", Depth: "infinity" },
  });
  return ensureWebdavOk(response, url);
}

/** COPY：复制 */
export async function copyKey(source, destination) {
  const url = webdavPath(source);
  const response = await apiFetch(url, {
    method: "COPY",
    headers: { Destination: absoluteWebdavUrl(destination), Overwrite: "T", Depth: "infinity" },
  });
  return ensureWebdavOk(response, url);
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

/** 触发浏览器保存 Blob */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename || "download";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

/** 带认证取对象字节（用于非公开读场景） */
export async function fetchFileBlob(key) {
  const url = rawUrl(key);
  const response = await apiFetch(url);
  if (!response.ok) throw new ApiError(await describeResponseError(response), response.status, url);
  return response.blob();
}

/**
 * 下载单个文件
 * @param {string} key
 * @param {{publicRead?: boolean}} [options] 公开读时直接用 `<a href="/raw/...">`
 */
export async function downloadKey(key, options) {
  const name = basename(key) || "download";
  const publicRead = !!(options && options.publicRead);
  if (publicRead) {
    const anchor = document.createElement("a");
    anchor.href = rawUrl(key);
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return null;
  }
  const blob = await fetchFileBlob(key);
  saveBlob(blob, name);
  return blob;
}

/** 目录/文件打包下载：`GET /api/zip/{path}`，保存为 `{名字}.zip` */
export async function downloadZip(path) {
  const url = zipUrl(path);
  const response = await apiFetch(url);
  if (!response.ok) throw new ApiError(await describeResponseError(response), response.status, url);
  const blob = await response.blob();
  const name = basename(path) || "全部文件";
  saveBlob(blob, name.toLowerCase().endsWith(".zip") ? name : `${name}.zip`);
  return blob;
}

/** 复制文本到剪贴板（带 execCommand 兜底） */
export async function copyTextToClipboard(text) {
  const value = String(text == null ? "" : text);
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      /* 非安全上下文或拒绝授权时走兜底 */
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    area.remove();
    return !!ok;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

/** 人类可读体积 */
export function formatSize(size) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/** 本地时间字符串 */
export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

/** 预览类型：image / video / audio / pdf / null */
export function previewKind(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  return null;
}

/** 是否可直接在新窗口预览 */
export function isPreviewable(contentType) {
  return previewKind(contentType) !== null;
}

/**
 * 重名时生成「xxx - 副本.ext」
 * @param {string} name
 * @param {string[]} existing 已占用的名字
 */
export function duplicateName(name, existing) {
  const used = Array.isArray(existing) ? existing : [];
  const extension = fileExtension(name);
  const base = stripExtension(name);
  let candidate = `${base} - 副本${extension}`;
  let counter = 2;
  while (used.includes(candidate)) {
    candidate = `${base} - 副本 (${counter})${extension}`;
    counter++;
  }
  return candidate;
}

/* ------------------------------------------------------------------ *
 * 摘要
 * ------------------------------------------------------------------ */

/** 字节数组转十六进制 */
export function toHex(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let hex = "";
  for (let i = 0; i < array.length; i++) hex += array[i].toString(16).padStart(2, "0");
  return hex;
}

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** 纯 JS SHA-1（仅在 crypto.subtle 不可用的非安全上下文里兜底） */
export function sha1Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const bitLength = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, "0")).join("");
}

/** Blob 的 SHA-1 十六进制摘要（缩略图文件名） */
export async function blobDigest(blob) {
  const buffer = await blob.arrayBuffer();
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof subtle.digest === "function") {
    try {
      const digest = await subtle.digest("SHA-1", buffer);
      return toHex(new Uint8Array(digest));
    } catch (error) {
      /* 非安全上下文等情况退回纯 JS 实现 */
    }
  }
  return sha1Hex(new Uint8Array(buffer));
}

/* ------------------------------------------------------------------ *
 * 缩略图
 * ------------------------------------------------------------------ */

/** 该文件类型是否需要（且能够）生成缩略图 */
export function isThumbnailable(file) {
  const type = String((file && file.type) || "").toLowerCase();
  return type.startsWith("image/") || type === "video/mp4" || type === "application/pdf";
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => resolve(blob), "image/png");
      return;
    }
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const binary = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      resolve(new Blob([bytes], { type: "image/png" }));
    } catch (error) {
      resolve(null);
    }
  });
}

function createCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  return canvas;
}

/** 等比裁剪铺满 144×144（居中） */
function drawCover(ctx, source, sourceWidth, sourceHeight) {
  const width = Number(sourceWidth) || THUMBNAIL_SIZE;
  const height = Number(sourceHeight) || THUMBNAIL_SIZE;
  const scale = Math.max(THUMBNAIL_SIZE / width, THUMBNAIL_SIZE / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  ctx.drawImage(source, (THUMBNAIL_SIZE - drawWidth) / 2, (THUMBNAIL_SIZE - drawHeight) / 2, drawWidth, drawHeight);
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解析图片"));
    };
    image.src = url;
  });
}

function onceEvent(target, event, errorEvent) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("媒体加载失败"));
    };
    function cleanup() {
      target.removeEventListener(event, onOk);
      if (errorEvent) target.removeEventListener(errorEvent, onErr);
    }
    target.addEventListener(event, onOk);
    if (errorEvent) target.addEventListener(errorEvent, onErr);
  });
}

async function drawImageThumbnail(ctx, file) {
  const image = await withTimeout(loadImageFromBlob(file), 10000, "图片加载超时");
  drawCover(ctx, image, image.naturalWidth || image.width, image.naturalHeight || image.height);
}

async function drawVideoThumbnail(ctx, file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await withTimeout(onceEvent(video, "loadeddata", "error"), 8000, "视频加载超时");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration > 1 ? Math.min(1, duration / 2) : 0;
    if (target > 0) {
      video.currentTime = target;
      await withTimeout(onceEvent(video, "seeked", "error"), 8000, "视频定位超时");
    }
    drawCover(ctx, video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 ${url}`));
    document.head.appendChild(script);
  });
}

/** 动态加载 pdf.js（优先 ESM import，失败退回 UMD script） */
async function loadPdfJs() {
  const shared = state();
  if (shared.pdfjs) return shared.pdfjs;
  for (const source of PDFJS_SOURCES) {
    try {
      let lib = null;
      if (source.kind === "esm") {
        const module = await import(/* @vite-ignore */ source.lib);
        lib = module && typeof module.getDocument === "function" ? module : module && module.default;
      } else {
        await loadScript(source.lib);
        lib = globalThis.pdfjsLib || globalThis["pdfjs-dist/build/pdf"];
      }
      if (lib && typeof lib.getDocument === "function") {
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = source.worker;
        shared.pdfjs = lib;
        return lib;
      }
    } catch (error) {
      console.warn("pdf.js 加载失败：", source.lib, error);
    }
  }
  return null;
}

async function drawPdfThumbnail(ctx, file) {
  const pdfjsLib = await loadPdfJs();
  if (!pdfjsLib) throw new Error("pdf.js 不可用");
  const data = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data, disableAutoFetch: true, disableStream: true });
  const pdf = await withTimeout(task.promise, 20000, "PDF 解析超时");
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = THUMBNAIL_SIZE / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const pageContext = canvas.getContext("2d");
    pageContext.fillStyle = "#ffffff";
    pageContext.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: pageContext, viewport }).promise;
    drawCover(ctx, canvas, canvas.width, canvas.height);
  } finally {
    if (typeof pdf.destroy === "function") {
      try {
        await pdf.destroy();
      } catch (error) {
        /* 忽略销毁错误 */
      }
    }
  }
}

/**
 * 生成 144×144 PNG 缩略图
 * @param {File} file
 * @returns {Promise<Blob|null>} 不支持或失败时返回 null
 */
export async function generateThumbnail(file) {
  if (!file || !isThumbnailable(file)) return null;
  const type = String(file.type).toLowerCase();
  const canvas = createCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  try {
    if (type.startsWith("image/")) await drawImageThumbnail(ctx, file);
    else if (type === "video/mp4") await drawVideoThumbnail(ctx, file);
    else await drawPdfThumbnail(ctx, file);
  } catch (error) {
    console.warn("生成缩略图失败：", error);
    return null;
  }
  return canvasToBlob(canvas);
}

/* ------------------------------------------------------------------ *
 * 上传
 * ------------------------------------------------------------------ */

/**
 * 带认证与上传进度的 XMLHttpRequest 封装
 * @param {string} method
 * @param {string} url
 * @param {BodyInit|null} body
 * @param {{headers?: Record<string,string>, onUploadProgress?: (progress: {loaded:number,total:number}) => void, responseType?: string}} [options]
 */
export function xhrRequest(method, url, body, options) {
  const settings = options || {};
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    const headers = authHeaders(settings.headers);
    for (const name of Object.keys(headers)) {
      const value = headers[name];
      if (value == null) continue;
      try {
        xhr.setRequestHeader(name, value);
      } catch (error) {
        /* 非法头名忽略 */
      }
    }
    if (settings.responseType) xhr.responseType = settings.responseType;
    const onProgress = typeof settings.onUploadProgress === "function" ? settings.onUploadProgress : null;
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
      };
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        notifyUnauthorized();
        reject(new ApiError(statusMessage(401), 401, url));
        return;
      }
      let responseText = "";
      try {
        if (!settings.responseType || settings.responseType === "text") responseText = xhr.responseText || "";
      } catch (error) {
        responseText = "";
      }
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        responseText,
        response: xhr.response,
        getHeader(name) {
          try {
            return xhr.getResponseHeader(name);
          } catch (error) {
            return null;
          }
        },
      });
    };
    xhr.onerror = () => reject(new ApiError("网络错误，上传失败", 0, url));
    xhr.ontimeout = () => reject(new ApiError("上传超时", 0, url));
    xhr.onabort = () => reject(new ApiError("上传已取消", 0, url));
    try {
      xhr.send(body === undefined ? null : body);
    } catch (error) {
      reject(new ApiError(`上传失败：${errorMessage(error)}`, 0, url));
    }
  });
}

/** 非 2xx 抛错，否则返回 xhr 结果 */
export function ensureOk(result, url) {
  if (result && result.ok) return result;
  const status = (result && result.status) || 0;
  throw new ApiError(statusMessage(status), status, url || "");
}

/**
 * 上传缩略图到 `_$flaredrive$/thumbnails/{sha1}.png`
 * @param {Blob} blob
 * @returns {Promise<string>} sha1 十六进制摘要
 */
export async function uploadThumbnail(blob) {
  const digest = await blobDigest(blob);
  const url = webdavPath(`${THUMBNAIL_PREFIX}${digest}.png`);
  const result = await xhrRequest("PUT", url, blob, { headers: { "content-type": "image/png" } });
  ensureOk(result, url);
  return digest;
}

/** 小文件直传：`PUT /webdav/{key}` */
export async function putFile(key, file, options) {
  const settings = options || {};
  const url = webdavPath(key);
  const headers = Object.assign(
    { "content-type": (file && file.type) || "application/octet-stream" },
    settings.headers || {}
  );
  const result = await xhrRequest("PUT", url, file, {
    headers,
    onUploadProgress: settings.onUploadProgress,
  });
  ensureOk(result, url);
  return result;
}

/**
 * 分片上传：`POST ?uploads` → 并发 2 片 `PUT ?uploadId=&partNumber=` → `POST ?uploadId=`
 * @param {string} key
 * @param {File|Blob} file
 * @param {{headers?: Record<string,string>, onUploadProgress?: Function, partSize?: number, concurrency?: number}} [options]
 */
export async function multipartUpload(key, file, options) {
  const settings = options || {};
  const url = webdavPath(key);
  const headers = Object.assign({}, settings.headers || {});

  const createResult = await xhrRequest("POST", `${url}?uploads`, null, { headers });
  ensureOk(createResult, `${url}?uploads`);
  let created = null;
  try {
    created = JSON.parse(createResult.responseText || "{}");
  } catch (error) {
    throw new ApiError("无法解析分片上传响应", createResult.status, `${url}?uploads`);
  }
  const uploadId = created && created.uploadId;
  if (!uploadId) throw new ApiError("服务端未返回 uploadId", createResult.status, `${url}?uploads`);

  const partSize = Number(settings.partSize) > 0 ? Number(settings.partSize) : SIZE_LIMIT;
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const concurrency = Math.max(1, Math.min(Number(settings.concurrency) || MULTIPART_CONCURRENCY, totalParts));
  const onProgress = typeof settings.onUploadProgress === "function" ? settings.onUploadProgress : null;
  const loadedByPart = new Array(totalParts + 1).fill(0);
  const parts = new Array(totalParts);

  const report = () => {
    if (!onProgress) return;
    let loaded = 0;
    for (let i = 1; i <= totalParts; i++) loaded += loadedByPart[i];
    onProgress({ loaded: Math.min(loaded, file.size), total: file.size });
  };

  let nextIndex = 1;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index > totalParts) return;
      const start = (index - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      const partUrl = `${url}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${index}`;
      const result = await xhrRequest("PUT", partUrl, chunk, {
        onUploadProgress: (progress) => {
          loadedByPart[index] = progress.loaded;
          report();
        },
      });
      ensureOk(result, partUrl);
      let etag = result.getHeader("etag") || result.getHeader("ETag") || "";
      if (!etag) {
        try {
          const data = JSON.parse(result.responseText || "{}");
          etag = (data && data.etag) || "";
        } catch (error) {
          etag = "";
        }
      }
      if (!etag) throw new ApiError("分片响应缺少 etag", result.status, partUrl);
      loadedByPart[index] = chunk.size;
      report();
      parts[index - 1] = { partNumber: index, etag: String(etag) };
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const completeUrl = `${url}?uploadId=${encodeURIComponent(uploadId)}`;
  const completeResult = await xhrRequest("POST", completeUrl, JSON.stringify({ parts }), {
    headers: { "content-type": "application/json" },
  });
  ensureOk(completeResult, completeUrl);
  if (onProgress) onProgress({ loaded: file.size, total: file.size });
  return { uploadId, parts };
}

/**
 * 按文件大小自动选择直传或分片上传
 * @param {string} key
 * @param {File} file
 * @param {{headers?: Record<string,string>, onUploadProgress?: Function}} [options]
 */
export async function uploadFile(key, file, options) {
  const settings = options || {};
  const maxUploadSize = getMaxUploadSize();
  if (file.size < maxUploadSize) {
    if (typeof settings.onUploadProgress === "function") {
      settings.onUploadProgress({ loaded: 0, total: file.size });
    }
    return putFile(key, file, settings);
  }
  return multipartUpload(key, file, settings);
}

/**
 * 完整上传流程：先生成并上传缩略图（失败不阻断），再带 `fd-thumbnail` 上传原文件。
 * @param {string} key
 * @param {File} file
 * @param {{headers?: Record<string,string>, onUploadProgress?: Function}} [options]
 */
export async function uploadWithThumbnail(key, file, options) {
  const settings = options || {};
  const headers = Object.assign({}, settings.headers || {});
  if (isThumbnailable(file)) {
    try {
      const thumbnail = await generateThumbnail(file);
      if (thumbnail) {
        const digest = await uploadThumbnail(thumbnail);
        if (digest) headers["fd-thumbnail"] = digest;
      }
    } catch (error) {
      console.warn("缩略图上传失败，继续上传原文件：", error);
    }
  }
  return uploadFile(key, file, Object.assign({}, settings, { headers }));
}
