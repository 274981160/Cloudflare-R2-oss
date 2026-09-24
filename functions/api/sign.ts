import { Env } from "../../utils/config";
import {
  authenticate,
  canList,
  canRead,
  forbidden,
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
import { normalizePath } from "../../utils/permissions";
import { statPath } from "../../utils/core";
import { DEFAULT_SIGN_TTL, signKey } from "../../utils/signing";

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * 签发下载直链。
 *
 * 私有模式下浏览器直链带不上认证头，前端只能先取回整文件再存成 Blob，
 * 既没有进度、又可能被浏览器在异步之后拦掉下载。这里签一个短时效 URL，
 * 前端在打开菜单时就拿到它，点击下载时用同步的 <a href> 触发浏览器原生下载。
 *
 * 需要认证，并且调用者对被签的 key 有读权限；签名只对这一个 key 且在有效期内有效。
 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);

    const key = normalizePath(url.searchParams.get("key") || "");
    if (!key) return badRequest("缺少 key 参数");

    const bucket = resolveBucket(env, url);
    if (!bucket) return notFound();

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return authUnauthorized(auth);
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    const stat = await statPath(bucket, key);
    if (!stat) return notFound();

    const allowed = stat.isDirectory
      ? canList(subject, key)
      : canRead(subject, key);
    if (!allowed) {
      return auth.anonymous
        ? unauthorized("需要登录")
        : forbidden("没有该路径的读取权限");
    }

    const requested = parseInt(url.searchParams.get("ttl") || "", 10);
    const ttl = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 60), 3600)
      : DEFAULT_SIGN_TTL;

    const signed = await signKey(env, key, ttl);
    if (!signed) {
      // 没有可用的签名密钥（账号配置为空）时前端会退回「取回 Blob」的方式
      return jsonResponse(
        { error: "服务端没有可用的签名密钥，请配置 WEBDAV_PASSWORD 或 DOWNLOAD_SECRET" },
        501
      );
    }

    const query = `exp=${signed.exp}&sig=${signed.sig}`;
    const encoded = encodeKeyPath(key);

    return jsonResponse({
      key,
      isDirectory: stat.isDirectory,
      url: stat.isDirectory
        ? `/api/zip/${encoded}?${query}`
        : `/raw/${encoded}?${query}`,
      expiresAt: new Date(signed.exp * 1000).toISOString(),
    });
  } catch (error) {
    return serverError(error);
  }
};
