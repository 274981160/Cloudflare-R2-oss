import {
  INTERNAL_PREFIX,
  isAutoMkdirEnabled,
  maxPutSize,
} from "../../utils/config";
import {
  THUMBNAIL_CACHE_CONTROL,
  ensureDirectories,
  isThumbnailKey,
  objectWriteOptions,
  statPath,
} from "../../utils/core";
import { releaseTrashedFile } from "../../utils/trash";
import { isTrashed } from "../../utils/trashindex";
import { DavContext, parentOf } from "./context";

async function handlePutPart(context: DavContext): Promise<Response> {
  const { bucket, path, request } = context;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = url.searchParams.get("partNumber");

  if (!uploadId || !partNumber) {
    return new Response("Bad Request", { status: 400 });
  }
  if (!path) return new Response("Bad Request", { status: 400 });

  const parsedPart = parseInt(partNumber, 10);
  if (!Number.isFinite(parsedPart) || parsedPart < 1) {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    const multipartUpload = bucket.resumeMultipartUpload(path, uploadId);
    const uploadedPart = await multipartUpload.uploadPart(
      parsedPart,
      request.body as any
    );
    const headers = new Headers();
    if (uploadedPart.etag) headers.set("ETag", uploadedPart.etag);
    return new Response(null, { status: 200, headers });
  } catch (error) {
    return new Response(
      `分片上传失败: ${error instanceof Error ? error.message : String(error)}`,
      { status: 400 }
    );
  }
}

export async function handleRequestPut(context: DavContext): Promise<Response> {
  const { bucket, path, request, env, subject } = context;
  const url = new URL(request.url);

  if (url.searchParams.has("uploadId")) return handlePutPart(context);

  if (!path) return new Response("Method Not Allowed", { status: 405 });
  if (url.pathname.endsWith("/")) {
    // 对集合执行 PUT 是非法的
    return new Response("Method Not Allowed", { status: 405 });
  }

  const declaredLength = parseInt(request.headers.get("Content-Length") || "", 10);
  const limit = maxPutSize(env);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return new Response(
      `文件超过单次 PUT 上限（${limit} 字节），大文件请使用网页端分片上传`,
      { status: 413 }
    );
  }

  const isInternal = path === INTERNAL_PREFIX.replace(/\/$/, "") ||
    path.startsWith(INTERNAL_PREFIX);

  // 已进回收站的位置还留着旧内容。若回收站里正好是「同名文件」，那份内容
  // 马上就会被这次写入覆盖，记录已无意义 → 自动清掉后继续；
  // 其余情况（文件夹、或位于回收站子树内）拦住，让用户先恢复或彻底删除。
  if (!isInternal && (await isTrashed(bucket, path))) {
    const released = await releaseTrashedFile(bucket, path);
    if (!released || (await isTrashed(bucket, path))) {
      return new Response(
        "该路径在回收站里，请先从回收站恢复或彻底删除后再上传",
        { status: 409 }
      );
    }
  }

  if (!isInternal) {
    const existing = await statPath(bucket, path);
    if (existing && existing.isDirectory) {
      return new Response("不能把目录覆盖成文件", { status: 405 });
    }

    const parent = parentOf(path);
    if (parent) {
      const parentStat = await statPath(bucket, parent);
      if (!parentStat || !parentStat.isDirectory) {
        if (!isAutoMkdirEnabled(env)) {
          return new Response("Conflict", { status: 409 });
        }
        await ensureDirectories(bucket, path);
      }
    }
  }

  const options = objectWriteOptions(request, {
    cacheControl: isThumbnailKey(path) ? THUMBNAIL_CACHE_CONTROL : undefined,
  });

  let result: any;
  try {
    result = await bucket.put(path, (request.body ?? null) as any, options as any);
  } catch (error) {
    return new Response(
      `写入失败: ${error instanceof Error ? error.message : String(error)}`,
      { status: 500 }
    );
  }

  if (!result) return new Response("Precondition Failed", { status: 412 });

  const headers = new Headers();
  if (result.httpEtag) headers.set("ETag", result.httpEtag);
  return new Response(null, { status: 201, headers });
}
