/**
 * XML 构造与解析工具。Workers 运行时没有 DOMParser，因此这里全部用字符串拼装，
 * 并且对所有来自对象键、元数据的值做转义，避免文件名里的 & < > 破坏响应。
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** 转义 XML 文本/属性值，并剔除 XML 1.0 不允许的控制字符。 */
export function escapeXml(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

/** 生成 WebDAV href：逐段编码，集合以 `/` 结尾（RFC 4918 要求）。 */
export function encodeHref(key: string, isDirectory: boolean, endpoint = "/webdav/"): string {
  const trimmed = (key || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return endpoint;
  const encoded = trimmed
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${endpoint}${encoded}${isDirectory ? "/" : ""}`;
}

export interface PropfindRequest {
  mode: "allprop" | "propname" | "prop";
  props: string[];
}

/** 解析 PROPFIND 请求体。空体等价于 allprop。 */
export function parsePropfindBody(body: string | null | undefined): PropfindRequest {
  if (!body || !body.trim()) return { mode: "allprop", props: [] };
  if (/<(?:\w+:)?propname\b/i.test(body)) return { mode: "propname", props: [] };

  const block = /<(?:\w+:)?prop\b[^>]*>([\s\S]*?)<\/(?:\w+:)?prop>/i.exec(body);
  if (!block) {
    if (/<(?:\w+:)?allprop\b/i.test(body)) return { mode: "allprop", props: [] };
    return { mode: "allprop", props: [] };
  }

  const props: string[] = [];
  const tagPattern = /<(?:[\w.-]+:)?([\w.-]+)\b[^>]*?\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(block[1])) !== null) {
    props.push(match[1]);
  }
  if (props.length === 0) return { mode: "allprop", props: [] };
  return { mode: "prop", props };
}

export interface PropfindProp {
  /** 属性名，可带命名空间前缀，如 `getcontentlength`。 */
  name: string;
  /** 属性值；为 null 表示空元素（propname 模式）。 */
  value: string | null;
  /** 该属性属于哪个命名空间，`DAV:` 或自定义。 */
  namespace: "DAV:" | string;
  /** value 已经是完整的 XML 片段（如 resourcetype），直接输出不再转义。 */
  raw?: boolean;
}

export interface PropfindItem {
  href: string;
  isDirectory: boolean;
  props: PropfindProp[];
}

function renderProp(prop: PropfindProp): string {
  // 默认命名空间：所有 DAV: 属性不再带 D: 前缀（Android 客户端按标签名解析）
  const tag = prop.name;
  if (prop.value === null) return `<${tag} />`;
  const value = prop.raw ? prop.value : escapeXml(prop.value);
  return `<${tag}>${value}</${tag}>`;
}

/** 生成 207 Multi-Status 响应体。 */
export function buildMultistatus(items: PropfindItem[]): string {
  const responses = items
    .map((item) => {
      const status = item.isDirectory
        ? "HTTP/1.1 200 OK"
        : "HTTP/1.1 200 OK";
      return [
        "  <response>",
        `    <href>${escapeXml(item.href)}</href>`,
        "    <propstat>",
        "      <prop>",
        ...item.props.map((prop) => `        ${renderProp(prop)}`),
        "      </prop>",
        `      <status>${status}</status>`,
        "    </propstat>",
        "  </response>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<multistatus xmlns="DAV:" xmlns:fd="flaredrive">',
    responses,
    "</multistatus>",
  ].join("\n");
}

export interface PropstatGroup {
  status: string;
  props: Array<{ name: string; value: string | null }>;
}

/** 生成由若干 propstat 组成的 207 响应（用于 PROPPATCH）。 */
export function buildPropstatResponse(href: string, groups: PropstatGroup[]): string {
  const blocks = groups
    .map((group) =>
      [
        "    <propstat>",
        "      <prop>",
        ...group.props.map((prop) =>
          prop.value === null
            ? `        <${prop.name} />`
            : `        <${prop.name}>${escapeXml(prop.value)}</${prop.name}>`
        ),
        "      </prop>",
        `      <status>${group.status}</status>`,
        "    </propstat>",
      ].join("\n")
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<multistatus xmlns="DAV:" xmlns:fd="flaredrive">',
    "  <response>",
    `    <href>${escapeXml(href)}</href>`,
    blocks,
    "  </response>",
    "</multistatus>",
  ].join("\n");
}

/** 从 If 头中提取全部锁令牌。 */
export function parseIfHeaderTokens(header: string | null): string[] {
  if (!header) return [];
  const tokens: string[] = [];
  const pattern = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(header)) !== null) {
    const value = match[1].trim();
    if (value.toLowerCase().startsWith("opaquelocktoken:")) tokens.push(value);
  }
  return tokens;
}

/** 解析 Timeout 头，返回秒数；无法解析时返回 null。 */
export function parseTimeoutHeader(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.startsWith("infinite")) return Number.MAX_SAFE_INTEGER;
  const match = /second-(\d+)/.exec(value);
  if (!match) return null;
  const seconds = parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** 从 LOCK 请求体中取出 Owner 的原始 XML 片段。 */
export function extractLockOwner(body: string | null | undefined): string {
  if (!body) return "";
  const match = /<(?:\w+:)?owner\b[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i.exec(body);
  if (!match) return "";
  return match[1].trim().slice(0, 512);
}

/** 解析 PROPPATCH/其它请求体里出现的属性名，用于回显。 */
export function extractPropNames(body: string | null | undefined): string[] {
  if (!body) return [];
  const names: string[] = [];
  const pattern = /<(?:\w+:)?([\w.-]+)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const name = match[1];
    if (["propertyupdate", "set", "remove", "prop"].includes(name.toLowerCase())) continue;
    names.push(name);
  }
  return names;
}
