<template>
  <Dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <form class="login-dialog" autocomplete="on" @click.stop @submit.prevent="submit">
      <h3 class="login-title">登录</h3>
      <label class="login-field">
        <span class="login-label">用户名</span>
        <input
          type="text"
          class="login-input"
          v-model="username"
          name="username"
          autocomplete="username"
          placeholder="用户名"
        />
      </label>
      <label class="login-field">
        <span class="login-label">密码</span>
        <input
          type="password"
          class="login-input"
          v-model="password"
          name="password"
          autocomplete="current-password"
          placeholder="密码"
        />
      </label>
      <label class="login-remember">
        <input type="checkbox" v-model="remember" />
        <span>记住密码</span>
      </label>
      <p v-if="error" class="login-error" role="alert" v-text="error"></p>
      <p class="login-hint">通过 HTTP Basic 认证访问；凭据只保存在本机浏览器里。</p>
      <div class="login-actions">
        <button v-if="dismissible" type="button" class="login-text-button" @click="close">
          取消
        </button>
        <button type="submit" class="login-primary-button" :disabled="submitting">
          <span v-text="submitting ? '登录中...' : '登录'"></span>
        </button>
      </div>
    </form>
  </Dialog>
</template>

<script>
import Dialog from "./Dialog.vue";
import {
  errorMessage,
  getLastUsername,
  isRemembered,
  setCredentials,
  verifyCredentials,
} from "/assets/main.mjs";

export default {
  components: { Dialog },

  props: {
    modelValue: Boolean,
    /** 公开读模式下允许关闭登录框继续匿名浏览 */
    dismissible: {
      type: Boolean,
      default: false,
    },
  },

  emits: ["update:modelValue", "success"],

  data: () => ({
    username: "",
    password: "",
    remember: true,
    error: "",
    submitting: false,
  }),

  watch: {
    modelValue(value) {
      if (value) {
        this.error = "";
        if (!this.username) this.username = getLastUsername();
        this.remember = isRemembered() || !getLastUsername();
      } else {
        this.password = "";
      }
    },
  },

  methods: {
    onDialogToggle(value) {
      if (value) {
        this.$emit("update:modelValue", true);
        return;
      }
      if (this.dismissible) this.close();
    },

    close() {
      this.$emit("update:modelValue", false);
    },

    async submit() {
      if (this.submitting) return;
      const username = this.username.trim();
      if (!username) {
        this.error = "请输入用户名";
        return;
      }
      this.submitting = true;
      this.error = "";
      try {
        const profile = await verifyCredentials(username, this.password);
        if (!profile) {
          this.error = "用户名或密码错误";
          return;
        }
        setCredentials(username, this.password, this.remember);
        this.$emit("success", profile);
        this.close();
      } catch (error) {
        this.error = `登录失败：${errorMessage(error)}`;
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>

<style>
.login-dialog {
  padding: 16px;
  min-width: min(300px, 82vw);
  display: flex;
  flex-direction: column;
}

.login-title {
  margin: 0 0 12px;
  font-size: 1em;
}

.login-field {
  display: block;
  margin-bottom: 10px;
}

.login-label {
  display: block;
  margin-bottom: 4px;
  font-size: 0.8em;
  color: var(--fd-text-muted);
}

.login-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: inherit;
}

.login-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  color: var(--fd-text-soft);
  margin-bottom: 4px;
}

.login-error {
  margin: 8px 0 0;
  color: var(--fd-danger);
  font-size: 0.8em;
  word-break: break-word;
}

.login-hint {
  margin: 8px 0 0;
  color: var(--fd-text-muted);
  font-size: 0.75em;
}

.login-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

.login-text-button {
  color: var(--fd-primary);
  padding: 8px 8px;
  font-size: inherit;
}

.login-primary-button {
  background-color: var(--fd-accent);
  color: white;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: inherit;
}

.login-primary-button:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
