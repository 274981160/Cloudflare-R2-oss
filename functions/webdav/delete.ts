import { isTrashEnabled } from "../../utils/config";
import { CoreError, deletePath } from "../../utils/core";
import { moveToTrash } from "../../utils/trash";
import { DavContext } from "./context";

/**
 * DELETE：默认移入回收站（可恢复），`WEBDAV_TRASH=0` 时保持原来的直接删除。
 * 回收站是「软删除」——只写一条记录、内容原地不动，因此删除瞬间完成，
 * 也不会因为目录很大而中途失败。
 */
export async function handleRequestDelete(context: DavContext): Promise<Response> {
  const { bucket, path, env, subject, request } = context;

  if (!path) {
    return new Response("不允许删除根目录", { status: 403 });
  }

  // `DELETE ?uploadId=` 是「放弃分片上传」（S3 语义的 AbortMultipartUpload）：
  // 不删对象，只把没传完的分片任务取消掉，免得留下垃圾分片一直占空间
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (uploadId) {
    try {
      const upload = bucket.resumeMultipartUpload(path, uploadId);
      await upload.abort();
      return new Response(null, { status: 204 });
    } catch (error) {
      // 任务已经不存在/已完成：按幂等处理
      return new Response(null, { status: 204 });
    }
  }

  try {
    if (isTrashEnabled(env)) {
      const entry = await moveToTrash(
        bucket,
        path,
        subject && subject.account ? subject.account.username : null
      );
      if (!entry) return new Response("Not found", { status: 404 });
      // 告诉客户端「去哪了」，前端据此提示可在回收站恢复
      return new Response(null, {
        status: 204,
        headers: { "X-FlareDrive-Trash": entry.id },
      });
    }

    const deleted = await deletePath(bucket, path);
    if (deleted === 0) return new Response("Not found", { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof CoreError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}
