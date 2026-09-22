import { canWrite } from "../../utils/auth";
import { deletePath, statPath } from "../../utils/core";
import { DavContext } from "./context";
import { handleRequestCopy } from "./copy";

/** MOVE = COPY + 删除源，复用 copy 的全部校验逻辑。 */
export async function handleRequestMove(context: DavContext): Promise<Response> {
  const { bucket, path, request, subject } = context;

  if (!path) {
    return new Response("不允许移动根目录", { status: 403 });
  }

  const stat = await statPath(bucket, path);
  if (!stat) return new Response("Not found", { status: 404 });

  const depthHeader = (request.headers.get("Depth") || "infinity")
    .trim()
    .toLowerCase();
  if (stat.isDirectory && depthHeader === "0") {
    return new Response("对集合执行 MOVE 时 Depth 必须为 infinity", {
      status: 400,
    });
  }

  if (!canWrite(subject, path)) {
    return new Response("没有源路径的写入权限", { status: 403 });
  }

  const copyResponse = await handleRequestCopy(context);
  if (copyResponse.status >= 400) return copyResponse;

  await deletePath(bucket, path);
  return new Response(null, { status: copyResponse.status });
}
