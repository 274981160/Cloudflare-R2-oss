import { Env } from "../../../utils/config";
import {
  authenticate,
  canRead,
  forbidden,
  unauthorized,
  type Subject,
  authUnauthorized,} from "../../../utils/auth";
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
  applySharePassword,
  createShareToken,
  deleteShare,
  findShareForKey,
  hasPassword,
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
    return { denied: authUnauthorized(auth) };
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

    // 有效期：显式带了 expiresInDays 才处理；
    // 传正整数=多少天，传 null / 空串 / 0 = 永久（用于把已有的限时分享改回永久）
    let expiresInDays: number | null = null;
    let expiryRequested = false;
    if (payload && Object.prototype.hasOwnProperty.call(payload, "expiresInDays")) {
      const rawExpires = payload.expiresInDays;
      const text = String(rawExpires == null ? "" : rawExpires).trim();
      if (text === "" || text === "0") {
        expiryRequested = true;
        expiresInDays = null;
      } else {
        const parsedDays = parseInt(text, 10);
        if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
          return badRequest("expiresInDays 必须是正整数，或用 null 表示永久");
        }
        expiryRequested = true;
        expiresInDays = Math.min(parsedDays, 3650);
      }
    }

    const origin = new URL(request.url).origin;
    const createdBy = loaded.subject.account
      ? loaded.subject.account.username
      : null;

    // 访问密码（B2）：带 password 字段才处理；
    // 空字符串 / null = 清除密码，非空 = 设置或修改密码（明文不落盘）
    let passwordValue: string | null = null;
    let passwordRequested = false;
    if (payload && Object.prototype.hasOwnProperty.call(payload, "password")) {
      passwordRequested = true;
      passwordValue = String(payload.password == null ? "" : payload.password);
    }

    // 暂停 / 恢复：带 suspended 字段才处理（对已有分享做状态切换）
    let suspendedValue: boolean | null = null;
    let suspendedRequested = false;
    if (payload && Object.prototype.hasOwnProperty.call(payload, "suspended")) {
      suspendedRequested = true;
      suspendedValue = Boolean(payload.suspended);
    }

    // 同一个 key 已经有同一创建者的分享时直接复用，避免刷出一堆记录
    const existing = findShareForKey(
      await listShares(loaded.bucket),
      key,
      createdBy
    );
    if (existing) {
      // 复用同一条记录；显式指定的字段（有效期/密码/暂停）逐个更新，
      // 否则用户「给已有分享设 7 天」之类的操作会毫无效果。
      let updated: ShareRecord = { ...existing };
      let changed = false;
      if (expiryRequested) {
        const nextExpiresAt = expiresInDays
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
        if ((updated.expiresAt || null) !== nextExpiresAt) {
          updated = { ...updated, expiresAt: nextExpiresAt };
          changed = true;
        }
      }
      if (passwordRequested) {
        const before = `${updated.passwordHash || ""}|${updated.passwordSalt || ""}`;
        updated = await applySharePassword(updated, passwordValue || "");
        const after = `${updated.passwordHash || ""}|${updated.passwordSalt || ""}`;
        if (before !== after) changed = true;
      }
      if (suspendedRequested) {
        const nextSuspended = suspendedValue || false;
        if (Boolean(updated.suspended) !== nextSuspended) {
          updated = nextSuspended
            ? { ...updated, suspended: true }
            : (() => { const { suspended: _s, ...rest } = updated; return rest; })();
          changed = true;
        }
      }
      if (changed) {
        await saveShare(loaded.bucket, updated);
      }
      return jsonResponse(publicShare(updated, origin), changed ? 200 : 200);
    }

    // 新建分享时也可以直接带密码与暂停状态（一般用不到暂停，但保持一致性）
    let record: ShareRecord = {
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
    if (passwordRequested && passwordValue) {
      record = await applySharePassword(record, passwordValue);
    }
    if (suspendedRequested && suspendedValue) {
      record = { ...record, suspended: true };
    }

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
