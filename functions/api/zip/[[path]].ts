import { Env } from "../../../utils/config";
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
import { buildZipResponse } from "../../../utils/zipserve";

/**
 * 目录打包下载（需要认证）。实际打包逻辑在 utils/zipserve.ts，
 * 分享链接的 `?zip=1` 用的是同一份实现，只是不带权限过滤。
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

    const allowed = canList(subject, path) || canRead(subject, path);
    if (!allowed) {
      return auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有下载该路径的权限");
    }

    return await buildZipResponse(bucket, path, env, {
      filter: (key: string) => canRead(subject, key),
    });
  } catch (error) {
    return serverError(error);
  }
};
