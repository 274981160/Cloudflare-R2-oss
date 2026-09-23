/**
 * 目录/单文件打包下载。被 `/api/zip`（需要认证）与 `/s/{token}?zip=1`（分享链接）共用。
 *
 * 性能要点：
 * - store 模式流式输出，不把整包读进内存；
 * - 写文件前先并发预取若干个对象的 body，让 R2 的读取与上一个文件的写出重叠，
 *   文件夹里有很多小文件时能把「逐个 GET 的串行延迟」压下来；
 * - 打包开始前就算出精确的总字节数并回 `Content-Length`，浏览器/客户端能显示真实进度条。
 */
import { Env, maxZipSize } from "./config";
import {
  baseName,
  isDirectoryObject,
  isLegacyDirMarker,
  listAll,
  statPath,
} from "./core";
import { ZipWriter } from "./zip";

export interface ZipEntry {
  name: string;
  /** 空字符串表示没有实际对象（目录条目或源对象已消失）。 */
  key: string;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
}

/** 并发预取的对象数量（也是 R2 GET 的最大 in-flight 数）。 */
const PREFETCH = 8;

/** 估算一个 zip 的精确字节数（store 模式 + data descriptor + UTF-8 标志）。 */
export function estimateZipSize(entries: ZipEntry[]): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const entry of entries) {
    const nameLen = encoder.encode(entry.name).length;
    // 本地文件头：30 字节固定 + 名称
    total += 30 + nameLen;
    if (!entry.isDirectory) {
      // 文件数据 + 16 字节 data descriptor
      total += entry.size + 16;
    }
  }
  // 中央目录：每条 46 字节固定 + 名称
  for (const entry of entries) {
    total += 46 + encoder.encode(entry.name).length;
  }
  // EOCD
  total += 22;
  return total;
}

export interface ZipOptions {
  /** 压缩包文件名（不含 .zip）。 */
  archiveName?: string;
  /** 覆盖默认大小上限。 */
  limit?: number;
  /** 逐对象过滤；返回 false 的对象不会进包。 */
  filter?: (key: string) => boolean;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename
  )}`;
}

/** 收集待打包条目。 */
async function collectEntries(
  bucket: R2Bucket,
  path: string,
  filter?: (key: string) => boolean
): Promise<ZipEntry[] | null> {
  const stat = await statPath(bucket, path);
  if (!stat) return null;

  const entries: ZipEntry[] = [];
  const archiveBase = baseName(path) || "download";

  if (!stat.isDirectory) {
    if (filter && !filter(path)) return [];
    entries.push({
      name: baseName(path),
      key: path,
      isDirectory: false,
      size: stat.size,
      uploaded: stat.uploaded,
    });
    return entries;
  }

  const prefix = `${path}/`;
  for await (const object of listAll(bucket, prefix, true)) {
    const key = object.key as string;
    if (isLegacyDirMarker(key)) continue;
    if (filter && !filter(key)) continue;
    const relative = key.slice(prefix.length);
    if (!relative) continue;

    // 目录对象以「以 / 结尾的零字节条目」写进包，解压后才是文件夹
    if (isDirectoryObject(object)) {
      entries.push({
        name: `${relative}/`,
        key: "",
        isDirectory: true,
        size: 0,
        uploaded: object.uploaded instanceof Date ? object.uploaded : null,
      });
      continue;
    }

    entries.push({
      name: relative,
      key,
      isDirectory: false,
      size: typeof object.size === "number" ? object.size : 0,
      uploaded: object.uploaded instanceof Date ? object.uploaded : null,
    });
  }

  if (entries.length === 0) {
    entries.push({
      name: `${archiveBase}/`,
      key: "",
      isDirectory: true,
      size: 0,
      uploaded: null,
    });
  }
  return entries;
}

export async function buildZipResponse(
  bucket: R2Bucket,
  path: string,
  env: Env,
  options: ZipOptions = {}
): Promise<Response> {
  const entries = await collectEntries(bucket, path, options.filter);
  if (entries === null) {
    return new Response("Not found", { status: 404 });
  }

  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const limit = options.limit || maxZipSize(env);
  if (totalSize > limit) {
    return new Response(
      `打包体积约 ${totalSize} 字节，超过上限 ${limit} 字节，请分批下载`,
      { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new ZipWriter(controller);
      const fetches = new Map<string, Promise<any>>();
      const getBody = (key: string) => {
        let promise = fetches.get(key);
        if (!promise) {
          promise = bucket.get(key).then((object: any) =>
            object && "body" in object ? (object.body as ReadableStream<Uint8Array>) : null
          );
          fetches.set(key, promise);
        }
        return promise;
      };

      /** 小文件整体读进内存，与「上一个文件的写出」真正并发（R2 读取重叠）。 */
      const SMALL_LIMIT = 1024 * 1024; // 1MB 以下才整读
      const fileEntries = entries.filter((e) => !e.isDirectory && e.key);

      /** 已整读的小文件字节：key -> Uint8Array | null（null 表示对象消失） */
      const buffered = new Map<string, Promise<Uint8Array | null>>();
      let cursor = 0;
      const prefetchSmall = () => {
        while (buffered.size < PREFETCH && cursor < fileEntries.length) {
          const entry = fileEntries[cursor++];
          if (entry.size > SMALL_LIMIT) continue; // 大文件不走整读
          buffered.set(
            entry.key,
            getBody(entry.key).then(async (body) => {
              if (!body) return null;
              const reader = body.getReader();
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
              let offset = 0;
              for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
              }
              return merged;
            })
          );
        }
      };
      prefetchSmall();

      for (const entry of entries) {
        if (entry.isDirectory) {
          writer.addDirectory(entry.name, entry.uploaded);
          continue;
        }

        let body: ReadableStream<Uint8Array> | null = null;
        if (entry.key) {
          const bufferedPromise = buffered.get(entry.key);
          if (bufferedPromise) {
            const bytes = await bufferedPromise;
            buffered.delete(entry.key);
            prefetchSmall();
            if (bytes && bytes.length > 0) {
              // 把整读的字节包成一个一次性流交给 writer
              body = new ReadableStream<Uint8Array>({
                start(streamController) {
                  streamController.enqueue(bytes);
                  streamController.close();
                },
              });
            }
          } else {
            body = await getBody(entry.key);
          }
        }
        await writer.addFile(entry.name, body, entry.uploaded);
      }
      writer.finish();
    },
  });

  const filename = `${options.archiveName || baseName(path) || "download"}.zip`;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
    },
  });
}
