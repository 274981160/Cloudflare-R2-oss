/**
 * 编辑历史（版本快照）。
 *
 * 每次带 `fd-snapshot: 1` 的覆盖写（网页编辑器保存）会把**旧内容**存进
 * `_$flaredrive$/versions/{sha256(key)}/{id}.bin`，因此改错了可以回退；
 * 回退本身也会先给当前内容存一份，所以回退也能再回退。
 */
import {
  Env,
  VERSIONS_PREFIX,
  isVersioningEnabled,
  versionLimit,
  versionMaxSize,
} from "./config";
import { normalizePath } from "./permissions";

export interface VersionRecord {
  id: string;
  key: string;
  size: number;
  uploaded: string;
  savedBy: string | null;
  contentType: string;
}

const META_ORIGINAL_KEY = "fdOriginalKey";
const META_SAVED_BY = "fdSavedBy";
const META_SAVED_AT = "fdSavedAt";
const VERSION_ID_PATTERN = /^\d{13}-[0-9a-f]{6}$/;

async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizePath(key))
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function versionPrefix(key: string): Promise<string> {
  return `${VERSIONS_PREFIX}${await hashKey(key)}/`;
}

function newVersionId(): string {
  const buffer = new Uint8Array(3);
  crypto.getRandomValues(buffer);
  const suffix = Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${Date.now()}-${suffix}`;
}

export function isVersionId(value: string | null | undefined): boolean {
  return VERSION_ID_PATTERN.test((value || "").trim());
}

/** 只保留缩略图这类用户级自定义元数据，别把内部标记写回用户对象。 */
export function stripInternalMetadata(
  customMetadata: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!customMetadata) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(customMetadata)) {
    if (name.startsWith("fd")) continue;
    cleaned[name] = value;
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

async function pruneVersions(
  bucket: R2Bucket,
  env: Env,
  key: string
): Promise<void> {
  const limit = versionLimit(env);
  const prefix = await versionPrefix(key);
  const listed: any = await bucket.list({ prefix });
  const objects = (listed.objects || []).slice().sort((a: any, b: any) =>
    a.key.localeCompare(b.key)
  );
  if (objects.length <= limit) return;

  const obsolete = objects.slice(0, objects.length - limit).map((o: any) => o.key);
  for (let i = 0; i < obsolete.length; i += 500) {
    const batch = obsolete.slice(i, i + 500);
    if (batch.length) await (bucket as any).delete(batch);
  }
}

/**
 * 把某个对象当前的**旧内容**存成一份历史版本。
 * 返回是否真的存了（对象不存在、是目录、太大、未开启版本功能都会跳过）。
 */
export async function snapshotObject(
  bucket: R2Bucket,
  env: Env,
  key: string,
  savedBy: string | null
): Promise<boolean> {
  if (!isVersioningEnabled(env)) return false;

  const target = normalizePath(key);
  if (!target) return false;

  const head: any = await bucket.head(target);
  if (!head) return false;
  if (head.httpMetadata?.contentType === "application/x-directory") return false;
  if (typeof head.size === "number" && head.size > versionMaxSize(env)) {
    return false;
  }

  const object: any = await bucket.get(target);
  if (!object || !("body" in object)) return false;

  const id = newVersionId();
  await bucket.put(`${await versionPrefix(target)}${id}.bin`, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: {
      ...(stripInternalMetadata(object.customMetadata) || {}),
      [META_ORIGINAL_KEY]: target,
      [META_SAVED_BY]: savedBy || "",
      [META_SAVED_AT]: new Date().toISOString(),
    },
  });

  await pruneVersions(bucket, env, target);
  return true;
}

export async function listVersions(
  bucket: R2Bucket,
  key: string
): Promise<VersionRecord[]> {
  const target = normalizePath(key);
  if (!target) return [];

  const prefix = await versionPrefix(target);
  const records: VersionRecord[] = [];
  let cursor: string | undefined;

  do {
    const listed: any = await bucket.list({
      prefix,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    for (const object of listed.objects || []) {
      const fileName = String(object.key).slice(prefix.length);
      const id = fileName.replace(/\.bin$/, "");
      if (!isVersionId(id)) continue;
      records.push({
        id,
        key: target,
        size: typeof object.size === "number" ? object.size : 0,
        uploaded:
          object.uploaded instanceof Date
            ? object.uploaded.toISOString()
            : new Date(0).toISOString(),
        savedBy: object.customMetadata?.[META_SAVED_BY] || null,
        contentType: object.httpMetadata?.contentType || "application/octet-stream",
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return records.sort((a, b) => b.id.localeCompare(a.id));
}

export async function getVersionObject(
  bucket: R2Bucket,
  key: string,
  id: string
): Promise<any | null> {
  const target = normalizePath(key);
  if (!target || !isVersionId(id)) return null;
  const object: any = await bucket.get(
    `${await versionPrefix(target)}${id}.bin`
  );
  if (!object || !("body" in object)) return null;
  return object;
}

/** 取某个版本的内容元信息（不含 body），用于判断存在性。 */
export async function statVersion(
  bucket: R2Bucket,
  key: string,
  id: string
): Promise<{ size: number; uploaded: Date | null; contentType: string } | null> {
  const target = normalizePath(key);
  if (!target || !isVersionId(id)) return null;
  const head: any = await bucket.head(`${await versionPrefix(target)}${id}.bin`);
  if (!head) return null;
  return {
    size: typeof head.size === "number" ? head.size : 0,
    uploaded: head.uploaded instanceof Date ? head.uploaded : null,
    contentType: head.httpMetadata?.contentType || "application/octet-stream",
  };
}

/**
 * 用某个历史版本覆盖当前内容。恢复前会先把当前内容也快照一份。
 */
export async function restoreVersion(
  bucket: R2Bucket,
  env: Env,
  key: string,
  id: string,
  savedBy: string | null
): Promise<{ size: number } | null> {
  const target = normalizePath(key);
  if (!target || !isVersionId(id)) return null;

  const object = await getVersionObject(bucket, target, id);
  if (!object) return null;

  await snapshotObject(bucket, env, target, savedBy);

  const body = await object.arrayBuffer();
  const result: any = await bucket.put(target, body, {
    httpMetadata: object.httpMetadata,
    customMetadata: stripInternalMetadata(object.customMetadata),
  });

  return { size: result && typeof result.size === "number" ? result.size : body.byteLength };
}

export async function deleteVersion(
  bucket: R2Bucket,
  key: string,
  id: string
): Promise<boolean> {
  const target = normalizePath(key);
  if (!target || !isVersionId(id)) return false;
  const stat = await statVersion(bucket, target, id);
  if (!stat) return false;
  await bucket.delete(`${await versionPrefix(target)}${id}.bin`);
  return true;
}
