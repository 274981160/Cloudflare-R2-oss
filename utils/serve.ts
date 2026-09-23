import { DIRECTORY_CONTENT_TYPE, Env } from "./config";
import { normalizePath } from "./auth";
import {
  THUMBNAIL_CACHE_CONTROL,
  isThumbnailKey,
  statPath,
  type PathStat,
} from "./core";

export type RangeResult =
  | { kind: "none" }
  | { kind: "ok"; offset: number; length: number }
  | { kind: "invalid" };

/** 解析单段 Range 头；多段或非法值一律按整文件返回。 */
export function parseRangeHeader(
  header: string | null,
  size: number
): RangeResult {
  if (!header) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };

  const rawStart = match[1];
  const rawEnd = match[2];
  if (rawStart === "" && rawEnd === "") return { kind: "none" };
  if (size <= 0) return { kind: "invalid" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "invalid" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: "invalid" };
  if (start > end || start >= size) return { kind: "invalid" };
  end = Math.min(end, size - 1);
  return { kind: "ok", offset: start, length: end - start + 1 };
}

function normalizeEtag(value: string | null): string {
  if (!value) return "";
  return value.trim().replace(/^W\//, "");
}

/**
 * 自行处理条件请求，返回 null 表示继续正常响应。
 * 不把 onlyIf 交给 R2，是因为 R2 在不满足条件时返回不带 body 的对象，
 * 无法区分 304 与 412。
 */
export function checkConditional(
  request: Request,
  stat: PathStat
): Response | null {
  const etag = normalizeEtag(stat.httpEtag || (stat.etag ? `"${stat.etag}"` : ""));
  const headers = request.headers;

  const ifMatch = headers.get("If-Match");
  if (ifMatch && etag) {
    const candidates = ifMatch.split(",").map((value) => normalizeEtag(value));
    if (!candidates.includes("*") && !candidates.includes(etag)) {
      return new Response("Precondition Failed", { status: 412 });
    }
  }

  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch && etag) {
    const candidates = ifNoneMatch.split(",").map((value) => normalizeEtag(value));
    if (candidates.includes("*") || candidates.includes(etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag },
      });
    }
  }

  const lastModified = stat.uploaded ? stat.uploaded.getTime() : 0;
  const ifModifiedSince = headers.get("If-Modified-Since");
  if (ifModifiedSince && lastModified) {
    const since = Date.parse(ifModifiedSince);
    if (Number.isFinite(since) && lastModified <= since) {
      return new Response(null, { status: 304 });
    }
  }

  const ifUnmodifiedSince = headers.get("If-Unmodified-Since");
  if (ifUnmodifiedSince && lastModified) {
    const since = Date.parse(ifUnmodifiedSince);
    if (Number.isFinite(since) && lastModified > since) {
      return new Response("Precondition Failed", { status: 412 });
    }
  }

  return null;
}

/** 该请求是否应该忽略 Range（If-Range 不匹配时按整文件返回）。 */
function shouldIgnoreRange(request: Request, stat: PathStat): boolean {
  const ifRange = request.headers.get("If-Range");
  if (!ifRange) return false;
  const value = ifRange.trim();
  const etag = normalizeEtag(stat.httpEtag || (stat.etag ? `"${stat.etag}"` : ""));
  if (value.startsWith('"') || value.startsWith("W/")) {
    return normalizeEtag(value) !== etag;
  }
  const since = Date.parse(value);
  if (!Number.isFinite(since) || !stat.uploaded) return false;
  return stat.uploaded.getTime() > since;
}

export function baseObjectHeaders(stat: PathStat, key: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", stat.contentType || "application/octet-stream");
  if (stat.contentDisposition) {
    headers.set("Content-Disposition", stat.contentDisposition);
  }
  if (stat.contentLanguage) {
    headers.set("Content-Language", stat.contentLanguage);
  }
  const etag = stat.httpEtag || (stat.etag ? `"${stat.etag}"` : "");
  if (etag) headers.set("ETag", etag);
  if (stat.uploaded) headers.set("Last-Modified", stat.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");

  if (isThumbnailKey(key)) {
    headers.set("Cache-Control", stat.cacheControl || THUMBNAIL_CACHE_CONTROL);
  } else if (stat.cacheControl) {
    headers.set("Cache-Control", stat.cacheControl);
  } else {
    // 私有内容允许**浏览器私有缓存**：反复预览同一张图 / 拖动同一个视频
    // 时不用重下（高延迟网络下差别很大）。
    // private = 只允许浏览器自己缓存，绝不允许 CDN/共享缓存，避免内容外泄。
    headers.set("Cache-Control", "private, max-age=300");
  }
  return headers;
}

/**
 * 输出对象内容，支持 Range、条件请求与 HEAD。
 * 目录与不存在的对象返回 null，由调用方决定怎么处理。
 */
export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { headOnly?: boolean; stat?: PathStat } = {}
): Promise<Response | null> {
  const target = normalizePath(key);
  const stat = options.stat ?? (await statPath(bucket, target));
  if (!stat || stat.isDirectory) return null;

  const conditional = checkConditional(request, stat);
  if (conditional) return conditional;

  const headers = baseObjectHeaders(stat, target);
  if (options.headOnly) {
    headers.set("Content-Length", String(stat.size));
    return new Response(null, { status: 200, headers });
  }

  let range = parseRangeHeader(request.headers.get("Range"), stat.size);
  if (range.kind !== "none" && shouldIgnoreRange(request, stat)) {
    range = { kind: "none" };
  }
  if (range.kind === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }

  if (range.kind === "ok") {
    const object: any = await bucket.get(target, {
      range: { offset: range.offset, length: range.length },
    } as any);
    if (!object || !("body" in object)) return null;
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${stat.size}`
    );
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  const object: any = await bucket.get(target);
  if (!object || !("body" in object)) return null;
  headers.set("Content-Length", String(stat.size));
  return new Response(object.body, { status: 200, headers });
}

function escapeHtml(value: unknown): string {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSize(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export interface ListingEntry {
  key: string;
  name: string;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
}

/** 生成一个极简的目录浏览页，方便直接用浏览器打开 WebDAV 目录。 */
export interface DirectoryListingOptions {
  env: Env;
  /** 标题（默认用路径）。 */
  title?: string;
  /** 自定义每个条目的链接（分享页用 `/s/{token}/...`）。 */
  linkFor?: (entry: ListingEntry) => string;
  /** 返回上级的链接；传 null 表示不显示。默认回到 /webdav 的上级。 */
  parentHref?: string | null;
  /** 页面底部的说明文字。 */
  note?: string;
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function renderDirectoryListing(
  path: string,
  entries: ListingEntry[],
  options: DirectoryListingOptions
): Response {
  const target = normalizePath(path);
  const title = options.title || (target ? `${target}/` : "/");

  const defaultLink = (entry: ListingEntry) =>
    entry.isDirectory
      ? `/webdav/${encodeKeyPath(entry.key)}/`
      : `/raw/${encodeKeyPath(entry.key)}`;
  const linkFor = options.linkFor || defaultLink;

  const rows = entries
    .map((entry) => {
      const href = linkFor(entry);
      const label = escapeHtml(entry.isDirectory ? `${entry.name}/` : entry.name);
      const size = entry.isDirectory ? "-" : formatSize(entry.size);
      const modified = entry.uploaded
        ? escapeHtml(entry.uploaded.toISOString().replace("T", " ").slice(0, 19))
        : "-";
      return `<tr><td><a href="${escapeHtml(href)}">${label}</a></td><td class="num">${escapeHtml(
        size
      )}</td><td class="num">${modified}</td></tr>`;
    })
    .join("\n");

  let parentLink = "";
  if (options.parentHref !== null) {
    if (typeof options.parentHref === "string") {
      parentLink = `<tr><td><a href="${escapeHtml(
        options.parentHref
      )}">../</a></td><td class="num">-</td><td class="num">-</td></tr>`;
    } else if (target !== "") {
      const parent = target.includes("/")
        ? target.slice(0, target.lastIndexOf("/"))
        : "";
      parentLink = `<tr><td><a href="/webdav/${parent
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/")}${parent ? "/" : ""}">../</a></td><td class="num">-</td><td class="num">-</td></tr>`;
    }
  }

  const note =
    options.note ||
    `这是 WebDAV 目录的只读浏览页。要上传和管理文件，请使用 <a href="/?p=${encodeURIComponent(
      target
    )}">网页端</a> 或 WebDAV 客户端。`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - 文件库</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Liberation Sans", sans-serif; margin: 24px; color: #222; }
  h1 { font-size: 18px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; max-width: 960px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  td.num { text-align: right; color: dimgray; white-space: nowrap; }
  a { color: #f38020; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .hint { margin-top: 16px; color: dimgray; font-size: 13px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<table>
<thead><tr><th>名称</th><th class="num">大小</th><th class="num">修改时间</th></tr></thead>
<tbody>
${parentLink}
${rows}
</tbody>
</table>
<p class="hint">${note}</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function directoryStatHeaders(): Headers {
  const headers = new Headers();
  headers.set("Content-Type", DIRECTORY_CONTENT_TYPE);
  return headers;
}
