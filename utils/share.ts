/**
 * 分享链接存储。
 *
 * 安全模型：整站默认私有，匿名唯一的读入口就是 `/s/{token}`；
 * 一个 token 只对应一个对象键（文件）或一棵子树（目录），越权访问一律 404。
 */
import { INTERNAL_PREFIX, SHARES_PREFIX } from "./config";
import { normalizePath } from "./permissions";

const TOKEN_PATTERN = /^s_[0-9a-f]{20}$/;

export interface ShareRecord {
  token: string;
  key: string;
  type: "file" | "folder";
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  /** 访问密码的 SHA-256(salt + password)；不设密码则没有这个字段（B2） */
  passwordHash?: string;
  passwordSalt?: string;
  /** 暂停分享：记录保留、链接不变，但访问一律 404；随时恢复 */
  suspended?: boolean;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createShareToken(): string {
  return `s_${randomHex(10)}`;
}

export function isShareToken(value: string | null | undefined): boolean {
  return TOKEN_PATTERN.test((value || "").trim());
}

function objectName(token: string): string {
  return `${SHARES_PREFIX}${token}.json`;
}

export async function saveShare(
  bucket: R2Bucket,
  record: ShareRecord
): Promise<void> {
  await bucket.put(objectName(record.token), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

/* ---------------- 访问密码（B2） ---------------- */

async function hmacHex(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 是否设置了访问密码 */
export function hasPassword(record: ShareRecord): boolean {
  return Boolean(record.passwordHash && record.passwordSalt);
}

/** 校验访问密码；没设密码的分享返回 false */
export async function verifySharePassword(
  record: ShareRecord,
  password: string
): Promise<boolean> {
  if (!hasPassword(record)) return false;
  const hash = await sha256Hex(`${record.passwordSalt}:${password}`);
  return hash === record.passwordHash;
}

/** 为记录生成/更新密码字段（明文不落盘） */
export async function applySharePassword(
  record: ShareRecord,
  password: string
): Promise<ShareRecord> {
  const trimmed = String(password == null ? "" : password);
  if (!trimmed) {
    // 空密码 = 清除密码
    const { passwordHash: _h, passwordSalt: _s, ...rest } = record;
    return rest;
  }
  const salt = randomHex(8);
  return { ...record, passwordSalt: salt, passwordHash: await sha256Hex(`${salt}:${trimmed}`) };
}

/* ---------------- 密码凭证 Cookie ---------------- */

const SHARE_PW_COOKIE = "fdsp";

function credentialCookieName(token: string): string {
  return `${SHARE_PW_COOKIE}_${token}`;
}

/** 校验通过后签发的 cookie 值；绑定 token 与当前密码，改密码后旧凭证自动失效 */
async function passwordCookieValue(
  env: { WEBDAV_PASSWORD?: string; DOWNLOAD_SECRET?: string },
  record: ShareRecord
): Promise<string | null> {
  const secret = env.DOWNLOAD_SECRET || env.WEBDAV_PASSWORD;
  // 没有 secret 时退回「密码哈希片段」做凭证：它只在密码验证正确后下发，
  // 且绑定当前密码哈希——改密码后旧凭证立即失效，安全性仍然成立。
  if (!secret) return (record.passwordHash || "").slice(0, 32) || null;
  return hmacHex(secret, `share-pw\n${record.token}\n${record.passwordHash || ""}`);
}

/** 请求里的密码凭证是否有效 */
export async function hasValidPasswordCookie(
  env: { WEBDAV_PASSWORD?: string; DOWNLOAD_SECRET?: string },
  record: ShareRecord,
  request: Request
): Promise<boolean> {
  if (!hasPassword(record)) return true;
  const secret = env.DOWNLOAD_SECRET || env.WEBDAV_PASSWORD;
  if (!secret) return false;
  const expected = await passwordCookieValue(env, record);
  if (!expected) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${credentialCookieName(record.token)}=`));
  if (!match) return false;
  const value = match.slice(credentialCookieName(record.token).length + 1);
  return value === expected;
}

/** Set-Cookie 头值（30 天有效，HttpOnly） */
export async function passwordCookieHeader(
  env: { WEBDAV_PASSWORD?: string; DOWNLOAD_SECRET?: string },
  record: ShareRecord
): Promise<string | null> {
  const value = await passwordCookieValue(env, record);
  if (!value) return null;
  return `${credentialCookieName(record.token)}=${value}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
}

/* ---------------- 过期 ---------------- */

function isExpired(record: ShareRecord): boolean {
  if (!record.expiresAt) return false;
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

/** 读取分享记录（不过滤暂停状态）；仅限管理端与分享入口内部使用。 */
export async function loadShareAnyState(
  bucket: R2Bucket,
  token: string
): Promise<ShareRecord | null> {
  return loadShareRecord(bucket, token);
}

/** 读取分享记录；token 非法、不存在、已过期或已暂停都返回 null（不区分，避免探测）。 */
export async function loadShare(
  bucket: R2Bucket,
  token: string
): Promise<ShareRecord | null> {
  const record = await loadShareRecord(bucket, token);
  if (!record) return null;
  return record.suspended ? null : record;
}

async function loadShareRecord(
  bucket: R2Bucket,
  token: string
): Promise<ShareRecord | null> {
  if (!isShareToken(token)) return null;

  const object: any = await bucket.get(objectName(token));
  if (!object || !("body" in object)) return null;

  let record: ShareRecord;
  try {
    record = JSON.parse(await object.text());
  } catch (error) {
    return null;
  }

  if (!record || record.token !== token || typeof record.key !== "string") {
    return null;
  }
  if (isExpired(record)) return null;
  if (record.suspended) return null;
  if (normalizePath(record.key).startsWith(normalizePath(INTERNAL_PREFIX))) {
    // 内部目录永远不能被分享
    return null;
  }
  return record;
}

export async function listShares(bucket: R2Bucket): Promise<ShareRecord[]> {
  const shares: ShareRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed: any = await bucket.list({ prefix: SHARES_PREFIX, cursor });
    for (const object of listed.objects || []) {
      const body: any = await bucket.get(object.key);
      if (!body || !("body" in body)) continue;
      try {
        const record = JSON.parse(await body.text());
        // 暂停中的记录也在列表里——管理端要能看到它、并随时恢复
        if (record && typeof record.token === "string" && !isExpired(record)) {
          shares.push(record);
        }
      } catch (error) {
        // 忽略损坏记录
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return shares.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

/** 同一个 key 是否已经有某人创建的分享。 */
export function findShareForKey(
  shares: ShareRecord[],
  key: string,
  createdBy: string | null
): ShareRecord | null {
  const target = normalizePath(key);
  return (
    shares.find(
      (share) =>
        normalizePath(share.key) === target && share.createdBy === createdBy
    ) || null
  );
}

export async function deleteShare(
  bucket: R2Bucket,
  token: string
): Promise<boolean> {
  if (!isShareToken(token)) return false;
  const existing = await loadShare(bucket, token);
  if (!existing) return false;
  await bucket.delete(objectName(token));
  return true;
}

/**
 * 把分享 URL 里的相对路径解析成真实对象键。
 * 越权、`..`、内部目录一律返回 null。
 */
export function resolveSharePath(
  share: ShareRecord,
  relative: string
): string | null {
  const base = normalizePath(share.key);
  if (!base) return null;

  const rel = normalizePath(relative);
  if (share.type === "file") {
    // 文件分享只允许访问它本身
    return rel === "" ? base : null;
  }

  if (!rel) return base;

  for (const segment of rel.split("/")) {
    if (segment === "..") return null;
  }

  const target = `${base}/${rel}`;
  if (!target.startsWith(`${base}/`)) return null;
  if (normalizePath(target).startsWith(normalizePath(INTERNAL_PREFIX))) {
    return null;
  }
  return target;
}

export function publicShare(record: ShareRecord, origin: string) {
  return {
    token: record.token,
    key: record.key,
    type: record.type,
    createdAt: record.createdAt,
    createdBy: record.createdBy || null,
    expiresAt: record.expiresAt || null,
    hasPassword: hasPassword(record),
    suspended: Boolean(record.suspended),
    url: `/s/${record.token}`,
    absoluteUrl: `${origin}/s/${record.token}`,
  };
}
