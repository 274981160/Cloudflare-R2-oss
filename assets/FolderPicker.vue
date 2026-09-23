<template>
  <Dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <div class="fp-dialog" @click.stop>
      <h3 class="fp-title" v-text="title"></h3>

      <nav class="fp-breadcrumb" aria-label="目标路径">
        <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
          <span v-if="index > 0" class="fp-separator">/</span>
          <button
            type="button"
            class="fp-crumb"
            :class="{ current: index === breadcrumbs.length - 1 }"
            v-text="crumb.name"
            @click="enter(crumb.path)"
          ></button>
        </template>
      </nav>

      <div class="fp-list">
        <div v-if="loading" class="fp-state">加载中...</div>
        <template v-else>
          <div v-if="error" class="fp-state error" v-text="error"></div>
          <template v-else>
            <!-- 多选模式：可以把「当前目录」本身作为授权前缀 -->
            <div
              v-if="multiple && cwd"
              class="fp-item fp-selectable"
              :class="{ selected: isSelected(cwd) }"
              @click="toggle(cwd)"
            >
              <input
                type="checkbox"
                class="fp-check"
                aria-label="选择当前目录"
                :checked="isSelected(cwd)"
                @click.stop="toggle(cwd)"
              />
              <span class="fp-name" v-text="`当前目录：${displayPath}`"></span>
            </div>

            <div v-if="cwd" class="fp-item" @click="goUp">
              <img :src="folderIcon" width="24" height="24" alt="" />
              <span>..</span>
            </div>

            <div
              v-for="folder in folders"
              :key="folder.key"
              class="fp-item"
              :class="{ 'fp-selectable': multiple, selected: multiple && isSelected(folder.key) }"
              @click="multiple ? toggle(folder.key) : enter(folder.key)"
            >
              <input
                v-if="multiple"
                type="checkbox"
                class="fp-check"
                :aria-label="`选择目录 ${folder.name}`"
                :checked="isSelected(folder.key)"
                @click.stop="toggle(folder.key)"
              />
              <img :src="folderIcon" width="24" height="24" alt="" />
              <span class="fp-name" v-text="folder.name"></span>
              <button
                v-if="multiple"
                type="button"
                class="fp-enter"
                :aria-label="`进入 ${folder.name}`"
                @click.stop="enter(folder.key)"
              >
                <span>进入</span>
              </button>
            </div>

            <template v-if="multiple">
              <div
                v-for="file in files"
                :key="file.key"
                class="fp-item fp-selectable"
                :class="{ selected: isSelected(file.key) }"
                @click="toggle(file.key)"
              >
                <input
                  type="checkbox"
                  class="fp-check"
                  :aria-label="`选择文件 ${file.name}`"
                  :checked="isSelected(file.key)"
                  @click.stop="toggle(file.key)"
                />
                <span class="fp-icon">
                  <MimeIcon :content-type="file.contentType" :thumbnail="file.thumbnail" :size="18" />
                </span>
                <span class="fp-name" v-text="file.name"></span>
              </div>
            </template>

            <div v-if="isEmpty" class="fp-state" v-text="emptyText"></div>
          </template>
        </template>
      </div>

      <p v-if="!multiple" class="fp-current">
        <span>目标目录：</span>
        <span v-text="displayPath"></span>
      </p>
      <p v-else class="fp-current" aria-live="polite" v-text="selectedSummary"></p>
      <p v-if="!multiple && disabledReason" class="fp-warning" v-text="disabledReason"></p>

      <div class="fp-actions">
        <button type="button" class="fp-text-button" @click="close">取消</button>
        <button
          type="button"
          class="fp-primary-button"
          :aria-label="multiple ? '确定选择' : '选择此目录'"
          :disabled="confirmDisabled"
          @click="confirm"
        >
          <span v-text="confirmText"></span>
        </button>
      </div>
    </div>
  </Dialog>
</template>

<script>
import Dialog from "./Dialog.vue";
import MimeIcon from "./MimeIcon.vue";
import { basename, errorMessage, listDirectory, normalizePath } from "/assets/main.mjs";

const FOLDER_ICON =
  "https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png";

export default {
  components: { Dialog, MimeIcon },

  props: {
    modelValue: Boolean,
    /** 打开时定位到的目录 */
    initialPath: {
      type: String,
      default: "",
    },
    /** 不允许选入的前缀（正在移动的文件夹自身及其子目录） */
    forbiddenPrefixes: {
      type: Array,
      default: () => [],
    },
    /** 不允许选入的目录（与原位置相同的情况），null 表示无限制 */
    forbiddenPath: {
      type: String,
      default: null,
    },
    title: {
      type: String,
      default: "选择目标文件夹",
    },
    busy: {
      type: Boolean,
      default: false,
    },
    /** 多选模式：目录与文件都带勾选框，确定时 emit 选中的 key 数组 */
    multiple: {
      type: Boolean,
      default: false,
    },
  },

  emits: ["update:modelValue", "select"],

  data: () => ({
    cwd: "",
    folders: [],
    files: [],
    selected: [],
    loading: false,
    error: "",
  }),

  computed: {
    folderIcon: () => FOLDER_ICON,

    breadcrumbs() {
      const crumbs = [{ name: "全部文件", path: "" }];
      let accumulated = "";
      for (const segment of normalizePath(this.cwd).split("/").filter(Boolean)) {
        accumulated = accumulated ? `${accumulated}/${segment}` : segment;
        crumbs.push({ name: segment, path: accumulated });
      }
      return crumbs;
    },

    displayPath() {
      return this.cwd || "全部文件（根目录）";
    },

    isEmpty() {
      if (this.folders.length) return false;
      if (this.multiple && this.files.length) return false;
      return true;
    },

    emptyText() {
      return this.multiple ? "这个目录下没有内容" : "这个目录下没有子文件夹";
    },

    selectedSummary() {
      if (!this.selected.length) return "未选择任何目录或文件";
      return `已选 ${this.selected.length} 项：${this.selected.join("、")}`;
    },

    confirmDisabled() {
      if (this.busy) return true;
      if (this.multiple) return this.selected.length === 0;
      return !!this.disabledReason;
    },

    confirmText() {
      if (!this.multiple) return this.busy ? "处理中..." : "选择此目录";
      return this.selected.length ? `确定（已选 ${this.selected.length}）` : "确定";
    },

    disabledReason() {
      const target = normalizePath(this.cwd);
      for (const prefix of this.forbiddenPrefixes || []) {
        const normalized = normalizePath(prefix);
        if (!normalized) continue;
        if (target === normalized || target.startsWith(`${normalized}/`)) {
          return `不能移动到「${basename(normalized)}」自身或其子目录`;
        }
      }
      if (this.forbiddenPath !== null && this.forbiddenPath !== undefined) {
        if (normalizePath(this.forbiddenPath) === target) return "目标目录与当前位置相同";
      }
      return "";
    },
  },

  watch: {
    modelValue(value) {
      if (value) {
        this.cwd = normalizePath(this.initialPath);
        this.selected = [];
        this.load();
      }
    },
  },

  methods: {
    onDialogToggle(value) {
      if (value) {
        this.$emit("update:modelValue", true);
        return;
      }
      this.close();
    },

    close() {
      this.$emit("update:modelValue", false);
    },

    confirm() {
      if (this.confirmDisabled) return;
      if (this.multiple) {
        this.$emit("select", this.selected.slice());
        this.close();
        return;
      }
      this.$emit("select", this.cwd);
      this.close();
    },

    /* ---------------- 多选 ---------------- */

    isSelected(key) {
      const value = normalizePath(key);
      if (!value) return false;
      return this.selected.indexOf(value) !== -1;
    },

    toggle(key) {
      const value = normalizePath(key);
      if (!value) return;
      const index = this.selected.indexOf(value);
      if (index === -1) this.selected.push(value);
      else this.selected.splice(index, 1);
    },

    /* ---------------- 导航与加载 ---------------- */

    enter(path) {
      this.cwd = normalizePath(path);
      this.load();
    },

    goUp() {
      const index = this.cwd.lastIndexOf("/");
      this.enter(index === -1 ? "" : this.cwd.slice(0, index));
    },

    async load() {
      this.loading = true;
      this.error = "";
      try {
        const listing = await listDirectory(this.cwd);
        this.folders = listing.folders;
        this.files = listing.files;
      } catch (error) {
        this.folders = [];
        this.files = [];
        this.error = `无法读取目录：${errorMessage(error)}`;
      } finally {
        this.loading = false;
      }
    },
  },
};
</script>

<style>
.fp-dialog {
  padding: 16px;
  width: min(480px, 88vw);
  display: flex;
  flex-direction: column;
}

.fp-title {
  margin: 0 0 8px;
  font-size: 1em;
}

.fp-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  font-size: 0.8em;
  margin-bottom: 8px;
}

.fp-crumb {
  color: #0b5fa5;
  padding: 2px 4px;
  border-radius: 4px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-crumb.current {
  color: #222;
  font-weight: 600;
}

.fp-separator {
  color: #bbb;
  padding: 0 2px;
}

.fp-list {
  height: 240px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 4px;
}

.fp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.fp-item:hover {
  background-color: whitesmoke;
}

.fp-item.selected {
  background-color: #e8f1fb;
}

.fp-check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin: 0;
}

.fp-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.fp-icon .file-icon {
  width: 18px;
  height: 18px;
}

.fp-enter {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 6px;
  color: #0b5fa5;
  font-size: 0.8em;
}

.fp-enter:hover {
  background-color: #eef4fb;
}

.fp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-state {
  padding: 12px;
  text-align: center;
  color: dimgray;
  font-size: 0.85em;
}

.fp-state.error {
  color: #b00020;
}

.fp-current {
  margin: 8px 0 0;
  font-size: 0.8em;
  color: #444;
  word-break: break-all;
}

.fp-warning {
  margin: 6px 0 0;
  font-size: 0.8em;
  color: #b00020;
}

.fp-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.fp-text-button {
  color: #0b5fa5;
  padding: 8px;
  font-size: inherit;
}

.fp-primary-button {
  background-color: rgb(243, 128, 32);
  color: white;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: inherit;
}

.fp-primary-button:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 多选用法下要盖在其它弹窗（例如 API 密钥弹窗）之上 */
.dialog-mask:has(.fp-dialog) {
  z-index: 9999;
}

@media only screen and (max-width: 768px) {
  .fp-dialog {
    width: 92vw;
  }

  .fp-list {
    height: 200px;
  }
}

/* 触摸设备：面包屑原来只有 ~20px 高，很难点中 */
@media only screen and (max-width: 768px) {
  .fp-crumb {
    padding: 9px 6px;
    max-width: 45vw;
  }

  .fp-breadcrumb {
    padding: 4px 8px 8px;
  }
}
</style>
