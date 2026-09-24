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
import { buildZipResponse, probeZip } from "../../../utils/zipserve";
import { verifySignedKey } from "../../../utils/signing";

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

    const requestUrl = new URL(request.url);

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    // 同样允许「正常权限」或「短时效签名」两种放行方式
    const signedOk = await verifySignedKey(
      env,
      path,
      requestUrl.searchParams.get("exp"),
      requestUrl.searchParams.get("sig")
    );

    const allowed = signedOk || canList(subject, path) || canRead(subject, path);
    if (!allowed) {
      return auth.invalid
        ? unauthorized("用户名或密码不正确")
        : auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有下载该路径的权限");
    }

    // ?probe=1：只统计条目与估算体积，不产出 zip。前端打包前先探一次，
    // 超限就直接提示，别让浏览器下载到一半才失败（或存下一个打不开的"zip"）
    if (requestUrl.searchParams.get("probe") === "1") {
      return await probeZip(bucket, path, env, {
        filter: signedOk ? undefined : (key: string) => canRead(subject, key),
      });
    }

    return await buildZipResponse(bucket, path, env, {
      // 有签名就代表整棵子树都被授权，不再逐个过滤
      filter: signedOk ? undefined : (key: string) => canRead(subject, key),
    });
  } catch (error) {
    return serverError(error);
  }
};
