import {
  DIRECTORY_CONTENT_TYPE,
  Env,
  INTERNAL_PREFIX,
  LEGACY_DIR_MARKER,
} from "./config";
import { normalizePath } from "./auth";
import {
  isTrashed,
  matchesTrashed,
  matchesTrashedEntry,
  type TrashedPrefix,
  trashedEntries,
  trashedPrefixes,
} from "./trashindex";

// 供 trash.ts 等复用，避免各处再从 auth 引一次
export { normalizePath };

/** 目录只有两种载体：目录对象本身，或旧的 `X/_$folder$` 标记。 */
export interface ObjectMeta {
  key: string;
  size: number;
  uploaded: Date | null;
  etag: string;
  httpEtag: string;
  contentType: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  customMetadata: Record<string, string>;
  thumbnail: string | null;
}

export interface FileEntry extends ObjectMeta {
  name: string;
}

export interface FolderEntry {
  key: string;
  name: string;
  /** 该目录是旧版 `_$folder$` 标记形成的。 */
  legacy: boolean;
}

export interface Listing {
  path: string;
  exists: boolean;
  isCollection: boolean;
  files: FileEntry[];
  folders: FolderEntry[];
}

export interface PathStat {
  key: string;
  exists: boolean;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
  etag: string | null;
  httpEtag: string | null;
  contentType: string;
  customMetadata: Record<string, string>;
  thumbnail: string | null;
  /** 目录是通过旧标记或纯前缀推断出来的，没有目录对象。 */
  synthetic: boolean;
}

export class CoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CoreError";
    this.status = status;
  }
}

const INTERNAL_BARE = INTERNAL_PREFIX.replace(/\/$/, "");

export function baseName(key: string): string {
  const trimmed = normalizePath(key);
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export function isInternalKey(key: string): boolean {
  const target = normalizePath(key);
  return target === INTERNAL_BARE || target.startsWith(INTERNAL_PREFIX);
}

export function isLegacyDirMarker(key: string): boolean {
  return normalizePath(key).endsWith(`/${LEGACY_DIR_MARKER}`);
}

export function legacyDirKey(key: string): string {
  return normalizePath(key).slice(0, -(LEGACY_DIR_MARKER.length + 1));
}

export function isDirectoryObject(obj: any): boolean {
  return obj?.httpMetadata?.contentType === DIRECTORY_CONTENT_TYPE;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function toMeta(obj: any): ObjectMeta {
  const etag = typeof obj.etag === "string" ? obj.etag : "";
  return {
    key: obj.key,
    size: typeof obj.size === "number" ? obj.size : 0,
    uploaded: toDate(obj.uploaded),
    etag,
    httpEtag: typeof obj.httpEtag === "string" && obj.httpEtag ? obj.httpEtag : etag ? `"${etag}"` : "",
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    contentDisposition: obj.httpMetadata?.contentDisposition,
    contentLanguage: obj.httpMetadata?.contentLanguage,
    cacheControl: obj.httpMetadata?.cacheControl,
    customMetadata: obj.customMetadata || {},
    thumbnail: obj.customMetadata?.thumbnail || null,
  };
}

function toFileEntry(obj: any): FileEntry {
  const meta = toMeta(obj);
  return { ...meta, name: baseName(meta.key) };
}

function timeOf(obj: any): number {
  const value = obj && (obj.uploaded ?? obj.uploaded_at);
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/**
 * 文件夹在列表里只有名字（没有时间戳），判断它该不该被回收站记录藏起来，
 * 只能去前缀底下找证据：只要存在一个「删除之后写入」的对象，这个文件夹
 * 就是用户后来重新建出来的，必须显示。找不到就直接沿用旧判定。
 */
async function subtreeHasNewContent(
  bucket: R2Bucket,
  dirKey: string,
  trashedPre?: TrashedPrefix[]
): Promise<boolean> {
  const trashed = trashedPre || (await trashedEntries(bucket));
  const hit = trashed.find(
    (entry) => dirKey === entry.key || dirKey.startsWith(`${entry.key}/`)
  );
  if (!hit) return false;
  // 路径本身就是文件：直接看它自己的写入时间
  if (dirKey !== hit.key) {
    const self: any = await bucket.head(dirKey);
    return Boolean(self && timeOf(self) > hit.at);
  }
  // 旧内容还在原地且都早于删除时间，不能只看第一个对象——
  // 得翻到出现「删除之后写入」的对象为止，翻完都没有才继续藏。
  let cursor: string | undefined;
  do {
    const probe: any = await bucket.list({
      prefix: `${dirKey}/`,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    } as any);
    for (const obj of probe.objects || []) {
      if (isInternalKey(obj.key)) continue;
      if (timeOf(obj) > hit.at) return true;
    }
    cursor = probe.truncated ? probe.cursor : undefined;
  } while (cursor);
  return false;
}

/**
 * 递归/一层列出对象，自动翻页，并跳过内部保留目录。
 * 默认也会跳过「已进回收站」的内容（includeTrashed=true 时才包含，
 * 只有回收站自身的彻底删除/清空需要）。
 */
export async function* listAll(
  bucket: R2Bucket,
  prefix = "",
  recursive = false,
  options: { includeTrashed?: boolean } = {}
): AsyncGenerator<any> {
  const trashed = options.includeTrashed ? [] : await trashedEntries(bucket);
  let cursor: string | undefined;
  do {
    const listed: any = await bucket.list({
      prefix,
      delimiter: recursive ? undefined : "/",
      cursor,
      include: ["httpMetadata", "customMetadata"],
    } as any);

    for (const obj of listed.objects || []) {
      if (isInternalKey(obj.key)) continue;
      if (!options.includeTrashed && matchesTrashedEntry(trashed, obj.key, timeOf(obj))) continue;
      yield obj;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** 该路径是否是目录（含目录对象、旧标记、纯前缀三种情形）。 */
export async function isCollectionPath(
  bucket: R2Bucket,
  path: string
): Promise<boolean> {
  const target = normalizePath(path);
  if (!target) return true;
  // 回收站里的内容对外一律「不存在」；但用户后来在同一位置重新写过的东西
  // （往删过的同名文件夹里解压/上传）是活内容，路径要算「存在」
  if (await isTrashed(bucket, target)) {
    return await subtreeHasNewContent(bucket, target);
  }

  const head: any = await bucket.head(target);
  if (head) {
    if (isDirectoryObject(head)) return true;
    const marker: any = await bucket.head(`${target}/${LEGACY_DIR_MARKER}`);
    if (marker) return true;
    return false;
  }

  const marker: any = await bucket.head(`${target}/${LEGACY_DIR_MARKER}`);
  if (marker) return true;

  const probe: any = await bucket.list({ prefix: `${target}/`, limit: 1 } as any);
  return (
    (probe.objects || []).length > 0 ||
    (probe.delimitedPrefixes || []).length > 0
  );
}

const ROOT_STAT: PathStat = {
  key: "",
  exists: true,
  isDirectory: true,
  size: 0,
  uploaded: null,
  etag: null,
  httpEtag: null,
  contentType: DIRECTORY_CONTENT_TYPE,
  customMetadata: {},
  thumbnail: null,
  synthetic: false,
};

/** 探测单个路径。返回 null 表示不存在。 */
export async function statPath(
  bucket: R2Bucket,
  path: string
): Promise<PathStat | null> {
  const target = normalizePath(path);
  if (!target) return { ...ROOT_STAT };
  // 回收站里的内容对外一律「不存在」：直链 404、WebDAV 读不到、也不能再签直链。
  // 但删除之后重新写入的对象是活内容，要放行（见 subtreeHasNewContent）
  if (await isTrashed(bucket, target)) {
    if (await subtreeHasNewContent(bucket, target)) {
      return statPathRaw(bucket, target);
    }
    return null;
  }

  const head: any = await bucket.head(target);
  if (head) {
    const meta = toMeta(head);
    return {
      ...meta,
      exists: true,
      isDirectory: isDirectoryObject(head),
      synthetic: false,
    };
  }

  const isDir = await isCollectionPath(bucket, target);
  if (!isDir) return null;

  return {
    key: target,
    exists: true,
    isDirectory: true,
    size: 0,
    uploaded: null,
    etag: null,
    httpEtag: null,
    contentType: DIRECTORY_CONTENT_TYPE,
    customMetadata: {},
    thumbnail: null,
    synthetic: true,
  };
}

/**
 * 与 statPath 相同，但**不过滤回收站**（只有彻底删除需要，因为那时内容还在原路径）。
 */
async function statPathRaw(
  bucket: R2Bucket,
  path: string
): Promise<PathStat | null> {
  const target = normalizePath(path);
  if (!target) return { ...ROOT_STAT };

  const head: any = await bucket.head(target);
  if (head) {
    const meta = toMeta(head);
    return {
      ...meta,
      exists: true,
      isDirectory: isDirectoryObject(head),
      synthetic: false,
    };
  }

  const marker: any = await bucket.head(`${target}/${LEGACY_DIR_MARKER}`);
  if (marker) {
    return {
      key: target,
      exists: true,
      isDirectory: true,
      size: 0,
      uploaded: null,
      etag: null,
      httpEtag: null,
      contentType: DIRECTORY_CONTENT_TYPE,
      customMetadata: {},
      thumbnail: null,
      synthetic: true,
    };
  }

  const probe: any = await bucket.list({ prefix: `${target}/`, limit: 1 } as any);
  const hasChild =
    (probe.objects || []).length > 0 || (probe.delimitedPrefixes || []).length > 0;
  if (!hasChild) return null;

  return {
    key: target,
    exists: true,
    isDirectory: true,
    size: 0,
    uploaded: null,
    etag: null,
    httpEtag: null,
    contentType: DIRECTORY_CONTENT_TYPE,
    customMetadata: {},
    thumbnail: null,
    synthetic: true,
  };
}

/** 列出目录的直接子项（一层）。 */
export async function listDirectory(
  bucket: R2Bucket,
  path: string
): Promise<Listing> {
  const target = normalizePath(path);
  const prefix = target ? `${target}/` : "";
  const folders = new Map<string, FolderEntry>();
  const files: FileEntry[] = [];
  let sawChild = false;
  let cursor: string | undefined;
  const trashed = await trashedEntries(bucket);

  do {
    const listed: any = await bucket.list({
      prefix,
      delimiter: "/",
      cursor,
      include: ["httpMetadata", "customMetadata"],
    } as any);

    for (const obj of listed.objects || []) {
      const key = obj.key as string;
      if (isInternalKey(key)) continue;
      if (matchesTrashedEntry(trashed, key, timeOf(obj))) continue;
      sawChild = true;

      if (isDirectoryObject(obj)) {
        folders.set(key, { key, name: baseName(key), legacy: false });
        continue;
      }
      if (isLegacyDirMarker(key)) {
        const dirKey = legacyDirKey(key);
        if (dirKey) folders.set(dirKey, { key: dirKey, name: baseName(dirKey), legacy: true });
        continue;
      }
      files.push(toFileEntry(obj));
    }

    for (const raw of listed.delimitedPrefixes || []) {
      const dirKey = normalizePath(raw as string);
      if (!dirKey || isInternalKey(dirKey)) continue;
      if (
        matchesTrashedEntry(trashed, dirKey, 0) &&
        !(await subtreeHasNewContent(bucket, dirKey, trashed))
      ) {
        continue;
      }
      sawChild = true;
      if (!folders.has(dirKey)) {
        folders.set(dirKey, { key: dirKey, name: baseName(dirKey), legacy: false });
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  let isCollection = target === "" ? true : sawChild;
  if (target !== "" && !isCollection) {
    isCollection = await isCollectionPath(bucket, target);
  }

  return {
    path: target,
    exists: target === "" ? true : isCollection,
    isCollection,
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    folders: Array.from(folders.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
  };
}

/** 创建目录对象。 */
export async function putDirectory(
  bucket: R2Bucket,
  path: string
): Promise<void> {
  const target = normalizePath(path);
  if (!target) return;
  await bucket.put(target, "", {
    httpMetadata: { contentType: DIRECTORY_CONTENT_TYPE },
  });
}

/** 确保某个 key 的所有父目录都存在目录对象（内部目录除外）。 */
export async function ensureDirectories(
  bucket: R2Bucket,
  path: string
): Promise<void> {
  const target = normalizePath(path);
  if (!target || isInternalKey(target)) return;

  const segments = target.split("/");
  let current = "";
  for (let i = 0; i < segments.length - 1; i++) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    if (isInternalKey(current)) continue;

    const head: any = await bucket.head(current);
    if (head) {
      // 已存在同名对象：是目录对象或旧标记就跳过，是普通文件则不覆盖
      continue;
    }
    const marker: any = await bucket.head(`${current}/${LEGACY_DIR_MARKER}`);
    if (marker) continue;
    await putDirectory(bucket, current);
  }
}

/** 确保该目录自身及其所有祖先目录都有目录对象。 */
export async function ensureDirectoryChain(
  bucket: R2Bucket,
  path: string
): Promise<void> {
  const target = normalizePath(path);
  if (!target || isInternalKey(target)) return;
  await ensureDirectories(bucket, `${target}/_chain_probe_`);
}

/** 写入缩略图等小对象时的元数据组装。 */
export function objectWriteOptions(
  request: Request,
  options?: { thumbnail?: string | null; cacheControl?: string }
): { httpMetadata: any; customMetadata?: Record<string, string> } {
  const httpMetadata: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type");
  if (contentType) httpMetadata.contentType = contentType;

  const contentDisposition = request.headers.get("Content-Disposition");
  if (contentDisposition) httpMetadata.contentDisposition = contentDisposition;

  const contentLanguage = request.headers.get("Content-Language");
  if (contentLanguage) httpMetadata.contentLanguage = contentLanguage;

  if (options?.cacheControl) httpMetadata.cacheControl = options.cacheControl;

  const customMetadata: Record<string, string> = {};
  const thumbnail =
    options?.thumbnail ?? request.headers.get("fd-thumbnail") ?? null;
  if (thumbnail) customMetadata.thumbnail = thumbnail;

  return Object.keys(customMetadata).length
    ? { httpMetadata, customMetadata }
    : { httpMetadata };
}

async function deleteKeysBatched(
  bucket: R2Bucket,
  keys: string[]
): Promise<void> {
  const unique = Array.from(new Set(keys.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    if (batch.length) await (bucket as any).delete(batch);
  }
}

/**
 * 删除对象或整个目录（目录会递归删掉所有子对象与旧标记）。
 * 返回删除的对象数量；路径不存在时返回 0。
 */
export async function deletePath(
  bucket: R2Bucket,
  path: string,
  options: { includeTrashed?: boolean } = {}
): Promise<number> {
  const target = normalizePath(path);
  if (!target) throw new CoreError(403, "不允许删除根目录");
  // 默认不允许硬删回收站里的内容：那属于「彻底删除」，必须走回收站接口
  if (!options.includeTrashed && (await isTrashed(bucket, target))) {
    throw new CoreError(409, "该路径在回收站里，请从回收站恢复或彻底删除");
  }

  const stat = options.includeTrashed
    ? await statPathRaw(bucket, target)
    : await statPath(bucket, target);
  if (!stat) return 0;

  if (!stat.isDirectory) {
    await bucket.delete(target);
    return 1;
  }

  const keys: string[] = [];
  const prefix = `${target}/`;
  for await (const obj of listAll(bucket, prefix, true, {
    includeTrashed: options.includeTrashed,
  })) {
    keys.push(obj.key);
  }
  keys.push(`${target}/${LEGACY_DIR_MARKER}`);
  keys.push(target);

  const count = keys.length;
  await deleteKeysBatched(bucket, keys);
  return count;
}

/** 并发受限的任务泵。 */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = new Array(size).fill(null).map(async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

export interface CopyOptions {
  overwrite?: boolean;
  /** "0" 只复制集合本身，"infinity" 递归复制。 */
  depth?: "0" | "infinity";  /** 恢复流程专用：允许把内容写回回收站标记的原位置 */
  allowIntoTrashed?: boolean;
}

export interface CopyResult {
  created: boolean;
  copied: number;
}

/**
 * 复制对象或目录。复制目录时会顺带把旧版 `X/_$folder$` 标记迁移成目录对象。
 */
export async function copyPath(
  bucket: R2Bucket,
  sourcePath: string,
  destinationPath: string,
  options: CopyOptions = {}
): Promise<CopyResult> {
  const source = normalizePath(sourcePath);
  const destination = normalizePath(destinationPath);
  const overwrite = options.overwrite !== false;
  const depth = options.depth || "infinity";

  if (!destination) throw new CoreError(403, "目标路径非法");
  if (source === destination) throw new CoreError(400, "源与目标相同");
  // 不许把东西写进「已回收」的位置：那里还留着旧内容，会造成两边打架。
  // 例外：恢复流程（allowIntoTrashed）就是要写回回收站里的原位置；
  // 以及目标位置已经有「删除之后新写入」的活内容（见 subtreeHasNewContent）。
  if (await isTrashed(bucket, destination) && !options.allowIntoTrashed) {
    if (!(await subtreeHasNewContent(bucket, destination))) {
      throw new CoreError(409, "目标路径在回收站里，请先恢复或彻底删除");
    }
  }
  if (source && destination.startsWith(`${source}/`)) {
    throw new CoreError(400, "不能把资源复制到自身子目录");
  }

  const sourceStat = await statPath(bucket, source);
  if (!sourceStat) throw new CoreError(404, "源不存在");

  const destinationStat = await statPath(bucket, destination);
  if (destinationStat) {
    if (!overwrite) throw new CoreError(412, "目标已存在");
    await deletePath(bucket, destination);
  }
  const created = !destinationStat;

  if (!sourceStat.isDirectory) {
    const object: any = await bucket.get(source);
    if (!object || !("body" in object)) throw new CoreError(404, "源不存在");
    await bucket.put(destination, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    return { created, copied: 1 };
  }

  await putDirectory(bucket, destination);
  if (depth === "0") return { created, copied: 0 };

  const prefix = `${source}/`;
  const objects: any[] = [];
  for await (const obj of listAll(bucket, prefix, true)) objects.push(obj);

  let copied = 0;
  await mapLimit(objects, 4, async (obj) => {
    const key = obj.key as string;
    const relative = key.slice(prefix.length);
    if (!relative) return;

    if (isLegacyDirMarker(key)) {
      const dirRelative = relative.slice(0, -(LEGACY_DIR_MARKER.length + 1));
      if (dirRelative) await putDirectory(bucket, `${destination}/${dirRelative}`);
      return;
    }

    const object: any = await bucket.get(key);
    if (!object || !("body" in object)) return;
    await bucket.put(`${destination}/${relative}`, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    copied += 1;
  });

  return { created, copied };
}

/**
 * 统计目录下的对象数量与总大小（用于打包下载与回收站记录）。
 * 大目录分页累计；超过 maxCount 只保证「不少于」的下限（标记 `>=` 语义），
 * 避免删一个几万文件的目录时统计本身把请求拖到超时。
 */
export async function measurePath(
  bucket: R2Bucket,
  path: string,
  options: { maxCount?: number } = {}
): Promise<{ count: number; size: number; approximate: boolean }> {
  const target = normalizePath(path);
  const prefix = target ? `${target}/` : "";
  const maxCount = options.maxCount ?? 10000;
  let count = 0;
  let size = 0;
  let cursor: string | undefined;
  for (;;) {
    const listed: any = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects || []) {
      if (isInternalKey(obj.key)) continue;
      count += 1;
      size += typeof obj.size === "number" ? obj.size : 0;
    }
    if (count >= maxCount) return { count, size, approximate: Boolean(listed.truncated) || count > maxCount };
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
  return { count, size, approximate: false };
}

/** 缩略图对象的 cache-control 由写入方决定，这里只提供常量。 */
export const THUMBNAIL_CACHE_CONTROL = "max-age=31536000";

export function isThumbnailKey(key: string): boolean {
  return normalizePath(key).startsWith(`${INTERNAL_BARE}/thumbnails/`);
}
