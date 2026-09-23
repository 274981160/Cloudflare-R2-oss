<script setup>
/**
 * 下拉菜单。
 *
 * items 每项支持：{ text, active?, disabled?, divider? }
 * - active：当前生效项（前面打个勾）
 * - disabled：置灰不可点
 * - divider：分隔线（此时忽略 text）
 */
defineProps({
  modelValue: Boolean,
  items: {
    type: Array,
    required: true,
  },
});

const emit = defineEmits(["update:modelValue", "click"]);

function onSelect(item) {
  if (!item || item.disabled || item.divider) return;
  emit("update:modelValue", false);
  emit("click", item.text);
}
</script>

<template>
  <div class="menu">
    <Transition name="fade">
      <div
        v-show="modelValue"
        class="menu-modal"
        @click="emit('update:modelValue', false)"
      ></div>
    </Transition>
    <Transition name="fade">
      <div v-show="modelValue" class="menu-content" role="menu">
        <ul>
          <template v-for="(item, index) in items" :key="index">
            <li v-if="item.divider" class="menu-divider" role="separator"></li>
            <li
              v-else
              class="menu-item"
              role="menuitem"
              :class="{ active: item.active, disabled: item.disabled }"
              :aria-disabled="item.disabled ? 'true' : 'false'"
              @click="onSelect(item)"
            >
              <span class="menu-check" aria-hidden="true">
                <svg v-if="item.active" viewBox="0 0 448 512" width="12" height="12">
                  <path
                    fill="currentColor"
                    d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
                  />
                </svg>
              </span>
              <span class="menu-text" v-text="item.text"></span>
            </li>
          </template>
        </ul>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.menu-modal {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.24);
  z-index: 1;
}

.menu-content {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 2;
  min-width: 180px;
  max-width: calc(100vw - 24px);
  max-height: min(70vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid var(--fd-border);
  border-radius: var(--fd-radius);
  background-color: var(--fd-surface);
  box-shadow: var(--fd-shadow-2);
  color: var(--fd-text);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--fd-radius-sm);
  cursor: pointer;
  font-size: 0.92em;
  white-space: nowrap;
  transition: background-color 0.15s ease;
}

.menu-item:hover {
  background-color: var(--fd-surface-2);
}

.menu-item.active {
  color: var(--fd-primary);
  font-weight: 600;
}

.menu-item.disabled {
  opacity: 0.45;
  cursor: default;
}

.menu-item.disabled:hover {
  background-color: transparent;
}

.menu-check {
  width: 12px;
  flex-shrink: 0;
  color: var(--fd-primary);
  display: inline-flex;
  align-items: center;
}

.menu-divider {
  height: 1px;
  margin: 5px 4px;
  background-color: var(--fd-border);
}
</style>
