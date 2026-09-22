/**
 * 路径规范化与权限前缀判定。
 *
 * 单独成文件是为了让 auth.ts 与 apikey.ts 都能引用而不产生循环依赖。
 */

/** 去掉首尾斜杠，得到用于比较的规范路径。 */
export function normalizePath(path: string | null | undefined): string {
  return (path || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 解析逗号分隔的权限列表；空项会被丢弃，`*` 归一为全部。 */
export function parsePermissions(raw: string | undefined | null): string[] {
  if (typeof raw !== "string") return [];
  const parts = raw
    .split(",")
    .map((part) => normalizePath(part.trim()))
    .filter((part) => part.length > 0);
  if (parts.includes("*")) return ["*"];
  return Array.from(new Set(parts));
}

/** 单个权限项能否覆盖目标路径。 */
export function permissionAllows(
  permission: string,
  path: string | null | undefined
): boolean {
  const perm = normalizePath(permission);
  if (perm === "*") return true;
  if (!perm) return false;
  const target = normalizePath(path);
  if (!target) return false;
  return target === perm || target.startsWith(perm + "/");
}

/** 权限列表里是否有任意一项覆盖目标路径。 */
export function anyPermissionAllows(
  permissions: string[],
  path: string | null | undefined
): boolean {
  return permissions.some((permission) => permissionAllows(permission, path));
}
