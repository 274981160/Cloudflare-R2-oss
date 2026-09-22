import {
  Env,
  INTERNAL_PREFIX,
  THUMBNAILS_PREFIX,
  isPublicRead,
  isPublicThumbnails,
} from "./config";
import { ApiKeyRecord, looksLikeApiKey, verifyApiKey } from "./apikey";
import {
  normalizePath,
  parsePermissions,
  permissionAllows,
} from "./permissions";

// 路径与权限工具下沉到 permissions.ts，这里继续对外导出以保持调用方不变
export { normalizePath, parsePermissions, permissionAllows };

export interface Account {
  username: string;
  password: string;
  /** 允许访问的路径前缀；["*"] 表示全部。 */
  permissions: string[];
  /** 配置来源，仅用于诊断：WEBDAV_USERNAME / WEBDAV_USERS / env-name / apikey */
  source: string;
  /** 通过 API Key 认证时的密钥 id。 */
  apiKeyId?: string;
}

/** 一次请求的授权主体。 */
export interface Subject {
  account: Account | null;
  anonymous: boolean;
  env: Env;
}

export interface AuthResult {
  account: Account | null;
  anonymous: boolean;
  /** 带了 Authorization 头但凭据不合法。 */
  invalid: boolean;
}

const RESERVED_ENV_KEYS = new Set([
  "BUCKET",
  "GUEST",
  "PUBURL",
  "ASSETS",
  "NODE_ENV",
  "CF_ACCOUNT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);

const RESERVED_ENV_PREFIXES = ["WEBDAV_", "CF_", "NODE_", "npm_", "__"];

function decodeBase64Utf8(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 定长比较，避免通过响应时间逐字符猜密码。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * 收集全部账号，来源依次为：
 * 1. `WEBDAV_USERNAME` + `WEBDAV_PASSWORD`（权限取 `WEBDAV_PERMISSIONS`，默认全部）
 * 2. `WEBDAV_USERS`，格式 `用户名:密码:权限1,权限2;用户名2:密码2:*`
 * 3. 旧版兼容写法：环境变量名直接是 `用户名:密码`，值是可访问前缀
 */
export function parseAccounts(env: Env): Account[] {
  const accounts: Account[] = [];
  const seen = new Set<string>();

  const push = (
    username: string,
    password: string,
    permissions: string[],
    source: string
  ) => {
    if (!username || seen.has(username)) return;
    seen.add(username);
    accounts.push({ username, password, permissions, source });
  };

  if (
    typeof env.WEBDAV_USERNAME === "string" &&
    env.WEBDAV_USERNAME.length > 0 &&
    typeof env.WEBDAV_PASSWORD === "string"
  ) {
    const raw =
      typeof env.WEBDAV_PERMISSIONS === "string" && env.WEBDAV_PERMISSIONS.trim()
        ? env.WEBDAV_PERMISSIONS
        : "*";
    push(env.WEBDAV_USERNAME, env.WEBDAV_PASSWORD, parsePermissions(raw), "WEBDAV_USERNAME");
  }

  if (typeof env.WEBDAV_USERS === "string") {
    for (const entry of env.WEBDAV_USERS.split(";")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(":");
      if (parts.length < 2) continue;
      const username = parts[0].trim();
      const password = parts[1];
      const rawPermissions = parts.slice(2).join(":").trim();
      push(
        username,
        password,
        parsePermissions(rawPermissions || "*"),
        "WEBDAV_USERS"
      );
    }
  }

  for (const key of Object.keys(env)) {
    if (!key.includes(":")) continue;
    if (RESERVED_ENV_KEYS.has(key)) continue;
    if (RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const value = env[key];
    if (typeof value !== "string") continue;
    const separator = key.indexOf(":");
    const username = key.slice(0, separator).trim();
    const password = key.slice(separator + 1);
    if (!username) continue;
    push(username, password, parsePermissions(value), "env-name");
  }

  return accounts;
}

/** 从请求里取出 API Key（X-Api-Key 头或 Bearer 令牌）。 */
export function extractApiKey(request: Request): string | null {
  const header = request.headers.get("X-Api-Key");
  if (header && header.trim()) return header.trim();

  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return bearer ? bearer[1].trim() : null;
}

function accountFromApiKey(record: ApiKeyRecord): Account {
  return {
    username: `key:${record.name || record.id}`,
    password: "",
    permissions: record.permissions,
    source: "apikey",
    apiKeyId: record.id,
  };
}

async function authenticateApiKey(
  bucket: R2Bucket,
  key: string
): Promise<AuthResult> {
  const record = await verifyApiKey(bucket, key);
  if (!record) return { account: null, anonymous: false, invalid: true };
  return {
    account: accountFromApiKey(record),
    anonymous: false,
    invalid: false,
  };
}

/**
 * 认证。支持三种凭据：
 * 1. 环境变量里配置的账号（HTTP Basic）
 * 2. API Key：`X-Api-Key: fd_...` 或 `Authorization: Bearer fd_...`
 * 3. 只支持 Basic 的 WebDAV 客户端：用户名随便填，密码位填 API Key
 */
export async function authenticate(
  request: Request,
  env: Env,
  bucket?: R2Bucket | null
): Promise<AuthResult> {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    if (!bucket) return { account: null, anonymous: false, invalid: true };
    return authenticateApiKey(bucket, apiKey);
  }

  const header = request.headers.get("Authorization");
  if (!header || !header.trim()) {
    return { account: null, anonymous: true, invalid: false };
  }

  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header.trim());
  if (!match) return { account: null, anonymous: false, invalid: true };

  let decoded: string;
  try {
    decoded = decodeBase64Utf8(match[1]);
  } catch (error) {
    return { account: null, anonymous: false, invalid: true };
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return { account: null, anonymous: false, invalid: true };

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  for (const account of parseAccounts(env)) {
    const userMatches = timingSafeEqual(account.username, username);
    const passwordMatches = timingSafeEqual(account.password, password);
    if (userMatches && passwordMatches) {
      return { account, anonymous: false, invalid: false };
    }
  }

  if (bucket && looksLikeApiKey(password)) {
    return authenticateApiKey(bucket, password);
  }

  return { account: null, anonymous: false, invalid: true };
}

function permissionsOf(subject: Subject): string[] {
  return subject.account ? subject.account.permissions : [];
}

function guestPermissions(env: Env): string[] {
  return typeof env.GUEST === "string" ? parsePermissions(env.GUEST) : [];
}

/** 能否读取该对象。缩略图在开启公开缩略图时对所有主体可读。 */
export function canRead(subject: Subject, path: string): boolean {
  if (normalizePath(path).startsWith(normalizePath(THUMBNAILS_PREFIX))) {
    if (subject.account) return true;
    if (isPublicThumbnails(subject.env)) return true;
  }
  if (!subject.account) return isPublicRead(subject.env);
  return permissionsOf(subject).some((perm) => permissionAllows(perm, path));
}

/**
 * 能否列出该目录。只要账号对目录内任意前缀有权限即可列出，返回结果再按权限过滤，
 * 这样受限账号在根目录也能看到自己被授权的目录。
 */
export function canList(subject: Subject, path: string): boolean {
  if (!subject.account) return isPublicRead(subject.env);
  const perms = permissionsOf(subject);
  if (perms.includes("*")) return true;
  const dir = normalizePath(path);
  if (!dir) return perms.length > 0;
  return perms.some(
    (perm) =>
      permissionAllows(perm, dir) || normalizePath(perm).startsWith(dir + "/")
  );
}

/** 能否写入该路径。 */
export function canWrite(subject: Subject, path: string): boolean {
  const target = normalizePath(path);
  if (target.startsWith(normalizePath(THUMBNAILS_PREFIX))) {
    if (subject.account) return true;
    return guestPermissions(subject.env).some((perm) =>
      permissionAllows(perm, target)
    );
  }
  if (!subject.account) {
    return guestPermissions(subject.env).some((perm) =>
      permissionAllows(perm, target)
    );
  }
  return permissionsOf(subject).some((perm) => permissionAllows(perm, target));
}

/** 该主体是否存在任何可写前缀，用于网页端决定是否显示上传入口。 */
export function canWriteAnywhere(subject: Subject): boolean {
  if (!subject.account) return guestPermissions(subject.env).length > 0;
  const perms = permissionsOf(subject);
  return perms.includes("*") || perms.length > 0;
}

export function isInternalPath(path: string | null | undefined): boolean {
  return normalizePath(path).startsWith(normalizePath(INTERNAL_PREFIX)) ||
    normalizePath(path) === normalizePath(INTERNAL_PREFIX);
}

export function buildSubject(env: Env, account: Account | null, anonymous: boolean): Subject {
  return { account, anonymous, env };
}

export function unauthorized(message = "Unauthorized"): Response {
  return new Response(message, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="FlareDrive", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function forbidden(message = "Forbidden"): Response {
  return new Response(message, {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
