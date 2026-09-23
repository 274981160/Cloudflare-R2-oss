import { Env, isTrashEnabled } from "../../../utils/config";
import {
  authenticate,
  canWrite,
  forbidden,
  unauthorized,
  type Subject,
} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  resolveBucket,
  serverError,
} from "../../../utils/bucket";
import { CoreError } from "../../../utils/core";
import {
  emptyTrash,
  listTrash,
  purgeExpired,
  purgeTrashEntry,
  restoreFromTrash,
  retentionDays,
  type TrashEntry,
} from "../../../utils/trash";

/**
 * 回收站接口（需要认证）。
 *
 *   GET    /api/trash                 列出回收站（受限账号只看自己删的）
 *   POST   /api/trash/{id}/restore    恢复到原位置
 *   DELETE /api/trash/{id}            彻底删除这一项
 *   DELETE /api/trash                 清空回收站
 *
 * 顺带做过期清理：Pages Functions 没有定时任务，所以在这几个入口上顺手做。
 */

function identityOf(subject: Subject): string | null {
  return subject.account ? subject.account.username : null;
}

/** 是否能看到/操作某条记录：`*` 权限看全部，其余只看自己删的 */
function canManage(subject: Subject, entry: TrashEntry): boolean {
  const permissions = subject.account ? subject.account.permissions : [];
  if (permissions.includes("*")) return true;
  return Boolean(entry.deletedBy) && entry.deletedBy === identityOf(subject);
}

function publicEntry(entry: TrashEntry, days: number) {
  return {
    id: entry.id,
    key: entry.key,
    name: entry.name,
    type: entry.type,
    size: entry.size,
    count: entry.count,
    deletedAt: entry.deletedAt,
    deletedBy: entry.deletedBy,
    retentionDays: days,
  };
}

async function handleList(context: any): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const bucket = resolveBucket(env, url);
  if (!bucket) return notFound();

  const auth = await authenticate(request, env, bucket);
  if (auth.invalid) return unauthorized("用户名或密码不正确");
  const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };
  if (!subject.account) return unauthorized("需要登录");

  const expired = await purgeExpired(bucket, env);
  const days = retentionDays(env);
  const entries = (await listTrash(bucket))
    .filter((entry) => canManage(subject, entry))
    .map((entry) => publicEntry(entry, days));

  return jsonResponse({
    enabled: isTrashEnabled(env),
    retentionDays: days,
    purged: expired,
    items: entries,
  });
}

export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    return await handleList(context);
  } catch (error) {
    return serverError(error);
  }
};

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

    // 路径形如 {id}/restore
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/trash\/?/, ""));
    const segments = path.split("/").filter(Boolean);
    const id = segments[0] || "";
    const action = segments[1] || "";
    if (!id || action !== "restore") return badRequest("请使用 /api/trash/{id}/restore");

    const entries = await listTrash(bucket);
    const entry = entries.find((item) => item.id === id);
    if (!entry) return notFound("回收站里没有这一项");
    if (!canManage(subject, entry)) return forbidden("只能恢复自己删除的内容");
    // 恢复要写回原位置，必须对那个位置有写权限
    if (!canWrite(subject, entry.key)) return forbidden("没有恢复该路径的权限");

    const result = await restoreFromTrash(bucket, id);
    return jsonResponse({ restored: result.key, renamed: result.renamed });
  } catch (error) {
    if (error instanceof CoreError) {
      return new Response(error.message, { status: error.status });
    }
    return serverError(error);
  }
};

export const onRequestDelete: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const bucket = resolveBucket(env, url);
    if (!bucket) return notFound();

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };
    if (!subject.account) return unauthorized("需要登录");

    const path = decodeURIComponent(url.pathname.replace(/^\/api\/trash\/?/, ""));
    const id = path.split("/").filter(Boolean)[0] || "";

    if (!id) {
      // 清空回收站：只清自己能管的那些
      const entries = await listTrash(bucket);
      let items = 0;
      let objects = 0;
      for (const entry of entries) {
        if (!canManage(subject, entry)) continue;
        try {
          objects += await purgeTrashEntry(bucket, entry.id);
          items += 1;
        } catch (error) {
          console.warn("[flaredrive] 清空回收站失败", entry.key, error);
        }
      }
      return jsonResponse({ items, objects });
    }

    const entries = await listTrash(bucket);
    const entry = entries.find((item) => item.id === id);
    if (!entry) return notFound("回收站里没有这一项");
    if (!canManage(subject, entry)) return forbidden("只能彻底删除自己删除的内容");

    const deleted = await purgeTrashEntry(bucket, id);
    return jsonResponse({ deleted });
  } catch (error) {
    if (error instanceof CoreError) {
      return new Response(error.message, { status: error.status });
    }
    return serverError(error);
  }
};
