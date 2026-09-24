import { Env } from "../../utils/config";
import {
  hasPassword,
  hasValidPasswordCookie,
  loadShare,
  loadShareAnyState,
  passwordCookieHeader,
  resolveSharePath,
  verifySharePassword,
  type ShareRecord,
} from "../../utils/share";
import { methodNotAllowed, notFound, parseBucketPath, serverError } from "../../utils/bucket";
import { baseName, listDirectory, statPath } from "../../utils/core";
import { serveObject } from "../../utils/serve";
import { previewKindOf, renderSharePage, type ShareEntry } from "../../utils/sharepage";
import { buildZipResponse } from "../../utils/zipserve";

/**
 * 分享链接的公开入口，也是**唯一**允许匿名读取内容的通道。
 *
 * - token 不存在 / 已过期 / 非法 → 一律 404（不区分，避免探测）
 * - 只能读到被分享的那一个对象，或被分享目录这棵子树
 * - 目录页是只读浏览页：只能预览与下载，没有任何写入口
 * - 不支持跨域读取，避免被第三方页面热链
 */

const SHARE_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];

function shareHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra || {});
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

async function renderShareListing(
  bucket: R2Bucket,
  share: ShareRecord,
  target: string,
  relative: string
): Promise<Response> {
  const listing = await listDirectory(bucket, target);

  const entries: ShareEntry[] = [
    ...listing.folders.map((folder) => ({
      name: folder.name,
      key: folder.name,
      isDirectory: true,
      size: 0,
      uploaded: null as string | null,
      contentType: "application/x-directory",
      previewKind: "" as ShareEntry["previewKind"],
    })),
    ...listing.files.map((file) => ({
      name: file.name,
      key: file.name,
      isDirectory: false,
      size: file.size,
      uploaded: file.uploaded ? file.uploaded.toISOString() : null,
      contentType: file.contentType,
      previewKind: previewKindOf(file.contentType, file.name),
    })),
  ];

  const html = renderSharePage({
    token: share.token,
    shareKey: share.key,
    relative,
    entries,
    allowZip: true,
  });

  return new Response(html, {
    status: 200,
    headers: shareHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}

export const onRequest: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: shareHeaders({ Allow: SHARE_METHODS.join(", "), "Content-Length": "0" }),
      });
    }
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      const response = methodNotAllowed(SHARE_METHODS);
      return new Response(response.body, {
        status: response.status,
        headers: shareHeaders({ Allow: SHARE_METHODS.join(", ") }),
      });
    }

    const parsed = parseBucketPath(context, "/s");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;
    if (!path) return notFound();

    const slash = path.indexOf("/");
    const token = slash === -1 ? path : path.slice(0, slash);
    const relative = slash === -1 ? "" : path.slice(slash + 1);

    // 访问密码（B2）：设置了密码的分享要先提交正确密码；
    // 验证通过签发 HttpOnly cookie，之后 30 天内免重复输入。
    const url0 = new URL(request.url);
    const shareAny = await loadShareAnyState(bucket, token);
    if (shareAny && shareAny.suspended) {
      // 暂停中的分享：链接还在但内容不可访问；页面给出明确原因，避免访问者以为是死链
      return shareSuspendedPage();
    }
    const share = await loadShare(bucket, token);
    if (!share) return notFound();

    if (hasPassword(share) && !(await hasValidPasswordCookie(env, share, request))) {
      if (method === "POST") {
        let submitted = "";
        try {
          const form = await request.formData();
          submitted = String(form.get("password") || "");
        } catch (error) {
          submitted = "";
        }
        if (await verifySharePassword(share, submitted)) {
          const cookie = await passwordCookieHeader(env, share);
          // 验证通过：跳回本页（GET），把密码从地址栏/历史里带走。
          // 注意不能 `{...headers}` 展开 Headers 对象——它不是可枚举属性，会全部丢失
          const headers = shareHeaders({
            "Set-Cookie": cookie || "",
            "Cache-Control": "no-store",
            Location: url0.pathname + (url0.search || ""),
          });
          return new Response(null, { status: 303, headers });
        }
        return sharePasswordPage(share.token, true, relative);
      }
      return sharePasswordPage(share.token, false, relative);
    }

    const target = resolveSharePath(share, relative);
    if (!target) return notFound();

    const stat = await statPath(bucket, target);
    if (!stat) return notFound();

    const url = new URL(request.url);

    if (stat.isDirectory) {
      if (url.searchParams.has("zip")) {
        const response = await buildZipResponse(bucket, target, env, {
          archiveName: baseName(target) || "share",
        });
        const headers = shareHeaders(Object.fromEntries(response.headers));
        return new Response(response.body, { status: response.status, headers });
      }
      const response = await renderShareListing(bucket, share, target, relative);
      return method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    const response = await serveObject(bucket, target, request, {
      stat,
      headOnly: method === "HEAD",
    });
    if (!response) return notFound();

    const headers = shareHeaders(Object.fromEntries(response.headers));
    if (url.searchParams.has("download") || url.searchParams.has("dl")) {
      const filename = baseName(target) || "download";
      const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      headers.set(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
          filename
        )}`
      );
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return serverError(error);
  }
};

/** 暂停中的分享：明确告知「已暂停」，而不是装作链接失效 */
function shareSuspendedPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>分享已暂停</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f7f7f9;color:#1f2328;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #e8e8ec;border-radius:12px;padding:32px;max-width:400px;text-align:center}h1{font-size:18px;margin:0 0 10px}p{color:#6b7280;font-size:14px;line-height:1.7;margin:0}</style>
</head><body><div class="card"><h1>分享已暂停</h1><p>分享者暂时关闭了这个链接的访问。<br />链接本身没有失效，恢复后这个地址可以继续使用。</p></div></body></html>`;
  return new Response(html, {
    status: 404,
    headers: shareHeaders({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

/** 密码输入页 */
function sharePasswordPage(token: string, wrong: boolean, relative: string): Response {
  const action = `/s/${token}/${relative.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${relative ? "/" : ""}`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>需要访问密码 · 分享</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f7f7f9;color:#1f2328;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #e8e8ec;border-radius:12px;padding:32px;max-width:400px;width:100%;margin:16px}
h1{font-size:18px;margin:0 0 10px}
p{color:#6b7280;font-size:13px;line-height:1.7;margin:0 0 18px}
input{width:100%;box-sizing:border-box;border:1px solid #d8d8de;border-radius:8px;padding:10px 12px;font-size:15px;margin-bottom:14px}
input:focus{outline:none;border-color:#f38020}
button{width:100%;appearance:none;border:0;border-radius:8px;background:#f38020;color:#fff;font-size:15px;padding:11px;cursor:pointer}
button:hover{background:#e0721a}
.err{background:#fdecec;color:#b42318;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
</style>
</head><body><div class="card">
<h1>这个分享设置了访问密码</h1>
<p>输入分享者提供的密码后才能查看内容。密码验证通过后 30 天内本设备无需重复输入。</p>
${wrong ? '<div class="err">密码不正确，请重试。</div>' : ""}
<form method="post" action="${escapeAttr(action)}">
<input type="password" name="password" placeholder="访问密码" autocomplete="current-password" required autofocus />
<button type="submit">查看内容</button>
</form>
</div></body></html>`;
  return new Response(html, {
    status: wrong ? 401 : 200,
    headers: shareHeaders({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
