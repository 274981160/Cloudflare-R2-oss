/**
 * 在线解压：只通过 R2 的 Range 读取 zip 的尾部（EOCD）与中央目录，
 * 再按条目取本地文件头定位数据区，逐条解压后写回 R2。
 * 不把整个 zip 读进内存，也不需第三方依赖。
 */
import { Env } from "./config";
import { DIRECTORY_CONTENT_TYPE, maxUnzipEntries, maxUnzipFileSize } from "./config";
import { ensureDirectories } from "./core";
import { normalizePath } from "./auth";
import { inflate } from "./inflate";

/** 单个 zip 条目（中央目录记录）。 */
export interface ZipEntryInfo {
  name: string;
  /** 以 / 结尾表示目录。 */
  isDirectory: boolean;
  method: number;
  compSize: number;
  uncompSize: number;
  crc: number;
  localOffset: number;
}

async function readRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  const object: any = await bucket.get(key, { range: { offset, length } } as any);
  if (!object || !("body" in object)) {
    throw new Error("读取 zip 数据失败");
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }
  return merged;
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24)
  ) >>> 0;
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8)) & 0xffff;
}

const EOCD_SIG = 0x06054b50;

/**
 * 读取并解析 zip 中央目录。
 * 返回 null 表示对象太小或找不到 EOCD（不是合法 zip）。
 */
export async function readZipIndex(
  bucket: R2Bucket,
  key: string,
  size: number,
  entryLimit = maxUnzipEntries({} as Env)
): Promise<ZipEntryInfo[] | null> {
  // EOCD 在文件末尾，结构固定 22 字节 + 最长 65535 字节注释
  const tailLen = Math.min(size, 22 + 65535);
  if (tailLen < 22) return null;
  const tail = await readRange(bucket, key, size - tailLen, tailLen);

  let eocdIndex = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (readU32(tail, i) === EOCD_SIG) {
      eocdIndex = i;
      break;
    }
  }
  if (eocdIndex < 0) return null;

  const disk = readU16(tail, eocdIndex + 4);
  const cdDisk = readU16(tail, eocdIndex + 6);
  const entriesOnDisk = readU16(tail, eocdIndex + 8);
  const totalEntries = readU16(tail, eocdIndex + 10);
  const cdSize = readU32(tail, eocdIndex + 12);
  const cdOffset = readU32(tail, eocdIndex + 16);

  // ZIP64 暂不支持（正常网盘压缩包基本不会触发）
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("该 zip 使用了多盘/跨盘结构，暂不支持");
  }
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("该 zip 为 ZIP64 格式，暂不支持");
  }
  if (totalEntries > entryLimit) {
    throw new Error(`zip 条目过多（${totalEntries}），超过上限`);
  }

  const central = await readRange(bucket, key, cdOffset, cdSize);
  const entries: ZipEntryInfo[] = [];
  let pos = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > central.length) throw new Error("zip 中央目录被截断");
    if (readU32(central, pos) !== 0x02014b50) throw new Error("zip 中央目录签名不匹配");
    const method = readU16(central, pos + 10);
    const crc = readU32(central, pos + 16);
    const compSize = readU32(central, pos + 20);
    const uncompSize = readU32(central, pos + 24);
    const nameLen = readU16(central, pos + 28);
    const extraLen = readU16(central, pos + 30);
    const commentLen = readU16(central, pos + 32);
    const externalAttr = readU32(central, pos + 38);
    const localOffset = readU32(central, pos + 42);

    const nameBytes = central.slice(pos + 46, pos + 46 + nameLen);
    let name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    if (name.includes("\0")) throw new Error("zip 条目名包含非法字符");

    const isDirectory =
      name.endsWith("/") || ((externalAttr >>> 16) & 0x10) !== 0;

    entries.push({
      name,
      isDirectory,
      method,
      compSize,
      uncompSize,
      crc,
      localOffset,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读取一个条目解压后的完整字节。 */
async function readZipEntryData(
  bucket: R2Bucket,
  key: string,
  entry: ZipEntryInfo,
  fileLimit: number
): Promise<Uint8Array> {
  if (entry.isDirectory) return new Uint8Array(0);
  if (entry.uncompSize > fileLimit) {
    throw new Error(`单文件超过解压上限（${entry.uncompSize} > ${fileLimit}）`);
  }

  // 本地文件头：定位数据起点（30 字节固定 + 名称 + extra）
  const header = await readRange(bucket, key, entry.localOffset, 30);
  if (readU32(header, 0) !== 0x04034b50) throw new Error("zip 本地文件头签名不匹配");
  const nameLen = readU16(header, 26);
  const extraLen = readU16(header, 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;

  const compressed = await readRange(bucket, key, dataStart, entry.compSize);

  if (entry.method === 0) {
    // store：data 就是原文
    return compressed.slice(0, entry.uncompSize);
  }
  if (entry.method === 8) {
    // deflate
    return inflate(compressed, entry.uncompSize);
  }
  throw new Error(`暂不支持解压方式 #${entry.method}（仅支持 store/deflate）`);
}

/**
 * 安全地把 zip 条目名拼到目标目录下。
 * 拒绝绝对路径、`..` 跳级、盘符与空段；返回 null 表示非法。
 */
export function safeZipEntryPath(targetDir: string, zipName: string): string | null {
  const cleaned = zipName.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  // 去掉开头的 windows 盘符如 C:/
  const withoutDrive = cleaned.replace(/^[A-Za-z]:\//, "").replace(/^[A-Za-z]:$/, "");
  const segments = withoutDrive.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") return null;
    if (segment === "") continue;
    if (/[\0]/.test(segment)) return null;
  }
  const parts = segments.filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const relative = parts.join("/");
  return normalizePath(`${targetDir}/${relative}`);
}

/**
 * 在线解压：
 * - 读取 zip 索引，逐条把文件写入 R2；
 * - 目录条目创建目录对象；
 * - isWriteAllowed(key) 决定每个目标是否可写（权限过滤）。
 * 返回解压出的文件数；错误逐条收集。
 */
export async function extractZipArchive(
  bucket: R2Bucket,
  zipKey: string,
  zipSize: number,
  targetDir: string,
  env: Env,
  isWriteAllowed: (key: string) => boolean,
  preloadedIndex?: ZipEntryInfo[] | null
): Promise<{ files: number; errors: string[] }> {
  const entries = preloadedIndex !== undefined
    ? preloadedIndex
    : await readZipIndex(bucket, zipKey, zipSize);
  if (!entries) throw new Error("不是有效的 zip 文件（找不到目录索引）");

  const errors: string[] = [];
  let files = 0;

  const pendingDirs = new Set<string>();

  for (const entry of entries) {
    const target = safeZipEntryPath(targetDir, entry.name);
    if (!target) {
      errors.push(`条目名非法，已跳过：${entry.name}`);
      continue;
    }
    if (!isWriteAllowed(target)) {
      errors.push(`没有权限写入：${entry.name}`);
      continue;
    }

    if (entry.isDirectory) {
      await bucket.put(target, "", {
        httpMetadata: { contentType: DIRECTORY_CONTENT_TYPE },
      });
      continue;
    }

    const fileLimit = maxUnzipFileSize(env);
    try {
      const data = await readZipEntryData(bucket, zipKey, entry, fileLimit);
      await ensureDirectories(bucket, target);
      await bucket.put(target, data, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      files += 1;
    } catch (error) {
      errors.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
    }
    void pendingDirs;
  }

  return { files, errors };
}