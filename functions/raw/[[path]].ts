import { Env, THUMBNAILS_PREFIX } from "../../utils/config";
import {
  authenticate,
  canRead,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
} from "../../utils/auth";
import { notFound, parseBucketPath, serverError } from "../../utils/bucket";
import { isThumbnailKey, statPath } from "../../utils/core";
import { serveObject } from "../../utils/serve";

/**
 * 直链读取对象。缩略图默认允许匿名引用，这样 `<img>` 才能直接加载；
 * 其余路径按公开读开关与账号权限判定。
 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;

    const parsed = parseBucketPath(context, "/raw");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;
    if (!path) return notFound();

    // 内部保留目录只允许直接访问缩略图
    if (isInternalPath(path) && !isThumbnailKey(path)) return notFound();

    const auth = await authenticate(request, env, bucket);
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    if (!canRead(subject, path)) {
      return auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有读取该对象的权限");
    }

    const stat = await statPath(bucket, path);
    if (!stat || stat.isDirectory) return notFound();

    const response = await serveObject(bucket, path, request, {
      stat,
      headOnly: request.method.toUpperCase() === "HEAD",
    });
    if (!response) return notFound();

    const url = new URL(request.url);
    const forceDownload =
      url.searchParams.has("download") || url.searchParams.has("dl");
    if (!forceDownload) return response;

    const headers = new Headers(response.headers);
    const filename = path.split("/").pop() || "download";
    const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`
    );
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return serverError(error);
  }
};

export const onRequestHead = onRequestGet;
