import { Env, unzipConcurrency } from "../../../utils/config";
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
import {
  extractZipArchive,
  findZipConflicts,
  readZipIndex,
  type UnzipMode,
} from "../../../utils/unzip";

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
    let mode = "skip";
    try {
      const body: any = await request.json();
      if (typeof body?.target === "string" && body.target.trim()) {
        target = body.target.trim().replace(/^\/+|\/+$/g, "");
      }
      if (["check", "skip", "overwrite"].includes(body?.mode)) mode = body.mode;
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

    // mode=check：只报告同名冲突，不写任何东西（前端据此问用户「跳过还是覆盖」）
    if (mode === "check") {
      const pre = await findZipConflicts(
        bucket,
        path,
        stat.size,
        target,
        (key) => canWrite(subject, key),
        index
      );
      return jsonResponse({
        target,
        total: pre.total,
        conflictCount: pre.conflicts.length,
        conflicts: pre.conflicts.slice(0, 20),
      });
    }

    /**
     * 解压可能要处理成百上千个条目，干等没有任何反馈。
     * 这里用 **NDJSON 流**把进度边做边推给前端：
     *   {"type":"progress","done":12,"total":50,"files":10,"skipped":2}
     *   {"type":"done","target":"...","files":45,"skipped":3,"errors":[]}
     * 出错则推 {"type":"error","message":"..."}。
     */
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    let lastReport = 0;
    const send = (payload: unknown) =>
      writer.write(encoder.encode(`${JSON.stringify(payload)}\n`));

    void (async () => {
      try {
        const result = await extractZipArchive(
          bucket,
          path,
          stat.size,
          target,
          env,
          (key) => canWrite(subject, key),
          index,
          {
            mode: mode as UnzipMode,
            concurrency: unzipConcurrency(env),
            onProgress: (done, total, stats) => {
              // 节流：最多每 150ms 推一次，避免条目很多时刷爆流
              const now = Date.now();
              if (done < total && now - lastReport < 150) return;
              lastReport = now;
              void send({ type: "progress", done, total, ...stats });
            },
          }
        );
        await send({
          type: "done",
          target,
          files: result.files,
          skipped: result.skipped,
          errors: result.errors,
        });
      } catch (error) {
        await send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // 关掉中间层缓冲，让进度尽快到达
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return serverError(error);
  }
};