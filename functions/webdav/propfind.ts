import {
  DIRECTORY_CONTENT_TYPE,
  REPORTED_AVAILABLE_BYTES,
  THUMBNAILS_PREFIX,
  isLockingEnabled,
  maxDepthItems,
} from "../../utils/config";
import { canList, canRead } from "../../utils/auth";
import {
  baseName,
  isDirectoryObject,
  isLegacyDirMarker,
  legacyDirKey,
  listAll,
  listDirectory,
  statPath,
} from "../../utils/core";
import { collectActiveLocks } from "../../utils/lock";
import {
  PropfindItem,
  PropfindProp,
  buildMultistatus,
  encodeHref,
  escapeXml,
  parsePropfindBody,
} from "../../utils/xml";
import { DavContext, parentOf, readBodyText, xmlResponse } from "./context";

interface DavEntry {
  key: string;
  isDirectory: boolean;
  size: number;
  uploaded: Date | null;
  etag: string;
  httpEtag: string;
  contentType: string;
  thumbnail: string | null;
  synthetic: boolean;
}

const STANDARD_PROPS = [
  "creationdate",
  "displayname",
  "getcontentlanguage",
  "getcontentlength",
  "getcontenttype",
  "getetag",
  "getlastmodified",
  "resourcetype",
  "supportedlock",
  "lockdiscovery",
  "quota-available-bytes",
  "quota-used-bytes",
];

function directoryEntry(key: string, uploaded: Date | null, synthetic: boolean): DavEntry {
  return {
    key,
    isDirectory: true,
    size: 0,
    uploaded,
    etag: "",
    httpEtag: "",
    contentType: DIRECTORY_CONTENT_TYPE,
    thumbnail: null,
    synthetic,
  };
}

function toEntry(obj: any): DavEntry {
  const etag = typeof obj.etag === "string" ? obj.etag : "";
  const uploaded = obj.uploaded instanceof Date ? obj.uploaded : null;
  return {
    key: obj.key,
    isDirectory: isDirectoryObject(obj),
    size: typeof obj.size === "number" ? obj.size : 0,
    uploaded,
    etag,
    httpEtag: typeof obj.httpEtag === "string" ? obj.httpEtag : etag ? `"${etag}"` : "",
    contentType:
      obj.httpMetadata?.contentType ||
      (isDirectoryObject(obj) ? DIRECTORY_CONTENT_TYPE : "application/octet-stream"),
    thumbnail: obj.customMetadata?.thumbnail || null,
    synthetic: false,
  };
}

function lockDiscoveryXml(
  locks: Array<{ token: string; owner: string; depth: string; timeoutSeconds: number; path: string }>,
  request: Request
): string {
  if (!locks.length) return "<D:lockdiscovery />";
  const origin = new URL(request.url).origin;
  const body = locks
    .map(
      (lock) => `<D:activelock>
          <D:locktype><D:write /></D:locktype>
          <D:lockscope><D:exclusive /></D:lockscope>
          <D:depth>${escapeXml(lock.depth)}</D:depth>
          ${lock.owner ? `<D:owner>${lock.owner}</D:owner>` : "<D:owner />"}
          <D:timeout>Second-${Math.max(1, Math.floor(lock.timeoutSeconds))}</D:timeout>
          <D:locktoken><D:href>${escapeXml(lock.token)}</D:href></D:locktoken>
          <D:lockroot><D:href>${escapeXml(
            origin + encodeHref(lock.path, true)
          )}</D:href></D:lockroot>
        </D:activelock>`
    )
    .join("\n");
  return `<D:lockdiscovery>\n${body}\n</D:lockdiscovery>`;
}

function buildProps(
  entry: DavEntry,
  options: {
    propname: boolean;
    locks: Array<{ token: string; owner: string; depth: string; timeoutSeconds: number; path: string }>;
    request: Request;
    usedBytes: number;
    locking: boolean;
  }
): PropfindProp[] {
  const includeLockProps = options.locking;
  const names = [...STANDARD_PROPS];
  if (includeLockProps === false) {
    const filtered = names.filter(
      (name) => name !== "supportedlock" && name !== "lockdiscovery"
    );
    names.length = 0;
    names.push(...filtered);
  }

  const values: Record<string, string | null> = {
    creationdate: entry.uploaded ? entry.uploaded.toISOString() : null,
    displayname: baseName(entry.key) || "/",
    getcontentlanguage: null,
    getcontentlength: String(entry.size),
    getcontenttype: entry.contentType,
    getetag: entry.httpEtag || entry.etag,
    getlastmodified: (entry.uploaded || new Date()).toUTCString(),
    resourcetype: null,
    "fd:thumbnail": entry.thumbnail,
  };

  const props: PropfindProp[] = [];

  for (const name of names) {
    if (options.propname) {
      props.push({ name, value: null, namespace: "DAV:" });
      continue;
    }
    switch (name) {
      case "resourcetype":
        props.push({
          name,
          value: entry.isDirectory ? "<D:collection />" : "",
          namespace: "DAV:",
          raw: true,
        });
        break;
      case "supportedlock":
        props.push({
          name,
          value: includeLockProps
            ? '<D:lockentry><D:lockscope><D:exclusive /></D:lockscope><D:locktype><D:write /></D:locktype></D:lockentry>'
            : "",
          namespace: "DAV:",
          raw: true,
        });
        break;
      case "lockdiscovery":
        props.push({
          name,
          value: includeLockProps
            ? lockDiscoveryXml(options.locks, options.request)
            : "<D:lockdiscovery />",
          namespace: "DAV:",
          raw: true,
        });
        break;
      case "quota-available-bytes":
        props.push({
          name,
          value: String(REPORTED_AVAILABLE_BYTES),
          namespace: "DAV:",
        });
        break;
      case "quota-used-bytes":
        props.push({ name, value: String(options.usedBytes), namespace: "DAV:" });
        break;
      default: {
        const value = values[name];
        if (value === null || value === undefined) {
          if (name === "fd:thumbnail") break;
          props.push({ name, value: "", namespace: "DAV:" });
        } else {
          props.push({
            name,
            value,
            namespace: name.startsWith("fd:") ? "flaredrive" : "DAV:",
          });
        }
      }
    }
  }

  return props;
}

function readDepth(request: Request): string {
  const raw = (request.headers.get("Depth") || "infinity").trim().toLowerCase();
  if (raw === "0" || raw === "1" || raw === "infinity") return raw;
  return "infinity";
}

export async function handleRequestPropfind(context: DavContext): Promise<Response> {
  const { bucket, path, request, env, subject } = context;
  const depth = readDepth(request);
  const body = await readBodyText(request);
  const parsed = parsePropfindBody(body);
  const locking = isLockingEnabled(env);

  const targetStat = await statPath(bucket, path);
  if (!targetStat) {
    return new Response("Not found", { status: 404 });
  }

  const children: DavEntry[] = [];
  let truncated = false;

  if (targetStat.isDirectory && depth !== "0") {
    if (depth === "1") {
      const listing = await listDirectory(bucket, path);
      for (const folder of listing.folders) {
        children.push(directoryEntry(folder.key, null, folder.legacy));
      }
      for (const file of listing.files) {
        children.push({
          key: file.key,
          isDirectory: false,
          size: file.size,
          uploaded: file.uploaded,
          etag: file.etag,
          httpEtag: file.httpEtag,
          contentType: file.contentType,
          thumbnail: file.thumbnail,
          synthetic: false,
        });
      }
    } else {
      const limit = maxDepthItems(env);
      const prefix = `${path}/`;
      const seen = new Set<string>();
      const addDir = (key: string, uploaded: Date | null, synthetic: boolean) => {
        if (!key || seen.has(key)) return;
        seen.add(key);
        children.push(directoryEntry(key, uploaded, synthetic));
      };

      for await (const obj of listAll(bucket, prefix, true)) {
        if (children.length >= limit) {
          truncated = true;
          break;
        }
        const key = obj.key as string;

        if (isLegacyDirMarker(key)) {
          const dirKey = legacyDirKey(key);
          addDir(dirKey, obj.uploaded instanceof Date ? obj.uploaded : null, true);
        } else {
          const entry = toEntry(obj);
          if (entry.isDirectory) {
            addDir(entry.key, entry.uploaded, false);
          } else {
            seen.add(key);
            children.push(entry);
          }
        }

        // 补齐可能没有目录对象的中间层级
        let ancestor = parentOf(key);
        while (ancestor && ancestor.length > path.length) {
          addDir(ancestor, null, true);
          ancestor = parentOf(ancestor);
        }
      }
    }
  }

  // 自制目录没有自身的时间戳，用子项里最新的时间兜底
  const newestChild = children.reduce<Date | null>((latest, entry) => {
    if (!entry.uploaded) return latest;
    if (!latest || entry.uploaded > latest) return entry.uploaded;
    return latest;
  }, null);

  const selfEntry: DavEntry = {
    key: path,
    isDirectory: targetStat.isDirectory,
    size: targetStat.size,
    uploaded:
      targetStat.uploaded ||
      (targetStat.isDirectory ? newestChild || new Date() : null),
    etag: targetStat.etag || "",
    httpEtag: targetStat.httpEtag || "",
    contentType: targetStat.contentType,
    thumbnail: targetStat.thumbnail,
    synthetic: targetStat.synthetic,
  };

  const requestedKey = (entry: DavEntry) =>
    entry.isDirectory ? canList(subject, entry.key) : canRead(subject, entry.key);

  const visible = children.filter((entry) => {
    if (entry.key.startsWith(THUMBNAILS_PREFIX)) return false;
    return requestedKey(entry);
  });

  const selfLocks = locking ? await collectActiveLocks(bucket, path) : [];
  const usedBytesSelf = selfEntry.isDirectory
    ? visible.reduce((sum, entry) => sum + (entry.size || 0), 0)
    : selfEntry.size;

  const items: PropfindItem[] = [];
  items.push({
    href: encodeHref(selfEntry.key, selfEntry.isDirectory),
    isDirectory: selfEntry.isDirectory,
    props: buildProps(selfEntry, {
      propname: parsed.mode === "propname",
      locks: selfLocks,
      request,
      usedBytes: usedBytesSelf,
      locking,
    }),
  });

  for (const entry of visible) {
    items.push({
      href: encodeHref(entry.key, entry.isDirectory),
      isDirectory: entry.isDirectory,
      props: buildProps(entry, {
        propname: parsed.mode === "propname",
        locks: [],
        request,
        usedBytes: entry.size || 0,
        locking,
      }),
    });
  }

  if (truncated) {
    return new Response(
      '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth /></D:error>',
      {
        status: 507,
        headers: { "Content-Type": 'application/xml; charset="utf-8"' },
      }
    );
  }

  return xmlResponse(buildMultistatus(items));
}
