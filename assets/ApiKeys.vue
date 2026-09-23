<template>
  <Dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <div class="apikeys-dialog" @click.stop>
      <h3 class="apikeys-title">API 密钥</h3>
      <p class="apikeys-intro">
        密钥用于给脚本 / 第三方程序上传，不必交出主账号密码；密钥只在生成时明文显示一次。
      </p>

      <p v-if="forbidden" class="apikeys-notice" role="alert">
        需要主账号登录且拥有全部目录权限才能管理密钥
      </p>
      <p v-else-if="notImplemented" class="apikeys-notice" role="alert">
        服务端尚未实现 API Key 接口（404）。请部署包含该接口的版本，或联系管理员。
      </p>

      <template v-else>
        <form class="apikeys-form" @submit.prevent="create">
          <label class="apikeys-field">
            <span class="apikeys-label">备注名</span>
            <input
              type="text"
              class="apikeys-input"
              name="apikey-name"
              aria-label="密钥备注名"
              v-model="name"
              placeholder="例如：备份脚本"
              autocomplete="off"
            />
          </label>
          <label class="apikeys-field">
            <span class="apikeys-label">有效天数</span>
            <input
              type="number"
              class="apikeys-input"
              name="apikey-expires"
              aria-label="有效天数"
              v-model="expires"
              placeholder="留空为永不过期"
              min="1"
              step="1"
            />
          </label>

          <div class="apikeys-field apikeys-field-wide">
            <span class="apikeys-label">权限（授权目录，可读可写）</span>
            <div class="apikeys-perm-row">
              <button
                type="button"
                class="apikeys-pick-button"
                aria-label="选择目录"
                @click="openPicker"
              >
                <span>选择目录</span>
              </button>
              <label class="apikeys-all">
                <input
                  type="checkbox"
                  name="apikey-all-permissions"
                  aria-label="全部目录"
                  :checked="allPermissions"
                  @change="onAllChange"
                />
                <span>全部目录（*）</span>
              </label>
            </div>

            <div class="apikeys-tags" aria-label="已选权限">
              <span v-if="allPermissions" class="apikeys-tag all">
                <span class="apikeys-tag-text">*</span>
              </span>
              <span v-for="perm in permissions" :key="perm" class="apikeys-tag">
                <span class="apikeys-tag-text" v-text="perm"></span>
                <button
                  type="button"
                  class="apikeys-tag-remove"
                  :aria-label="`移除 ${perm}`"
                  @click="removePermission(perm)"
                >
                  <span>×</span>
                </button>
              </span>
              <span v-if="!permissions.length && !allPermissions" class="apikeys-tag-empty">
                未选择任何目录，留空表示全部目录
              </span>
            </div>

            <p v-if="allPermissions && permissions.length" class="apikeys-perm-hint">
              已开启「全部目录（*）」，提交时会忽略上面选择的具体目录。
            </p>

            <input
              type="text"
              class="apikeys-input apikeys-manual"
              name="apikey-permissions"
              aria-label="手动添加路径"
              v-model="manualPath"
              placeholder="手动添加还不存在的目录，回车确认，例：backup/"
              autocomplete="off"
              @keydown.enter.prevent="addManual"
            />
            <p v-if="permHint" class="apikeys-perm-hint" v-text="permHint"></p>
          </div>

          <p v-if="formError" class="apikeys-message error" role="alert" v-text="formError"></p>

          <div class="apikeys-form-actions">
            <button
              type="submit"
              class="apikeys-primary-button"
              aria-label="生成密钥"
              :disabled="creating"
            >
              <span v-text="creating ? '生成中...' : '生成密钥'"></span>
            </button>
          </div>
        </form>

        <div v-if="createdKey" class="apikeys-created" role="alert">
          <p class="apikeys-created-warn">此密钥只显示一次，请立即保存。</p>
          <div class="apikeys-key-row">
            <code class="apikeys-key" aria-label="新密钥" v-text="createdKey.key"></code>
            <button
              type="button"
              class="apikeys-copy-button"
              aria-label="复制新密钥"
              @click="copyCreatedKey"
            >
              <span>复制</span>
            </button>
          </div>
          <p v-if="copyHint" class="apikeys-copy-hint" v-text="copyHint"></p>

          <div class="apikeys-curl">
            <p class="apikeys-curl-hint">可以直接复制到终端使用的上传示例：</p>
            <pre class="apikeys-curl-code" aria-label="curl 示例" v-text="curlExample"></pre>
            <div class="apikeys-curl-actions">
              <button
                type="button"
                class="apikeys-copy-button"
                aria-label="复制 curl 示例"
                @click="copyCurl"
              >
                <span>复制示例</span>
              </button>
            </div>
            <p v-if="curlHint" class="apikeys-copy-hint" v-text="curlHint"></p>
          </div>
        </div>

        <p
          v-if="listMessage"
          class="apikeys-message"
          :class="{ error: listMessageError }"
          v-text="listMessage"
        ></p>

        <div v-if="loadingList" class="apikeys-state">加载中...</div>
        <div v-else-if="!keys.length" class="apikeys-state">还没有生成过密钥</div>
        <div v-else class="apikeys-table-wrap">
          <table class="apikeys-table">
            <thead>
              <tr>
                <th scope="col">备注名</th>
                <th scope="col">密钥提示</th>
                <th scope="col">权限</th>
                <th scope="col">创建时间</th>
                <th scope="col">最后使用</th>
                <th scope="col">过期时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in keys" :key="item.id">
                <td v-text="item.name || '（未命名）'"></td>
                <td><code class="apikeys-hint" v-text="item.hint || '—'"></code></td>
                <td v-text="formatPermissions(item.permissions)"></td>
                <td v-text="formatDate(item.createdAt) || '—'"></td>
                <td v-text="item.lastUsedAt ? formatDate(item.lastUsedAt) : '从未使用'"></td>
                <td v-text="item.expiresAt ? formatDate(item.expiresAt) : '永不过期'"></td>
                <td>
                  <button
                    type="button"
                    class="apikeys-revoke-button"
                    :aria-label="`吊销密钥 ${item.name || item.id}`"
                    :disabled="revokingId === item.id"
                    @click="revoke(item)"
                  >
                    <span>吊销</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div class="apikeys-actions">
        <button type="button" class="apikeys-refresh-button" aria-label="刷新密钥列表" @click="fetchKeys">
          <span>刷新</span>
        </button>
        <button type="button" class="apikeys-close-button" aria-label="关闭密钥管理" @click="close">
          <span>关闭</span>
        </button>
      </div>
    </div>
  </Dialog>

  <FolderPicker
    v-model="showPicker"
    multiple
    title="选择授权目录（可多选）"
    @select="onPickerSelect"
  ></FolderPicker>
</template>

<script>
import Dialog from "./Dialog.vue";
import FolderPicker from "./FolderPicker.vue";
import {
  ApiError,
  apiFetch,
  apiFetchJson,
  copyTextToClipboard,
  describeResponseError,
  errorMessage,
  formatDate,
} from "/assets/main.mjs";

/** GET /api/keys 列表、POST /api/keys 创建、DELETE /api/keys/{id} 吊销，见 docs/API.md 第 8 节 */

export default {
  components: { Dialog, FolderPicker },

  props: {
    modelValue: Boolean,
  },

  emits: ["update:modelValue"],

  data: () => ({
    keys: [],
    loadingList: false,
    listMessage: "",
    listMessageError: false,
    forbidden: false,
    notImplemented: false,
    name: "",
    /** 已选授权目录（前缀）列表 */
    permissions: [],
    /** 全部目录（*）开关：打开时忽略具体列表 */
    allPermissions: false,
    /** 手动添加还不存在的目录 */
    manualPath: "",
    permHint: "",
    expires: "",
    formError: "",
    creating: false,
    createdKey: null,
    copyHint: "",
    curlHint: "",
    showPicker: false,
    revokingId: "",
  }),

  computed: {
    /** 可直接复制的 curl 上传示例（域名取当前站点） */
    curlExample() {
      if (!this.createdKey) return "";
      const origin = (window.location && window.location.origin) || "";
      return `curl -X POST "${origin}/api/upload/${this.exampleDir}" -H "X-Api-Key: ${this.createdKey.key}" -F "file=@本地文件"`;
    },

    /** 示例里使用的目录：取第一个具体授权目录，全部权限时用 upload/ 占位 */
    exampleDir() {
      const list = this.createdKey && Array.isArray(this.createdKey.permissions)
        ? this.createdKey.permissions
        : [];
      const first = list.find((perm) => perm && perm !== "*");
      if (!first) return "upload/";
      return `${String(first).replace(/\/+$/, "")}/`;
    },
  },

  watch: {
    modelValue(value) {
      if (value) {
        this.resetForm();
        this.fetchKeys();
      } else {
        this.showPicker = false;
        this.createdKey = null;
        this.copyHint = "";
        this.curlHint = "";
        this.formError = "";
        this.permHint = "";
        this.listMessage = "";
        this.listMessageError = false;
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

    resetForm() {
      this.name = "";
      this.permissions = [];
      this.allPermissions = false;
      this.manualPath = "";
      this.permHint = "";
      this.expires = "";
      this.formError = "";
      this.copyHint = "";
      this.curlHint = "";
      this.createdKey = null;
      this.revokingId = "";
      this.showPicker = false;
    },

    /* ---------------- 权限选择 ---------------- */

    openPicker() {
      this.showPicker = true;
    },

    /** FolderPicker 多选结果：合并进标签（去重，保留原有顺序） */
    onPickerSelect(keys) {
      const picked = Array.isArray(keys) ? keys : [keys];
      let added = 0;
      for (const raw of picked) {
        const value = this.normalizePermission(raw);
        if (!value || this.permissions.indexOf(value) !== -1) continue;
        this.permissions.push(value);
        added++;
      }
      this.permHint = added ? `已添加 ${added} 项授权目录` : "所选目录已在列表中";
    },

    normalizePermission(value) {
      return String(value == null ? "" : value)
        .trim()
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
    },

    removePermission(perm) {
      // 按值移除：避免批量点击时索引失效
      const index = this.permissions.indexOf(perm);
      if (index !== -1) this.permissions.splice(index, 1);
      this.permHint = "";
    },

    onAllChange(event) {
      this.allPermissions = !!(event && event.target && event.target.checked);
      this.permHint = this.allPermissions ? "已选择全部目录（*），无需再选具体目录" : "";
    },

    /** 手动添加：支持逗号分隔，回车确认 */
    addManual() {
      const raw = String(this.manualPath || "");
      const parts = raw.split(",");
      let added = 0;
      let invalid = 0;
      for (const part of parts) {
        if (!part.trim()) continue;
        const value = this.normalizePermission(part);
        if (!value || value === "*") {
          invalid++;
          continue;
        }
        if (this.permissions.indexOf(value) !== -1) continue;
        this.permissions.push(value);
        added++;
      }
      if (!added && !invalid) {
        this.permHint = "请输入要授权的目录，例如 backup/";
        return;
      }
      this.manualPath = "";
      if (invalid) this.permHint = "「*」请用上面的「全部目录（*）」开关选择";
      else this.permHint = `已添加 ${added} 项授权目录`;
    },

    /* ---------------- 列表 / 创建 / 吊销 ---------------- */

    /** 处理 401/403/404，返回 true 表示已经用友好提示接管 */
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

    async fetchKeys() {
      this.loadingList = true;
      this.listMessage = "";
      this.listMessageError = false;
      try {
        const data = await apiFetchJson("/api/keys");
        const list = data && Array.isArray(data.keys) ? data.keys : [];
        this.keys = list;
        this.forbidden = false;
        this.notImplemented = false;
      } catch (error) {
        this.keys = [];
        if (!this.handleAccessError(error)) {
          this.listMessage = `加载密钥列表失败：${errorMessage(error)}`;
          this.listMessageError = true;
        }
      } finally {
        this.loadingList = false;
      }
    },

    async create() {
      const name = (this.name || "").trim();
      if (!name) {
        this.formError = "请填写密钥备注名";
        return;
      }
      let expiresInDays = null;
      const rawExpires = String(this.expires == null ? "" : this.expires).trim();
      if (rawExpires) {
        const parsed = Number(rawExpires);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          this.formError = "有效天数必须是正整数";
          return;
        }
        expiresInDays = parsed;
      }
      this.creating = true;
      this.formError = "";
      this.copyHint = "";
      this.curlHint = "";
      this.createdKey = null;
      try {
        const body = { name };
        if (this.allPermissions) {
          // 全部权限：不要再同时传具体前缀
          body.permissions = "*";
        } else if (this.permissions.length) {
          body.permissions = this.permissions.join(",");
        }
        if (expiresInDays !== null) body.expiresInDays = expiresInDays;
        const data = await apiFetchJson("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const key = data && data.key ? String(data.key) : "";
        if (!key) {
          this.formError = "服务端没有返回新密钥，请检查后端实现";
          return;
        }
        const granted = data && Array.isArray(data.permissions)
          ? data.permissions
          : this.allPermissions
            ? ["*"]
            : this.permissions.slice();
        this.createdKey = { key, name: (data && data.name) || name, permissions: granted };
        this.curlHint = granted.indexOf("*") !== -1
          ? "该密钥拥有全部目录权限，示例里的 upload/ 可替换为任意目录。"
          : "";
        this.name = "";
        this.expires = "";
        this.permHint = "";
        await this.fetchKeys();
      } catch (error) {
        if (!this.handleAccessError(error)) {
          this.formError = `生成失败：${errorMessage(error)}`;
        }
      } finally {
        this.creating = false;
      }
    },

    async revoke(item) {
      if (!item || !item.id) return;
      const label = item.name || item.id;
      if (!window.confirm(`确定要吊销「${label}」吗？使用该密钥的脚本会立即失效。`)) return;
      const url = `/api/keys/${encodeURIComponent(item.id)}`;
      this.revokingId = item.id;
      this.listMessage = "";
      this.listMessageError = false;
      try {
        const response = await apiFetch(url, { method: "DELETE" });
        if (!response.ok) {
          throw new ApiError(await describeResponseError(response), response.status, url);
        }
        if (this.createdKey && this.createdKey.key.indexOf(item.id) !== -1) {
          this.createdKey = null;
          this.copyHint = "";
          this.curlHint = "";
        }
        await this.fetchKeys();
        this.listMessage = `已吊销「${label}」`;
        this.listMessageError = false;
      } catch (error) {
        if (!this.handleAccessError(error)) {
          this.listMessage = `吊销失败：${errorMessage(error)}`;
          this.listMessageError = true;
        }
      } finally {
        this.revokingId = "";
      }
    },

    async copyCreatedKey() {
      const text = this.createdKey && this.createdKey.key ? this.createdKey.key : "";
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      this.copyHint = ok ? "已复制到剪贴板" : "复制失败，请手动选中密钥后复制";
    },

    async copyCurl() {
      const text = this.curlExample;
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      this.curlHint = ok ? "示例已复制到剪贴板" : "复制失败，请手动选中示例后复制";
    },

    formatPermissions(value) {
      if (!Array.isArray(value) || !value.length) return "全部";
      if (value.includes("*")) return "全部（*）";
      return value.join("、");
    },

    formatDate,
  },
};
</script>

<style>
.apikeys-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  width: min(720px, 88vw);
  max-height: min(84vh, 720px);
  overflow: auto;
}

.apikeys-title {
  margin: 0;
  font-size: 1em;
}

.apikeys-intro {
  margin: 0;
  color: var(--fd-text-muted);
  font-size: 0.8em;
}

.apikeys-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: var(--fd-danger-soft);
  color: var(--fd-danger);
  font-size: 0.85em;
}

.apikeys-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--fd-border);
}

.apikeys-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 160px;
  min-width: 0;
}

.apikeys-field-wide {
  flex: 1 1 100%;
}

.apikeys-label {
  color: var(--fd-text-muted);
  font-size: 0.75em;
}

.apikeys-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: inherit;
}

.apikeys-perm-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.apikeys-pick-button {
  padding: 6px 14px;
  border-radius: 6px;
  background-color: var(--fd-accent);
  color: white;
  font-size: 0.85em;
}

.apikeys-pick-button:hover {
  filter: brightness(0.95);
}

.apikeys-all {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fd-text-soft);
  font-size: 0.85em;
  cursor: pointer;
}

.apikeys-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px dashed #ddd;
  border-radius: 6px;
  background-color: var(--fd-surface-2);
}

.apikeys-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: 999px;
  background-color: #e8f1fb;
  color: var(--fd-primary);
  font-size: 0.8em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  max-width: 100%;
}

.apikeys-tag.all {
  background-color: var(--fd-accent-soft);
  color: var(--fd-accent-strong);
  padding: 3px 10px;
}

.apikeys-tag-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.apikeys-tag-remove {
  flex-shrink: 0;
  color: inherit;
  opacity: 0.7;
  padding: 0 4px;
  font-size: 1.1em;
  line-height: 1;
}

.apikeys-tag-remove:hover {
  opacity: 1;
}

.apikeys-tag-empty {
  color: var(--fd-text-muted);
  font-size: 0.8em;
}

.apikeys-perm-hint {
  margin: 0;
  color: var(--fd-accent-strong);
  font-size: 0.8em;
}

.apikeys-manual {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  font-size: 0.85em;
}

.apikeys-form-actions {
  flex: 0 0 auto;
}

.apikeys-primary-button {
  padding: 8px 18px;
  border-radius: 6px;
  background-color: var(--fd-accent);
  color: white;
  font-size: 0.9em;
}

.apikeys-primary-button:hover {
  filter: brightness(0.95);
}

.apikeys-primary-button:disabled {
  opacity: 0.6;
}

.apikeys-created {
  padding: 10px 12px;
  border-radius: 8px;
  background-color: #fff8e6;
  border: 1px solid #f0d9a8;
}

.apikeys-created-warn {
  margin: 0 0 8px;
  color: var(--fd-accent-strong);
  font-size: 0.85em;
  font-weight: 600;
}

.apikeys-key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.apikeys-key {
  flex: 1 1 240px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: var(--fd-surface);
  border: 1px solid #e0cfa6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  font-size: 0.85em;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
}

.apikeys-copy-button {
  padding: 6px 14px;
  border-radius: 6px;
  background-color: var(--fd-accent);
  color: white;
  font-size: 0.85em;
}

.apikeys-copy-hint {
  margin: 8px 0 0;
  color: var(--fd-accent-strong);
  font-size: 0.8em;
}

.apikeys-curl {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #e0cfa6;
}

.apikeys-curl-hint {
  margin: 0 0 6px;
  color: var(--fd-accent-strong);
  font-size: 0.8em;
}

.apikeys-curl-code {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: var(--fd-surface);
  border: 1px solid #e0cfa6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  font-size: 0.8em;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
}

.apikeys-curl-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

.apikeys-message {
  margin: 0;
  color: var(--fd-success);
  font-size: 0.85em;
}

.apikeys-message.error {
  color: var(--fd-danger);
}

.apikeys-state {
  padding: 12px 0;
  color: var(--fd-text-muted);
  font-size: 0.85em;
  text-align: center;
}

.apikeys-table-wrap {
  overflow-x: auto;
}

.apikeys-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8em;
  white-space: nowrap;
}

.apikeys-table th,
.apikeys-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--fd-border);
}

.apikeys-table th {
  color: var(--fd-text-muted);
  font-weight: 600;
}

.apikeys-hint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  user-select: text;
  -webkit-user-select: text;
}

.apikeys-revoke-button {
  color: var(--fd-danger);
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 1em;
}

.apikeys-revoke-button:hover {
  background-color: var(--fd-danger-soft);
}

.apikeys-revoke-button:disabled {
  opacity: 0.5;
}

.apikeys-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.apikeys-refresh-button {
  color: var(--fd-primary);
  padding: 8px;
  font-size: 0.9em;
}

.apikeys-close-button {
  padding: 8px 18px;
  border-radius: 6px;
  background-color: var(--fd-accent);
  color: white;
  font-size: 0.9em;
}

@media only screen and (max-width: 768px) {
  .apikeys-dialog {
    width: 94vw;
    max-height: 86vh;
    padding: 12px;
  }
}
</style>
