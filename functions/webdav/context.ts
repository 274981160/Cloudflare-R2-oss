import { Env, isLockingEnabled } from "../../utils/config";
import { Subject } from "../../utils/auth";

/** 各 WebDAV 方法处理函数的入参。 */
export interface DavContext {
  bucket: R2Bucket;
  /** 规范化的对象键，不含首尾斜杠。 */
  path: string;
  request: Request;
  env: Env;
  subject: Subject;
  /** 请求携带的锁令牌（来自 If / Lock-Token 头）。 */
  lockTokens: string[];
}

export const DAV_HEADER_VALUE = "1, 2";

/** 统一补上 WebDAV 相关响应头；关掉锁时不宣告 class 2。 */
export function withDavHeaders(response: Response, env?: Env): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "DAV",
    env && !isLockingEnabled(env) ? "1" : DAV_HEADER_VALUE
  );
  headers.set("MS-Author-Via", "DAV");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function xmlResponse(body: string, status = 207): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** 读取请求体文本，空体返回空串。 */
export async function readBodyText(request: Request): Promise<string> {
  try {
    return await request.text();
  } catch (error) {
    return "";
  }
}

export function parentOf(key: string): string {
  const index = key.lastIndexOf("/");
  return index < 0 ? "" : key.slice(0, index);
}
