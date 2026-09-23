import { Env } from "./config";
import { normalizePath } from "./auth";

export interface ParsedRequest {
  bucket: R2Bucket;
  /** 规范化的 R2 对象键，不含首尾斜杠；根目录为空串。 */
  path: string;
  url: URL;
}

function isBucketLike(value: any): value is R2Bucket {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.get === "function" &&
    typeof value.put === "function" &&
    typeof value.list === "function"
  );
}

/**
 * 从 URL pathname 中解析出 R2 对象键（已解码、去掉首尾斜杠）。
 * 返回 null 表示该 pathname 不属于这个路由或路径非法。
 */
export function extractKeyFromPathname(
  pathname: string,
  routePrefix: string
): string | null {
  let remainder: string;
  if (pathname === routePrefix || pathname === `${routePrefix}/`) {
    remainder = "";
  } else if (pathname.startsWith(`${routePrefix}/`)) {
    remainder = pathname.slice(routePrefix.length + 1);
  } else {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(remainder);
  } catch (error) {
    decoded = remainder;
  }

  if (decoded.includes("\0")) return null;

  const cleaned = normalizePath(decoded);
  for (const segment of cleaned.split("/")) {
    if (segment === "..") return null;
  }
  return cleaned;
}

/**
 * 解析请求 URL 中的 R2 对象键。
 *
 * 直接取 `URL.pathname` 再整体解码一次，保证结果可预期（不依赖运行时对
 * `params.path` 是否已解码的行为）。返回 null 表示路径非法。
 */
export function extractKey(request: Request, routePrefix: string): string | null {
  return extractKeyFromPathname(new URL(request.url).pathname, routePrefix);
}

/**
 * 选择目标存储桶：取主机名第一段作为绑定名，找不到则回落到 `BUCKET`，
 * 因此可以用 `a.example.com` / `b.example.com` 指向不同桶。
 */
export function resolveBucket(env: Env, url: URL): R2Bucket | null {
  const driveId = url.hostname.replace(/\..*/, "");
  const candidate = driveId ? env[driveId] : undefined;

  if (isBucketLike(candidate)) return candidate;
  if (isBucketLike(env.BUCKET)) return env.BUCKET;
  return null;
}

/**
 * 解析出目标存储桶与对象键。
 */
export function parseBucketPath(
  context: any,
  routePrefix: string
): ParsedRequest | null {
  const { request, env } = context as { request: Request; env: Env };
  const path = extractKey(request, routePrefix);
  if (path === null) return null;

  const url = new URL(request.url);
  const bucket = resolveBucket(env, url);
  if (!bucket) return null;
  return { bucket, path, url };
}

export function notFound(message = "Not found"): Response {
  return new Response(message, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function badRequest(message = "Bad Request"): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function conflict(message = "Conflict"): Response {
  return new Response(message, {
    status: 409,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function methodNotAllowed(allow?: string[]): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (allow && allow.length) headers.Allow = allow.join(", ");
  return new Response("Method Not Allowed", { status: 405, headers });
}

export function payloadTooLarge(message = "Payload Too Large"): Response {
  return new Response(message, {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function preconditionFailed(message = "Precondition Failed"): Response {
  return new Response(message, {
    status: 412,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function serverError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[flaredrive]", error);
  const status =
    error && typeof error === "object" && typeof (error as any).status === "number"
      ? (error as any).status
      : 500;
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
