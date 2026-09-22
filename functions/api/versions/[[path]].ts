import { Env, isVersioningEnabled } from "../../../utils/config";
import {
  authenticate,
  canRead,
  canWrite,
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
import {
  deleteVersion,
  getVersionObject,
  listVersions,
  restoreVersion,
  statVersion,
} from "../../../utils/versions";

const ROUTE = "/api/versions";

interface ParsedAction {
  action: string;
  key: string;
  id: string;
}

/** 解析 `/api/versions/{action}/{key}[/{id}]`。 */
function parseAction(path: string): ParsedAction | null {
  const segments = (path || "").split("/").filter(Boolean);
  const action = segments.shift();
  if (!action) return null;
  const rest = segments.join("/");

  if (action === "list") {
    if (!rest) return null;
    return { action, key: rest, id: "" };
  }
  if (!["content", "restore", "remove"].includes(action)) return null;

  const index = rest.lastIndexOf("/");
  if (index <= 0) return null;
  return {
    action,
    key: rest.slice(0, index),
    id: rest.slice(index + 1),
  };
}

async function loadSubject(context: any) {
  const parsed = parseBucketPath(context, ROUTE);
  if (!parsed) return { denied: notFound() as Response };

  const auth = await authenticate(context.request, context.env, parsed.bucket);
  if (auth.invalid) return { denied: unauthorized("用户名或密码不正确") };

  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env: context.env,
  };
  return { bucket: parsed.bucket, subject, path: parsed.path };
}

function denyRead(subject: Subject, key: string): Response | null {
  if (canRead(subject, key)) return null;
  return subject.anonymous
    ? unauthorized("需要登录")
    : forbidden("没有该对象的读权限");
}

function denyWrite(subject: Subject, key: string): Response | null {
  if (canWrite(subject, key)) return null;
  return subject.anonymous
    ? unauthorized("需要登录")
    : forbidden("没有该对象的写权限");
}

function versioningDisabled(): Response {
  return jsonResponse({ error: "服务端未启用编辑历史（WEBDAV_VERSIONING）" }, 403);
}

export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const parsed = parseAction(loaded.path || "");
    if (!parsed) return badRequest("路径形如 /api/versions/list/{key} 或 /api/versions/content/{key}/{id}");

    const denied = denyRead(loaded.subject, parsed.key);
    if (denied) return denied;

    if (parsed.action === "list") {
      if (!isVersioningEnabled(context.env)) {
        return jsonResponse({ versions: [], disabled: true });
      }
      const versions = await listVersions(loaded.bucket, parsed.key);
      return jsonResponse({ versions });
    }

    // content：把某个历史版本的内容原样返回
    const stat = await statVersion(loaded.bucket, parsed.key, parsed.id);
    if (!stat) return notFound();

    const response = await serveVersionObject(
      loaded.bucket,
      parsed.key,
      parsed.id,
      context.request,
      stat
    );
    if (!response) return notFound();
    return response;
  } catch (error) {
    return serverError(error);
  }
};

/** 历史版本内容不在用户目录里，不能用 serveObject 直接按 key 取，这里单独拼响应。 */
async function serveVersionObject(
  bucket: R2Bucket,
  key: string,
  id: string,
  request: Request,
  stat: { size: number; uploaded: Date | null; contentType: string }
): Promise<Response | null> {
  const object: any = await getVersionObject(bucket, key, id);
  if (!object) return null;

  const headers = new Headers();
  headers.set("Content-Type", stat.contentType || "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (stat.uploaded) headers.set("Last-Modified", stat.uploaded.toUTCString());
  headers.set("Content-Length", String(stat.size));

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const parsed = parseAction(loaded.path || "");
    if (!parsed || parsed.action !== "restore") {
      return badRequest("恢复用 POST /api/versions/restore/{key}/{id}");
    }
    if (!isVersioningEnabled(context.env)) return versioningDisabled();

    const denied = denyWrite(loaded.subject, parsed.key);
    if (denied) return denied;

    const result = await restoreVersion(
      loaded.bucket,
      context.env,
      parsed.key,
      parsed.id,
      loaded.subject.account ? loaded.subject.account.username : null
    );
    if (!result) return notFound();

    return jsonResponse({
      key: parsed.key,
      restoredFrom: parsed.id,
      size: result.size,
    });
  } catch (error) {
    return serverError(error);
  }
};

export const onRequestDelete: PagesFunction<Env> = async function (context) {
  try {
    const loaded = await loadSubject(context);
    if (loaded.denied || !loaded.bucket || !loaded.subject) {
      return loaded.denied as Response;
    }

    const parsed = parseAction(loaded.path || "");
    if (!parsed || parsed.action !== "remove") {
      return badRequest("删除历史版本用 DELETE /api/versions/remove/{key}/{id}");
    }

    const denied = denyWrite(loaded.subject, parsed.key);
    if (denied) return denied;

    const removed = await deleteVersion(loaded.bucket, parsed.key, parsed.id);
    if (!removed) return notFound();
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError(error);
  }
};
