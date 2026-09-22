import { Env } from "../../utils/config";
import { loadShare, resolveSharePath, type ShareRecord } from "../../utils/share";
import { methodNotAllowed, notFound, parseBucketPath, serverError } from "../../utils/bucket";
import { baseName, listDirectory, statPath } from "../../utils/core";
import { serveObject } from "../../utils/serve";
import { previewKindOf, renderSharePage, type ShareEntry } from "../../utils/sharepage";
import { buildZipResponse } from "../../utils/zipserve";

/**
 * 分享链接的公开入口，也是**唯一**允许匿名读取内容的通道。
 *
 * - token 不存在 / 已过期 / 非法 → 一律 404（不区分，避免探测）
 * - 只能读到被分享的那一个对象，或被分享目录这棵子树
 * - 目录页是只读浏览页：只能预览与下载，没有任何写入口
 * - 不支持跨域读取，避免被第三方页面热链
 */

const SHARE_METHODS = ["GET", "HEAD", "OPTIONS"];

function shareHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra || {});
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

async function renderShareListing(
  bucket: R2Bucket,
  share: ShareRecord,
  target: string,
  relative: string
): Promise<Response> {
  const listing = await listDirectory(bucket, target);

  const entries: ShareEntry[] = [
    ...listing.folders.map((folder) => ({
      name: folder.name,
      key: folder.name,
      isDirectory: true,
      size: 0,
      uploaded: null as string | null,
      contentType: "application/x-directory",
      previewKind: "" as ShareEntry["previewKind"],
    })),
    ...listing.files.map((file) => ({
      name: file.name,
      key: file.name,
      isDirectory: false,
      size: file.size,
      uploaded: file.uploaded ? file.uploaded.toISOString() : null,
      contentType: file.contentType,
      previewKind: previewKindOf(file.contentType, file.name),
    })),
  ];

  const html = renderSharePage({
    token: share.token,
    shareKey: share.key,
    relative,
    entries,
    allowZip: true,
  });

  return new Response(html, {
    status: 200,
    headers: shareHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}

export const onRequest: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: shareHeaders({ Allow: SHARE_METHODS.join(", "), "Content-Length": "0" }),
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      const response = methodNotAllowed(SHARE_METHODS);
      return new Response(response.body, {
        status: response.status,
        headers: shareHeaders({ Allow: SHARE_METHODS.join(", ") }),
      });
    }

    const parsed = parseBucketPath(context, "/s");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;
    if (!path) return notFound();

    const slash = path.indexOf("/");
    const token = slash === -1 ? path : path.slice(0, slash);
    const relative = slash === -1 ? "" : path.slice(slash + 1);

    const share = await loadShare(bucket, token);
    if (!share) return notFound();

    const target = resolveSharePath(share, relative);
    if (!target) return notFound();

    const stat = await statPath(bucket, target);
    if (!stat) return notFound();

    const url = new URL(request.url);

    if (stat.isDirectory) {
      if (url.searchParams.has("zip")) {
        const response = await buildZipResponse(bucket, target, env, {
          archiveName: baseName(target) || "share",
        });
        const headers = shareHeaders(Object.fromEntries(response.headers));
        return new Response(response.body, { status: response.status, headers });
      }
      const response = await renderShareListing(bucket, share, target, relative);
      return method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    const response = await serveObject(bucket, target, request, {
      stat,
      headOnly: method === "HEAD",
    });
    if (!response) return notFound();

    const headers = shareHeaders(Object.fromEntries(response.headers));
    if (url.searchParams.has("download") || url.searchParams.has("dl")) {
      const filename = baseName(target) || "download";
      const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      headers.set(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
          filename
        )}`
      );
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return serverError(error);
  }
};
