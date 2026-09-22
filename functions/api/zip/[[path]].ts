import { Env, maxZipSize } from "../../../utils/config";
import {
  authenticate,
  canList,
  canRead,
  forbidden,
  unauthorized,
  type Subject,
} from "../../../utils/auth";
import {
  badRequest,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import {
  baseName,
  isDirectoryObject,
  isLegacyDirMarker,
  listAll,
  statPath,
} from "../../../utils/core";
import { ZipWriter } from "../../../utils/zip";

interface ZipEntry {
  name: string;
  /** 空字符串表示没有实际对象（目录条目或源对象已消失）。 */
  key: string;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename
  )}`;
}

/**
 * 目录打包下载。store 模式流式输出：媒体文件本来压不动，这样 CPU 占用最低，
 * 也不会把整个包读进内存。写入器是仓库自带的零依赖实现，见 utils/zip.ts。
 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;

    const parsed = parseBucketPath(context, "/api/zip");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;

    if (!path) return badRequest("不能打包根目录");

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    const stat = await statPath(bucket, path);
    if (!stat) return notFound();

    const allowed = stat.isDirectory
      ? canList(subject, path)
      : canRead(subject, path);
    if (!allowed) {
      return auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有下载该路径的权限");
    }

    const entries: ZipEntry[] = [];
    const archiveBase = baseName(path) || "download";

    if (!stat.isDirectory) {
      entries.push({
        name: baseName(path),
        key: path,
        isDirectory: false,
        size: stat.size,
        uploaded: stat.uploaded,
      });
    } else {
      const prefix = `${path}/`;
      for await (const object of listAll(bucket, prefix, true)) {
        const key = object.key as string;
        if (isLegacyDirMarker(key)) continue;
        if (!canRead(subject, key)) continue;
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
        // 空目录也给出一个条目，解压后能看到文件夹
        entries.push({
          name: `${archiveBase}/`,
          key: "",
          isDirectory: true,
          size: 0,
          uploaded: null,
        });
      }
    }

    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const limit = maxZipSize(env);
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

    const filename = `${archiveBase}.zip`;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(filename),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return serverError(error);
  }
};
