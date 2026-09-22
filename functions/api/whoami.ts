import {
  Env,
  isLockingEnabled,
  isPublicRead,
  isPublicThumbnails,
  maxPutSize,
  webdavVersion,
} from "../../utils/config";
import {
  authenticate,
  canWriteAnywhere,
  type Subject,
} from "../../utils/auth";
import { jsonResponse, resolveBucket } from "../../utils/bucket";

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
    version: webdavVersion(),
  });
};
