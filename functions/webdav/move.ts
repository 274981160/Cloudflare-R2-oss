import { canWrite } from "../../utils/auth";
import { CoreError, deletePath, statPath } from "../../utils/core";
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

  try {
    await deletePath(bucket, path);
  } catch (error) {
    if (error instanceof CoreError) {
      // 复制已经成功、只是清理源失败：不能装作整体成功（那会变成两份），
      // 也不能回 500 让客户端以为移动根本没发生。按 403/409 如实上报。
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
  return new Response(null, { status: copyResponse.status });
}
