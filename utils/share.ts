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

function isExpired(record: ShareRecord): boolean {
  if (!record.expiresAt) return false;
  const expires = Date.parse(record.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

/** 读取分享记录；token 非法、不存在或已过期都返回 null（不区分，避免探测）。 */
export async function loadShare(
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
    url: `/s/${record.token}`,
    absoluteUrl: `${origin}/s/${record.token}`,
  };
}
