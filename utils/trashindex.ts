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
  /**
   * 「保留内容」模式下，内容被搬到了这里（回收站内部路径）。
   * 不填 = 标记模式：内容还在原路径，只是对外隐藏。
   *
   * 为什么要两种：删除用标记模式（瞬间完成、不搬数据）；
   * 而「覆盖前保留旧文件」必须真的把旧内容搬走——否则紧随其后的写入会把它顶掉，
   * 恢复出来的就是新文件了。
   */
  movedTo?: string;
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
  entryCache = null;
}

/** 当前生效的回收站前缀列表（缓存 5 秒）。 */
export async function trashedPrefixes(bucket: R2Bucket): Promise<string[]> {
  const now = Date.now();
  if (indexCache && now - indexCache.at < INDEX_TTL) return indexCache.prefixes;
  // 只隐藏「标记模式」的记录：moved 模式的原路径已经空了，
  // 新文件要能正常写到那儿（这正是覆盖流程）
  const prefixes = (await listTrash(bucket))
    .filter((entry) => !entry.movedTo)
    .map((entry) => entry.key)
    .filter(Boolean);
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

/**
 * 带删除时间的前缀列表（缓存 5 秒）。
 *
 * 为什么需要时间：删除用标记模式，旧内容只是被隐藏、还留在原地。
 * 如果用户后来在同一位置重新写了东西（往同名文件夹里解压、上传），
 * 那是新内容，不能被旧记录一并藏掉——否则就会出现
 * 「解压提示成功，但文件/文件夹不见了」这种事。
 * 所以判定隐藏时，删除时间之前写入的对象才隐藏，之后写入的照常显示。
 */
export interface TrashedPrefix {
  key: string;
  /** 删除时间（毫秒）。早于它写入的对象才算被删内容。 */
  at: number;
}

interface EntryCache {
  at: number;
  prefixes: TrashedPrefix[];
}
let entryCache: EntryCache | null = null;

export function invalidateTrashedEntries(): void {
  entryCache = null;
}

export async function trashedEntries(bucket: R2Bucket): Promise<TrashedPrefix[]> {
  const now = Date.now();
  if (entryCache && now - entryCache.at < INDEX_TTL) return entryCache.prefixes;
  const prefixes = (await listTrash(bucket))
    .filter((entry) => !entry.movedTo)
    .map((entry) => ({
      key: normalize(entry.key),
      at: Date.parse(entry.deletedAt) || 0,
    }))
    .filter((entry): entry is TrashedPrefix => Boolean(entry.key));
  entryCache = { at: now, prefixes };
  return prefixes;
}

/**
 * 拿到带时间的列表后的同步判定：
 * 命中回收站前缀，且对象的写入时间不晚于删除时间 → 属于被删内容 → 隐藏。
 * writtenAt 传 0/undefined 表示未知时间，维持旧行为（一律隐藏）。
 */
export function matchesTrashedEntry(
  prefixes: TrashedPrefix[],
  key: string,
  writtenAt: number
): boolean {
  const target = normalize(key);
  if (!target) return false;
  for (const prefix of prefixes) {
    if (target === prefix.key || target.startsWith(`${prefix.key}/`)) {
      return !(writtenAt > prefix.at);
    }
  }
  return false;
}
