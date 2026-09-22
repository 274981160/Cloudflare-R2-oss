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
          <div v-else-if="cwd" class="fp-item" @click="goUp">
            <img :src="folderIcon" width="24" height="24" alt="" />
            <span>..</span>
          </div>
          <div v-for="folder in folders" :key="folder.key" class="fp-item" @click="enter(folder.key)">
            <img :src="folderIcon" width="24" height="24" alt="" />
            <span class="fp-name" v-text="folder.name"></span>
          </div>
          <div v-if="!error && !folders.length" class="fp-state">这个目录下没有子文件夹</div>
        </template>
      </div>

      <p class="fp-current">
        <span>目标目录：</span>
        <span v-text="displayPath"></span>
      </p>
      <p v-if="disabledReason" class="fp-warning" v-text="disabledReason"></p>

      <div class="fp-actions">
        <button type="button" class="fp-text-button" @click="close">取消</button>
        <button
          type="button"
          class="fp-primary-button"
          :disabled="!!disabledReason || busy"
          @click="confirm"
        >
          <span v-text="busy ? '处理中...' : '选择此目录'"></span>
        </button>
      </div>
    </div>
  </Dialog>
</template>

<script>
import Dialog from "./Dialog.vue";
import { basename, errorMessage, listDirectory, normalizePath } from "/assets/main.mjs";

const FOLDER_ICON =
  "https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png";

export default {
  components: { Dialog },

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
  },

  emits: ["update:modelValue", "select"],

  data: () => ({
    cwd: "",
    folders: [],
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
      if (this.disabledReason || this.busy) return;
      this.$emit("select", this.cwd);
      this.close();
    },

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
      } catch (error) {
        this.folders = [];
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

.fp-name {
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

@media only screen and (max-width: 768px) {
  .fp-dialog {
    width: 92vw;
  }

  .fp-list {
    height: 200px;
  }
}
</style>
