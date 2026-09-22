/**
 * 全站中间件。
 *
 * 1) 屏蔽仓库里的源码 / 脚本 / 文档等非站点文件。
 *    Cloudflare Pages 会把输出目录里的一切都当静态资源发布，`utils/*.ts`、
 *    `scripts/*.sh`、`docs/*.md`、`package.json` 这些本来不该被当成站点资源访问
 *    （测试脚本里还写着本地演示口令）。这里统一回 404。
 *    `_redirects` 不支持 404 状态码，所以只能用中间件做。
 *
 * 2) 给所有响应补上几个基础安全响应头（已存在的不覆盖）。
 */
import { Env } from "../utils/config";

const BLOCKED_PREFIXES = [
  "/utils/",
  "/scripts/",
  "/docs/",
  "/.git/",
  "/.wrangler/",
];

const BLOCKED_EXACT = new Set([
  "/package.json",
  "/package-lock.json",
  "/tsconfig.json",
  "/.gitignore",
  "/.dev.vars",
  "/wrangler.toml",
  "/wrangler.jsonc",
]);

function isBlocked(pathname: string): boolean {
  if (BLOCKED_EXACT.has(pathname)) return true;
  return BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const onRequest: PagesFunction<Env> = async function (context) {
  const pathname = new URL(context.request.url).pathname;

  if (isBlocked(pathname)) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const response = await context.next();
  const headers = new Headers(response.headers);
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
