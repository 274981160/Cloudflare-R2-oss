import {
  Env,
  THUMBNAILS_PREFIX,
  maxPutSize,
} from "../../../utils/config";
import {
  authenticate,
  isInternalPath,
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
  payloadTooLarge,
  serverError,
} from "../../../utils/bucket";
import {
  THUMBNAIL_CACHE_CONTROL,
  ensureDirectories,
  isCollectionPath,
  isThumbnailKey,
} from "../../../utils/core";

const ROUTE = "/api/upload";

function encodeUrlPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * 给脚本使用的上传接口，支持账号密码或 API Key。
 *
 * - `POST /api/upload/dir/` + multipart/form-data（文件字段名随意，推荐 file）
 * - `PUT  /api/upload/dir/name.bin` + 原始字节流
 * - `POST /api/upload/dir/name.bin` + 原始字节流
 */
async function handleUpload(context: any): Promise<Response> {
  const { request, env } = context;

  const parsed = parseBucketPath(context, ROUTE);
  if (!parsed) return notFound();
  const { bucket, path } = parsed;
  const url = new URL(request.url);

  const auth = await authenticate(request, env, bucket);
  if (auth.invalid) return unauthorized("账号密码或 API Key 不正确");
  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env,
  };

  const pathIsDirectory = path === "" || url.pathname.endsWith("/");
  const contentType = request.headers.get("Content-Type") || "";
  const limit = maxPutSize(env);

  let key = path;
  let body: any = null;
  let objectType = contentType.split(";")[0].trim() || "application/octet-stream";
  let reportedSize = 0;

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      return badRequest("表单解析失败");
    }

    let file: any = null;
    for (const [, value] of form.entries()) {
      if (value && typeof value === "object" && typeof value.stream === "function") {
        file = value;
        break;
      }
    }
    if (!file) return badRequest("表单里没有文件字段（建议字段名为 file）");

    const filename = String(file.name || "upload.bin")
      .replace(/[\\/]+/g, "_")
      .replace(/^\.+/, "")
      .trim();
    if (!filename) return badRequest("无法从表单里取到文件名");

    if (pathIsDirectory) key = path ? `${path}/${filename}` : filename;

    reportedSize = typeof file.size === "number" ? file.size : 0;
    if (reportedSize > limit) {
      return payloadTooLarge(
        `文件 ${reportedSize} 字节，超过上限 ${limit} 字节。大文件请用网页端分片上传`
      );
    }

    body = file.stream();
    objectType = file.type || objectType;
  } else {
    if (pathIsDirectory) {
      return badRequest(
        "原始字节流上传必须在路径里给出完整对象名，例如 /api/upload/backup/a.bin"
      );
    }
    const declared = parseInt(request.headers.get("Content-Length") || "", 10);
    if (Number.isFinite(declared) && declared > limit) {
      return payloadTooLarge(
        `请求体 ${declared} 字节，超过上限 ${limit} 字节。大文件请用网页端分片上传`
      );
    }
    body = request.body;
    reportedSize = Number.isFinite(declared) ? declared : 0;
  }

  if (!key) return badRequest("无法确定目标对象名");
  if (key.startsWith("_$flaredrive$/") && !isThumbnailKey(key)) {
    return forbidden("内部保留目录不可写");
  }
  // 内部保留目录（分享/锁/回收站记录、缩略图除外）不允许通过上传接口写入，
  // 与 WebDAV 的规则保持一致
  if (isInternalPath(key) && !key.startsWith(THUMBNAILS_PREFIX)) {
    return forbidden("内部保留目录不能写入");
  }

  if (!canWrite(subject, key)) {
    return auth.anonymous
      ? unauthorized("需要登录或提供 API Key")
      : forbidden("没有写入该路径的权限");
  }

  // 父目录不存在就自动补齐，脚本调用时不需要先建目录
  const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
  if (parent && !key.startsWith("_$flaredrive$/")) {
    const parentIsCollection = await isCollectionPath(bucket, parent);
    if (!parentIsCollection) await ensureDirectories(bucket, key);
  }

  const httpMetadata: Record<string, string> = { contentType: objectType };
  if (isThumbnailKey(key)) {
    httpMetadata.cacheControl = THUMBNAIL_CACHE_CONTROL;
  }

  const customMetadata: Record<string, string> = {};
  const thumbnail = request.headers.get("fd-thumbnail");
  if (thumbnail) customMetadata.thumbnail = thumbnail;

  let result: any;
  try {
    result = await bucket.put(
      key,
      body ?? null,
      (Object.keys(customMetadata).length
        ? { httpMetadata, customMetadata }
        : { httpMetadata }) as any
    );
  } catch (error) {
    return new Response(
      `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      { status: 500 }
    );
  }

  return jsonResponse(
    {
      key,
      size: result && typeof result.size === "number" ? result.size : reportedSize,
      uploaded:
        result && result.uploaded instanceof Date
          ? result.uploaded.toISOString()
          : new Date().toISOString(),
      url: `/raw/${encodeUrlPath(key)}`,
    },
    201
  );
}

export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    return await handleUpload(context);
  } catch (error) {
    return serverError(error);
  }
};

export const onRequestPut = onRequestPost;
