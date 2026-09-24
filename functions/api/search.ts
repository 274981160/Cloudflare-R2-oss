import { Env, isPublicRead } from "../../utils/config";
import {
  authenticate,
  canRead,
  unauthorized,
  type Subject,
  authUnauthorized,} from "../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  resolveBucket,
  serverError,
} from "../../utils/bucket";
import { isDirectoryObject, listAll, normalizePath } from "../../utils/core";

/**
 * 全局搜索文件名（跨目录递归）。
 *
 *   GET /api/search?q=关键词&prefix=&limit=200
 *
 * 说明：
 * - 只做**文件名子串**匹配（大小写不敏感），不搜内容；
 * - 递归遍历时按权限过滤，受限账号搜不到自己没权限的路径；
 * - 自动跳过内部保留目录与回收站内容（listAll 已经过滤）；
 * - 有扫描上限，避免大网盘把请求拖死；返回结果也有条数上限。
 */
const MAX_SCAN = 50000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const bucket = resolveBucket(env, url);
    if (!bucket) return notFound();

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return authUnauthorized(auth);
    const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };

    // 私有模式下匿名一律拒绝（与 /api/list 一致）：
    // 结果虽然会按权限过滤，但不该让未登录的人有「全局探测」这个入口
    if (!subject.account && !isPublicRead(env)) {
      return unauthorized("需要登录");
    }

    const raw = (url.searchParams.get("q") || "").trim();
    if (!raw) return badRequest("请提供搜索关键词 q");
    const keyword = raw.toLowerCase();

    const prefix = normalizePath(url.searchParams.get("prefix") || "");
    const requested = parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const results: any[] = [];
    let scanned = 0;
    let truncated = false;

    for await (const object of listAll(bucket, prefix, true)) {
      scanned += 1;
      if (scanned > MAX_SCAN) {
        truncated = true;
        break;
      }

      const key = String(object.key || "");
      if (!key) continue;
      // 目录对象（新建文件夹产生的标记）不作为搜索结果
      if (isDirectoryObject(object)) continue;

      const name = key.slice(key.lastIndexOf("/") + 1);
      if (!name.toLowerCase().includes(keyword)) continue;
      if (!canRead(subject, key)) continue;

      const custom = object.customMetadata || {};
      results.push({
        key,
        name,
        size: Number(object.size) || 0,
        contentType:
          (object.httpMetadata && object.httpMetadata.contentType) || null,
        uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : null,
        thumbnail: custom.thumbnail || null,
      });

      if (results.length >= limit) {
        truncated = true;
        break;
      }
    }

    results.sort((left, right) => left.key.localeCompare(right.key, "zh-Hans-CN"));

    return jsonResponse({
      query: raw,
      prefix,
      scanned,
      truncated,
      total: results.length,
      results,
    });
  } catch (error) {
    return serverError(error);
  }
};
