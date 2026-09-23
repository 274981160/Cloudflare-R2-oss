import {
  INTERNAL_PREFIX,
  isAutoMkdirEnabled,
  isTrashEnabled,
  maxPutSize,
} from "../../utils/config";
import {
  THUMBNAIL_CACHE_CONTROL,
  ensureDirectories,
  isThumbnailKey,
  objectWriteOptions,
  statPath,
} from "../../utils/core";
import { preserveBeforeOverwrite, releaseTrashedFile } from "../../utils/trash";
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

  /**
   * 分段 PUT（`Content-Range`）：Windows 资源管理器、macOS Finder 挂载 WebDAV
   * 上传大文件时会这么发——每次只发一段，期望服务端**追加/写入指定偏移**。
   *
   * 但 R2 不支持随机写，我们只能整对象覆盖。若不拦，客户端发第 1 段我们写成整个文件、
   * 发第 2 段又把第 1 段覆盖掉……最后文件只剩最后一段，而且客户端全程收到 201，
   * 属于**静默的数据损坏**。所以这里明确拒绝，让它回退或报错。
   *
   * 例外：`bytes 0-(size-1)/size` 且长度一致，等价于「一次性完整上传」，照常处理。
   */
  const contentRange = request.headers.get("Content-Range");
  if (contentRange) {
    const matched = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
    const declaredTotal = parseInt(request.headers.get("Content-Length") || "", 10);
    let wholeFile = false;
    if (matched) {
      const start = parseInt(matched[1], 10);
      const end = parseInt(matched[2], 10);
      const total = matched[3] === "*" ? NaN : parseInt(matched[3], 10);
      wholeFile =
        start === 0 &&
        Number.isFinite(total) &&
        end + 1 === total &&
        (!Number.isFinite(declaredTotal) || declaredTotal === total);
    }
    if (!wholeFile) {
      return new Response(
        "本服务不支持分段 PUT（Content-Range）：存储层不支持随机写入，" +
          "强行接收会导致文件被逐段覆盖而损坏。\n" +
          "大文件请用网页端上传（自动分片、断点续传），或改用单次 PUT 的客户端。",
        { status: 501 }
      );
    }
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
    // 覆盖已有文件前，先把旧内容收进回收站——传错版本也还能找回来
    if (existing && isTrashEnabled(env)) {
      await preserveBeforeOverwrite(
        bucket,
        path,
        subject && subject.account ? subject.account.username : null
      );
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
