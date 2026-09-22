import { canWrite } from "../../utils/auth";
import { extractKeyFromPathname } from "../../utils/bucket";
import { isLockingEnabled } from "../../utils/config";
import { CoreError, copyPath } from "../../utils/core";
import { findBlockingLock } from "../../utils/lock";
import { DavContext } from "./context";

/** 把 Destination 头解析成同一个站点 `/webdav/` 下的对象键。 */
export function resolveDestination(
  request: Request,
  header: string
): string | null {
  let url: URL;
  try {
    url = new URL(header, request.url);
  } catch (error) {
    return null;
  }
  const origin = new URL(request.url).origin;
  if (url.origin !== origin) return null;
  return extractKeyFromPathname(url.pathname, "/webdav");
}

export function readOverwrite(request: Request): boolean {
  const header = (request.headers.get("Overwrite") || "T").trim().toUpperCase();
  return header !== "F";
}

export function readCopyDepth(request: Request): "0" | "infinity" {
  const header = (request.headers.get("Depth") || "infinity").trim().toLowerCase();
  return header === "0" ? "0" : "infinity";
}

export async function handleRequestCopy(context: DavContext): Promise<Response> {
  const { bucket, path, request, env, subject, lockTokens } = context;

  const destinationHeader = request.headers.get("Destination");
  if (!destinationHeader) {
    return new Response("缺少 Destination 头", { status: 400 });
  }

  const destination = resolveDestination(request, destinationHeader);
  if (destination === null) {
    return new Response("Destination 必须是本站 /webdav/ 下的地址", { status: 400 });
  }
  if (!destination) {
    return new Response("Destination 不能指向根目录", { status: 400 });
  }

  if (!canWrite(subject, destination)) {
    return new Response("没有目标路径的写入权限", { status: 403 });
  }

  if (isLockingEnabled(env)) {
    const destinationLock = await findBlockingLock(bucket, destination, lockTokens);
    if (destinationLock.locked) {
      return new Response("目标资源已被锁定", { status: 423 });
    }
  }

  try {
    const result = await copyPath(bucket, path, destination, {
      overwrite: readOverwrite(request),
      depth: readCopyDepth(request),
    });
    return new Response(null, { status: result.created ? 201 : 204 });
  } catch (error) {
    if (error instanceof CoreError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}
