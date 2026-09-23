/**
 * 回收站（软删除）。
 *
 * 设计取舍：**不搬对象，只写一条标记记录**。
 *
 * 为什么不用「把文件移到 trash/ 目录」：R2 没有 rename/move，只能 copy+delete。
 * 删一个几 GB 的目录就要把几 GB 数据在 Worker 里读一遍再写一遍——慢、耗配额，
 * 而且中途失败会留下「一半在回收站、一半在原处」的烂摊子。
 *
 * 这里改成：删除时只在 `_$flaredrive$/trash/<id>.json` 写一条记录（原路径、大小、
 * 删除时间…），文件本身原地不动；所有读取路径通过 isTrashed() 把这些前缀当成
 * 「不存在」——列表看不到、直链 404、WebDAV 也读不到。删除因此瞬间完成，
 * 恢复只是删掉那条记录（内容一直都在）。
 *
 * 代价：被回收的内容仍占用存储（这是回收站的正常代价），彻底删除时才真的删。
 */
import { Env, TRASH_PREFIX, trashDays } from "./config";
import {
  CoreError,
  copyPath,
  deletePath,
  measurePath,
  normalizePath,
  statPath,
} from "./core";
import {
  createTrashId,
  isTrashKey,
  listTrash,
  loadTrashEntry,
  removeTrashEntry,
  saveTrashEntry,
  type TrashEntry,
} from "./trashindex";

export { isTrashKey, listTrash, loadTrashEntry, type TrashEntry };

function baseNameOf(key: string): string {
  const target = normalizePath(key);
  const index = target.lastIndexOf("/");
  return index < 0 ? target : target.slice(index + 1);
}

/**
 * 该路径底下是否还有真实对象（绕开回收站过滤，直接看 R2）。
 * 用于识别「记录还在、内容已被彻底删除」的悬空项。
 */
async function pathHasContent(bucket: R2Bucket, key: string): Promise<boolean> {
  const target = normalizePath(key);
  if (!target) return false;
  const head: any = await bucket.head(target);
  if (head) return true;
  const probe: any = await bucket.list({ prefix: `${target}/`, limit: 1 } as any);
  return (
    (probe.objects || []).length > 0 || (probe.delimitedPrefixes || []).length > 0
  );
}

/** 移入回收站（只写记录，不动文件）。返回 null 表示路径不存在。 */
export async function moveToTrash(
  bucket: R2Bucket,
  path: string,
  deletedBy: string | null
): Promise<TrashEntry | null> {
  const target = normalizePath(path);
  if (!target) throw new CoreError(403, "不允许删除根目录");
  if (isTrashKey(target)) throw new CoreError(403, "回收站本身不能删除");

  const stat = await statPath(bucket, target);
  if (!stat) return null;

  const measured = stat.isDirectory
    ? await measurePath(bucket, target)
    : { count: 1, size: stat.size };

  const entry: TrashEntry = {
    id: createTrashId(),
    key: target,
    name: baseNameOf(target) || target,
    type: stat.isDirectory ? "folder" : "file",
    size: measured.size,
    count: measured.count,
    deletedAt: new Date().toISOString(),
    deletedBy,
  };
  await saveTrashEntry(bucket, entry);
  return entry;
}

export { TRASH_PREFIX };

/**
 * 从回收站恢复。
 * 原位置被占用时自动改成「名字 (恢复)」，绝不覆盖别的文件。
 */
export async function restoreFromTrash(
  bucket: R2Bucket,
  id: string
): Promise<{ key: string; renamed: boolean }> {
  const entry = await loadTrashEntry(bucket, id);
  if (!entry) throw new CoreError(404, "回收站里没有这一项");

  // 内容可能已经被「彻底删除父目录」之类的操作真删掉了，这时要如实告知，
  // 而不是把记录一删了事、让用户以为恢复成功了
  if (!(await pathHasContent(bucket, entry.key))) {
    await removeTrashEntry(bucket, id);
    throw new CoreError(410, "该项的内容已被彻底删除，无法恢复（已从回收站移除）");
  }

  let target = entry.key;
  let renamed = false;
  if (await statPath(bucket, target)) {
    const slash = entry.key.lastIndexOf("/");
    const parent = slash < 0 ? "" : entry.key.slice(0, slash);
    for (let index = 1; index <= 100; index++) {
      const suffix = index === 1 ? " (恢复)" : ` (恢复 ${index})`;
      const candidate = parent
        ? `${parent}/${entry.name}${suffix}`
        : `${entry.name}${suffix}`;
      if (!(await statPath(bucket, candidate))) {
        target = candidate;
        renamed = true;
        break;
      }
    }
    if (!renamed) throw new CoreError(409, "原位置被占用，且没能生成可用的新名字");
  }

  if (target !== entry.key) {
    // 只有「原位置被占用」时才真的要搬一次（copy + delete）
    await copyPath(bucket, entry.key, target, { overwrite: false, depth: "infinity" });
    await deletePath(bucket, entry.key);
  }

  await removeTrashEntry(bucket, id);
  return { key: target, renamed };
}

/**
 * 准备往 `key` 写入时调用：如果回收站里正好有一条**同名文件**记录，
 * 说明那个文件的内容马上就会被覆盖——那条记录已经失去意义，直接清掉。
 *
 * 只处理「文件且路径完全相同」这一种情况：文件夹不动（否则会连带删掉
 * 里面其他仍可恢复的文件），路径在回收站子树里的情况也不动（返回 false，
 * 由调用方给出 409 让用户先恢复或彻底删除）。
 */
export async function releaseTrashedFile(
  bucket: R2Bucket,
  key: string
): Promise<boolean> {
  const target = normalizePath(key);
  if (!target) return false;
  const entries = await listTrash(bucket);
  const hit = entries.find((entry) => entry.key === target && entry.type === "file");
  if (!hit) return false;
  await purgeTrashEntry(bucket, hit.id);
  return true;
}

/** 彻底删除某一项（真正的物理删除）。 */
export async function purgeTrashEntry(
  bucket: R2Bucket,
  id: string
): Promise<number> {
  const entry = await loadTrashEntry(bucket, id);
  if (!entry) throw new CoreError(404, "回收站里没有这一项");
  const deleted = await deletePath(bucket, entry.key, { includeTrashed: true });
  await removeTrashEntry(bucket, id);

  // 若回收站里还有「位于它内部」的条目，那些内容已经被一并删掉，
  // 记录要一起清掉，免得上层恢复/列表里出现指向空气的条目
  const rest = await listTrash(bucket);
  for (const other of rest) {
    if (other.id === id) continue;
    if (other.key === entry.key || other.key.startsWith(`${entry.key}/`)) {
      await removeTrashEntry(bucket, other.id);
    }
  }
  return deleted;
}

/** 清空回收站。 */
export async function emptyTrash(
  bucket: R2Bucket
): Promise<{ items: number; objects: number }> {
  const entries = await listTrash(bucket);
  let objects = 0;
  for (const entry of entries) {
    try {
      objects += await purgeTrashEntry(bucket, entry.id);
    } catch (error) {
      console.warn("[flaredrive] 清空回收站时删除失败", entry.key, error);
    }
  }
  return { items: entries.length, objects };
}

/**
 * 过期自动清理：超过保留天数的项彻底删除。
 * Pages Functions 没有定时任务，所以在每次访问回收站或删除时顺手做一次。
 */
export async function purgeExpired(bucket: R2Bucket, env: Env): Promise<number> {
  const days = trashDays(env);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = await listTrash(bucket);
  let purged = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.deletedAt);
    if (!Number.isFinite(at) || at > deadline) continue;
    try {
      await purgeTrashEntry(bucket, entry.id);
      purged += 1;
    } catch (error) {
      console.warn("[flaredrive] 清理过期回收站项失败", entry.key, error);
    }
  }
  return purged;
}

/** 保留天数（给前端显示）。 */
export function retentionDays(env: Env): number {
  return trashDays(env);
}
