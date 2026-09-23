<script>
/**
 * 回收站弹窗。
 *
 * 删除的文件并没有被搬走（那会很慢），而是被标记为「已回收」从各处以隐藏；
 * 所以这里能列出它们，恢复也只是去掉标记——内容一直都在。
 */
import {
  emptyTrash,
  errorMessage,
  formatSize,
  listTrash,
  purgeTrash,
  restoreTrash,
  shareTypeLabel,
} from "/assets/main.mjs";
import Dialog from "./Dialog.vue";

export default {
  components: {
    Dialog,
  },

  props: {
    modelValue: Boolean,
  },

  emits: ["update:modelValue", "changed"],

  data: () => ({
    loading: false,
    items: [],
    retentionDays: 0,
    message: "",
    messageError: false,
    busyId: "",
    emptying: false,
  }),

  watch: {
    modelValue(value) {
      if (value) this.load();
    },
  },

  methods: {
    formatSize,
    typeLabel: shareTypeLabel,

    /** 紧凑时间：2026-09-23 21:39（窄屏放得下，也不会把列撑宽） */
    formatDate(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours()
      )}:${pad(date.getMinutes())}`;
    },

    close() {
      this.$emit("update:modelValue", false);
    },

    /** 剩余保留天数（超期会被自动彻底删除） */
    remainingDays(item) {
      if (!this.retentionDays || !item.deletedAt) return "";
      const deleted = Date.parse(item.deletedAt);
      if (!Number.isFinite(deleted)) return "";
      const deadline = deleted + this.retentionDays * 24 * 60 * 60 * 1000;
      const days = Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000));
      if (days <= 0) return "即将自动清理";
      return `${days} 天后自动清理`;
    },

    async load() {
      this.loading = true;
      this.message = "";
      this.messageError = false;
      try {
        const data = await listTrash();
        this.items = data.items;
        this.retentionDays = data.retentionDays;
        if (!data.enabled) {
          this.setMessage("回收站当前已关闭（WEBDAV_TRASH=0），删除是直接删除。", true);
        }
      } catch (error) {
        this.setMessage(`加载回收站失败：${errorMessage(error)}`, true);
      } finally {
        this.loading = false;
      }
    },

    setMessage(text, isError) {
      this.message = text;
      this.messageError = Boolean(isError);
    },

    async restore(item) {
      if (!item || this.busyId) return;
      this.busyId = item.id;
      this.setMessage(`正在恢复「${item.name}」...`, false);
      try {
        const result = await restoreTrash(item.id);
        this.setMessage(
          result && result.renamed
            ? `原位置已被占用，已恢复为「${result.restored}」`
            : `已恢复到「${result.restored}」`,
          false
        );
        await this.load();
        this.$emit("changed");
      } catch (error) {
        this.setMessage(`恢复失败：${errorMessage(error)}`, true);
      } finally {
        this.busyId = "";
      }
    },

    async purge(item) {
      if (!item || this.busyId) return;
      if (
        !window.confirm(
          `彻底删除「${item.name}」吗？\n这一步不可恢复（回收站里也会消失）。`
        )
      ) {
        return;
      }
      this.busyId = item.id;
      try {
        await purgeTrash(item.id);
        this.setMessage(`已彻底删除「${item.name}」`, false);
        await this.load();
      } catch (error) {
        this.setMessage(`彻底删除失败：${errorMessage(error)}`, true);
      } finally {
        this.busyId = "";
      }
    },

    async emptyAll() {
      if (this.emptying || !this.items.length) return;
      if (
        !window.confirm(
          `清空回收站？共 ${this.items.length} 项，会被永久删除且无法恢复。`
        )
      ) {
        return;
      }
      this.emptying = true;
      try {
        const result = await emptyTrash();
        this.setMessage(`回收站已清空（${result.items || 0} 项 / ${result.objects || 0} 个对象）`, false);
        await this.load();
      } catch (error) {
        this.setMessage(`清空失败：${errorMessage(error)}`, true);
      } finally {
        this.emptying = false;
      }
    },
  },
};
</script>

<template>
  <Dialog :model-value="modelValue" @update:model-value="close">
    <div class="trash-dialog" @click.stop>
      <h3 class="trash-title">回收站</h3>
      <p class="trash-intro">
        删除的内容会先放到这里，可以随时恢复。
        <template v-if="retentionDays">
          超过 {{ retentionDays }} 天未恢复的会被自动彻底删除。
        </template>
      </p>

      <p
        v-if="message"
        class="trash-message"
        :class="{ error: messageError }"
        role="status"
        v-text="message"
      ></p>

      <div v-if="loading" class="trash-state">加载中...</div>

      <div v-else-if="!items.length" class="trash-state">回收站是空的</div>

      <div v-else class="trash-table-wrap" role="region" aria-label="回收站列表" tabindex="0">
        <table class="trash-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">原位置</th>
              <th scope="col">大小</th>
              <th scope="col">删除时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id">
              <td class="trash-name">
                <code v-text="item.name"></code>
                <span class="trash-meta" v-text="`${typeLabel(item.type)} · ${formatSize(item.size)}`"></span>
              </td>
              <td class="trash-key">
                <code v-text="item.key || '（根目录）'"></code>
                <span class="trash-meta" v-if="item.deletedBy" v-text="`由 ${item.deletedBy} 删除`"></span>
                <span class="trash-meta" v-text="`${formatDate(item.deletedAt)} · ${remainingDays(item)}`"></span>
              </td>
              <td v-text="formatSize(item.size)"></td>
              <td v-text="formatDate(item.deletedAt)"></td>
              <td class="trash-actions">
                <button
                  type="button"
                  class="trash-button"
                  :disabled="busyId === item.id"
                  @click="restore(item)"
                >
                  <span>恢复</span>
                </button>
                <button
                  type="button"
                  class="trash-button danger"
                  :disabled="busyId === item.id"
                  @click="purge(item)"
                >
                  <span>彻底删除</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="trash-footer">
        <button
          type="button"
          class="trash-button danger"
          :disabled="!items.length || emptying"
          @click="emptyAll"
        >
          <span v-text="emptying ? '清空中...' : '清空回收站'"></span>
        </button>
        <button type="button" class="trash-button" @click="load"><span>刷新</span></button>
        <button type="button" class="trash-close" @click="close"><span>关闭</span></button>
      </div>
    </div>
  </Dialog>
</template>

<style>
.trash-dialog {
  display: flex;
  flex-direction: column;
  padding: 16px;
  width: min(900px, 92vw);
  max-height: 84vh;
}

.trash-title {
  margin: 0 0 8px;
  font-size: 1em;
}

.trash-intro {
  margin: 0 0 12px;
  color: dimgray;
  font-size: 0.8em;
  line-height: 1.5;
}

.trash-message {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background-color: #eef7f0;
  color: #1b7f3b;
  font-size: 0.8em;
  word-break: break-word;
}

.trash-message.error {
  background-color: #fdecef;
  color: #b00020;
}

.trash-state {
  padding: 24px 8px;
  text-align: center;
  color: dimgray;
  font-size: 0.9em;
}

.trash-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid #eee;
  border-radius: 6px;
}

.trash-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 0.82em;
}

.trash-table th,
.trash-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #f0f0f0;
  vertical-align: top;
  word-break: break-all;
  overflow-wrap: anywhere;
}

.trash-table th {
  position: sticky;
  top: 0;
  background-color: #fafafa;
  font-weight: 600;
  white-space: nowrap;
}

.trash-table th:nth-child(3),
.trash-table td:nth-child(3),
.trash-table th:nth-child(4),
.trash-table td:nth-child(4) {
  width: 9em;
}

.trash-table th:nth-child(5),
.trash-table td:nth-child(5) {
  width: 11em;
}

.trash-name code,
.trash-key code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.trash-meta {
  display: block;
  margin-top: 3px;
  color: dimgray;
  font-size: 0.9em;
}

.trash-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.trash-button {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #ddd;
  color: #0b5fa5;
  font-size: 0.95em;
}

.trash-button:hover {
  background-color: #eef4fb;
}

.trash-button:disabled {
  opacity: 0.6;
}

.trash-button.danger {
  color: #b00020;
  border-color: #f0c9d0;
}

.trash-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.trash-close {
  padding: 6px 12px;
  color: #0b5fa5;
}

/* 窄屏：原位置列收起，改在名称下方显示，避免横向撑宽 */
@media only screen and (max-width: 768px) {
  .trash-dialog {
    width: 94vw;
    max-height: 88vh;
    padding: 12px;
  }

  .trash-table {
    font-size: 0.78em;
  }

  .trash-table th,
  .trash-table td {
    padding: 6px 8px;
  }

  .trash-table th:nth-child(3),
  .trash-table td:nth-child(3),
  .trash-table th:nth-child(4),
  .trash-table td:nth-child(4) {
    display: none;
  }

  .trash-table th:nth-child(5),
  .trash-table td:nth-child(5) {
    width: 7.6em;
  }

  .trash-table .trash-meta {
    display: block;
  }

  .trash-button {
    padding: 3px 8px;
    font-size: 0.9em;
  }
}
</style>
