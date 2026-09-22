/**
 * 下载签名。
 *
 * 私有模式下浏览器直链带不上认证头，前端只能「先取回整文件再存成 Blob」，
 * 这样既没有进度、又可能被浏览器（尤其 Safari）在异步之后拦掉下载。
 *
 * 这里给下载地址签一个短时效签名：前端先（在打开菜单时就）取到签名 URL，
 * 点击下载时用同步的 <a href> 直接触发浏览器原生下载——有进度条、秒弹保存框、
 * 也不受异步手势限制。签名只对**那一个 key** 且在有效期内有效。
 */
import { Env } from "./config";
import { constantTimeEqualHex } from "./apikey";

const encoder = new TextEncoder();
/** 默认有效期 10 分钟 */
export const DEFAULT_SIGN_TTL = 600;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 取签名密钥：优先显式配置的 `DOWNLOAD_SECRET`，
 * 否则用账号配置派生（同一份环境变量在不同实例上派生结果一致）。
 * 什么都没配时返回 null，表示不支持签名（前端会退回取回 Blob 的方式）。
 */
export async function downloadSecret(env: Env): Promise<string | null> {
  const explicit =
    typeof env.DOWNLOAD_SECRET === "string" ? env.DOWNLOAD_SECRET.trim() : "";
  if (explicit) return explicit;

  const seed = [
    typeof env.WEBDAV_USERNAME === "string" ? env.WEBDAV_USERNAME : "",
    typeof env.WEBDAV_PASSWORD === "string" ? env.WEBDAV_PASSWORD : "",
    typeof env.WEBDAV_USERS === "string" ? env.WEBDAV_USERS : "",
    typeof env.GUEST === "string" ? env.GUEST : "",
  ]
    .join("|")
    .replace(/\|/g, "");

  if (!seed) return null;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `flaredrive-download|${env.WEBDAV_USERNAME || ""}|${env.WEBDAV_PASSWORD || ""}|${
        env.WEBDAV_USERS || ""
      }|${env.GUEST || ""}`
    )
  );
  return toHex(new Uint8Array(digest));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

export interface SignedKey {
  exp: number;
  sig: string;
}

export async function signKey(
  env: Env,
  key: string,
  ttlSeconds: number = DEFAULT_SIGN_TTL
): Promise<SignedKey | null> {
  const secret = await downloadSecret(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, ttlSeconds);
  const sig = await hmacHex(secret, `${key}\n${exp}`);
  return { exp, sig };
}

export async function verifySignedKey(
  env: Env,
  key: string,
  exp: string | null,
  sig: string | null
): Promise<boolean> {
  if (!exp || !sig) return false;
  const expires = parseInt(exp, 10);
  if (!Number.isFinite(expires)) return false;
  if (expires <= Math.floor(Date.now() / 1000)) return false;

  const secret = await downloadSecret(env);
  if (!secret) return false;

  const expected = await hmacHex(secret, `${key}\n${expires}`);
  return constantTimeEqualHex(expected, sig.trim().toLowerCase());
}
