/**
 * WebDAV 锁存储。锁记录放在 R2 内部目录里，因此跨 isolate、跨实例都可见，
 * 不依赖 Durable Object，也不需要额外绑定。
 */
import { INTERNAL_PREFIX, isLockingEnabled, Env } from "./config";
import { normalizePath } from "./auth";

export const LOCK_PREFIX = `${INTERNAL_PREFIX}locks/`;
export const DEFAULT_LOCK_TIMEOUT = 1800;
export const MAX_LOCK_TIMEOUT = 604800; // 7 天，RFC 4918 允许的上限

export interface LockInfo {
  path: string;
  token: string;
  owner: string;
  depth: "0" | "infinity";
  timeoutSeconds: number;
  /** epoch 毫秒 */
  expires: number;
  created: number;
  username: string | null;
}

export function createLockToken(): string {
  const random =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `opaquelocktoken:${random}`;
}

async function lockObjectKey(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizePath(path))
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${LOCK_PREFIX}${hex}.json`;
}

/** 读取某个路径上的锁；已过期的锁会被顺手清掉并视为不存在。 */
export async function readLock(
  bucket: R2Bucket,
  path: string
): Promise<LockInfo | null> {
  const key = await lockObjectKey(path);
  const object: any = await bucket.get(key);
  if (!object || !("body" in object)) return null;

  let info: LockInfo;
  try {
    info = JSON.parse(await object.text());
  } catch (error) {
    await bucket.delete(key);
    return null;
  }

  if (!info || typeof info.expires !== "number") {
    await bucket.delete(key);
    return null;
  }
  if (info.expires <= Date.now()) {
    await bucket.delete(key);
    return null;
  }
  return info;
}

export async function writeLock(
  bucket: R2Bucket,
  info: LockInfo
): Promise<void> {
  const key = await lockObjectKey(info.path);
  await bucket.put(key, JSON.stringify(info), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function dropLock(
  bucket: R2Bucket,
  path: string
): Promise<void> {
  await bucket.delete(await lockObjectKey(path));
}

function ancestorsOf(path: string): string[] {
  const target = normalizePath(path);
  const result: string[] = [];
  if (target) result.push(target);

  let current = target;
  while (current.includes("/")) {
    current = current.slice(0, current.lastIndexOf("/"));
    result.push(current);
  }
  result.push("");
  return Array.from(new Set(result));
}

export interface LockCheckResult {
  locked: boolean;
  token?: string;
  owner?: string;
  path?: string;
}

/**
 * 判断某个写操作是否被锁挡住。
 *
 * - 目标自身的锁（无论 depth 是 0 还是 infinity）都会拦。
 * - 祖先目录的锁只在 depth=infinity 时才会拦住子孙。
 * - 请求携带的 If/Lock-Token 里只要包含该锁令牌就算持有。
 */
export async function findBlockingLock(
  bucket: R2Bucket,
  path: string,
  tokens: string[]
): Promise<LockCheckResult> {
  const target = normalizePath(path);
  const held = new Set(tokens);

  for (const candidate of ancestorsOf(target)) {
    const lock = await readLock(bucket, candidate);
    if (!lock) continue;
    if (held.has(lock.token)) continue;
    if (candidate === target) {
      return { locked: true, token: lock.token, owner: lock.owner, path: lock.path };
    }
    if (lock.depth === "infinity") {
      return { locked: true, token: lock.token, owner: lock.owner, path: lock.path };
    }
  }

  return { locked: false };
}

/** 收集资源自身的锁，以及 depth=infinity 的祖先锁（用于 lockdiscovery）。 */
export async function collectActiveLocks(
  bucket: R2Bucket,
  path: string
): Promise<LockInfo[]> {
  const target = normalizePath(path);
  const locks: LockInfo[] = [];

  const self = await readLock(bucket, target);
  if (self) locks.push(self);

  for (const candidate of ancestorsOf(target)) {
    if (candidate === target) continue;
    const lock = await readLock(bucket, candidate);
    if (lock && lock.depth === "infinity") locks.push(lock);
  }

  return locks;
}

export function normalizeTimeout(seconds: number | null): number {
  if (seconds === null) return DEFAULT_LOCK_TIMEOUT;
  if (!Number.isFinite(seconds)) return MAX_LOCK_TIMEOUT;
  return Math.max(60, Math.min(seconds, MAX_LOCK_TIMEOUT));
}

export function lockingEnabled(env: Env): boolean {
  return isLockingEnabled(env);
}
