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
import { jsonResponse } from "../../utils/bucket";

/** 登录状态与能力探测，网页端启动时调用。永远返回 200。 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  const { request, env } = context;
  const auth = authenticate(request, env);
  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env,
  };

  return jsonResponse({
    authenticated: Boolean(auth.account),
    username: auth.account ? auth.account.username : null,
    permissions: auth.account ? auth.account.permissions : [],
    publicRead: isPublicRead(env),
    publicThumbnails: isPublicThumbnails(env),
    readOnly: !canWriteAnywhere(subject),
    canWriteAny: canWriteAnywhere(subject),
    maxUploadSize: maxPutSize(env),
    locking: isLockingEnabled(env),
    version: webdavVersion(),
  });
};
