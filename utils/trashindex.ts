/**
 * 回收站索引：记录读取 + 「某个 key 是否被回收」的判定。
 *
 * 单独成文件是为了避免循环依赖：
 *   core.ts  →  trashindex.ts（只依赖 R2 与 config，不依赖 core）
 *   trash.ts →  core.ts + trashindex.ts
 * 否则 core 与 trash 会互相 import。
 *
 * 判定结果在实例内缓存几秒——每个读请求都要判断，逐个列回收站目录太浪费。
 */
import { TRASH_PREFIX } from "./config";

export interface TrashEntry {
  id: string;
  /** 被删除时的原始路径（恢复就回这里） */
  key: string;
  name: string;
  type: "file" | "folder";
  size: number;
  count: number;
  deletedAt: string;
  /** 删除者（账号名），受限账号只能看到自己删的 */
  deletedBy: string | null;
}

function normalize(key: string): string {
  return (key || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function isTrashKey(key: string): boolean {
  return normalize(key).startsWith(TRASH_PREFIX);
}

export function trashEntryKey(id: string): string {
  return `${TRASH_PREFIX}${normalize(id)}.json`;
}

export function createTrashId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${Date.now().toString(36)}-${random}`;
}

/** 读原始记录（不走 core，避免循环依赖） */
export async function listTrash(bucket: R2Bucket): Promise<TrashEntry[]> {
  const entries: TrashEntry[] = [];
  let cursor: string | undefined;
  do {
    const listed: any = await bucket.list({ prefix: TRASH_PREFIX, cursor });
    for (const object of listed.objects || []) {
      const key = object.key as string;
      if (!key.endsWith(".json")) continue;
      try {
        const body: any = await bucket.get(key);
        if (!body || typeof body.text !== "function") continue;
        const parsed = JSON.parse(await body.text());
        if (parsed && typeof parsed.id === "string" && typeof parsed.key === "string") {
          entries.push(parsed as TrashEntry);
        }
      } catch (error) {
        console.warn("[flaredrive] 回收站记录解析失败", key, error);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return entries.sort((left, right) =>
    String(right.deletedAt).localeCompare(String(left.deletedAt))
  );
}

export async function loadTrashEntry(
  bucket: R2Bucket,
  id: string
): Promise<TrashEntry | null> {
  const body: any = await bucket.get(trashEntryKey(id));
  if (!body || typeof body.text !== "function") return null;
  try {
    return JSON.parse(await body.text()) as TrashEntry;
  } catch (error) {
    return null;
  }
}

export async function saveTrashEntry(bucket: R2Bucket, entry: TrashEntry): Promise<void> {
  await bucket.put(trashEntryKey(entry.id), JSON.stringify(entry), {
    httpMetadata: { contentType: "application/json" },
  });
  invalidateTrashIndex();
}

export async function removeTrashEntry(bucket: R2Bucket, id: string): Promise<void> {
  await bucket.delete(trashEntryKey(id));
  invalidateTrashIndex();
}

/* ------------------------------------------------------------------ *
 * 「是否被回收」的判定（带短缓存）
 * ------------------------------------------------------------------ */

interface IndexCache {
  at: number;
  prefixes: string[];
}
const INDEX_TTL = 5000;
let indexCache: IndexCache | null = null;

export function invalidateTrashIndex(): void {
  indexCache = null;
}

/** 当前生效的回收站前缀列表（缓存 5 秒）。 */
export async function trashedPrefixes(bucket: R2Bucket): Promise<string[]> {
  const now = Date.now();
  if (indexCache && now - indexCache.at < INDEX_TTL) return indexCache.prefixes;
  const prefixes = (await listTrash(bucket)).map((entry) => entry.key).filter(Boolean);
  indexCache = { at: now, prefixes };
  return prefixes;
}

/** key 本身或它的祖先是否在回收站里（异步版，读缓存）。 */
export async function isTrashed(bucket: R2Bucket, key: string): Promise<boolean> {
  const target = normalize(key);
  if (!target) return false;
  return matchesTrashed(await trashedPrefixes(bucket), target);
}

/** 已经拿到前缀列表时的同步判定。 */
export function matchesTrashed(prefixes: string[], key: string): boolean {
  const target = normalize(key);
  if (!target) return false;
  for (const prefix of prefixes) {
    if (target === prefix || target.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
