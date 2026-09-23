import { Env } from "../../utils/config";
import {
  authenticate,
  canWrite,
  unauthorized,
  type Subject,
} from "../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  resolveBucket,
  serverError,
} from "../../utils/bucket";
import { mapLimit, normalizePath, statPath } from "../../utils/core";

/**
 * 上传前的同名预检：`POST /api/exists`，body `{ keys: string[] }`
 * 返回 `{ existing: string[] }`（只回存在的那些）。
 *
 * 为什么需要它：网页端要在上传前告诉用户「这些文件名已存在，覆盖还是重命名」。
 * 客户端逐层列目录去判断既慢又容易漏（嵌套目录），
 * 交给服务端按 key 精确探测最省事。
 */
const MAX_KEYS = 500;

export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const bucket = resolveBucket(env, url);
    if (!bucket) return notFound();

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };
    if (!subject.account) return unauthorized("需要登录");

    let keys: string[] = [];
    try {
      const body: any = await request.json();
      if (Array.isArray(body?.keys)) {
        keys = body.keys
          .filter((key: any) => typeof key === "string" && key.trim())
          .map((key: string) => normalizePath(key))
          .filter(Boolean);
      }
    } catch (error) {
      return badRequest("请求体必须是 JSON，包含 keys 数组");
    }

    if (!keys.length) return badRequest("请提供要检查的 keys");
    if (keys.length > MAX_KEYS) {
      return badRequest(`一次最多检查 ${MAX_KEYS} 个路径`);
    }

    const unique = Array.from(new Set(keys));
    const existing: string[] = [];
    await mapLimit(unique, 8, async (key) => {
      // 只回答「我自己有权写入的位置」，避免变成任意路径探测工具
      if (!canWrite(subject, key)) return;
      const stat = await statPath(bucket, key);
      if (stat) existing.push(key);
    });

    return jsonResponse({ existing });
  } catch (error) {
    return serverError(error);
  }
};
