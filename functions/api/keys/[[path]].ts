import { Env } from "../../../utils/config";
import {
  authenticate,
  forbidden,
  unauthorized,
  type AuthResult,
} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  publicApiKey,
} from "../../../utils/apikey";

const ROUTE = "/api/keys";

/**
 * 只有「真实账号」且权限为 `*` 才能管理密钥。
 * API Key 本身无权再签发密钥，避免泄漏一把密钥就扩散成无限权限。
 */
function requireKeyManager(auth: AuthResult): Response | null {
  const account = auth.account;
  if (!account) return unauthorized("需要登录");
  if (account.source === "apikey") {
    return forbidden("API Key 不能用于管理密钥");
  }
  if (!account.permissions.includes("*")) {
    return forbidden("需要全部目录权限才能管理密钥");
  }
  return null;
}

async function authorize(context: any) {
  const parsed = parseBucketPath(context, ROUTE);
  if (!parsed) return { bucket: null, denied: notFound() as Response };
  const auth = await authenticate(
    context.request,
    context.env,
    parsed.bucket
  );
  return { bucket: parsed.bucket, denied: requireKeyManager(auth), auth };
}

export const onRequestGet: PagesFunction<Env> = async function (context) {
  try {
    const { bucket, denied } = await authorize(context);
    if (denied || !bucket) return denied as Response;

    const keys = await listApiKeys(bucket);
    return jsonResponse({ keys: keys.map(publicApiKey) });
  } catch (error) {
    return serverError(error);
  }
};

export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const { bucket, denied, auth } = await authorize(context);
    if (denied || !bucket) return denied as Response;

    const request = context.request;
    let payload: any = {};
    try {
      const contentType = request.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        payload = await request.json();
      } else {
        const form = await request.formData();
        payload = {
          name: form.get("name"),
          permissions: form.get("permissions"),
          expiresInDays: form.get("expiresInDays"),
        };
      }
    } catch (error) {
      return badRequest("请求体解析失败");
    }

    const name = String(payload?.name ?? "").trim();
    if (!name) return badRequest("请提供密钥备注名 name");
    if (name.length > 64) return badRequest("name 最多 64 个字符");

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

    const { record, key } = await createApiKey(bucket, {
      name,
      permissions: payload?.permissions,
      expiresInDays,
      createdBy: auth?.account ? auth.account.username : null,
    });

    return jsonResponse({ ...publicApiKey(record), key }, 201);
  } catch (error) {
    return serverError(error);
  }
};

export const onRequestDelete: PagesFunction<Env> = async function (context) {
  try {
    const parsed = parseBucketPath(context, ROUTE);
    if (!parsed) return notFound();

    const auth = await authenticate(context.request, context.env, parsed.bucket);
    const denied = requireKeyManager(auth);
    if (denied) return denied;

    if (!parsed.path) return badRequest("请在路径里给出要吊销的密钥 id");
    const removed = await deleteApiKey(parsed.bucket, parsed.path);
    if (!removed) return notFound();
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError(error);
  }
};
