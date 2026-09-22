import { isAutoMkdirEnabled } from "../../utils/config";
import {
  ensureDirectoryChain,
  putDirectory,
  statPath,
} from "../../utils/core";
import { DavContext, parentOf } from "./context";

export async function handleRequestMkcol(context: DavContext): Promise<Response> {
  const { bucket, path, env } = context;

  if (!path) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const existing = await statPath(bucket, path);
  if (existing) {
    // RFC 4918：目标已存在时 MKCOL 必须失败
    return new Response("Method Not Allowed", { status: 405 });
  }

  const parent = parentOf(path);
  if (parent) {
    const parentStat = await statPath(bucket, parent);
    if (!parentStat || !parentStat.isDirectory) {
      if (!isAutoMkdirEnabled(env)) {
        return new Response("Conflict", { status: 409 });
      }
      await ensureDirectoryChain(bucket, path);
      return new Response(null, { status: 201 });
    }
  }

  await putDirectory(bucket, path);
  return new Response(null, { status: 201 });
}
