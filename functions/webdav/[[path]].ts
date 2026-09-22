import {
  Env,
  INTERNAL_PREFIX,
  isLockingEnabled,
} from "../../utils/config";
import {
  authenticate,
  canList,
  canRead,
  canWrite,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
} from "../../utils/auth";
import { notFound, parseBucketPath, serverError } from "../../utils/bucket";
import { isThumbnailKey, statPath } from "../../utils/core";
import { findBlockingLock } from "../../utils/lock";
import { parseIfHeaderTokens } from "../../utils/xml";
import { DavContext, withDavHeaders } from "./context";
import { handleRequestCopy } from "./copy";
import { handleRequestDelete } from "./delete";
import { handleRequestGet } from "./get";
import { handleRequestHead } from "./head";
import { handleRequestLock, handleRequestUnlock } from "./lock";
import { handleRequestMkcol } from "./mkcol";
import { handleRequestMove } from "./move";
import { handleRequestPost } from "./post";
import { handleRequestPropfind } from "./propfind";
import { handleRequestProppatch } from "./proppatch";
import { handleRequestPut } from "./put";

const HANDLERS: Record<string, (context: DavContext) => Promise<Response>> = {
  PROPFIND: handleRequestPropfind,
  PROPPATCH: handleRequestProppatch,
  MKCOL: handleRequestMkcol,
  HEAD: handleRequestHead,
  GET: handleRequestGet,
  POST: handleRequestPost,
  PUT: handleRequestPut,
  COPY: handleRequestCopy,
  MOVE: handleRequestMove,
  DELETE: handleRequestDelete,
  LOCK: handleRequestLock,
  UNLOCK: handleRequestUnlock,
};

const READ_METHODS = new Set(["GET", "HEAD", "PROPFIND"]);

/** 需要做锁校验的方法；LOCK/UNLOCK 自己在处理函数里管锁。 */
const LOCK_CHECKED_METHODS = new Set([
  "PUT",
  "POST",
  "DELETE",
  "MKCOL",
  "COPY",
  "MOVE",
  "PROPPATCH",
]);

function collectLockTokens(request: Request): string[] {
  const tokens = parseIfHeaderTokens(request.headers.get("If"));
  const header = request.headers.get("Lock-Token");
  if (header) {
    const cleaned = header.trim().replace(/^</, "").replace(/>$/, "");
    if (cleaned) tokens.push(cleaned);
  }
  return Array.from(new Set(tokens));
}

function handleOptions(env: Env): Response {
  const allow = [
    "OPTIONS",
    "GET",
    "HEAD",
    "PROPFIND",
    "POST",
    "PUT",
    "DELETE",
    "MKCOL",
    "COPY",
    "MOVE",
    "PROPPATCH",
  ];
  if (isLockingEnabled(env)) allow.push("LOCK", "UNLOCK");

  return withDavHeaders(
    new Response(null, {
      status: 200,
      headers: { Allow: allow.join(", "), "Content-Length": "0" },
    }),
    env
  );
}

function lockedResponse(detail: { owner?: string; path?: string }): Response {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:error xmlns:D="DAV:">
  <D:lock-token-submitted>
    <D:href>${detail.path ? encodeURI(detail.path) : ""}</D:href>
  </D:lock-token-submitted>
</D:error>`;
  return new Response(body, {
    status: 423,
    headers: { "Content-Type": 'application/xml; charset="utf-8"' },
  });
}

export const onRequest: PagesFunction<Env> = async function (context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return handleOptions(env);

  const parsed = parseBucketPath(context, "/webdav");
  if (!parsed) return withDavHeaders(notFound(), env);
  const { bucket, path } = parsed;

  const auth = await authenticate(request, env, bucket);
  if (auth.invalid) {
    return withDavHeaders(unauthorized("用户名或密码不正确"), env);
  }
  const subject: Subject = {
    account: auth.account,
    anonymous: auth.anonymous,
    env,
  };

  const handler = HANDLERS[method];
  if (!handler) {
    return withDavHeaders(
      new Response("Method Not Implemented", {
        status: 501,
        headers: { Allow: Object.keys(HANDLERS).join(", ") },
      }),
      env
    );
  }

  if (READ_METHODS.has(method)) {
    // 内部保留目录只允许直接访问缩略图，其余一律当作不存在
    if (isInternalPath(path) && !isThumbnailKey(path)) {
      return withDavHeaders(notFound(), env);
    }
    const stat = await statPath(bucket, path);
    const allowed = stat
      ? stat.isDirectory
        ? canList(subject, path)
        : canRead(subject, path)
      : canRead(subject, path) || canList(subject, path);
    if (!allowed) {
      return withDavHeaders(
        auth.anonymous
          ? unauthorized("需要登录")
          : forbidden("没有访问该路径的权限"),
        env
      );
    }
  } else {
    if (isInternalPath(path) && !isThumbnailKey(path)) {
      return withDavHeaders(forbidden("内部保留目录不可写"), env);
    }
    if (!canWrite(subject, path)) {
      return withDavHeaders(
        auth.anonymous
          ? unauthorized("需要登录")
          : forbidden("没有写入该路径的权限"),
        env
      );
    }
  }

  const lockTokens = collectLockTokens(request);

  if (LOCK_CHECKED_METHODS.has(method) && isLockingEnabled(env)) {
    const blocking = await findBlockingLock(bucket, path, lockTokens);
    if (blocking.locked) {
      return withDavHeaders(lockedResponse(blocking), env);
    }
  }

  try {
    const response = await handler({
      bucket,
      path,
      request,
      env,
      subject,
      lockTokens,
    });
    return withDavHeaders(response, env);
  } catch (error) {
    return withDavHeaders(serverError(error), env);
  }
};
