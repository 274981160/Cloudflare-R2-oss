import { isAutoMkdirEnabled } from "../../utils/config";
import {
  ensureDirectoryChain,
  putDirectory,
  statPath,
} from "../../utils/core";
import { isTrashed } from "../../utils/trashindex";
import { DavContext, parentOf } from "./context";

export async function handleRequestMkcol(context: DavContext): Promise<Response> {
  const { bucket, path, env } = context;

  if (!path) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 回收站里的同名位置：不允许直接建目录（那里还留着可恢复的内容），
  // 让用户先恢复或彻底删除
  if (await isTrashed(bucket, path)) {
    return new Response(
      "该路径在回收站里，请先从回收站恢复或彻底删除",
      { status: 409 }
    );
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
