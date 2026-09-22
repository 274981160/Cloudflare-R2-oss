import { buildPropstatResponse, extractPropNames } from "../../utils/xml";
import { DavContext, readBodyText, xmlResponse } from "./context";

/**
 * PROPPATCH。
 *
 * 死属性（dead properties）不做持久化：属性集合统一回 200，表示已受理。
 * 这是绝大多数轻量 DAV 服务端的做法，能避免 macOS Finder / Office
 * 写入扩展属性时报错中断流程。
 */
export async function handleRequestProppatch(
  context: DavContext
): Promise<Response> {
  const { request } = context;
  const body = await readBodyText(request);
  const names = extractPropNames(body);
  const href = new URL(request.url).pathname;

  const groups = names.length
    ? [
        {
          status: "HTTP/1.1 200 OK",
          props: names.map((name) => ({ name, value: "" })),
        },
      ]
    : [];

  return xmlResponse(buildPropstatResponse(href, groups), 207);
}
