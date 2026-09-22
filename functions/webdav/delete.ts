import { deletePath } from "../../utils/core";
import { DavContext } from "./context";

export async function handleRequestDelete(context: DavContext): Promise<Response> {
  const { bucket, path } = context;

  if (!path) {
    return new Response("不允许删除根目录", { status: 403 });
  }

  const deleted = await deletePath(bucket, path);
  if (deleted === 0) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
