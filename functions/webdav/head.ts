import { DIRECTORY_CONTENT_TYPE } from "../../utils/config";
import { statPath } from "../../utils/core";
import { serveObject } from "../../utils/serve";
import { DavContext } from "./context";

export async function handleRequestHead(context: DavContext): Promise<Response> {
  const { bucket, path, request } = context;

  const stat = await statPath(bucket, path);
  if (!stat) return new Response("Not found", { status: 404 });

  if (stat.isDirectory) {
    const headers = new Headers();
    headers.set("Content-Type", DIRECTORY_CONTENT_TYPE);
    if (stat.uploaded) headers.set("Last-Modified", stat.uploaded.toUTCString());
    headers.set("Accept-Ranges", "bytes");
    return new Response(null, { status: 200, headers });
  }

  const response = await serveObject(bucket, path, request, {
    headOnly: true,
    stat,
  });
  if (!response) return new Response("Not found", { status: 404 });
  return response;
}
