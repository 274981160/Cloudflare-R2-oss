import { Zip, ZipPassThrough } from "fflate";

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

interface ZipEntry {
  name: string;
  key: string;
  size: number;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename
  )}`;
}

/**
 * 目录打包下载。使用 store 模式（不压缩）流式输出：
 * 媒体文件本来压不动，这样 CPU 占用最低，也不会把整个包读进内存。
 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;

    const parsed = parseBucketPath(context, "/api/zip");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;

    if (!path) return badRequest("不能打包根目录");

    const auth = authenticate(request, env);
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
      entries.push({ name: baseName(path), key: path, size: stat.size });
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
          entries.push({ name: `${relative}/`, key: "", size: 0 });
          continue;
        }

        entries.push({
          name: relative,
          key,
          size: typeof object.size === "number" ? object.size : 0,
        });
      }
      if (entries.length === 0) {
        // 空目录也给出一个条目，解压后能看到文件夹
        entries.push({ name: `${archiveBase}/`, key: "", size: 0 });
      }
    }

    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const limit = maxZipSize(env);
    if (totalSize > limit) {
      return new Response(
        `打包体积 ${totalSize} 字节超过上限 ${limit} 字节，请分批下载`,
        { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const zip = new Zip((error, chunk, final) => {
          if (error) {
            controller.error(error);
            return;
          }
          controller.enqueue(chunk);
          if (final) controller.close();
        });

        try {
          for (const entry of entries) {
            const file = new ZipPassThrough(entry.name);
            zip.add(file);

            if (!entry.key) {
              file.push(new Uint8Array(0), true);
              continue;
            }

            const object: any = await bucket.get(entry.key);
            if (!object || !("body" in object)) {
              file.push(new Uint8Array(0), true);
              continue;
            }

            const reader = (object.body as ReadableStream<Uint8Array>).getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) file.push(value, false);
            }
            file.push(new Uint8Array(0), true);
          }
          zip.end();
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
