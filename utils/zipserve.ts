/**
 * 目录/单文件打包下载。被 `/api/zip`（需要认证）与 `/s/{token}?zip=1`（分享链接）共用。
 * store 模式流式输出：媒体文件压不动，这样 CPU 占用最低，也不把整包读进内存。
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

interface ZipEntry {
  name: string;
  /** 空字符串表示没有实际对象（目录条目或源对象已消失）。 */
  key: string;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
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
      try {
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
      } catch (error) {
        controller.error(error);
      }
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
