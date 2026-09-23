<script setup>
/**
 * 文件夹图标（自绘内联 SVG）。
 *
 * 为什么不用 CDN 的黑色 PNG：深色主题下黑图标几乎看不见，
 * 而且每次渲染都要发一个跨域请求。内联 SVG 用 currentColor，
 * 颜色交给外层 CSS（.file-icon 的 color），深浅色都清晰。
 */
defineProps({
  size: {
    type: Number,
    default: 36,
  },
});
</script>

<template>
  <div class="file-icon tone-folder">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      :width="size"
      :height="size"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.2c.66 0 1.3.26 1.77.73l1.02 1.02c.47.47 1.1.73 1.77.73h5.24A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z"
      />
    </svg>
  </div>
</template>
