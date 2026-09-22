/**
 * 分享链接的公开浏览页。
 *
 * 设计约束：
 * - 只读：页面里**不存在**任何写操作入口（上传 / 删除 / 重命名 / 移动都没有）。
 * - 安全：所有条目数据以 JSON 内联，客户端用 textContent 渲染，不拼接 HTML；
 *   JSON 里的 `<` 会被转义，避免 `</script>` 逃逸。
 * - 自包含：不依赖外部 CDN，页面本身就能预览图片 / 视频 / 音频 / PDF / 文本。
 */

export interface ShareEntry {
  name: string;
  /** 相对分享根目录的路径 */
  key: string;
  isDirectory: boolean;
  size: number;
  uploaded: string | null;
  contentType: string;
  previewKind: "image" | "video" | "audio" | "pdf" | "text" | "";
}

export interface SharePageOptions {
  token: string;
  /** 被分享的根对象键，用于页面标题 */
  shareKey: string;
  /** 当前目录相对分享根的路径（空串表示分享根） */
  relative: string;
  entries: ShareEntry[];
  /** 是否提供打包下载（目录分享才有） */
  allowZip: boolean;
}

/** 判断能否在页面内预览，以及用哪种方式预览。 */
export function previewKindOf(contentType: string, name: string): ShareEntry["previewKind"] {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/")) return "text";
  if (["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(type)) {
    return "text";
  }
  const extension = String(name || "").split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].includes(extension)) return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["mp3", "m4a", "aac", "ogg", "wav", "flac"].includes(extension)) return "audio";
  if (extension === "pdf") return "pdf";
  if (
    ["txt", "md", "json", "yml", "yaml", "log", "csv", "js", "ts", "css", "html", "xml", "sh", "py", "ini", "conf"].includes(
      extension
    )
  ) {
    return "text";
  }
  return "";
}

function escapeHtml(value: unknown): string {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 内联 JSON：把 `<` 转义掉，防止内容里出现 `</script>` 提前闭合脚本。 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderSharePage(options: SharePageOptions): string {
  const rootName = options.shareKey.split("/").filter(Boolean).pop() || "分享";
  const segments = options.relative.split("/").filter(Boolean);
  const title = options.relative ? segments[segments.length - 1] : rootName;

  const payload = {
    token: options.token,
    base: `/s/${options.token}`,
    relative: options.relative,
    shareKey: options.shareKey,
    readOnly: true,
    canZip: options.allowZip,
    entries: options.entries.map((entry) => ({
      name: entry.name,
      key: entry.key,
      isDirectory: entry.isDirectory,
      size: entry.size,
      uploaded: entry.uploaded,
      kind: entry.previewKind,
    })),
  };

  const crumbs = [
    { label: rootName, href: `/s/${options.token}/` },
    ...segments.map((segment, index) => ({
      label: segment,
      href: `/s/${options.token}/${segments
        .slice(0, index + 1)
        .map(encodeURIComponent)
        .join("/")}/`,
    })),
  ];

  const crumbHtml = crumbs
    .map((crumb, index) =>
      index === crumbs.length - 1
        ? `<span class="crumb current">${escapeHtml(crumb.label)}</span>`
        : `<a class="crumb" href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`
    )
    .join('<span class="crumb-sep">/</span>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)} · 分享</title>
<style>
  :root {
    --accent: #f38020;
    --border: #e8e8ec;
    --muted: #6b7280;
    --bg: #f7f7f9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Adjusted", "Segoe UI", "Liberation Sans", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 16px; }
  header.share-head {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }
  .head-main { flex: 1; min-width: 200px; }
  h1 { font-size: 17px; margin: 0 0 6px; word-break: break-all; }
  .badge {
    display: inline-block;
    font-size: 12px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 1px 8px;
    vertical-align: middle;
  }
  .crumbs { font-size: 13px; color: var(--muted); word-break: break-all; margin-top: 6px; }
  .crumb { color: var(--accent); text-decoration: none; }
  .crumb.current { color: #1f2328; font-weight: 600; }
  .crumb-sep { margin: 0 6px; color: #c4c4cc; }
  .actions-top { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    appearance: none;
    border: 1px solid var(--border);
    background: #fff;
    color: #1f2328;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .btn:hover { border-color: #d0d0d8; background: #fafafa; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: #e0721a; }
  .btn[disabled] { opacity: .5; cursor: default; }
  ul.file-list {
    list-style: none;
    margin: 16px 0 0;
    padding: 0;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  li.file-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  li.file-row:last-child { border-bottom: none; }
  .icon { width: 34px; height: 34px; flex: 0 0 34px; display: flex; align-items: center; justify-content: center; }
  .icon svg { width: 28px; height: 28px; }
  .meta { flex: 1; min-width: 0; }
  .name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name a { color: inherit; text-decoration: none; }
  .name a:hover { color: var(--accent); }
  .sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .empty { padding: 28px; text-align: center; color: var(--muted); }
  footer.note { margin: 16px 2px 32px; font-size: 12px; color: var(--muted); line-height: 1.7; }
  .modal {
    position: fixed; inset: 0; background: rgba(0,0,0,.72);
    display: none; align-items: center; justify-content: center; padding: 20px; z-index: 50;
  }
  .modal.open { display: flex; }
  .modal-body {
    background: #fff; border-radius: 12px; max-width: min(1100px, 100%); max-height: 100%;
    width: 100%; display: flex; flex-direction: column; overflow: hidden;
  }
  .modal-head {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .modal-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .modal-content {
    flex: 1; min-height: 0; overflow: auto; background: #0f1115;
    display: flex; align-items: center; justify-content: center;
  }
  .modal-content img, .modal-content video { max-width: 100%; max-height: 100%; display: block; }
  .modal-content audio { width: 90%; margin: 24px; }
  .modal-content iframe { width: 100%; height: 70vh; border: 0; background: #fff; }
  .modal-content pre {
    margin: 0; padding: 16px; width: 100%; height: 70vh; overflow: auto; background: #fff;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word;
  }
  .state { color: #fff; padding: 24px; font-size: 14px; }
  @media (max-width: 560px) {
    li.file-row { flex-wrap: wrap; }
    .row-actions { width: 100%; justify-content: flex-end; }
    .actions-top { width: 100%; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="share-head">
    <div class="head-main">
      <h1>${escapeHtml(title)} <span class="badge">只读分享</span></h1>
      <div class="crumbs">${crumbHtml}</div>
    </div>
    <div class="actions-top">
      <button type="button" class="btn" id="btn-refresh">刷新</button>
      <button type="button" class="btn primary" id="btn-zip"${options.allowZip ? "" : ' style="display:none"'}>打包下载</button>
    </div>
  </header>

  <ul class="file-list" id="file-list"></ul>
  <div class="empty" id="empty-state" style="display:none">这个目录是空的</div>

  <footer class="note">
    这是通过分享链接打开的只读页面，可以预览和下载，不能上传、修改或删除。<br />
    链接由分享者随时可以吊销，请勿转发给不信任的人。
  </footer>
</div>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-label="预览">
  <div class="modal-body">
    <div class="modal-head">
      <span class="modal-title" id="modal-title"></span>
      <a class="btn primary" id="modal-download" href="#" download>下载</a>
      <button type="button" class="btn" id="modal-close" aria-label="关闭预览">关闭</button>
    </div>
    <div class="modal-content" id="modal-content"></div>
  </div>
</div>

<script type="application/json" id="share-data">${inlineJson(payload)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("share-data").textContent);
  var list = document.getElementById("file-list");
  var empty = document.getElementById("empty-state");
  var modal = document.getElementById("modal");
  var modalTitle = document.getElementById("modal-title");
  var modalContent = document.getElementById("modal-content");
  var modalDownload = document.getElementById("modal-download");

  function encodePath(path) {
    return String(path || "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }

  function entryUrl(entry) {
    var relative = DATA.relative ? DATA.relative + "/" + entry.key : entry.key;
    return DATA.base + "/" + encodePath(relative) + (entry.isDirectory ? "/" : "");
  }

  function formatSize(size) {
    if (typeof size !== "number" || size < 0) return "";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var value = size;
    var index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return value.toFixed(index === 0 ? 0 : 1) + " " + units[index];
  }

  function formatDate(value) {
    if (!value) return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  var ICONS = {
    folder: '<svg viewBox="0 0 512 512" fill="#f38020"><path d="M512 416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96C0 60.7 28.7 32 64 32H181.5c17 0 33.3 6.7 45.3 18.7l26.5 26.5c12 12 28.3 18.7 45.3 18.7H448c35.3 0 64 28.7 64 64V416z"/></svg>',
    image: '<svg viewBox="0 0 512 512" fill="#7c9cff"><path d="M448 80c8.8 0 16 7.2 16 16V416c0 8.8-7.2 16-16 16H64c-8.8 0-16-7.2-16-16V96c0-8.8 7.2-16 16-16H448zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zM200 232a32 32 0 1 0 0-64 32 32 0 1 0 0 64zm-56 96l64-96 64 96 72-88 88 120H104z"/></svg>',
    video: '<svg viewBox="0 0 576 512" fill="#7c9cff"><path d="M64 64C28.7 64 0 92.7 0 128V384c0 35.3 28.7 64 64 64H384c35.3 0 64-28.7 64-64V128c0-35.3-28.7-64-64-64H64zM200 356V156l120 100-120 100z"/></svg>',
    audio: '<svg viewBox="0 0 512 512" fill="#7c9cff"><path d="M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7v72V368c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V147L192 223.8V432c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V128c0-8.3 4.3-16.1 11.4-20.6l256-160c8.4-5.2 19.2-4.8 27.1 1z"/></svg>',
    pdf: '<svg viewBox="0 0 384 512" fill="#e5534b"><path d="M320 464c8.8 0 16-7.2 16-16V416h48v32c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64v-32h48v32c0 8.8 7.2 16 16 16h256zM256 160c-17.7 0-32-14.3-32-32V48H64c-8.8 0-16 7.2-16 16V192H0V64C0 28.7 28.7 0 64 0H229.5c17 0 33.3 6.7 45.3 18.7l90.5 90.5C377.3 121.3 384 137.5 384 154.5V192h-48v-32h-80zM88 224c30.9 0 56 25.1 56 56s-25.1 56-56 56H80v32c0 8.8-7.2 16-16 16s-16-7.2-16-16V240c0-8.8 7.2-16 16-16H88zm-8 80h8c13.3 0 24-10.7 24-24s-10.7-24-24-24H80v48zm80-64c0-8.8 7.2-16 16-16h24c26.5 0 48 21.5 48 48v64c0 26.5-21.5 48-48 48H176c-8.8 0-16-7.2-16-16V240zm32 112h8c8.8 0 16-7.2 16-16V272c0-8.8-7.2-16-16-16h-8v96zm144-112c8.8 0 16 7.2 16 16s-7.2 16-16 16h-32v32h32c8.8 0 16 7.2 16 16s-7.2 16-16 16h-32v48c0 8.8-7.2 16-16 16s-16-7.2-16-16V240c0-8.8 7.2-16 16-16h48z"/></svg>',
    text: '<svg viewBox="0 0 384 512" fill="#8b949e"><path d="M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z"/></svg>',
  };

  function iconFor(entry) {
    if (entry.isDirectory) return ICONS.folder;
    if (entry.kind && ICONS[entry.kind]) return ICONS[entry.kind];
    return ICONS.text;
  }

  function openPreview(entry) {
    var url = entryUrl(entry);
    modalTitle.textContent = entry.name;
    modalDownload.setAttribute("href", url + "?download=1");
    modalContent.textContent = "";
    var loading = document.createElement("div");
    loading.className = "state";
    loading.textContent = "加载中...";
    modalContent.appendChild(loading);
    modal.classList.add("open");

    var node = null;
    if (entry.kind === "image") {
      node = document.createElement("img");
      node.src = url;
      node.alt = entry.name;
    } else if (entry.kind === "video") {
      node = document.createElement("video");
      node.src = url;
      node.controls = true;
      node.autoplay = false;
    } else if (entry.kind === "audio") {
      node = document.createElement("audio");
      node.src = url;
      node.controls = true;
    } else if (entry.kind === "pdf") {
      node = document.createElement("iframe");
      node.src = url;
      node.title = entry.name;
    } else if (entry.kind === "text") {
      node = document.createElement("pre");
      if (entry.size > 1024 * 1024) {
        node.textContent = "文件较大，请直接下载查看";
      } else {
        fetch(url, { cache: "no-store" })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.text();
          })
          .then(function (text) { node.textContent = text; })
          .catch(function (error) { node.textContent = "读取失败：" + error.message; });
      }
    }

    if (!node) {
      modalContent.textContent = "";
      var tip = document.createElement("div");
      tip.className = "state";
      tip.textContent = "该类型无法在线预览，请点击右上角下载。";
      modalContent.appendChild(tip);
      return;
    }

    modalContent.textContent = "";
    modalContent.appendChild(node);
    node.onerror = function () {
      modalContent.textContent = "";
      var tip = document.createElement("div");
      tip.className = "state";
      tip.textContent = "预览加载失败，请尝试下载。";
      modalContent.appendChild(tip);
    };
  }

  function closePreview() {
    modal.classList.remove("open");
    modalContent.textContent = "";
  }

  function render() {
    list.textContent = "";
    var entries = DATA.entries.slice().sort(function (a, b) {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    empty.style.display = entries.length ? "none" : "block";

    entries.forEach(function (entry) {
      var row = document.createElement("li");
      row.className = "file-row";

      var icon = document.createElement("div");
      icon.className = "icon";
      icon.innerHTML = iconFor(entry);
      row.appendChild(icon);

      var meta = document.createElement("div");
      meta.className = "meta";
      var nameLine = document.createElement("span");
      nameLine.className = "name";
      var link = document.createElement("a");
      link.textContent = entry.isDirectory ? entry.name + "/" : entry.name;
      link.href = entryUrl(entry);
      link.title = entry.name;
      nameLine.appendChild(link);
      meta.appendChild(nameLine);

      var sub = document.createElement("div");
      sub.className = "sub";
      var parts = [];
      if (entry.isDirectory) parts.push("文件夹");
      else if (typeof entry.size === "number") parts.push(formatSize(entry.size));
      var when = formatDate(entry.uploaded);
      if (when) parts.push(when);
      sub.textContent = parts.join(" · ");
      meta.appendChild(sub);
      row.appendChild(meta);

      var actions = document.createElement("div");
      actions.className = "row-actions";

      if (entry.isDirectory) {
        var openBtn = document.createElement("a");
        openBtn.className = "btn";
        openBtn.textContent = "打开";
        openBtn.href = entryUrl(entry);
        actions.appendChild(openBtn);
      } else {
        if (entry.kind) {
          var previewBtn = document.createElement("button");
          previewBtn.type = "button";
          previewBtn.className = "btn";
          previewBtn.textContent = "预览";
          previewBtn.setAttribute("aria-label", "预览 " + entry.name);
          previewBtn.addEventListener("click", function () { openPreview(entry); });
          actions.appendChild(previewBtn);
        }
        var downloadBtn = document.createElement("a");
        downloadBtn.className = "btn primary";
        downloadBtn.textContent = "下载";
        downloadBtn.href = entryUrl(entry) + "?download=1";
        downloadBtn.setAttribute("aria-label", "下载 " + entry.name);
        actions.appendChild(downloadBtn);
      }

      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  document.getElementById("btn-refresh").addEventListener("click", function () {
    location.reload();
  });
  var zipBtn = document.getElementById("btn-zip");
  if (zipBtn && DATA.canZip) {
    zipBtn.addEventListener("click", function () {
      location.href = DATA.base + "/" + encodePath(DATA.relative) +
        (DATA.relative ? "/" : "") + "?zip=1";
    });
  }
  document.getElementById("modal-close").addEventListener("click", closePreview);
  modal.addEventListener("click", function (event) {
    if (event.target === modal) closePreview();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closePreview();
  });

  render();
})();
</script>
</body>
</html>`;
}
