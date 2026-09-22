import { Env } from "../../../utils/config";
import {
  authenticate,
  canRead,
  forbidden,
  unauthorized,
  type Subject,
} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import { statPath } from "../../../utils/core";
import { normalizePath } from "../../../utils/permissions";
import {
  createShareToken,
  deleteShare,
  findShareForKey,
  listShares,
  loadShare,
  publicShare,
  saveShare,
  type ShareRecord,
} from "../../../utils/share";

const ROUTE = "/api/shares";

async function loadSubject(context: any) {
  const parsed = parseBucketPath(context, ROUTE);
  if (!parsed) return { denied: notFound() as Response };

  const auth = await authenticate(context.request, context.env, parsed.bucket);
  if (auth.invalid) {
    return { denied: unauthorized("用户名或密码不正确") };
  }
  if (!auth.account) {
    return { denied: unauthorized("需要登录后才能管理分享链接") };
  }
  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env: context.env,
  };
  return { bucket: parsed.bucket, subject, path: parsed.path };
}

function canManageShare(subject: Subject, share: ShareRecord): boolean {
  const account = subject.account;
  if (!account) return false;
  if (account.permissions.includes("*")) return true;
  return share.createdBy === account.username;
}

/** 列出分享：普通账号只看自己创建的，`*` 权限账号看全部。 */
export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const origin = new URL(context.request.url).origin;
    const all = await listShares(loaded.bucket);
    const visible = loaded.subject.account?.permissions.includes("*")
      ? all
      : all.filter((share) => canManageShare(loaded.subject!, share));

    return jsonResponse({
      shares: visible.map((share) => publicShare(share, origin)),
    });
  } catch (error) {
    return serverError(error);
  }
};

/** 创建（或复用）某个 key 的分享链接。 */
export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const request = context.request;
    let payload: any = {};
    try {
      payload = await request.json();
    } catch (error) {
      return badRequest("请求体必须是 JSON，例如 {\"key\":\"photos/2026\"}");
    }

    const key = normalizePath(String(payload?.key ?? ""));
    if (!key) return badRequest("请提供要分享的 key");
    if (key.startsWith("_$flaredrive$/")) {
      return forbidden("内部保留目录不能分享");
    }

    const stat = await statPath(loaded.bucket, key);
    if (!stat) return notFound();

    if (!canRead(loaded.subject, key)) {
      return forbidden("没有该路径的读权限，无法分享");
    }

    let expiresInDays: number | null = null;
    const rawExpires = payload?.expiresInDays;
    if (
      rawExpires !== undefined &&
      rawExpires !== null &&
      String(rawExpires).trim() !== ""
    ) {
      const parsedDays = parseInt(String(rawExpires), 10);
      if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
        return badRequest("expiresInDays 必须是正整数");
      }
      expiresInDays = Math.min(parsedDays, 3650);
    }

    const origin = new URL(request.url).origin;
    const createdBy = loaded.subject.account
      ? loaded.subject.account.username
      : null;

    // 同一个 key 已经有同一创建者的分享时直接复用，避免刷出一堆记录
    const existing = findShareForKey(
      await listShares(loaded.bucket),
      key,
      createdBy
    );
    if (existing) {
      return jsonResponse(publicShare(existing, origin), 200);
    }

    const record: ShareRecord = {
      token: createShareToken(),
      key,
      type: stat.isDirectory ? "folder" : "file",
      createdAt: new Date().toISOString(),
      createdBy,
      expiresAt:
        expiresInDays && expiresInDays > 0
          ? new Date(
              Date.now() + expiresInDays * 24 * 60 * 60 * 1000
            ).toISOString()
          : null,
    };

    await saveShare(loaded.bucket, record);
    return jsonResponse(publicShare(record, origin), 201);
  } catch (error) {
    return serverError(error);
  }
};

/** 吊销分享：创建者本人，或 `*` 权限账号。 */
export const onRequestDelete: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const token = (loaded.path || "").split("/")[0];
    if (!token) return badRequest("请在路径里给出分享 token");

    const share = await loadShare(loaded.bucket, token);
    if (!share) return notFound();
    if (!canManageShare(loaded.subject, share)) {
      return forbidden("只能吊销自己创建的分享链接");
    }

    await deleteShare(loaded.bucket, token);
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError(error);
  }
};
