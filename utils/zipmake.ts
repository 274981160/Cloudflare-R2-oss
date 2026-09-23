/**
 * 在线压缩：把网盘里选中的若干文件/文件夹打包成一个 zip 对象存回 R2。
 * 复用 utils/zip.ts 的流式 ZipWriter，不把内容整体读进内存。
 */
import { Env, maxZipSize } from "./config";
import {
  baseName,
  isDirectoryObject,
  isLegacyDirMarker,
  CoreError,
  listAll,
  statPath,
} from "./core";
import { ZipWriter } from "./zip";
import { ZipEntry, estimateZipSize } from "./zipserve";

async function collectSources(
  bucket: R2Bucket,
  sources: string[],
  filter: (key: string) => boolean
): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const source of sources) {
    const stat = await statPath(bucket, source);
    if (!stat) throw new Error(`源不存在：${source}`);
    if (!filter(source)) throw new CoreError(403, `没有权限打包：${source}`);

    if (!stat.isDirectory) {
      entries.push({
        name: baseName(source),
        key: source,
        isDirectory: false,
        size: stat.size,
        uploaded: stat.uploaded,
      });
      continue;
    }

    const rootName = baseName(source) || "folder";
    entries.push({
      name: `${rootName}/`,
      key: "",
      isDirectory: true,
      size: 0,
      uploaded: null,
    });

    const prefix = `${source}/`;
    for await (const object of listAll(bucket, prefix, true)) {
      const key = object.key as string;
      if (isLegacyDirMarker(key)) continue;
      if (!filter(key)) continue;
      const relative = key.slice(prefix.length);
      if (!relative) continue;

      if (isDirectoryObject(object)) {
        entries.push({
          name: `${rootName}/${relative}/`,
          key: "",
          isDirectory: true,
          size: 0,
          uploaded: object.uploaded instanceof Date ? object.uploaded : null,
        });
        continue;
      }
      entries.push({
        name: `${rootName}/${relative}`,
        key,
        isDirectory: false,
        size: typeof object.size === "number" ? object.size : 0,
        uploaded: object.uploaded instanceof Date ? object.uploaded : null,
      });
    }
  }
  return entries;
}

/**
 * 把若干源打包成一个 zip 对象写入 bucket（R2 分片上传，内存有界）。
 * 返回打包结果。
 */
export async function createZipInBucket(
  bucket: R2Bucket,
  targetKey: string,
  sources: string[],
  env: Env,
  filter: (key: string) => boolean
): Promise<{ size: number; count: number }> {
  const entries = await collectSources(bucket, sources, filter);
  if (entries.length === 0) throw new Error("没有可打包的内容");

  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const limit = maxZipSize(env);
  if (totalSize > limit) {
    throw new Error(
      `打包体积约 ${totalSize} 字节，超过上限 ${limit} 字节，请拆分后再打包`
    );
  }
  const contentLength = estimateZipSize(entries);

  const upload: any = await bucket.createMultipartUpload(targetKey, {
    httpMetadata: { contentType: "application/zip" },
  } as any);
  const PART_SIZE = 8 * 1024 * 1024;
  let parts: Uint8Array[] = [];
  let current = 0;
  let partNumber = 1;
  const uploadedParts: any[] = [];
  let chain: Promise<void> = Promise.resolve();

  const flushPart = () => {
    const part = concatBytes(parts);
    parts = [];
    current = 0;
    const number = partNumber++;
    chain = chain.then(async () => {
      const uploaded: any = await upload.uploadPart(number, part);
      if (uploaded && typeof uploaded.part === "number") {
        uploadedParts[uploaded.part - 1] = uploaded;
      } else if (uploaded && uploaded.etag) {
        uploadedParts.push(uploaded);
      } else {
        uploadedParts.push(uploaded);
      }
    });
  };

  const controller = {
    enqueue(chunk: Uint8Array) {
      parts.push(chunk);
      current += chunk.length;
      if (current >= PART_SIZE) flushPart();
    },
    close() {
      /* complete 在 finish 之后统一做 */
    },
  };

  const writer = new ZipWriter(controller as any);
  for (const entry of entries) {
    if (entry.isDirectory) {
      writer.addDirectory(entry.name, entry.uploaded);
      continue;
    }
    let body: ReadableStream<Uint8Array> | null = null;
    if (entry.key) {
      const object: any = await bucket.get(entry.key);
      if (object && "body" in object) {
        body = object.body as ReadableStream<Uint8Array>;
      }
    }
    await writer.addFile(entry.name, body, entry.uploaded);
  }
  writer.finish();

  if (parts.length) flushPart();
  await chain;
  await upload.complete(uploadedParts);

  return { size: contentLength, count: entries.length };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}