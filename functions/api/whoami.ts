import {
  Env,
  isLockingEnabled,
  isPublicRead,
  isPublicThumbnails,
  isTrashEnabled,
  maxPutSize,
  trashDays,
  webdavVersion,
} from "../../utils/config";
import {
  authenticate,
  canWriteAnywhere,
  type Subject,
} from "../../utils/auth";
import { jsonResponse, resolveBucket } from "../../utils/bucket";
import { signPreviewToken } from "../../utils/signing";

/** 登录状态与能力探测，网页端启动时调用。永远返回 200。 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  const { request, env } = context;
  const bucket = resolveBucket(env, new URL(request.url));
  const auth = await authenticate(request, env, bucket);
  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env,
  };

  // 登录状态下签发一个只读预览 token：前端把它拼进 /raw 直链，
  // 这样预览图片/视频不必每次先请求 /api/sign（高延迟网络下那一次往返很贵）
  const preview = subject.account
    ? await signPreviewToken(env, subject.account.username)
    : null;

  return jsonResponse({
    authenticated: Boolean(auth.account),
    username: auth.account ? auth.account.username : null,
    permissions: auth.account ? auth.account.permissions : [],
    /** 本次请求是否用 API Key 认证（密钥本身无权管理密钥）。 */
    viaApiKey: Boolean(auth.account && auth.account.source === "apikey"),
    canManageKeys: Boolean(
      auth.account &&
        auth.account.source !== "apikey" &&
        auth.account.permissions.includes("*")
    ),
    publicRead: isPublicRead(env),
    publicThumbnails: isPublicThumbnails(env),
    readOnly: !canWriteAnywhere(subject),
    canWriteAny: canWriteAnywhere(subject),
    maxUploadSize: maxPutSize(env),
    locking: isLockingEnabled(env),
    // 前端据此把「已删除」文案改成「已移入回收站」
    trash: isTrashEnabled(env),
    previewToken: preview ? preview.token : null,
    previewTokenExp: preview ? preview.exp : 0,
    trashDays: trashDays(env),
    version: webdavVersion(),
  });
};
