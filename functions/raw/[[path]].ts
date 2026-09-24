import { Env, THUMBNAILS_PREFIX } from "../../utils/config";
import {
  authenticate,
  buildSubject,
  canRead,
  parseAccounts,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
  authUnauthorized,} from "../../utils/auth";
import { notFound, parseBucketPath, serverError } from "../../utils/bucket";
import { isThumbnailKey, statPath } from "../../utils/core";
import { verifyPreviewToken, verifySignedKey } from "../../utils/signing";
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

    const url = new URL(request.url);

    // 内部保留目录只允许直接访问缩略图
    if (isInternalPath(path) && !isThumbnailKey(path)) return notFound();

    const auth = await authenticate(request, env, bucket);
    const subject: Subject = {
      account: auth.account,
      anonymous: auth.anonymous,
      env,
    };

    // 三种放行方式：
    // 1) 正常权限（浏览器能带上认证头时）
    // 2) 针对该 key 的短时效签名（下载 / 复制链接用）
    // 3) 预览 token（?pt=，登录时签发、只读、只对 /raw 生效）
    //    预览走它就不必每次先请求 /api/sign——高延迟网络下那一次往返很贵
    const signedOk = await verifySignedKey(
      env,
      path,
      url.searchParams.get("exp"),
      url.searchParams.get("sig")
    );

    let previewOk = false;
    const previewToken = url.searchParams.get("pt");
    if (!signedOk && previewToken) {
      const verified = await verifyPreviewToken(env, previewToken);
      if (verified) {
        const account =
          parseAccounts(env).find(
            (item) => item.username === verified.account
          ) || null;
        if (account) {
          previewOk = canRead(buildSubject(env, account, false), path);
        }
      }
    }

    if (!signedOk && !previewOk && !canRead(subject, path)) {
      return auth.invalid
        ? authUnauthorized(auth)
        : auth.anonymous
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

    // url 已在前面声明，这里直接复用
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
