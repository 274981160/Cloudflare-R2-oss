/**
 * 登录限流（B3）：防止对账号密码的在线爆破。
 *
 * 为什么这么做：
 * - Workers 环境没有 KV / Durable Objects 可依赖（本项目保持零运行时依赖），
 *   用 R2 对象存失败记录。R2 写入没有原子性，但限流不需要精确——
 *   并发请求偶尔都读到「未锁定」也没关系，只要失败记录不断累积即可拦住爆破。
 * - 按「IP + 用户名」组合记录：换用户名爆破也绕不开同一个 IP 的累计；
 *   正常用户偶尔输错自己密码，只影响自己这个组合。
 * - 滑动窗口：只统计最近 N 分钟内的失败次数，清晨的一次输错不会在晚上惩罚你。
 * - 惩罚是「要求等待」而不是「永久锁死」：根据最近失败间隔动态计算必须等待的
 *   时间，等待足够久就能再试。这样误伤自己时最多等几分钟，而爆破者的成本
 *   会随失败次数指数级增长，得不偿失。
 * - 校验成功立即清零记录，正常用户完全无感。
 */

import { INTERNAL_PREFIX } from "./config";

/** 失败记录的存放前缀（内部保留目录，外部无法读写） */
const THROTTLE_PREFIX = `${INTERNAL_PREFIX}auth-throttle/`;

/** 滑动窗口大小：只统计最近 15 分钟的失败 */
const WINDOW_MS = 15 * 60 * 1000;

/** 窗口内允许的免惩罚失败次数 */
const FREE_ATTEMPTS = 5;

/** 单个记录最多保留的失败时间戳（再多没有意义，索引会被裁剪） */
const MAX_TRACKED = 15;

/** 惩罚等待的上限（15 分钟）——再长的锁定只会制造投诉电话 */
const MAX_DELAY_MS = 15 * 60 * 1000;

/** 记录本身的保留期：窗口外没有任何失败就整个删掉，别留垃圾 */
const RECORD_TTL_MS = 60 * 60 * 1000;

interface FailRecord {
  /** 最近失败的时间戳（毫秒），按时间升序 */
  stamps: number[];
  /** 记录更新时间 */
  updatedAt: number;
}

/** 客户端 IP：Cloudflare 环境取 CF-Connecting-IP，取不到就用固定占位（本地 dev）。 */
export function clientIpOf(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function recordKey(ip: string, username: string): string {
  // 只保留安全字符，避免 key 里混入路径分隔符
  const safeIp = ip.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  const safeUser = encodeURIComponent(username || "anonymous").slice(0, 80);
  return `${THROTTLE_PREFIX}${safeIp}__${safeUser}.json`;
}

/** 读失败记录；损坏/缺失按空记录处理 */
async function loadRecord(
  bucket: R2Bucket,
  key: string
): Promise<FailRecord> {
  try {
    const object = await bucket.get(key);
    if (!object) return { stamps: [], updatedAt: 0 };
    const parsed = JSON.parse(await object.text());
    if (Array.isArray(parsed?.stamps)) {
      return {
        stamps: parsed.stamps
          .map((value: unknown) => Number(value) || 0)
          .filter((value: number) => value > 0),
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    }
  } catch {
    /* 记录损坏当作空的 */
  }
  return { stamps: [], updatedAt: 0 };
}

async function saveRecord(
  bucket: R2Bucket,
  key: string,
  record: FailRecord
): Promise<void> {
  await bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** 计算当前必须等待的毫秒数；0 表示可以立即尝试。 */
function requiredDelayMs(stamps: number[], now: number): number {
  const recent = stamps.filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length <= FREE_ATTEMPTS) return 0;
  // 惩罚随窗口内失败次数指数增长：第 6 次失败要求 2s，第 10 次 32s，封顶 15 分钟
  const step = Math.min(recent.length - FREE_ATTEMPTS, 20);
  const delay = Math.min(1000 * Math.pow(2, step - 1), MAX_DELAY_MS);
  const lastFailedAt = recent[recent.length - 1];
  const elapsed = now - lastFailedAt;
  return elapsed >= delay ? 0 : delay - elapsed;
}

/** 裁剪掉窗口外的旧记录；没有剩余就顺手删掉整个对象 */
function prune(stamps: number[], now: number): number[] {
  return stamps.filter((stamp) => now - stamp < RECORD_TTL_MS);
}

/**
 * 登录尝试前调用：返回需要等待的毫秒数。
 * 大于 0 时调用方应直接拒绝本次认证（401 + Retry-After），不要比对密码。
 */
export async function loginDelayRequired(
  bucket: R2Bucket | null | undefined,
  ip: string,
  username: string
): Promise<number> {
  if (!bucket) return 0;
  const now = Date.now();
  const key = recordKey(ip, username);
  const record = await loadRecord(bucket, key);
  const kept = prune(record.stamps, now);
  if (kept.length !== record.stamps.length) {
    if (!kept.length) {
      await bucket.delete(key);
      return 0;
    }
    await saveRecord(bucket, key, { stamps: kept, updatedAt: now });
  }
  return requiredDelayMs(kept, now);
}

/** 认证失败后调用：记录一次失败。 */
export async function recordLoginFailure(
  bucket: R2Bucket | null | undefined,
  ip: string,
  username: string
): Promise<void> {
  if (!bucket) return;
  const now = Date.now();
  const key = recordKey(ip, username);
  const record = await loadRecord(bucket, key);
  const kept = prune(record.stamps, now);
  kept.push(now);
  // 只留最近的若干条
  const trimmed = kept.slice(-MAX_TRACKED);
  await saveRecord(bucket, key, { stamps: trimmed, updatedAt: now });
}

/** 认证成功后调用：清零该组合的失败记录，正常用户完全无感。 */
export async function clearLoginFailures(
  bucket: R2Bucket | null | undefined,
  ip: string,
  username: string
): Promise<void> {
  if (!bucket) return;
  await bucket.delete(recordKey(ip, username));
}

/** 是否启用了登录限流（环境变量 WEBDAV_LOGIN_THROTTLE=0 可关闭）。 */
export function isLoginThrottleEnabled(env: { WEBDAV_LOGIN_THROTTLE?: string }): boolean {
  return String(env.WEBDAV_LOGIN_THROTTLE ?? "1").trim() !== "0";
}
