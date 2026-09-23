<template>
  <Transition name="fade">
    <div
      v-if="modelValue"
      class="preview-mask"
      role="dialog"
      aria-modal="true"
      aria-label="预览"
      @click.self="close"
    >
      <div class="preview-dialog">
        <div class="preview-toolbar">
          <span class="preview-title" v-text="displayName"></span>
          <span class="preview-meta" v-text="metaText"></span>
          <span class="preview-spacer"></span>
          <template v-if="kind === 'image' && total > 1">
            <button
              type="button"
              class="preview-button"
              aria-label="上一张"
              :disabled="!hasPrev"
              @click="stepImage(-1)"
            >
              <span>‹ 上一张</span>
            </button>
            <span class="preview-meta" v-text="positionLabel"></span>
            <button
              type="button"
              class="preview-button"
              aria-label="下一张"
              :disabled="!hasNext"
              @click="stepImage(1)"
            >
              <span>下一张 ›</span>
            </button>
          </template>
          <button
            v-if="kind === 'image'"
            type="button"
            class="preview-button"
            aria-label="切换缩放"
            @click="toggleZoom"
          >
            <span v-text="zoom > 1 ? '适应窗口' : '1:1 放大'"></span>
          </button>
          <button
            type="button"
            class="preview-button"
            aria-label="下载"
            :disabled="busy"
            @click="download"
          >
            <span>下载</span>
          </button>
          <button
            type="button"
            class="preview-button"
            aria-label="复制分享链接"
            :disabled="sharing"
            @click="copyShareLink"
          >
            <span v-text="sharing ? '处理中...' : '复制链接'"></span>
          </button>
          <button type="button" class="preview-close" aria-label="关闭预览" @click="close">
            <span>关闭</span>
          </button>
        </div>

        <p
          v-if="status"
          class="preview-status"
          :class="{ error: statusError }"
          role="status"
          v-text="status"
        ></p>

        <div
          class="preview-stage"
          @touchstart.passive="onStageTouchStart"
          @touchmove="onStageTouchMove"
          @touchend="onStageTouchEnd"
          @touchcancel="onStageTouchCancel"
        >
          <div v-if="loading" class="preview-state">加载中...</div>

          <div v-else-if="loadError" class="preview-state error">
            <p class="preview-state-text" v-text="`加载失败：${loadError}`"></p>
            <button type="button" class="preview-primary" aria-label="重新加载预览" @click="load">
              <span>重试</span>
            </button>
          </div>

          <template v-else-if="objectUrl">
            <img
              v-if="kind === 'image'"
              class="preview-image"
              :class="{ zoomed: zoom > 1 }"
              :style="imageStyle"
              :src="objectUrl"
              :alt="displayName"
              @dblclick="toggleZoom"
              @wheel.prevent="onWheel"
            />
            <video
              v-else-if="kind === 'video'"
              class="preview-video"
              :src="objectUrl"
              controls
              playsinline
            ></video>
            <audio v-else-if="kind === 'audio'" class="preview-audio" :src="objectUrl" controls></audio>
            <iframe
              v-else-if="kind === 'pdf'"
              class="preview-frame"
              :src="objectUrl"
              title="PDF 预览"
            ></iframe>
            <div v-else class="preview-state">
              <p class="preview-state-text" v-text="`该类型（${typeLabel}）无法在线预览，已开始下载。`"></p>
              <p class="preview-state-hint">也可以点上方「下载」再次保存，或「复制链接」分享给别人。</p>
            </div>
          </template>

          <div v-else class="preview-state">没有可预览的内容</div>
        </div>

        <p v-if="kind === 'image'" class="preview-hint">
          <template v-if="total > 1">左右滑动（或按 ← →）切换同目录图片；</template>
          双击图片或滚动滚轮可以放大 / 还原。
        </p>
      </div>
    </div>
  </Transition>
</template>

<script>
import {
  ApiError,
  apiFetch,
  copyTextToClipboard,
  createShare,
  describeResponseError,
  downloadKey,
  errorMessage,
  formatSize,
  isImageFile,
  previewKind,
  rawUrl,
  saveBlob,
} from "/assets/main.mjs";

/** 服务端没给出可用 MIME 时，按扩展名兜底猜一个（blob 会按猜测的类型重建） */
const MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  pdf: "application/pdf",
};

/** 通用 / 缺失的 MIME，遇到它们时用扩展名猜测覆盖 */
const GENERIC_TYPES = ["", "application/octet-stream", "binary/octet-stream"];

function extensionOf(name) {
  const value = String(name == null ? "" : name).toLowerCase();
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(index + 1) : "";
}

/**
 * 应用内预览弹窗。
 * 因为 /raw/{key} 默认需要认证，新标签页带不上认证头，所以统一在这里
 * 用 apiFetch 取回 Blob → URL.createObjectURL → 按类型渲染。
 */
export default {
  props: {
    modelValue: Boolean,
    item: {
      type: Object,
      default: null,
    },
    /** 同目录的候选文件（用于左右切换图片），由父组件传入 */
    siblings: {
      type: Array,
      default: () => [],
    },
  },

  emits: ["update:modelValue", "select"],

  data: () => ({
    loading: false,
    loadError: "",
    objectUrl: "",
    blob: null,
    kind: null,
    /** 服务端 / 猜测得到的最终 MIME */
    contentType: "",
    /** 图片缩放倍率：1 = 适应窗口 */
    zoom: 1,
    sharing: false,
    status: "",
    statusError: false,
  }),

  computed: {
    itemKey() {
      return this.item && this.item.key ? String(this.item.key) : "";
    },

    displayName() {
      return this.item && this.item.name ? String(this.item.name) : "文件";
    },

    displaySize() {
      if (this.blob) return Number(this.blob.size) || 0;
      return this.item ? Number(this.item.size) || 0 : 0;
    },

    metaText() {
      const parts = [formatSize(this.displaySize)];
      if (this.contentType) parts.push(this.contentType);
      if (this.kind === "image" && this.zoom > 1) parts.push(`放大 ${this.zoom}×`);
      return parts.join(" · ");
    },

    typeLabel() {
      return this.contentType || "未知类型";
    },

    busy() {
      return this.loading;
    },

    /** 同目录里可以左右切换的图片（顺序与列表一致） */
    imageSiblings() {
      const list = Array.isArray(this.siblings) ? this.siblings : [];
      return list.filter((entry) => entry && isImageFile(entry.name, entry.contentType));
    },

    total() {
      return this.imageSiblings.length;
    },

    /** 当前图在同目录图片里的下标；-1 表示不在列表里 */
    currentIndex() {
      const key = this.itemKey;
      if (!key) return -1;
      return this.imageSiblings.findIndex((entry) => entry && entry.key === key);
    },

    hasPrev() {
      return this.currentIndex > 0;
    },

    hasNext() {
      const index = this.currentIndex;
      return index >= 0 && index < this.total - 1;
    },

    positionLabel() {
      const index = this.currentIndex;
      if (index < 0 || !this.total) return "";
      return `${index + 1}/${this.total}`;
    },

    /** 放大时按容器宽度百分比撑开，适应窗口时交给 max-width/max-height */
    imageStyle() {
      if (this.zoom <= 1) return { maxWidth: "100%", maxHeight: "100%" };
      return {
        width: `${Math.round(this.zoom * 100)}%`,
        maxWidth: "none",
        maxHeight: "none",
      };
    },
  },

  watch: {
    modelValue(value) {
      if (value) {
        this.lockScroll();
        this.load();
      } else {
        this.release();
        this.unlockScroll();
      }
    },

    itemKey() {
      if (this.modelValue) this.load();
    },
  },

  mounted() {
    this._onKeydown = (event) => {
      if (!this.modelValue || !event) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
      // 看图时用左右方向键切换同目录图片
      if (this.kind === "image" && this.total > 1 && this.zoom <= 1) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          this.stepImage(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          this.stepImage(1);
        }
      }
    };
    document.addEventListener("keydown", this._onKeydown, true);
  },

  beforeUnmount() {
    document.removeEventListener("keydown", this._onKeydown, true);
    this.release();
    this.unlockScroll();
  },

  methods: {
    /* ---------------- 同目录图片切换 ---------------- */

    /**
     * 切到上一张 / 下一张（不放环形绕回，到头就是到头，行为更好预期）。
     * 通过 select 事件把新条目交回父组件，父组件更新 item 后这里自动重新加载。
     */
    stepImage(delta) {
      const index = this.currentIndex;
      if (index < 0) return;
      const next = index + delta;
      if (next < 0 || next >= this.total) return;
      const target = this.imageSiblings[next];
      if (!target) return;
      this.zoom = 1;
      this.$emit("select", target);
    },

    /** 触摸滑动：横向位移超过 50px 且明显大于纵向位移才切换（避免和竖向滚动打架） */
    onStageTouchStart(event) {
      const touch = event && event.touches && event.touches[0];
      if (!touch) return;
      this._swipe = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    },

    /**
     * 横向滑动时阻止默认行为：否则在手机上会被浏览器当成「返回上一页」的手势，
     * 直接把整个页面带走（看图时右滑尤其容易触发）。
     * 元素上的 touchmove 默认不是 passive，所以这里可以 preventDefault。
     */
    onStageTouchMove(event) {
      const start = this._swipe;
      if (!start || this.kind !== "image" || this.total <= 1 || this.zoom > 1) return;
      const touch = event && event.touches && event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        if (event.cancelable) event.preventDefault();
      }
    },

    onStageTouchCancel() {
      this._swipe = null;
    },

    onStageTouchEnd(event) {
      const start = this._swipe;
      this._swipe = null;
      if (!start || this.kind !== "image" || this.total <= 1) return;
      // 放大状态下滑动用于看细节，不切图
      if (this.zoom > 1) return;
      const touch =
        (event && event.changedTouches && event.changedTouches[0]) ||
        (event && event.touches && event.touches[0]);
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      this.stepImage(dx < 0 ? 1 : -1);
    },

    /* ---------------- 打开 / 关闭 ---------------- */

    close() {
      this.$emit("update:modelValue", false);
    },

    /** 释放当前 Blob 与对象 URL（预览的 Blob 可能很大，不留在会话里） */
    release() {
      this._token = (this._token || 0) + 1;
      if (this.objectUrl) {
        try {
          URL.revokeObjectURL(this.objectUrl);
        } catch (error) {
          /* 忽略 */
        }
      }
      this.objectUrl = "";
      this.blob = null;
      this.kind = null;
      this.contentType = "";
      this.zoom = 1;
      this.loading = false;
      this.loadError = "";
      this.sharing = false;
      this.status = "";
      this.statusError = false;
    },

    lockScroll() {
      if (this._locked) return;
      this._prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      this._locked = true;
    },

    unlockScroll() {
      if (!this._locked) return;
      document.body.style.overflow = this._prevOverflow || "";
      this._locked = false;
    },

    setStatus(text, isError) {
      this.status = text;
      this.statusError = !!isError;
    },

    /* ---------------- 取回内容 ---------------- */

    async load() {
      const key = this.itemKey;
      this.release();
      if (!key) {
        this.loadError = "没有要预览的文件";
        return;
      }
      const token = (this._token = (this._token || 0) + 1);
      this.loading = true;
      try {
        const url = rawUrl(key);
        const response = await apiFetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new ApiError(await describeResponseError(response), response.status, url);
        }
        let blob = await response.blob();
        if (token !== this._token) return;

        let type = String((blob && blob.type) || "").split(";")[0].trim().toLowerCase();
        const guessed = MIME_BY_EXTENSION[extensionOf(this.displayName)] || "";
        if (guessed && GENERIC_TYPES.indexOf(type) !== -1) {
          type = guessed;
          try {
            blob = blob.slice(0, blob.size, guessed);
          } catch (error) {
            /* 重建失败就用原 Blob */
          }
        }

        this.blob = blob;
        this.contentType = type;
        this.kind = previewKind(type);
        this.objectUrl = URL.createObjectURL(blob);
        this.loading = false;

        // 图片、音视频、PDF 之外的类型无法在线渲染：直接触发下载并提示
        if (!this.kind) {
          saveBlob(blob, this.displayName);
          this.setStatus(`该类型（${this.typeLabel}）无法在线预览，已开始下载。`, false);
        }
      } catch (error) {
        if (token !== this._token) return;
        this.loading = false;
        if (error instanceof ApiError && error.status === 403) {
          this.loadError = "没有权限读取该文件";
        } else {
          this.loadError = errorMessage(error);
        }
      }
    },

    /* ---------------- 下载 / 分享 ---------------- */

    async download() {
      if (!this.itemKey) return;
      try {
        if (this.blob) {
          saveBlob(this.blob, this.displayName);
          this.setStatus("已开始下载", false);
          return;
        }
        await downloadKey(this.itemKey);
        this.setStatus("已开始下载", false);
      } catch (error) {
        this.setStatus(`下载失败：${errorMessage(error)}`, true);
      }
    },

    /** 「复制链接」复制的是分享链接（/raw 默认私有，直接分享 raw 链接对方打不开） */
    async copyShareLink() {
      if (!this.itemKey || this.sharing) return;
      this.sharing = true;
      this.setStatus("正在创建分享链接...", false);
      try {
        const share = await createShare(this.itemKey);
        const link = share.absoluteUrl || share.url;
        if (!link) {
          this.setStatus("服务端没有返回分享链接", true);
          return;
        }
        const ok = await copyTextToClipboard(link);
        if (ok) {
          this.setStatus(
            share.type === "folder"
              ? "已分享该文件夹，分享链接已复制（任何拿到链接的人都能访问）"
              : "分享链接已复制（任何拿到链接的人都能访问）",
            false
          );
        } else {
          this.setStatus(`复制失败，链接：${link}`, true);
        }
      } catch (error) {
        this.setStatus(`创建分享失败：${errorMessage(error)}`, true);
      } finally {
        this.sharing = false;
      }
    },

    /* ---------------- 图片缩放 ---------------- */

    toggleZoom() {
      this.zoom = this.zoom > 1 ? 1 : 2;
    },

    onWheel(event) {
      const delta = event && event.deltaY ? event.deltaY : 0;
      if (!delta) return;
      const next = this.zoom + (delta < 0 ? 0.25 : -0.25);
      this.zoom = Math.min(4, Math.max(1, Math.round(next * 100) / 100));
    },
  },
};
</script>

<style>
.preview-mask {
  position: fixed;
  inset: 0;
  z-index: 9997;
  background-color: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.preview-dialog {
  display: flex;
  flex-direction: column;
  width: min(1100px, 100%);
  height: min(90vh, 100%);
  background-color: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 2px 8px 24px rgba(0, 0, 0, 0.35);
}

.preview-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  background-color: #fafafa;
}

.preview-title {
  font-weight: 600;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-meta {
  color: dimgray;
  font-size: 0.8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-spacer {
  flex: 1;
}

.preview-button {
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #ddd;
  color: #0b5fa5;
  font-size: 0.85em;
}

.preview-button:hover {
  background-color: #eef4fb;
}

.preview-button:disabled {
  opacity: 0.6;
}

.preview-close {
  flex-shrink: 0;
  padding: 6px 10px;
  color: #0b5fa5;
  font-size: 0.9em;
}

.preview-status {
  flex-shrink: 0;
  padding: 6px 12px;
  background-color: #eef7f0;
  color: #1b7f3b;
  font-size: 0.8em;
  border-bottom: 1px solid #eee;
  word-break: break-word;
}

.preview-status.error {
  background-color: #fdecef;
  color: #b00020;
}

.preview-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  overflow: auto;
  background-color: #1f1f1f;
  overscroll-behavior: contain;
}

.preview-image {
  display: block;
  object-fit: contain;
  cursor: zoom-in;
}

.preview-image.zoomed {
  cursor: zoom-out;
}

.preview-video {
  max-width: 100%;
  max-height: 100%;
}

.preview-audio {
  width: min(520px, 100%);
}

.preview-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background-color: white;
}

.preview-state {
  color: #ddd;
  text-align: center;
  padding: 24px 16px;
}

.preview-state.error {
  color: #ff9d9d;
}

.preview-state-text {
  margin: 0;
  word-break: break-word;
}

.preview-state-hint {
  margin: 8px 0 0;
  font-size: 0.8em;
  color: #aaa;
}

.preview-primary {
  margin-top: 12px;
  padding: 8px 18px;
  border-radius: 6px;
  background-color: rgb(243, 128, 32);
  color: white;
  font-size: 0.9em;
}

.preview-hint {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  border-top: 1px solid #eee;
  color: dimgray;
  font-size: 0.78em;
  background-color: #fafafa;
}

@media only screen and (max-width: 768px) {
  .preview-mask {
    padding: 0;
  }

  .preview-dialog {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .preview-title {
    max-width: 100%;
  }
}
</style>
