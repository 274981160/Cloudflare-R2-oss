import { objectWriteOptions } from "../../utils/core";
import { DavContext } from "./context";

async function createMultipart(context: DavContext): Promise<Response> {
  const { bucket, path, request } = context;
  if (!path) return new Response("Bad Request", { status: 400 });

  const options = objectWriteOptions(request);
  const multipartUpload = await bucket.createMultipartUpload(path, options as any);

  return new Response(
    JSON.stringify({ key: multipartUpload.key, uploadId: multipartUpload.uploadId }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

async function completeMultipart(context: DavContext): Promise<Response> {
  const { bucket, path, request } = context;
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (!uploadId || !path) return new Response("Bad Request", { status: 400 });

  let body: { parts: Array<any> };
  try {
    body = await request.json();
  } catch (error) {
    return new Response("Bad Request", { status: 400 });
  }

  if (!body || !Array.isArray(body.parts)) {
    return new Response("Bad Request", { status: 400 });
  }

  try {
    const multipartUpload = bucket.resumeMultipartUpload(path, uploadId);
    const object = await multipartUpload.complete(body.parts);
    const headers = new Headers();
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(null, { status: 200, headers });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      { status: 400 }
    );
  }
}

/**
 * POST 不是标准 WebDAV 方法，这里承载网页端的分片上传：
 * `?uploads` 创建分片任务，`?uploadId=` 完成分片任务。
 */
export async function handleRequestPost(context: DavContext): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.searchParams.has("uploads")) return createMultipart(context);
  if (url.searchParams.has("uploadId")) return completeMultipart(context);
  return new Response("Method Not Allowed", { status: 405 });
}
