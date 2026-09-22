import { THUMBNAILS_PREFIX, Env } from "../../../utils/config";
import {
  authenticate,
  canList,
  canRead,
  canWrite,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import { isThumbnailKey, listDirectory, statPath } from "../../../utils/core";

/**
 * 网页端使用的 JSON 目录列举接口。
 * 只列直接子项，结果按账号权限过滤。
 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;

    const parsed = parseBucketPath(context, "/api/list");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;

    // 内部保留目录不可直接列举（缩略图目录除外）
    if (isInternalPath(path) && !path.startsWith(THUMBNAILS_PREFIX.replace(/\/$/, ""))) {
      return notFound();
    }

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    const stat = await statPath(bucket, path);
    if (!stat) return jsonResponse({ error: "路径不存在" }, 404);
    if (!stat.isDirectory) return jsonResponse({ error: "不是目录" }, 404);

    if (!canList(subject, path)) {
      return auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有访问该目录的权限");
    }

    const listing = await listDirectory(bucket, path);

    const files = listing.files
      .filter((file) => canRead(subject, file.key))
      .map((file) => ({
        key: file.key,
        name: file.name,
        size: file.size,
        uploaded: file.uploaded ? file.uploaded.toISOString() : null,
        etag: file.etag,
        contentType: file.contentType,
        thumbnail: file.thumbnail
          ? `/raw/${THUMBNAILS_PREFIX}${file.thumbnail}.png`
          : null,
        writable: canWrite(subject, file.key),
      }));

    const folders = listing.folders
      .filter((folder) => canList(subject, folder.key))
      .map((folder) => ({
        key: folder.key,
        name: folder.name,
        legacy: folder.legacy,
        writable: canWrite(subject, folder.key),
      }));

    return jsonResponse({
      path,
      canRead: true,
      canWrite: canWrite(subject, path),
      files,
      folders,
    });
  } catch (error) {
    return serverError(error);
  }
};
