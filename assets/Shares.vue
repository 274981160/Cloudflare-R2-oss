<template>
  <Dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <div class="shares-dialog" @click.stop>
      <h3 class="shares-title">分享管理</h3>
      <p class="shares-intro">
        分享链接是唯一允许匿名读取的通道：拿到链接的人不需要登录就能访问被分享的文件或文件夹。
        同一个对象重复分享会复用已有的那条记录。
      </p>

      <p v-if="forbidden" class="shares-message error" role="alert">
        没有权限查看分享列表（需要登录，且只能管理自己创建的分享）
      </p>
      <p v-else-if="notImplemented" class="shares-message error" role="alert">
        服务端尚未实现分享接口（404）。请部署包含该接口的版本，或联系管理员。
      </p>

      <p
        v-if="listMessage"
        class="shares-message"
        :class="{ error: listMessageError }"
        role="status"
        v-text="listMessage"
      ></p>
      <p
        v-if="copyHint"
        class="shares-message"
        :class="{ error: copyHintError }"
        role="status"
        v-text="copyHint"
      ></p>

      <div v-if="loading" class="shares-state">加载中...</div>
      <div v-else-if="!shares.length" class="shares-state">还没有分享链接</div>
      <div v-else class="shares-table-wrap" aria-label="分享列表" role="region" tabindex="0">
        <table class="shares-table">
          <thead>
            <tr>
              <th scope="col">路径</th>
              <th scope="col">类型</th>
              <th scope="col">创建时间</th>
              <th scope="col">过期时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="share in shares" :key="share.token">
              <td class="shares-key">
                <code v-text="share.key || '（根目录）'"></code>
                <span v-if="share.createdBy" class="shares-by" v-text="`由 ${share.createdBy} 创建`"></span>
              </td>
              <td v-text="typeLabel(share.type)"></td>
              <td v-text="formatDate(share.createdAt) || '—'"></td>
              <td v-text="share.expiresAt ? formatDate(share.expiresAt) : '长期有效'"></td>
              <td class="shares-actions">
                <button
                  type="button"
                  class="shares-button"
                  aria-label="复制分享链接"
                  @click="copyLink(share)"
                >
                  <span>复制分享链接</span>
                </button>
                <button
                  type="button"
                  class="shares-button"
                  aria-label="打开分享链接"
                  @click="openLink(share)"
                >
                  <span>打开</span>
                </button>
                <button
                  type="button"
                  class="shares-button danger"
                  :aria-label="`吊销分享 ${share.token}`"
                  :disabled="revokingToken === share.token"
                  @click="revoke(share)"
                >
                  <span>吊销</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="shares-footer">
        <button type="button" class="shares-button" aria-label="刷新分享列表" @click="fetchShares">
          <span>刷新</span>
        </button>
        <button type="button" class="shares-close" aria-label="关闭分享管理" @click="close">
          <span>关闭</span>
        </button>
      </div>
    </div>
  </Dialog>
</template>

<script>
import Dialog from "./Dialog.vue";
import {
  ApiError,
  copyTextToClipboard,
  errorMessage,
  formatDate,
  listShares,
  revokeShare,
  shareTypeLabel,
} from "/assets/main.mjs";

/** GET /api/shares 列表、DELETE /api/shares/{token} 吊销，见 docs/API.md 第 10 节 */

export default {
  components: { Dialog },

  props: {
    modelValue: Boolean,
  },

  emits: ["update:modelValue"],

  data: () => ({
    shares: [],
    loading: false,
    listMessage: "",
    listMessageError: false,
    copyHint: "",
    copyHintError: false,
    forbidden: false,
    notImplemented: false,
    revokingToken: "",
  }),

  watch: {
    modelValue(value) {
      if (value) {
        this.copyHint = "";
        this.copyHintError = false;
        this.fetchShares();
      } else {
        this.shares = [];
        this.listMessage = "";
        this.listMessageError = false;
        this.copyHint = "";
        this.copyHintError = false;
        this.revokingToken = "";
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

    typeLabel: shareTypeLabel,

    formatDate,

    /** 分享的绝对地址：服务端没给就按当前站点补全 */
    shareLink(share) {
      if (!share) return "";
      if (share.absoluteUrl) return share.absoluteUrl;
      if (!share.url) return "";
      try {
        return new URL(share.url, window.location.origin).toString();
      } catch (error) {
        return share.url;
      }
    },

    /** 处理 401 / 403 / 404，返回 true 表示已用友好提示接管 */
    handleAccessError(error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 403) {
        this.forbidden = true;
        this.notImplemented = false;
        return true;
      }
      if (status === 404) {
        this.notImplemented = true;
        this.forbidden = false;
        return true;
      }
      return false;
    },

    async fetchShares() {
      this.loading = true;
      this.listMessage = "";
      this.listMessageError = false;
      try {
        this.shares = await listShares();
        this.forbidden = false;
        this.notImplemented = false;
      } catch (error) {
        this.shares = [];
        if (!this.handleAccessError(error)) {
          this.listMessage = `加载分享列表失败：${errorMessage(error)}`;
          this.listMessageError = true;
        }
      } finally {
        this.loading = false;
      }
    },

    async copyLink(share) {
      const link = this.shareLink(share);
      if (!link) {
        this.copyHint = "这条分享没有可用的链接";
        this.copyHintError = true;
        return;
      }
      const ok = await copyTextToClipboard(link);
      if (ok) {
        this.copyHint = "分享链接已复制（任何拿到链接的人都能访问）";
        this.copyHintError = false;
      } else {
        this.copyHint = `复制失败，链接：${link}`;
        this.copyHintError = true;
      }
    },

    /** 分享链接是公开地址，新标签页可以直接打开 */
    openLink(share) {
      const link = this.shareLink(share);
      if (!link) {
        this.copyHint = "这条分享没有可用的链接";
        this.copyHintError = true;
        return;
      }
      window.open(link, "_blank", "noopener");
    },

    async revoke(share) {
      if (!share || !share.token || this.revokingToken) return;
      const name = share.key || "（根目录）";
      if (!window.confirm(`确定要吊销「${name}」的分享链接吗？吊销后链接立即失效。`)) return;
      this.revokingToken = share.token;
      this.listMessage = "";
      this.listMessageError = false;
      try {
        await revokeShare(share.token);
        this.copyHint = "";
        this.copyHintError = false;
        await this.fetchShares();
        this.listMessage = "已吊销该分享链接";
        this.listMessageError = false;
      } catch (error) {
        if (!this.handleAccessError(error)) {
          this.listMessage = `吊销失败：${errorMessage(error)}`;
          this.listMessageError = true;
        }
      } finally {
        this.revokingToken = "";
      }
    },
  },
};
</script>

<style>
.shares-dialog {
  display: flex;
  flex-direction: column;
  padding: 16px;
  width: min(880px, 92vw);
  max-height: 84vh;
}

.shares-title {
  margin: 0 0 8px;
  font-size: 1em;
}

.shares-intro {
  margin: 0 0 12px;
  color: dimgray;
  font-size: 0.8em;
  line-height: 1.5;
}

.shares-message {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background-color: #eef7f0;
  color: #1b7f3b;
  font-size: 0.8em;
  word-break: break-word;
}

.shares-message.error {
  background-color: #fdecef;
  color: #b00020;
}

.shares-state {
  padding: 24px 8px;
  text-align: center;
  color: dimgray;
  font-size: 0.9em;
}

.shares-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid #eee;
  border-radius: 6px;
}

.shares-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82em;
}

.shares-table th,
.shares-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #f0f0f0;
  vertical-align: top;
  word-break: break-all;
}

.shares-table th {
  position: sticky;
  top: 0;
  background-color: #fafafa;
  font-weight: 600;
  white-space: nowrap;
}

.shares-key code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.shares-by {
  display: block;
  margin-top: 4px;
  color: dimgray;
  font-size: 0.9em;
}

.shares-actions {
  white-space: nowrap;
}

.shares-button {
  padding: 4px 10px;
  margin: 2px 4px 2px 0;
  border-radius: 6px;
  border: 1px solid #ddd;
  color: #0b5fa5;
  font-size: 0.95em;
}

.shares-button:hover {
  background-color: #eef4fb;
}

.shares-button:disabled {
  opacity: 0.6;
}

.shares-button.danger {
  color: #b00020;
  border-color: #f0c9d0;
}

.shares-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.shares-close {
  padding: 6px 12px;
  color: #0b5fa5;
}

@media only screen and (max-width: 768px) {
  .shares-dialog {
    width: 94vw;
    max-height: 88vh;
  }

  .shares-table th:nth-child(3),
  .shares-table td:nth-child(3),
  .shares-table th:nth-child(4),
  .shares-table td:nth-child(4) {
    display: none;
  }
}
</style>
