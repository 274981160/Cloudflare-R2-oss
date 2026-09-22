<template>
  <Transition name="fade">
    <div v-if="modelValue" class="editor-mask" @click.self="requestClose">
      <div class="editor-dialog" role="dialog" aria-modal="true" aria-label="文本编辑器">
        <p v-if="binaryWarning" class="editor-warning" role="alert">
          检测到二进制内容，保存可能损坏文件
        </p>

        <div class="editor-toolbar">
          <span class="editor-title" v-text="displayName"></span>
          <span v-if="isReadOnly" class="editor-badge">只读</span>
          <span v-if="dirty" class="editor-badge dirty">已修改</span>
          <span
            v-if="showStats"
            class="editor-lang"
            aria-label="识别到的语言"
            v-text="language.label"
          ></span>
          <span v-if="showStats" class="editor-stat" v-text="statText"></span>
          <span
            v-if="showStats && jsonStatus"
            class="editor-json"
            :class="{ error: !jsonValid }"
            aria-live="polite"
            v-text="jsonStatus"
          ></span>
          <span class="editor-toolbar-spacer"></span>
          <button
            type="button"
            class="editor-undo"
            aria-label="撤销"
            :disabled="!undoStack.length"
            @click="undo"
          >
            <span>撤销</span>
          </button>
          <button
            type="button"
            class="editor-redo"
            aria-label="重做"
            :disabled="!redoStack.length"
            @click="redo"
          >
            <span>重做</span>
          </button>
          <button
            type="button"
            class="editor-versions-toggle"
            :class="{ active: showVersions }"
            aria-label="历史版本"
            :aria-pressed="showVersions ? 'true' : 'false'"
            @click="toggleVersions"
          >
            <span>历史版本</span>
          </button>
          <button
            v-if="canFormat"
            type="button"
            class="editor-format"
            aria-label="格式化"
            @click="formatJson"
          >
            <span>格式化</span>
          </button>
          <button
            v-if="canSave"
            type="button"
            class="editor-save"
            aria-label="保存"
            :disabled="saving"
            @click="save"
          >
            <span v-text="saving ? '保存中...' : '保存'"></span>
          </button>
          <button type="button" class="editor-close" aria-label="关闭编辑器" @click="requestClose">
            <span>关闭</span>
          </button>
        </div>

        <div
          v-if="status"
          class="editor-status"
          :class="{ error: statusError }"
          role="status"
          v-text="status"
        ></div>

        <div v-if="showStats" class="editor-searchbar">
          <input
            ref="search"
            type="search"
            class="editor-searchinput"
            name="editor-search"
            aria-label="编辑器内查找"
            placeholder="查找…"
            autocomplete="off"
            :value="search"
            @input="onSearchInput"
            @focus="searchFocused = true"
            @blur="searchFocused = false"
            @keydown.enter.prevent="onSearchEnter"
            @keydown.esc.prevent="handleEscape"
          />
          <span class="editor-matchcount" aria-live="polite" v-text="matchLabel"></span>
          <button type="button" class="editor-nav" aria-label="上一个匹配" @click="prevMatch()">
            <span>上一个</span>
          </button>
          <button type="button" class="editor-nav" aria-label="下一个匹配" @click="nextMatch()">
            <span>下一个</span>
          </button>
          <label class="editor-case">
            <input
              type="checkbox"
              name="editor-case"
              :checked="caseSensitive"
              @change="onCaseChange"
            />
            <span>区分大小写</span>
          </label>
        </div>

        <div class="editor-content">
          <div class="editor-main">
            <div v-if="loading" class="editor-state">加载中...</div>

            <div v-else-if="tooLarge" class="editor-state">
              <p class="editor-state-text">文件过大（限制 5MB），请下载后编辑</p>
              <p class="editor-state-hint" v-text="tooLargeHint"></p>
              <button type="button" class="editor-primary" aria-label="下载文件" @click="download">
                <span>下载</span>
              </button>
            </div>

            <div v-else-if="notText" class="editor-state">
              <p class="editor-state-text">该文件不是文本文件，无法在线编辑</p>
              <p class="editor-state-hint">如确需编辑，可强行按文本打开；保存可能损坏文件内容。</p>
              <button type="button" class="editor-primary" aria-label="以文本方式打开" @click="forceOpen">
                <span>以文本方式打开</span>
              </button>
            </div>

            <div v-else-if="loadError" class="editor-state error">
              <p class="editor-state-text" v-text="`加载失败：${loadError}`"></p>
              <button type="button" class="editor-primary" aria-label="重新加载" @click="load">
                <span>重试</span>
              </button>
            </div>

            <div v-else class="editor-body">
              <pre
                ref="highlight"
                class="editor-layer editor-highlight"
                aria-hidden="true"
                v-html="highlightHtml"
              ></pre>
              <textarea
                ref="input"
                class="editor-layer editor-input"
                name="editor-content"
                aria-label="文件内容"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                :readonly="isReadOnly"
                v-model="content"
                @scroll="syncScroll"
                @keydown.ctrl.z.exact.prevent="undo"
                @keydown.meta.z.exact.prevent="undo"
                @keydown.ctrl.shift.z.prevent="redo"
                @keydown.meta.shift.z.prevent="redo"
                @keydown.ctrl.y.prevent="redo"
                @keydown.meta.y.prevent="redo"
              ></textarea>
            </div>
          </div>

          <aside v-if="showVersions" class="editor-versions" aria-label="版本列表">
            <div class="editor-versions-head">
              <span class="editor-versions-title">历史版本</span>
              <button
                type="button"
                class="editor-versions-action"
                aria-label="刷新版本列表"
                :disabled="versionsLoading"
                @click="fetchVersions"
              >
                <span>刷新</span>
              </button>
              <button
                type="button"
                class="editor-versions-action"
                aria-label="关闭版本列表"
                @click="showVersions = false"
              >
                <span>关闭</span>
              </button>
            </div>

            <p class="editor-versions-hint">
              每次保存都会自动留一份旧内容，最多保留最近 10 个版本（服务端可配）。
            </p>

            <p
              v-if="versionsError"
              class="editor-versions-error"
              role="alert"
              v-text="versionsError"
            ></p>

            <div v-if="versionsLoading" class="editor-versions-state">加载中...</div>
            <div v-else-if="!versions.length" class="editor-versions-state">暂无历史版本</div>
            <ul v-else class="editor-versions-list">
              <li v-for="version in versions" :key="version.id" class="editor-version">
                <div class="editor-version-time" v-text="formatDate(version.uploaded) || version.id"></div>
                <div class="editor-version-meta">
                  <span v-text="formatSize(version.size)"></span>
                  <span v-text="version.savedBy ? `保存人 ${version.savedBy}` : '保存人未知'"></span>
                </div>
                <div class="editor-version-actions">
                  <button
                    type="button"
                    class="editor-version-button"
                    :aria-label="`预览版本 ${version.id}`"
                    :disabled="versionBusy === version.id"
                    @click="loadVersion(version)"
                  >
                    <span>载入到编辑器</span>
                  </button>
                  <button
                    type="button"
                    class="editor-version-button"
                    :aria-label="`恢复版本 ${version.id}`"
                    :disabled="versionBusy === version.id"
                    @click="restoreVersion(version)"
                  >
                    <span>恢复此版本</span>
                  </button>
                  <button
                    type="button"
                    class="editor-version-button danger"
                    :aria-label="`删除版本 ${version.id}`"
                    :disabled="versionBusy === version.id"
                    @click="deleteVersion(version)"
                  >
                    <span>删除此版本</span>
                  </button>
                </div>
              </li>
            </ul>
          </aside>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script>
import {
  ApiError,
  apiFetch,
  describeResponseError,
  detectLanguage,
  downloadKey,
  errorMessage,
  fetchVersionContent as fetchVersionContentRequest,
  formatDate,
  formatSize,
  isTextFile,
  listVersions,
  MAX_HIGHLIGHT_SIZE,
  rawUrl,
  removeVersion as removeVersionRequest,
  restoreVersion as restoreVersionRequest,
  tokenize,
  webdavUrl,
} from "/assets/main.mjs";

/** 可在线加载的最大字节数：小于它直接加载，大于等于则不加载（提示下载后编辑） */
const MAX_EDIT_SIZE = 5 * 1024 * 1024;
/** 上限的展示文案，与上面的常量保持一致 */
const MAX_EDIT_SIZE_LABEL = "5MB";
/** 高亮层最多渲染的匹配数，避免超大文件卡死 */
const MAX_MATCHES = 5000;
/** 两层共用的内边距（像素），必须与 .editor-layer 的 padding 一致 */
const EDITOR_PADDING = 12;
/** 除 text/* 外，按原样透传的文本类 MIME 类型 */
const APPLICATION_TEXT_TYPES = [
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/x-sh",
];

/** HTML 转义：高亮层只把文本当文本处理，绝不当 HTML 解析 */
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

/** 逐个找出匹配位置（保留原始下标，避免大小写折叠导致偏移） */
function findMatches(text, needle, caseSensitive) {  const result = [];
  const query = String(needle == null ? "" : needle);
  if (!query) return result;
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regexp;
  try {
    regexp = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch (error) {
    return result;
  }
  let match = regexp.exec(text);
  while (match) {
    result.push({ start: match.index, end: match.index + match[0].length });
    if (result.length >= MAX_MATCHES) break;
    if (match[0].length === 0) regexp.lastIndex++;
    match = regexp.exec(text);
  }
  return result;
}

/**
 * 把「语法 token」与「搜索匹配」合并成互不重叠的区间后一次性拼 HTML。
 * - 以所有区间端点切分文本，每个基本区间最多落在一个 token 与一个匹配里；
 * - 搜索匹配优先级高于语法色（命中区间输出 <mark>），当前匹配类最强；
 * - 所有文本都经过 HTML 转义，绝不把文件内容当 HTML 解析。
 */
function buildHighlightHtml(text, tokens, matches, currentIndex) {
  if (!text) return "";
  const points = [0, text.length];
  for (const token of tokens) {
    points.push(token.start, token.end);
  }
  for (const match of matches) {
    points.push(match.start, match.end);
  }
  const bounds = Array.from(new Set(points)).sort((left, right) => left - right);

  let html = "";
  let tokenIndex = 0;
  let matchIndex = 0;
  for (let index = 0; index < bounds.length - 1; index++) {
    const start = bounds[index];
    const end = bounds[index + 1];
    if (end <= start) continue;

    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= start) tokenIndex++;
    const token =
      tokenIndex < tokens.length &&
      tokens[tokenIndex].start <= start &&
      tokens[tokenIndex].end >= end
        ? tokens[tokenIndex]
        : null;

    while (matchIndex < matches.length && matches[matchIndex].end <= start) matchIndex++;
    const hit =
      matchIndex < matches.length &&
      matches[matchIndex].start <= start &&
      matches[matchIndex].end >= end
        ? matchIndex
        : -1;

    const classes = [];
    if (token) classes.push(`tok-${token.type}`);
    if (hit !== -1) classes.push(hit === currentIndex ? "editor-mark current" : "editor-mark");

    const chunk = escapeHtml(text.slice(start, end));
    if (!classes.length) {
      html += chunk;
      continue;
    }
    // 命中搜索的区间用 <mark>，其余用不影响排版的 <span>
    const tag = hit !== -1 ? "mark" : "span";
    html += `<${tag} class="${classes.join(" ")}">${chunk}</${tag}>`;
  }
  return html;
}

/** 按 docs/API.md 第 3 节，用 WebDAV PUT 写回对象 */
export default {  props: {
    modelValue: Boolean,
    item: {
      type: Object,
      default: null,
    },
    /** 强制按文本打开（右键菜单「以文本方式打开」），跳过文本类型判定并提示二进制风险 */
    forceText: Boolean,
  },

  emits: ["update:modelValue", "saved"],

  data: () => ({
    content: "",
    original: "",
    loading: false,
    loadError: "",
    tooLarge: false,
    /** 扩展名/MIME 判定为非文本，且没有强制打开 */
    notText: false,
    /** 用户在被拒绝后选择「以文本方式打开」 */
    localForce: false,
    saving: false,
    status: "",
    statusError: false,
    search: "",
    caseSensitive: false,
    currentIndex: 0,
    searchFocused: false,
    /** JSON 校验结果 */
    jsonValid: false,
    jsonError: "",
    /** 历史版本面板 */
    showVersions: false,
    versions: [],
    versionsLoading: false,
    versionsError: "",
    /** 正在处理（载入 / 恢复 / 删除）的版本 id */
    versionBusy: "",
    /**
     * 高亮层使用的文本副本（防抖更新）。
     * 语法着色要对全文分词并整段重渲染 v-html，如果跟着每个按键走，
     * 大文件下会明显掉帧；这里让打字保持流畅，着色稍后跟上。
     */
    highlightText: "",
    /** 编辑器内撤销 / 重做（Ctrl+Z / Ctrl+Y），按「一段连续输入」合并成一步 */
    undoStack: [],
    redoStack: [],
  }),

  computed: {
    itemKey() {
      return this.item && this.item.key ? String(this.item.key) : "";
    },

    displayName() {
      return this.item && this.item.name ? String(this.item.name) : "文本文件";
    },

    itemSize() {
      return this.item ? Number(this.item.size) || 0 : 0;
    },

    isReadOnly() {
      return !!(this.item && this.item.writable === false);
    },

    /** 是否处于「强行按文本打开」模式 */
    forceMode() {
      return !!(this.forceText || this.localForce);
    },

    /** 强行打开且内容里出现 NUL 字节时给出醒目警告（普通「编辑」不显示） */
    binaryWarning() {
      return this.forceMode && this.content.indexOf("\u0000") !== -1;
    },

    /** 编辑器主体（搜索栏/统计/输入区）是否可用 */
    showStats() {
      return !this.loading && !this.tooLarge && !this.notText && !this.loadError;
    },

    canSave() {
      return this.showStats && !this.isReadOnly;
    },

    dirty() {
      return this.content !== this.original;
    },

    charCount() {
      return this.content.length;
    },

    lineCount() {
      return this.content.split("\n").length;
    },

    statText() {
      return `${this.charCount} 字符 · ${this.lineCount} 行 · ${formatSize(this.itemSize)}`;
    },

    /** 语法识别：{ id, label } */
    language() {
      return detectLanguage(
        (this.item && (this.item.name || this.item.key)) || "",
        this.item ? this.item.contentType : ""
      );
    },

    isJson() {
      return this.language.id === "json";
    },

    /** 内容过大时跳过着色（搜索定位仍然可用） */
    colorized() {
      return this.content.length > 0 && this.content.length <= MAX_HIGHLIGHT_SIZE;
    },

    /** 语法着色区间（plaintext / 超大文件返回空数组） */
    tokens() {
      if (!this.colorized) return [];
      const id = this.language.id;
      if (id === "plaintext") return [];
      return tokenize(this.highlightText, this.language);
    },

    canFormat() {
      return this.showStats && this.isJson && !this.isReadOnly;
    },

    jsonStatus() {
      if (!this.isJson) return "";
      if (this.jsonError) return `JSON 错误：${this.jsonError}`;
      if (this.jsonValid) return "JSON 有效";
      return "";
    },

    tooLargeHint() {
      return `文件过大，无法在线编辑（文件大小 ${formatSize(
        this.itemSize
      )}，上限 ${MAX_EDIT_SIZE_LABEL}）。`;
    },

    matches() {
      // 与高亮层用同一份文本（highlightText），避免打字防抖窗口内
      // 搜索高亮与实际渲染文本错位
      return findMatches(this.highlightText, this.search, this.caseSensitive);
    },

    matchLabel() {
      const total = this.matches.length;
      if (!this.search || !total) return "0/0";
      const index = Math.min(Math.max(this.currentIndex, 0), total - 1);
      return `${index + 1}/${total}`;
    },

    /** 高亮层：语法着色 + 搜索匹配，与 textarea 内容逐字符对齐 */
    highlightHtml() {
      return buildHighlightHtml(
        this.highlightText,
        this.tokens,
        this.matches,
        this.currentIndex
      );
    },

    /** 保存时使用的 Content-Type */
    uploadContentType() {
      const raw = this.item && this.item.contentType ? String(this.item.contentType) : "";
      const base = raw.split(";")[0].trim().toLowerCase();
      if (!base) return "text/plain; charset=utf-8";
      if (base.startsWith("text/")) return raw;
      if (APPLICATION_TEXT_TYPES.includes(base)) return raw;
      return "text/plain; charset=utf-8";
    },
  },

  watch: {
    modelValue(value) {
      if (value) this.load();
      else this.reset();
    },

    itemKey() {
      if (this.modelValue) this.load();
    },

    content() {
      // 输入时只做滚动同步（轻量），measureGutter（读 offsetWidth 触发 reflow）
      // 交给 resize / 打开编辑器时做，避免每个按键都强制重排导致卡顿
      this.$nextTick(() => this.syncScroll());
      this.scheduleJsonCheck();
      this.scheduleUndoSnapshot();
      this.scheduleHighlight();
    },

    matches(list) {
      if (this.currentIndex >= list.length) {
        this.currentIndex = list.length ? list.length - 1 : 0;
      }
      this.$nextTick(() => this.syncLayers());
    },
  },

  created() {
    this._token = 0;
    this._versionToken = 0;
  },

  mounted() {
    this._onKeydown = (event) => this.handleKeydown(event);
    this._onResize = () => this.syncLayers();
    document.addEventListener("keydown", this._onKeydown, true);
    window.addEventListener("resize", this._onResize);
  },

  beforeUnmount() {
    document.removeEventListener("keydown", this._onKeydown, true);
    window.removeEventListener("resize", this._onResize);
    if (this._jsonTimer) clearTimeout(this._jsonTimer);
    if (this._hlTimer) clearTimeout(this._hlTimer);
    if (this._undoTimer) clearTimeout(this._undoTimer);
  },

  methods: {
    /* ---------------- 编辑器内撤销 / 重做 ---------------- */

    /** 输入时延迟入栈：连续敲键盘算一步，和常见编辑器的手感一致 */
    scheduleUndoSnapshot() {
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => this.pushUndoSnapshot(), 400);
    },

    pushUndoSnapshot() {
      if (this._undoTimer) {
        clearTimeout(this._undoTimer);
        this._undoTimer = 0;
      }
      const current = this.content;
      if (current === this._lastPushed) return;
      this.undoStack.push(this._lastPushed);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this._lastPushed = current;
      this.redoStack = [];
    },

    undo() {
      this.pushUndoSnapshot();
      if (!this.undoStack.length) {
        this.setStatus("没有可撤销的修改", false);
        return;
      }
      const previous = this.undoStack.pop();
      this.redoStack.push(this.content);
      this.applyHistory(previous);
      this.setStatus("已撤销上一次修改", false);
    },

    redo() {
      if (!this.redoStack.length) {
        this.setStatus("没有可重做的修改", false);
        return;
      }
      const next = this.redoStack.pop();
      this.undoStack.push(this.content);
      this.applyHistory(next);
      this.setStatus("已重做", false);
    },

    /**
     * 应用历史内容（撤销/重做/载入版本）。
     * 光标尽量停在原位置：取「撤销前光标位置」与「新文本长度」的较小值，
     * 不再强制跳到文件末尾，避免用户每次撤销都要滑回去。
     */
    applyHistory(text) {
      const input = this.$refs.input;
      // 记录撤销前的光标与滚动位置
      const prevStart = input && typeof input.selectionStart === "number" ? input.selectionStart : text.length;
      const prevScrollTop = input ? input.scrollTop : 0;

      this.content = text;
      this._lastPushed = text;
      this.$nextTick(() => {
        const el = this.$refs.input;
        if (!el) return;
        const pos = Math.min(prevStart, text.length);
        try {
          el.focus({ preventScroll: true });
          el.setSelectionRange(pos, pos);
          // 尽量保持原来的滚动位置；若光标已不在可视区，浏览器会自动微调
          el.scrollTop = Math.min(prevScrollTop, el.scrollHeight);
          this.syncScroll();
        } catch (error) {
          /* 忽略 */
        }
      });
    },

    /** 换文件或重新加载后重置历史 */
    resetHistory(text) {
      if (this._undoTimer) {
        clearTimeout(this._undoTimer);
        this._undoTimer = 0;
      }
      this.undoStack = [];
      this.redoStack = [];
      this._lastPushed = text == null ? "" : String(text);
    },

    /* ---------------- 历史版本 ---------------- */

    async toggleVersions() {
      this.showVersions = !this.showVersions;
      if (this.showVersions) await this.fetchVersions();
    },

    async fetchVersions() {
      if (!this.itemKey) return;
      this.versionsLoading = true;
      this.versionsError = "";
      // 并发保护：快速反复点击时只认最后一次
      const token = (this._versionToken = (this._versionToken || 0) + 1);
      try {
        // 15 秒超时，避免网络挂起时永远停在「加载中」
        const result = await Promise.race([
          listVersions(this.itemKey),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("请求超时，请检查网络后重试")), 15000)
          ),
        ]);
        if (token !== this._versionToken) return; // 已被更新的请求取代
        this.versions = result;
      } catch (error) {
        if (token !== this._versionToken) return;
        this.versions = [];
        this.versionsError = `读取历史版本失败：${errorMessage(error)}`;
      } finally {
        if (token === this._versionToken) this.versionsLoading = false;
      }
    },

    /** 把历史版本载入编辑器（不落盘，保存后才生效） */
    async loadVersion(version) {
      if (!version || !version.id || !this.itemKey) return;
      this.versionBusy = version.id;
      try {
        this.content = await fetchVersionContentRequest(this.itemKey, version.id);
        this.resetHistory(this.content);
        this.setStatus("已载入历史版本，保存后才会覆盖当前内容", false);
      } catch (error) {
        this.setStatus(`载入历史版本失败：${errorMessage(error)}`, true);
      } finally {
        this.versionBusy = "";
      }
    },

    /** 用历史版本覆盖当前对象；服务端会先给当前内容也留一份快照 */
    async restoreVersion(version) {
      if (!version || !version.id || !this.itemKey) return;
      if (!window.confirm(`确定用这个版本覆盖当前内容吗？\n${version.id}`)) return;
      this.versionBusy = version.id;
      try {
        await restoreVersionRequest(this.itemKey, version.id);
        await this.load();
        this.setStatus("已恢复到该版本", false);
        await this.fetchVersions();
        this.$emit("saved", { key: this.itemKey, size: this.content.length });
      } catch (error) {
        this.setStatus(`恢复失败：${errorMessage(error)}`, true);
      } finally {
        this.versionBusy = "";
      }
    },

    async deleteVersion(version) {
      if (!version || !version.id || !this.itemKey) return;
      if (!window.confirm(`确定删除这个历史版本吗？\n${version.id}`)) return;
      this.versionBusy = version.id;
      try {
        await removeVersionRequest(this.itemKey, version.id);
        await this.fetchVersions();
        this.setStatus("已删除该历史版本", false);
      } catch (error) {
        this.setStatus(`删除失败：${errorMessage(error)}`, true);
      } finally {
        this.versionBusy = "";
      }
    },

    /* ---------------- 打开 / 加载 / 关闭 ---------------- */

    reset() {
      this._token += 1;
      if (this._jsonTimer) {
        clearTimeout(this._jsonTimer);
        this._jsonTimer = null;
      }
      this.content = "";
      this.original = "";
      this.loading = false;
      this.loadError = "";
      this.tooLarge = false;
      this.notText = false;
      this.localForce = false;
      this.saving = false;
      this.status = "";
      this.statusError = false;
      this.search = "";
      this.caseSensitive = false;
      this.currentIndex = 0;
      this.searchFocused = false;
      this.jsonValid = false;
      this.jsonError = "";
      if (this._hlTimer) {
        clearTimeout(this._hlTimer);
        this._hlTimer = 0;
      }
      this.highlightText = "";
      this.resetHistory("");
    },

    /** 打开时用 apiFetch 取原始内容 */
    async load() {
      this.reset();
      await this.startLoad();
    },

    /** 被文本类型判定拦住后，用户坚持强行打开（效果等同 forceText） */
    async forceOpen() {
      this.reset();
      this.localForce = true;
      await this.startLoad();
    },

    async startLoad() {
      const item = this.item;
      if (!item || !item.key) return;
      if (this.itemSize >= MAX_EDIT_SIZE) {
        this.tooLarge = true;
        return;
      }
      if (!this.forceMode && !isTextFile(item.name || item.key, item.contentType)) {
        this.notText = true;
        return;
      }
      const token = this._token;
      this.loading = true;
      try {
        const url = rawUrl(item.key);
        // 明确不走 HTTP 缓存：刚保存过的对象必须读到最新内容
        const response = await apiFetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new ApiError(await describeResponseError(response), response.status, url);
        }
        const text = await response.text();
        if (token !== this._token) return;
        this.content = text;
        this.original = text;
        this.resetHistory(text);
        this.loading = false;
        this.jsonValid = false;
        this.jsonError = "";
        this.$nextTick(() => {
          this.highlightText = this.content;
          this.syncLayers();
          this.validateJson();
        });
      } catch (error) {
        if (token !== this._token) return;
        this.loading = false;
        this.loadError = errorMessage(error);
      }
    },

    close() {
      this.$emit("update:modelValue", false);
    },

    /** 关闭前若内容已修改，先确认 */
    requestClose() {
      if (this.dirty && !window.confirm("内容尚未保存，确定要关闭吗？")) return;
      this.close();
    },

    async download() {
      if (!this.item || !this.item.key) return;
      try {
        this.setStatus("正在下载...", false);
        await downloadKey(this.item.key);
        this.setStatus("", false);
      } catch (error) {
        this.setStatus(`下载失败：${errorMessage(error)}`, true);
      }
    },

    setStatus(text, isError) {
      this.status = text;
      this.statusError = !!isError;
    },

    /* ---------------- JSON 校验与格式化 ---------------- */

    /** 编辑时防抖 300ms 校验 */
    /** 防抖更新高亮层：停止输入 150ms 后再重新着色，打字过程不卡 */
    scheduleHighlight() {
      if (this._hlTimer) clearTimeout(this._hlTimer);
      this._hlTimer = setTimeout(() => {
        this._hlTimer = 0;
        this.highlightText = this.content;
      }, 150);
    },

    scheduleJsonCheck() {
      if (this._jsonTimer) clearTimeout(this._jsonTimer);
      if (!this.isJson) {
        this.jsonValid = false;
        this.jsonError = "";
        return;
      }
      this._jsonTimer = setTimeout(() => {
        this._jsonTimer = null;
        this.validateJson();
      }, 300);
    },

    validateJson() {
      if (!this.isJson) {
        this.jsonValid = false;
        this.jsonError = "";
        return;
      }
      const text = this.content;
      if (!text.trim()) {
        this.jsonValid = false;
        this.jsonError = "";
        return;
      }
      try {
        JSON.parse(text);
        this.jsonValid = true;
        this.jsonError = "";
      } catch (error) {
        this.jsonValid = false;
        this.jsonError = this.describeJsonError(error, text);
      }
    },

    /** 把 JSON.parse 的报错补上行列位置 */
    describeJsonError(error, text) {
      const message = error && error.message ? String(error.message) : "解析失败";
      const match = /position (\d+)/.exec(message);
      if (!match) return message;
      const position = Math.min(Number(match[1]), text.length);
      let line = 1;
      let column = 1;
      for (let index = 0; index < position; index++) {
        if (text[index] === "\n") {
          line++;
          column = 1;
        } else {
          column++;
        }
      }
      return `${message}（第 ${line} 行第 ${column} 列）`;
    },

    /** 格式化：JSON.stringify(parsed, null, 2) 重排，并标记为已修改 */
    formatJson() {
      if (!this.isJson || this.isReadOnly) return;
      try {
        const parsed = JSON.parse(this.content);
        this.content = JSON.stringify(parsed, null, 2);
        this.jsonValid = true;
        this.jsonError = "";
        this.setStatus("已格式化（记得保存）", false);
        this.$nextTick(() => this.syncLayers());
      } catch (error) {
        this.jsonValid = false;
        this.jsonError = this.describeJsonError(error, this.content);
        this.setStatus(`格式化失败：${this.jsonError}`, true);
      }
    },

    /* ---------------- 保存 ---------------- */

    async save() {
      if (this.isReadOnly) {
        this.setStatus("只读模式，无法保存", true);
        return;
      }
      if (this.saving) return;
      const item = this.item;
      if (!item || !item.key) return;
      const url = webdavUrl(item.key);
      this.saving = true;
      this.setStatus("正在保存...", false);
      try {
        const response = await apiFetch(url, {
          method: "PUT",
          body: this.content,
          headers: {
            "Content-Type": this.uploadContentType,
            // 让服务端在覆盖前把旧内容存成历史版本，改错了可以回退
            "fd-snapshot": "1",
          },
        });
        if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
          throw new ApiError(await describeResponseError(response), response.status, url);
        }
        this.original = this.content;
        this.setStatus("已保存", false);
        this.$emit("saved", { key: item.key, size: this.content.length });
      } catch (error) {
        this.setStatus(`保存失败：${errorMessage(error)}`, true);
      } finally {
        this.saving = false;
      }
    },

    /* ---------------- 快捷键 ---------------- */

    handleKeydown(event) {
      if (!this.modelValue || !event) return;
      const key = event.key;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "s" || key === "S")) {
        event.preventDefault();
        if (this.canSave) this.save();
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        this.handleEscape();
      }
    },

    /** Esc：优先关闭查找栏，其次（内容已修改时先确认）关闭编辑器 */
    handleEscape() {
      if (this.searchFocused || this.search) {
        this.search = "";
        this.currentIndex = 0;
        this.searchFocused = false;
        if (this.$refs.search && typeof this.$refs.search.blur === "function") {
          this.$refs.search.blur();
        }
        this.$nextTick(() => this.syncLayers());
        return;
      }
      this.requestClose();
    },

    /* ---------------- 编辑内搜索 ---------------- */

    onSearchInput(event) {
      this.search = event && event.target ? String(event.target.value) : "";
      this.currentIndex = 0;
      this.$nextTick(() => this.locate(false));
    },

    onSearchEnter(event) {
      this.stepMatch(event && event.shiftKey ? -1 : 1, false);
    },

    onCaseChange(event) {
      this.caseSensitive = !!(event && event.target && event.target.checked);
      this.currentIndex = 0;
      this.$nextTick(() => this.locate(false));
    },

    nextMatch() {
      this.stepMatch(1, true);
    },

    prevMatch() {
      this.stepMatch(-1, true);
    },

    stepMatch(delta, moveFocus) {
      const total = this.matches.length;
      if (!total) return;
      this.currentIndex = ((this.currentIndex + delta) % total + total) % total;
      this.$nextTick(() => this.locate(moveFocus !== false));
    },

    /** 定位到当前匹配：设置 selectionStart/End + 兜底调整 scrollTop */
    locate(moveFocus) {
      const input = this.$refs.input;
      const list = this.matches;
      if (!input || !list.length) return;
      const index = Math.min(Math.max(this.currentIndex, 0), list.length - 1);
      this.currentIndex = index;
      const match = list[index];
      try {
        input.setSelectionRange(match.start, match.end);
      } catch (error) {
        /* 极少数浏览器在只读状态下可能拒绝，忽略 */
      }
      this.scrollToMatch(match);
      if (moveFocus && typeof input.focus === "function") {
        try {
          input.focus({ preventScroll: true });
        } catch (error) {
          input.focus();
        }
      }
    },

    scrollToMatch(match) {
      const input = this.$refs.input;
      if (!input || !match) return;
      const before = this.content.slice(0, match.start);
      const lineIndex = before.split("\n").length - 1;
      const lineHeight = this.measureLineHeight(input);
      const paddingTop = parseFloat(window.getComputedStyle(input).paddingTop) || 0;
      const target = lineIndex * lineHeight + paddingTop - input.clientHeight / 3;
      input.scrollTop = Math.max(0, target);
      this.syncScroll();
    },

    measureLineHeight(input) {
      const style = window.getComputedStyle(input);
      const lineHeight = parseFloat(style.lineHeight);
      if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
      const fontSize = parseFloat(style.fontSize);
      return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : 20;
    },

    /* ---------------- 两层同步 ---------------- */

    /** 高亮层跟随 textarea 的滚动位置 */
    syncScroll() {
      const input = this.$refs.input;
      const layer = this.$refs.highlight;
      if (!input || !layer) return;
      layer.scrollTop = input.scrollTop;
      layer.scrollLeft = input.scrollLeft;
    },

    /** 让高亮层的可用宽度与 textarea 一致（补上滚动条占用的宽度） */
    measureGutter() {
      const input = this.$refs.input;
      const layer = this.$refs.highlight;
      if (!input || !layer) return;
      const gutter = Math.max(0, input.offsetWidth - input.clientWidth);
      layer.style.paddingRight = `${EDITOR_PADDING + gutter}px`;
    },

    syncLayers() {
      this.measureGutter();
      this.syncScroll();
    },
  },
};
</script>

<style>
.editor-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.editor-dialog {
  display: flex;
  flex-direction: column;
  width: min(1000px, 100%);
  height: min(88vh, 100%);
  background-color: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 2px 8px 24px rgba(0, 0, 0, 0.3);
}

.editor-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
}

.editor-title {
  font-weight: 600;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-toolbar-spacer {
  flex: 1;
}

.editor-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 10px;
  background-color: #eee;
  color: dimgray;
  font-size: 0.75em;
  white-space: nowrap;
}

.editor-badge.dirty {
  background-color: #fff3d6;
  color: #8a6d3b;
}

.editor-stat {
  color: dimgray;
  font-size: 0.8em;
  white-space: nowrap;
}

/* 识别到的语言 */
.editor-lang {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 10px;
  background-color: #eef4fb;
  color: #0b5fa5;
  font-size: 0.75em;
  white-space: nowrap;
}

/* JSON 校验结果 */
.editor-json {
  flex-shrink: 0;
  font-size: 0.78em;
  color: #1b7f3b;
  white-space: nowrap;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.editor-json.error {
  color: #b00020;
}

.editor-format {
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #ddd;
  color: #0b5fa5;
  font-size: 0.85em;
}

.editor-format:hover {
  background-color: #eef4fb;
}

.editor-save {
  flex-shrink: 0;
  padding: 6px 16px;
  border-radius: 6px;
  background-color: rgb(243, 128, 32);
  color: white;
  font-size: 0.9em;
}

.editor-save:hover {
  filter: brightness(0.95);
}

.editor-save:disabled {
  opacity: 0.6;
}

.editor-close {
  flex-shrink: 0;
  padding: 6px 8px;
  color: #0b5fa5;
  font-size: 0.9em;
}

.editor-primary {
  padding: 8px 18px;
  border-radius: 6px;
  background-color: rgb(243, 128, 32);
  color: white;
  font-size: 0.9em;
}

.editor-status {
  flex-shrink: 0;
  padding: 6px 12px;
  background-color: #eef7f0;
  color: #1b7f3b;
  font-size: 0.8em;
  border-bottom: 1px solid #eee;
  word-break: break-word;
}

.editor-status.error {
  background-color: #fdecef;
  color: #b00020;
}

/* 强行按文本打开且发现 NUL 字节时的警告条 */
.editor-warning {
  flex-shrink: 0;
  margin: 0;
  padding: 8px 12px;
  background-color: #b00020;
  color: white;
  font-size: 0.85em;
  font-weight: 600;
  text-align: center;
}

.editor-searchbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  background-color: #fafafa;
}

.editor-searchbar .editor-searchinput {
  width: auto;
  flex: 1 1 160px;
  min-width: 120px;
  padding: 6px 12px;
}

.editor-matchcount {
  color: dimgray;
  font-size: 0.8em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.editor-nav {
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 6px;
  color: #0b5fa5;
  font-size: 0.85em;
}

.editor-nav:hover {
  background-color: #eef4fb;
}

.editor-case {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  color: #444;
  font-size: 0.8em;
  white-space: nowrap;
  cursor: pointer;
}

.editor-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
  color: dimgray;
  text-align: center;
}

.editor-state.error {
  color: #b00020;
}

.editor-state-text {
  margin: 0;
  word-break: break-word;
}

.editor-state-hint {
  margin: 0;
  font-size: 0.8em;
}

/* 编辑区：textarea 在上（文字透明、只留光标与选区），高亮层在下承载可见文本 */
/* 内容区：左编辑区 + 右历史版本面板。两条 flex 规则缺一不可，
   否则 textarea 的 height:100% 会失去参照高度，内容区塌成一行 */
.editor-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.editor-main {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.editor-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background-color: white;
}

.editor-layer {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 12px;
  border: 0;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  font-size: 13px;
  font-style: normal;
  font-weight: normal;
  font-variant: normal;
  line-height: 1.5;
  letter-spacing: normal;
  word-spacing: normal;
  text-align: left;
  text-indent: 0;
  text-transform: none;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  hyphens: none;
}

.editor-highlight {
  z-index: 0;
  overflow: hidden;
  color: #1a1a1a;
  pointer-events: none;
}

.editor-highlight mark {
  font: inherit;
  margin: 0;
  padding: 0;
  border-radius: 2px;
  background-color: #ffe08a;
  color: inherit;
}

.editor-highlight mark.current {
  background-color: #ff9f1a;
  color: #1a1a1a;
}

/* 语法着色：只改颜色，绝不改字体/字重/字距，否则两层会错位 */
.editor-highlight .tok-comment {
  color: #6a737d;
}

.editor-highlight .tok-string {
  color: #0a7d33;
}

.editor-highlight .tok-number {
  color: #b45309;
}

.editor-highlight .tok-keyword {
  color: #0b5fa5;
}

.editor-highlight .tok-literal {
  color: #8250df;
}

.editor-highlight .tok-property {
  color: #a31515;
}

.editor-highlight .tok-tag {
  color: #0b5fa5;
}

.editor-highlight .tok-attr {
  color: #b45309;
}

.editor-highlight .tok-punctuation {
  color: #6b6b6b;
}

.editor-input {
  z-index: 1;
  width: 100%;
  height: 100%;
  overflow: auto;
  scrollbar-gutter: stable;
  resize: none;
  background-color: transparent;
  color: transparent;
  caret-color: #1a1a1a;
  outline: none;
}

.editor-input::selection {
  background-color: rgba(255, 159, 26, 0.45);
  color: transparent;
}

.editor-input::-moz-selection {
  background-color: rgba(255, 159, 26, 0.45);
  color: transparent;
}

@media only screen and (max-width: 768px) {
  .editor-mask {
    padding: 0;
  }

  .editor-dialog {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .editor-title {
    max-width: 100%;
  }

  .editor-stat {
    font-size: 0.75em;
  }
}
</style>
