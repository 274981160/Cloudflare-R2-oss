import { isLockingEnabled } from "../../utils/config";
import { statPath } from "../../utils/core";
import {
  LockInfo,
  createLockToken,
  dropLock,
  findBlockingLock,
  normalizeTimeout,
  readLock,
  writeLock,
} from "../../utils/lock";
import {
  encodeHref,
  escapeXml,
  extractLockOwner,
  parseTimeoutHeader,
} from "../../utils/xml";
import { DavContext, readBodyText } from "./context";

function activeLockXml(lock: LockInfo, origin: string): string {
  return `<activelock>
        <locktype><write /></locktype>
        <lockscope><exclusive /></lockscope>
        <depth>${escapeXml(lock.depth)}</depth>
        ${lock.owner ? `<owner>${lock.owner}</owner>` : "<owner />"}
        <timeout>Second-${lock.timeoutSeconds}</timeout>
        <locktoken><href>${escapeXml(lock.token)}</href></locktoken>
        <lockroot><href>${escapeXml(
          origin + encodeHref(lock.path, true)
        )}</href></lockroot>
      </activelock>`;
}

function lockResponseBody(lock: LockInfo, origin: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<prop xmlns="DAV:">
  <lockdiscovery>
      ${activeLockXml(lock, origin)}
  </lockdiscovery>
</prop>`;
}

function lockResponse(lock: LockInfo, origin: string): Response {
  return new Response(lockResponseBody(lock, origin), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${lock.token}>`,
      Timeout: `Second-${lock.timeoutSeconds}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function handleRequestLock(context: DavContext): Promise<Response> {
  const { bucket, path, request, env, subject, lockTokens } = context;

  if (!isLockingEnabled(env)) {
    return new Response("LOCK 未启用", { status: 501 });
  }

  const origin = new URL(request.url).origin;
  const body = await readBodyText(request);
  const owner = extractLockOwner(body);
  const timeoutSeconds = normalizeTimeout(
    parseTimeoutHeader(request.headers.get("Timeout"))
  );

  const depthHeader = (request.headers.get("Depth") || "infinity")
    .trim()
    .toLowerCase();
  let depth: "0" | "infinity" = depthHeader === "0" ? "0" : "infinity";

  const existing = await readLock(bucket, path);
  if (existing) {
    if (lockTokens.includes(existing.token)) {
      // 续期
      existing.expires = Date.now() + timeoutSeconds * 1000;
      existing.timeoutSeconds = timeoutSeconds;
      if (owner) existing.owner = owner;
      await writeLock(bucket, existing);
      return lockResponse(existing, origin);
    }
    return new Response("资源已被锁定", { status: 423 });
  }

  const blocking = await findBlockingLock(bucket, path, lockTokens);
  if (blocking.locked) {
    return new Response("资源被上层目录锁定", { status: 423 });
  }

  const stat = await statPath(bucket, path);
  if (!stat) {
    // RFC 4918 9.10.4：对未映射的 URL 加锁会创建一个空资源
    const asCollection = new URL(request.url).pathname.endsWith("/");
    if (asCollection) {
      await bucket.put(path, "", {
        httpMetadata: { contentType: "application/x-directory" },
      });
      depth = "infinity";
    } else {
      await bucket.put(path, "");
    }
  } else if (stat.isDirectory) {
    depth = depth === "0" ? "0" : "infinity";
  }

  const lock: LockInfo = {
    path,
    token: createLockToken(),
    owner,
    depth,
    timeoutSeconds,
    expires: Date.now() + timeoutSeconds * 1000,
    created: Date.now(),
    username: subject.account ? subject.account.username : null,
  };
  await writeLock(bucket, lock);

  return lockResponse(lock, origin);
}

export async function handleRequestUnlock(context: DavContext): Promise<Response> {
  const { bucket, path, request, env } = context;

  if (!isLockingEnabled(env)) {
    return new Response("UNLOCK 未启用", { status: 501 });
  }

  const header = request.headers.get("Lock-Token");
  const token = header ? header.trim().replace(/^</, "").replace(/>$/, "") : "";
  if (!token) return new Response("缺少 Lock-Token 头", { status: 400 });

  const existing = await readLock(bucket, path);
  if (!existing) return new Response("资源没有锁", { status: 409 });
  if (existing.token !== token) {
    return new Response("锁令牌不匹配", { status: 409 });
  }

  await dropLock(bucket, path);
  return new Response(null, { status: 204 });
}
