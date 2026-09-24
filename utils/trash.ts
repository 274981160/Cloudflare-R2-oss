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
import {
  Env, TRASH_PREFIX, trashDays } from "./config";
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
  isTrashed,
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

/**
 * 移入回收站。
 *
 * 默认「标记模式」：只写记录、内容原地不动，对外隐藏——删除瞬间完成。
 * `preserveContent` 时改成「搬走模式」：把内容真的移到回收站内部路径。
 * 覆盖场景必须用后者，否则紧随其后的写入会把旧内容顶掉，恢复出来就是新文件了。
 *
 * 返回 null 表示路径不存在。
 */
export async function moveToTrash(
  bucket: R2Bucket,
  path: string,
  deletedBy: string | null,
  options: { preserveContent?: boolean } = {}
): Promise<TrashEntry | null> {
  const target = normalizePath(path);
  if (!target) throw new CoreError(403, "不允许删除根目录");
  if (isTrashKey(target)) throw new CoreError(403, "回收站本身不能删除");

  const stat = await statPath(bucket, target);
  if (!stat) return null;

  // 大目录只测到上限为止（记录里 count 会标成下限），别让统计本身拖垮删除请求
  const measured = stat.isDirectory
    ? await measurePath(bucket, target, { maxCount: 5000 })
    : { count: 1, size: stat.size, approximate: false };

  const id = createTrashId();
  const name = baseNameOf(target) || target;
  const entry: TrashEntry = {
    id,
    key: target,
    name,
    type: stat.isDirectory ? "folder" : "file",
    size: measured.size,
    count: measured.count,
    deletedAt: new Date().toISOString(),
    deletedBy,
  };

  // 只有「文件」才搬内容：目录搬起来可能是几个 GB，代价太大；
  // 而 PUT/MKCOL 本来就不允许用文件覆盖目录，不会走到这里。
  if (options.preserveContent && !stat.isDirectory) {
    const movedTo = `${TRASH_PREFIX}objects/${id}/${encodeURIComponent(name).replace(/%2F/gi, "_")}`;
    await copyPath(bucket, target, movedTo, { overwrite: true, depth: "0" });
    await deletePath(bucket, target, { includeTrashed: true });
    entry.movedTo = movedTo;
  }

  await saveTrashEntry(bucket, entry);
  return entry;
}

/**
 * 覆盖写入前的保险：目标已存在就先把它收进回收站（保留内容）。
 * 返回被保留的记录（没覆盖到东西时返回 null）。
 */
export async function preserveBeforeOverwrite(
  bucket: R2Bucket,
  key: string,
  deletedBy: string | null
): Promise<TrashEntry | null> {
  const target = normalizePath(key);
  if (!target || isTrashKey(target)) return null;
  const existing = await statPath(bucket, target);
  if (!existing || existing.isDirectory) return null;
  return moveToTrash(bucket, target, deletedBy, { preserveContent: true });
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
  const source = entry.movedTo || entry.key;
  if (!(await pathHasContent(bucket, source))) {
    await removeTrashEntry(bucket, id);
    throw new CoreError(410, "该项的内容已被彻底删除，无法恢复（已从回收站移除）");
  }

  let target = entry.key;
  let renamed = false;
  // 「原位置被占用」指的是那里有**别的**活内容。目标位置还在这条记录自己的
  // 隐藏范围内时不算占用——那正是恢复要去的地方（用户后来往里新写的文件，
  // 恢复后会与新内容共存；真撞名时 copyPath 的 overwrite:false 会如实报 412）。
  const selfHidden = await isTrashed(bucket, entry.key);
  if (!selfHidden && (await statPath(bucket, target))) {
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

  // 恢复是「写回回收站标记的原位置」，copyPath 的回收站拦截要放行；
  // 原位置里用户后来新写入的文件不属于这条记录，不能动（allowIntoTrashed
  // 配 overwrite:false 恰好保证：同名会 412 报错，其余新文件原样保留）。
  const restoreOptions = { overwrite: false, depth: "infinity", allowIntoTrashed: true } as const;
  if (entry.movedTo) {
    // 覆盖时被搬走的内容：搬回目标路径
    await copyPath(bucket, entry.movedTo, target, restoreOptions);
    await deletePath(bucket, entry.movedTo, { includeTrashed: true });
  } else if (target !== entry.key) {
    // 标记模式且原位置被占用：这才需要真的搬一次（copy + delete）。
    // 旧位置在回收站标记下，删除时要带 includeTrashed 才删得掉。
    await copyPath(bucket, entry.key, target, restoreOptions);
    await deletePath(bucket, entry.key, { includeTrashed: true });
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
  const deleted = entry.movedTo
    ? await deletePath(bucket, entry.movedTo, { includeTrashed: true })
    : await deletePath(bucket, entry.key, { includeTrashed: true });
  await removeTrashEntry(bucket, id);

  // 若回收站里还有「位于它内部」的条目，那些内容已经被一并删掉，
  // 记录要一起清掉，免得上层恢复/列表里出现指向空气的条目
  const rest = await listTrash(bucket);
  for (const other of rest) {
    if (other.id === id) continue;
    // 指向被彻底删除内容的「标记模式」下级记录一并清掉；
    // moved 模式的内容在回收站自己的路径里，不受影响
    if (other.movedTo) continue;
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
