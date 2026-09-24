import { Env } from "../../../utils/config";
import {
  authenticate,
  canRead,
  canWrite,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
  authUnauthorized,} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import { createZipInBucket } from "../../../utils/zipmake";

/**
 * 在线压缩：把选中的若干文件/文件夹打包成 zip 存回网盘。
 *
 * POST /api/compress/{targetZipKey}   body: { "sources": ["a.txt", "folder"] }
 * 目标 key 即 zip 落在网盘里的位置（如 `dir/归档.zip`）；需要写权限；
 * 每个源都要有读权限。
 */
export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const parsed = parseBucketPath(context, "/api/compress");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;
    if (!path) return badRequest("请指定 zip 保存位置");
    if (isInternalPath(path)) return forbidden("不允许写入内部目录");

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return authUnauthorized(auth);
    const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };

    if (!canWrite(subject, path)) {
      return auth.anonymous ? unauthorized("需要登录") : forbidden("没有该位置的写入权限");
    }

    let sources: string[] = [];
    try {
      const body: any = await request.json();
      if (Array.isArray(body?.sources)) {
        sources = body.sources.filter((s: any) => typeof s === "string" && s.trim());
      }
    } catch (error) {
      return badRequest("请求体必须是 JSON，包含 sources 数组");
    }
    if (sources.length === 0) return badRequest("请至少选择一个文件或文件夹");

    const result = await createZipInBucket(bucket, path, sources, env, (key) =>
      canRead(subject, key)
    );
    return jsonResponse({ key: path, size: result.size, count: result.count });
  } catch (error) {
    return serverError(error);
  }
};