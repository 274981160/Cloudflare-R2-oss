/**
 * 生成式 API Key 存储。与锁记录一样放在 R2 内部目录，跨实例可见、无需额外绑定。
 * 只保存密钥的 SHA-256 摘要，明文只在创建响应里出现一次。
 */
import { INTERNAL_PREFIX } from "./config";
import { parsePermissions } from "./permissions";

export const APIKEY_PREFIX = `${INTERNAL_PREFIX}apikeys/`;

/** 密钥形如 fd_<10位十六进制id>_<32位十六进制secret> */
const API_KEY_PATTERN = /^fd_([0-9a-f]{10})_([0-9a-f]{32})$/;

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** 密钥全文的 SHA-256 十六进制摘要 */
  hash: string;
  /** 仅用于展示的前缀，例如 fd_a1b2c3d4e5 */
  hint: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdBy: string | null;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 定长比较，避免按字符逐位试探。 */
export function constantTimeEqualHex(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

export function createApiKeyValue(): { id: string; key: string } {
  const id = randomHex(5);
  const secret = randomHex(16);
  return { id, key: `fd_${id}_${secret}` };
}

/** 取出密钥里的 id；格式不对返回 null。 */
export function apiKeyId(key: string | null | undefined): string | null {
  const match = API_KEY_PATTERN.exec((key || "").trim());
  return match ? match[1] : null;
}

/** 看起来像不像我们的密钥（用于把 Basic 密码位当密钥尝试）。 */
export function looksLikeApiKey(value: string | null | undefined): boolean {
  return apiKeyId(value) !== null;
}

function objectName(id: string): string {
  return `${APIKEY_PREFIX}${id}.json`;
}

export async function saveApiKey(
  bucket: R2Bucket,
  record: ApiKeyRecord
): Promise<void> {
  await bucket.put(objectName(record.id), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function loadApiKey(
  bucket: R2Bucket,
  id: string
): Promise<ApiKeyRecord | null> {
  if (!/^[0-9a-f]{10}$/.test(id)) return null;
  const object: any = await bucket.get(objectName(id));
  if (!object || !("body" in object)) return null;
  try {
    const record = JSON.parse(await object.text());
    if (!record || typeof record.hash !== "string") return null;
    return record as ApiKeyRecord;
  } catch (error) {
    return null;
  }
}

export async function listApiKeys(bucket: R2Bucket): Promise<ApiKeyRecord[]> {
  const records: ApiKeyRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed: any = await bucket.list({ prefix: APIKEY_PREFIX, cursor });
    for (const object of listed.objects || []) {
      const body: any = await bucket.get(object.key);
      if (!body || !("body" in body)) continue;
      try {
        const record = JSON.parse(await body.text());
        if (record && typeof record.hash === "string") records.push(record);
      } catch (error) {
        // 忽略损坏的记录
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return records.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

export async function deleteApiKey(
  bucket: R2Bucket,
  id: string
): Promise<boolean> {
  const existing = await loadApiKey(bucket, id);
  if (!existing) return false;
  await bucket.delete(objectName(id));
  return true;
}

const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/** 记录最后使用时间，十分钟内的重复使用不重复写。 */
async function touchApiKey(
  bucket: R2Bucket,
  record: ApiKeyRecord
): Promise<void> {
  const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (last && Date.now() - last < TOUCH_INTERVAL_MS) return;
  record.lastUsedAt = new Date().toISOString();
  try {
    await saveApiKey(bucket, record);
  } catch (error) {
    // 统计信息写失败不影响认证结果
  }
}

/** 校验密钥：存在、摘要一致、未过期。 */
export async function verifyApiKey(
  bucket: R2Bucket,
  key: string | null | undefined
): Promise<ApiKeyRecord | null> {
  const id = apiKeyId(key);
  if (!id) return null;

  const record = await loadApiKey(bucket, id);
  if (!record) return null;

  const hash = await sha256Hex(String(key).trim());
  if (!constantTimeEqualHex(record.hash, hash)) return null;

  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    return null;
  }

  await touchApiKey(bucket, record);
  return record;
}

/** 对外返回的安全字段（不含摘要）。 */
export function publicApiKey(record: ApiKeyRecord) {
  return {
    id: record.id,
    name: record.name,
    hint: record.hint,
    permissions: record.permissions,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    expiresAt: record.expiresAt || null,
    createdBy: record.createdBy || null,
  };
}

export interface CreateApiKeyInput {
  name: string;
  permissions: string[] | string | undefined;
  expiresInDays: number | null;
  createdBy: string | null;
}

export async function createApiKey(
  bucket: R2Bucket,
  input: CreateApiKeyInput
): Promise<{ record: ApiKeyRecord; key: string }> {
  const { id, key } = createApiKeyValue();
  const permissions = Array.isArray(input.permissions)
    ? parsePermissions(input.permissions.join(","))
    : parsePermissions(input.permissions);

  const now = new Date();
  const record: ApiKeyRecord = {
    id,
    name: input.name,
    hash: await sha256Hex(key),
    hint: `fd_${id}`,
    permissions: permissions.length ? permissions : ["*"],
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt:
      input.expiresInDays && input.expiresInDays > 0
        ? new Date(
            now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000
          ).toISOString()
        : null,
    createdBy: input.createdBy,
  };

  await saveApiKey(bucket, record);
  return { record, key };
}
