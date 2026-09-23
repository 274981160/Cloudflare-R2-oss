import { Env } from "../../../utils/config";
import {
  authenticate,
  canRead,
  canWrite,
  forbidden,
  isInternalPath,
  unauthorized,
  type Subject,
} from "../../../utils/auth";
import {
  badRequest,
  jsonResponse,
  notFound,
  parseBucketPath,
  serverError,
} from "../../../utils/bucket";
import { statPath } from "../../../utils/core";
import { extractZipArchive, readZipIndex } from "../../../utils/unzip";

/**
 * 在线解压：把网盘里的 zip 文件解压到指定目录（默认解到它所在的目录）。
 *
 * POST /api/unzip/{zipKey}   body: { "target": "可选目标目录" }
 * 需要认证；zip 本身要可读，落盘位置要可写；每个条目再逐条过权限。
 */
export const onRequestPost: PagesFunction<Env> = async function (context) {
  try {
    const { request, env } = context;
    const parsed = parseBucketPath(context, "/api/unzip");
    if (!parsed) return notFound();
    const { bucket, path } = parsed;
    if (!path) return badRequest("请指定要解压的 zip 文件");

    const auth = await authenticate(request, env, bucket);
    if (auth.invalid) return unauthorized("用户名或密码不正确");
    const subject: Subject = { account: auth.account, anonymous: auth.anonymous, env };

    const stat = await statPath(bucket, path);
    if (!stat) return notFound("zip 文件不存在");
    if (stat.isDirectory) return badRequest("请指定 zip 文件，不是目录");

    if (!canRead(subject, path)) {
      return auth.anonymous ? unauthorized("需要登录") : forbidden("没有读取该 zip 的权限");
    }

    let target = "";
    try {
      const body: any = await request.json();
      if (typeof body?.target === "string" && body.target.trim()) {
        target = body.target.trim().replace(/^\/+|\/+$/g, "");
      }
    } catch (error) {
      /* 没有 body 就默认解到 zip 所在目录 */
    }

    if (!target) {
      // 默认解到 zip 所在目录（父目录）
      const slash = path.lastIndexOf("/");
      target = slash < 0 ? "" : path.slice(0, slash);
    }
    // 拒绝 `..`、绝对路径等目标，防止跳出权限前缀
    const safeTarget = target
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
    if (safeTarget.some((segment) => segment === ".." || segment === ".")) {
      return badRequest("目标目录包含非法路径段");
    }
    target = safeTarget.join("/");
    if (isInternalPath(target)) return forbidden("不允许解压到内部目录");
    if (!canWrite(subject, target)) {
      return auth.anonymous ? unauthorized("需要登录") : forbidden("没有写入目标目录的权限");
    }

    // 先确认这是可解析的 zip，再逐条解压（非 zip 直接 400）
    const index = await readZipIndex(bucket, path, stat.size);
    if (!index) return badRequest("不是有效的 zip 文件");

    const result = await extractZipArchive(
      bucket,
      path,
      stat.size,
      target,
      env,
      (key) => canWrite(subject, key),
      index
    );
    return jsonResponse({ target, files: result.files, errors: result.errors });
  } catch (error) {
    return serverError(error);
  }
};