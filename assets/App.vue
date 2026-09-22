<template>
  <div
    class="main"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="dragging && canWrite" class="drop-overlay">
      <div class="drop-hint" v-text="`松开鼠标，上传到「${currentFolderName}」`"></div>
    </div>

    <div v-if="uploadStatus" class="upload-status">
      <span class="upload-status-text" v-text="uploadStatus"></span>
      <span v-text="uploadProgress === null ? '' : `${uploadProgress}%`"></span>
    </div>
    <progress v-if="uploadProgress !== null" :value="uploadProgress" max="100"></progress>

    <div class="app-bar">
      <input
        type="search"
        v-model="search"
        aria-label="搜索文件名"
        placeholder="搜索文件名"
      />
      <span v-if="!canWrite" class="readonly-badge" title="当前账号没有写权限">只读</span>
      <div class="menu-button">
        <button class="circle" aria-label="菜单" @click="showMenu = true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 448 512"
            width="24"
            height="24"
            style="display: block; margin: 4px"
          >
            <path
              d="M120 256c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm160 0c0 30.9-25.1 56-56 56s-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56zm104 56c-30.9 0-56-25.1-56-56s25.1-56 56-56s56 25.1 56 56s-25.1 56-56 56z"
            />
          </svg>
        </button>
        <Menu v-model="showMenu" :items="menuItems" @click="onMenuClick" />
      </div>
    </div>

    <nav class="breadcrumb" aria-label="当前路径">
      <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
        <span v-if="index > 0" class="crumb-separator">/</span>
        <button
          class="crumb"
          :class="{ current: index === breadcrumbs.length - 1 }"
          v-text="crumb.name"
          @click="navigate(crumb.path)"
        ></button>
      </template>
    </nav>

    <p v-if="loginHint" class="page-hint" v-text="loginHint"></p>

    <ul class="file-list" @click="clearSelection">
      <li v-if="cwd">
        <div class="file-item" tabindex="0" @click.stop="goUp" @contextmenu.prevent>
          <div class="file-icon">
            <img :src="folderIcon" width="36" height="36" alt="上级目录" />
          </div>
          <div class="file-body">
            <div class="file-name">..</div>
          </div>
        </div>
      </li>
      <li v-for="folder in visibleFolders" :key="folder.key">
        <div
          class="file-item"
          :class="{ selected: isSelected(folder.key) }"
          tabindex="0"
          @click.stop="toggleSelect(folder)"
          @dblclick.stop="openItem(folder)"
          @contextmenu.prevent="openContextMenu(folder)"
        >
          <div class="file-icon">
            <img :src="folderIcon" width="36" height="36" alt="文件夹" />
          </div>
          <div class="file-body">
            <div class="file-name" v-text="folder.name"></div>
            <div class="file-attr">
              <span>文件夹</span>
              <span v-if="folder.writable === false">只读</span>
            </div>
          </div>
          <button class="file-more" aria-label="更多操作" @click.stop="openContextMenu(folder)">
            <svg viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M10.5,12A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 13.5,12A1.5,1.5 0 0,1 12,13.5A1.5,1.5 0 0,1 10.5,12M10.5,16.5A1.5,1.5 0 0,1 12,15A1.5,1.5 0 0,1 13.5,16.5A1.5,1.5 0 0,1 12,18A1.5,1.5 0 0,1 10.5,16.5M10.5,7.5A1.5,1.5 0 0,1 12,6A1.5,1.5 0 0,1 13.5,7.5A1.5,1.5 0 0,1 12,9A1.5,1.5 0 0,1 10.5,7.5M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"
              ></path>
            </svg>
          </button>
        </div>
      </li>
      <li v-for="file in visibleFiles" :key="file.key">
        <div
          class="file-item"
          :class="{ selected: isSelected(file.key) }"
          tabindex="0"
          @click.stop="toggleSelect(file)"
          @dblclick.stop="openItem(file)"
          @contextmenu.prevent="openContextMenu(file)"
        >
          <MimeIcon :content-type="file.contentType" :thumbnail="file.thumbnail" />
          <div class="file-body">
            <div class="file-name" v-text="file.name"></div>
            <div class="file-attr">
              <span v-text="formatDate(file.uploaded)"></span>
              <span v-text="formatSize(file.size)"></span>
            </div>
          </div>
          <button class="file-more" aria-label="更多操作" @click.stop="openContextMenu(file)">
            <svg viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M10.5,12A1.5,1.5 0 0,1 12,10.5A1.5,1.5 0 0,1 13.5,12A1.5,1.5 0 0,1 12,13.5A1.5,1.5 0 0,1 10.5,12M10.5,16.5A1.5,1.5 0 0,1 12,15A1.5,1.5 0 0,1 13.5,16.5A1.5,1.5 0 0,1 12,18A1.5,1.5 0 0,1 10.5,16.5M10.5,7.5A1.5,1.5 0 0,1 12,6A1.5,1.5 0 0,1 13.5,7.5A1.5,1.5 0 0,1 12,9A1.5,1.5 0 0,1 10.5,7.5M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"
              ></path>
            </svg>
          </button>
        </div>
      </li>
    </ul>

    <div v-if="loading" class="page-state">
      <span>加载中...</span>
    </div>
    <div v-else-if="readError" class="page-state error">
      <span v-text="readError"></span>
      <button class="text-button" @click="reload">重试</button>
    </div>
    <div v-else-if="!visibleFiles.length && !visibleFolders.length" class="page-state">
      <span v-text="emptyText"></span>
    </div>

    <div v-if="selectedItems.length" class="selection-toolbar">
      <span class="selection-count" v-text="`已选 ${selectedItems.length} 项`"></span>
      <button @click="downloadSelected">下载</button>
      <button v-if="canWrite" @click="moveSelected">移动</button>
      <button v-if="canWrite" @click="copySelected">复制</button>
      <button v-if="canWrite" class="danger" @click="removeSelected">删除</button>
      <button @click="clearSelection">取消选择</button>
    </div>

    <button
      v-if="canWrite"
      class="upload-button circle"
      aria-label="上传"
      @click="showUploadPopup = true"
    >
      <img
        style="filter: invert(100%)"
        src="https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/upload_file/materialicons/36dp/2x/baseline_upload_file_black_36dp.png"
        alt="上传"
        width="36"
        height="36"
        @contextmenu.prevent
      />
    </button>

    <UploadPopup
      v-model="showUploadPopup"
      @upload="onUploadClicked"
      @createFolder="openNewFolderDialog"
    ></UploadPopup>

    <Dialog v-model="showNewFolderDialog">
      <div class="form-dialog" @click.stop>
        <h3 class="dialog-title">新建文件夹</h3>
        <input
          type="text"
          class="form-input"
          v-model="newFolderName"
          placeholder="文件夹名称"
          @keyup.enter="createFolder"
        />
        <p class="form-hint" v-text="`将创建在「${currentFolderName}」`"></p>
        <p v-if="formError" class="form-error" v-text="formError"></p>
        <div class="form-actions">
          <button type="button" class="text-button" @click="closeNewFolderDialog">取消</button>
          <button type="button" class="primary-button" @click="createFolder">创建</button>
        </div>
      </div>
    </Dialog>

    <Dialog v-model="showRenameDialog">
      <div class="form-dialog" @click.stop>
        <h3 class="dialog-title">重命名</h3>
        <input
          type="text"
          class="form-input"
          v-model="renameName"
          placeholder="新名称"
          @keyup.enter="confirmRename"
        />
        <p v-if="formError" class="form-error" v-text="formError"></p>
        <div class="form-actions">
          <button type="button" class="text-button" @click="closeRenameDialog">取消</button>
          <button type="button" class="primary-button" @click="confirmRename">确定</button>
        </div>
      </div>
    </Dialog>

    <Dialog v-model="showContextMenu">
      <div class="contextmenu" @click.stop>
        <div class="contextmenu-filename" v-text="focusedItem ? focusedItem.name : ''"></div>
        <ul v-if="focusedItem && focusedItem.type === 'folder'" class="contextmenu-list">
          <li>
            <button @click="runAction(() => openItem(focusedItem))"><span>打开</span></button>
          </li>
          <li>
            <button @click="runAction(() => downloadItem(focusedItem))">
              <span>下载 (zip)</span>
            </button>
          </li>
          <li>
            <button @click="runAction(() => copyLink(focusedItem))"><span>复制链接</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => renameItem(focusedItem))"><span>重命名</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => moveItem(focusedItem))"><span>移动</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => copyItem(focusedItem))"><span>复制</span></button>
          </li>
          <li v-if="canWrite">
            <button class="danger" @click="runAction(() => removeItem(focusedItem))">
              <span>删除</span>
            </button>
          </li>
        </ul>
        <ul v-else-if="focusedItem" class="contextmenu-list">
          <li>
            <button @click="runAction(() => preview(focusedItem))"><span>预览</span></button>
          </li>
          <li v-if="directDownload">
            <a :href="rawUrl(focusedItem.key)" :download="focusedItem.name">
              <span>下载</span>
            </a>
          </li>
          <li v-else>
            <button @click="runAction(() => downloadItem(focusedItem))"><span>下载</span></button>
          </li>
          <li>
            <button @click="runAction(() => copyLink(focusedItem))"><span>复制链接</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => renameItem(focusedItem))"><span>重命名</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => moveItem(focusedItem))"><span>移动</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => copyItem(focusedItem))"><span>复制</span></button>
          </li>
          <li v-if="canWrite">
            <button class="danger" @click="runAction(() => removeItem(focusedItem))">
              <span>删除</span>
            </button>
          </li>
        </ul>
      </div>
    </Dialog>

    <FolderPicker
      v-model="showFolderPicker"
      :initial-path="cwd"
      :forbidden-prefixes="moveFolders"
      :forbidden-path="moveFromDir"
      @select="onFolderPicked"
    ></FolderPicker>

    <LoginDialog
      v-model="showLoginDialog"
      :dismissible="canDismissLogin"
      @success="onLoginSuccess"
    ></LoginDialog>

    <Transition name="fade">
      <div v-if="notice" class="notice" :class="noticeType" role="status" v-text="notice"></div>
    </Transition>
  </div>
</template>

<script>
import Dialog from "./Dialog.vue";
import Menu from "./Menu.vue";
import MimeIcon from "./MimeIcon.vue";
import UploadPopup from "./UploadPopup.vue";
import LoginDialog from "./LoginDialog.vue";
import FolderPicker from "./FolderPicker.vue";
import {
  ApiError,
  basename,
  clearAuth,
  copyKey,
  copyTextToClipboard,
  createFolder as createFolderRequest,
  dirname,
  downloadKey,
  downloadZip,
  duplicateName,
  errorMessage,
  formatDate,
  formatSize,
  joinKey,
  listDirectory,
  moveKey,
  normalizePath,
  previewKind,
  rawLink,
  rawUrl,
  removeKey,
  setUnauthorizedHandler,
  uploadWithThumbnail,
  whoami as fetchWhoami,
} from "/assets/main.mjs";

const FOLDER_ICON =
  "https://cdnjs.cloudflare.com/ajax/libs/material-design-icons/4.0.0/png/file/folder/materialicons/36dp/2x/baseline_folder_black_36dp.png";

export default {
  components: {
    Dialog,
    Menu,
    MimeIcon,
    UploadPopup,
    LoginDialog,
    FolderPicker,
  },

  data: () => ({
    cwd: normalizePath(new URL(window.location).searchParams.get("p") || ""),
    files: [],
    folders: [],
    dirCanWrite: true,
    loading: false,
    readError: "",
    search: "",
    order: "name",
    initialized: false,
    profile: {
      authenticated: false,
      username: null,
      publicRead: false,
      readOnly: true,
      canWriteAny: false,
      maxUploadSize: 0,
    },
    showLoginDialog: false,
    showUploadPopup: false,
    showMenu: false,
    showContextMenu: false,
    showNewFolderDialog: false,
    showRenameDialog: false,
    showFolderPicker: false,
    focusedItem: null,
    newFolderName: "",
    renameTarget: null,
    renameName: "",
    formError: "",
    moveTargets: [],
    clipboard: [],
    selectedKeys: [],
    dragging: false,
    notice: "",
    noticeType: "info",
    uploadQueue: [],
    uploadTotalCount: 0,
    uploadFinishedCount: 0,
    uploadProgress: null,
    uploadStatus: "",
    uploadErrors: [],
    uploading: false,
  }),

  computed: {
    folderIcon: () => FOLDER_ICON,

    canWrite() {
      return this.profile.canWriteAny && this.dirCanWrite && !this.profile.readOnly;
    },

    directDownload() {
      return this.profile.publicRead === true;
    },

    canDismissLogin() {
      return this.profile.publicRead === true;
    },

    needLogin() {
      return !this.profile.authenticated && !this.profile.publicRead;
    },

    emptyText() {
      if (this.needLogin) return "请先登录后查看文件";
      if (this.search) return "没有匹配的文件";
      return "这个文件夹是空的";
    },

    loginHint() {
      if (!this.profile.authenticated && !this.profile.publicRead) return "请先登录后再浏览文件。";
      if (!this.profile.authenticated && this.profile.publicRead) return "当前为匿名浏览（仅可读）。";
      if (this.profile.authenticated && !this.canWrite) return "已登录，但当前目录不可写。";
      return "";
    },

    currentFolderName() {
      return basename(this.cwd) || "全部文件";
    },

    breadcrumbs() {
      const crumbs = [{ name: "全部文件", path: "" }];
      let accumulated = "";
      for (const segment of normalizePath(this.cwd).split("/").filter(Boolean)) {
        accumulated = accumulated ? `${accumulated}/${segment}` : segment;
        crumbs.push({ name: segment, path: accumulated });
      }
      return crumbs;
    },

    sortedFolders() {
      return this.folders
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
    },

    sortedFiles() {
      const files = this.files.slice();
      if (this.order === "size-asc") {
        files.sort((left, right) => left.size - right.size || left.name.localeCompare(right.name, "zh-Hans-CN"));
      } else if (this.order === "size-desc") {
        files.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name, "zh-Hans-CN"));
      } else {
        files.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      }
      return files;
    },

    visibleFolders() {
      const keyword = this.search.trim().toLowerCase();
      if (!keyword) return this.sortedFolders;
      return this.sortedFolders.filter((folder) => folder.name.toLowerCase().includes(keyword));
    },

    visibleFiles() {
      const keyword = this.search.trim().toLowerCase();
      if (!keyword) return this.sortedFiles;
      return this.sortedFiles.filter((file) => file.name.toLowerCase().includes(keyword));
    },

    selectedItems() {
      const all = this.folders.concat(this.files);
      return all.filter((item) => this.selectedKeys.includes(item.key));
    },

    /** 需要禁止选入的目标目录（正在移动的文件夹自身及其子目录） */
    moveFolders() {
      return this.moveTargets.filter((item) => item.type === "folder").map((item) => item.key);
    },

    /** 单目标移动时禁止选原位置（避免「移动到自己所在目录」）；根目录返回 null */
    moveFromDir() {
      if (this.moveTargets.length !== 1) return null;
      const parent = normalizePath(dirname(this.moveTargets[0].key));
      return parent ? parent : null;
    },

    allNames() {
      return this.folders.map((folder) => folder.name).concat(this.files.map((file) => file.name));
    },

    menuItems() {
      const items = [{ text: "名称A-Z" }, { text: "大小↑" }, { text: "大小↓" }];
      if (this.canWrite && this.clipboard.length) items.push({ text: "粘贴" });
      items.push({ text: this.profile.authenticated ? "退出登录" : "登录" });
      return items;
    },
  },

  watch: {
    cwd: {
      handler() {
        this.selectedKeys = [];
        this.syncLocation();
        if (this.initialized) this.fetchFiles();
      },
      immediate: true,
    },
  },

  created() {
    this._onPopState = () => {
      const target = normalizePath(new URL(window.location).searchParams.get("p") || "");
      if (target !== this.cwd) this.cwd = target;
    };
    window.addEventListener("popstate", this._onPopState);
    setUnauthorizedHandler(() => this.onUnauthorized());
    this.init();
  },

  beforeUnmount() {
    window.removeEventListener("popstate", this._onPopState);
    setUnauthorizedHandler(null);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
  },

  methods: {
    /* ---------------- 初始化与导航 ---------------- */

    async init() {
      const profile = await this.refreshWhoami();
      this.initialized = true;
      if (!profile.authenticated && !profile.publicRead) {
        // 未认证且未开启公开读：不必发必失败的请求，等登录即可
        this.loading = false;
        this.files = [];
        this.folders = [];
        this.dirCanWrite = false;
        this.readError = "";
        return;
      }
      await this.fetchFiles();
    },

    async refreshWhoami() {
      try {
        const profile = await fetchWhoami();
        this.profile = profile;
        if (!profile.authenticated && !profile.publicRead) this.showLoginDialog = true;
        return profile;
      } catch (error) {
        this.showNotice(`无法获取登录状态：${errorMessage(error)}`, "error");
        return this.profile;
      }
    },

    syncLocation() {
      const url = new URL(window.location);
      const current = url.searchParams.get("p") || "";
      if (this.cwd) {
        if (current !== this.cwd) {
          url.searchParams.set("p", this.cwd);
          window.history.pushState(null, "", url.toString());
        }
      } else if (current) {
        url.searchParams.delete("p");
        window.history.pushState(null, "", url.toString());
      }
      document.title = `${this.currentFolderName} - 文件库`;
    },

    navigate(path) {
      this.cwd = normalizePath(path);
    },

    goUp() {
      this.navigate(dirname(this.cwd));
    },

    reload() {
      this.fetchFiles();
    },

    async fetchFiles() {
      if (!this.profile.authenticated && !this.profile.publicRead) {
        this.loading = false;
        this.files = [];
        this.folders = [];
        this.dirCanWrite = false;
        this.readError = "";
        this.showLoginDialog = true;
        return;
      }
      this.loading = true;
      this.readError = "";
      try {
        const listing = await listDirectory(this.cwd);
        this.files = listing.files;
        this.folders = listing.folders;
        this.dirCanWrite = listing.canWrite && !listing.notFound;
        if (listing.notFound && this.cwd) this.readError = "目录不存在或已被删除";
      } catch (error) {
        this.files = [];
        this.folders = [];
        this.dirCanWrite = false;
        if (error instanceof ApiError && error.status === 401) {
          this.readError = "需要登录后才能查看该目录";
        } else if (error instanceof ApiError && error.status === 403) {
          this.readError = "没有权限读取该目录";
        } else {
          this.readError = errorMessage(error);
        }
      } finally {
        this.loading = false;
      }
    },

    /* ---------------- 认证 ---------------- */

    onUnauthorized() {
      this.profile = {
        authenticated: false,
        username: null,
        publicRead: false,
        readOnly: true,
        canWriteAny: false,
        maxUploadSize: this.profile.maxUploadSize,
      };
      this.showLoginDialog = true;
    },

    async onLoginSuccess(profile) {
      this.profile = profile;
      this.showLoginDialog = false;
      this.showNotice(`已登录：${profile.username || ""}`, "success");
      await this.fetchFiles();
    },

    openLoginDialog() {
      this.showLoginDialog = true;
    },

    async logout() {
      clearAuth();
      this.clipboard = [];
      this.showNotice("已退出登录", "info");
      await this.refreshWhoami();
      await this.fetchFiles();
    },

    /* ---------------- 选择 ---------------- */

    isSelected(key) {
      return this.selectedKeys.includes(key);
    },

    toggleSelect(item) {
      const index = this.selectedKeys.indexOf(item.key);
      if (index === -1) this.selectedKeys.push(item.key);
      else this.selectedKeys.splice(index, 1);
    },

    clearSelection() {
      this.selectedKeys = [];
    },

    /* ---------------- 打开 / 预览 / 下载 ---------------- */

    openItem(item) {
      if (!item) return;
      if (item.type === "folder") {
        this.navigate(item.key);
        return;
      }
      this.preview(item);
    },

    preview(item) {
      if (!item) return;
      if (previewKind(item.contentType)) {
        window.open(rawUrl(item.key), "_blank", "noopener");
        return;
      }
      this.downloadItem(item);
    },

    async downloadItem(item) {
      if (!item) return;
      try {
        if (item.type === "folder") {
          this.showNotice(`正在打包「${item.name}」...`, "info");
          await downloadZip(item.key);
          return;
        }
        await downloadKey(item.key, { publicRead: this.directDownload });
      } catch (error) {
        this.showNotice(`下载失败：${errorMessage(error)}`, "error");
      }
    },

    async downloadSelected() {
      const items = this.selectedItems.slice();
      if (!items.length) return;
      let failed = 0;
      for (const item of items) {
        try {
          if (item.type === "folder") {
            this.showNotice(`正在打包「${item.name}」...`, "info");
            await downloadZip(item.key);
          } else {
            await downloadKey(item.key, { publicRead: this.directDownload });
          }
        } catch (error) {
          failed++;
          console.error("下载失败", item.key, error);
        }
      }
      if (failed) this.showNotice(`有 ${failed} 个项目下载失败`, "error");
    },

    async copyLink(item) {
      if (!item) return;
      const ok = await copyTextToClipboard(rawLink(item.key));
      this.showNotice(ok ? "链接已复制到剪贴板" : `复制失败，链接：${rawLink(item.key)}`, ok ? "success" : "error");
    },

    /* ---------------- 上传 ---------------- */

    onDragEnter() {
      this.dragging = true;
    },

    onDragLeave(event) {
      const related = event && event.relatedTarget;
      if (related && this.$el && this.$el.contains(related)) return;
      this.dragging = false;
    },

    onDrop(event) {
      this.dragging = false;
      if (!this.canWrite) {
        this.showNotice("当前为只读模式，无法上传", "error");
        return;
      }
      const transfer = event && event.dataTransfer;
      if (!transfer) return;

      // webkitGetAsEntry 只能在事件处理期间同步取出，之后再异步遍历
      const picked = [];
      if (transfer.items && transfer.items.length) {
        for (const item of Array.from(transfer.items)) {
          if (item.kind !== "file") continue;
          const entry =
            typeof item.webkitGetAsEntry === "function"
              ? item.webkitGetAsEntry()
              : null;
          if (entry) {
            picked.push({ entry });
          } else {
            const file = item.getAsFile();
            if (file) picked.push({ file, relativePath: "" });
          }
        }
      } else if (transfer.files) {
        for (const file of Array.from(transfer.files)) {
          picked.push({ file, relativePath: "" });
        }
      }
      if (!picked.length) return;

      Promise.all(picked.map((item) => this.resolveDroppedItem(item)))
        .then((groups) => {
          const collected = [].concat(...groups);
          if (!collected.length) {
            this.showNotice("没有可上传的文件", "error");
            return;
          }
          this.uploadFiles(collected, this.cwd);
        })
        .catch((error) => {
          console.error("读取拖入内容失败", error);
          this.showNotice("读取拖入内容失败", "error");
        });
    },

    /** 把拖入项解析成 { file, relativePath } 列表，支持整个文件夹 */
    async resolveDroppedItem(item) {
      if (item.file) return [item];
      const output = [];
      await this.walkEntry(item.entry, "", output);
      return output;
    },

    async walkEntry(entry, prefix, output) {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) =>
          entry.file(resolve, reject)
        );
        output.push({ file, relativePath: prefix });
        return;
      }
      if (!entry.isDirectory) return;
      const directory = `${prefix}${entry.name}/`;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (!batch || !batch.length) break;
        for (const child of batch) await this.walkEntry(child, directory, output);
      }
    },

    onUploadClicked(inputElement) {
      if (!inputElement || !inputElement.files || !inputElement.files.length) return;
      this.uploadFiles(Array.from(inputElement.files), this.cwd);
      this.showUploadPopup = false;
      inputElement.value = "";
    },

    uploadFiles(fileList, basedir) {
      if (!this.canWrite) {
        this.showNotice("当前为只读模式，无法上传", "error");
        return;
      }
      const directory = normalizePath(basedir == null ? this.cwd : basedir);
      const tasks = Array.from(fileList || [])
        .filter(Boolean)
        .map((item) => {
          // 支持 { file, relativePath } 形式：拖入整个文件夹时保留目录结构
          if (item && item.file) {
            return {
              basedir: joinKey(directory, item.relativePath || ""),
              file: item.file,
            };
          }
          return { basedir: directory, file: item };
        });
      if (!tasks.length) return;
      this.uploadQueue.push(...tasks);
      this.uploadTotalCount += tasks.length;
      this.processUploadQueue();
    },

    async processUploadQueue() {
      if (this.uploading) return;
      if (!this.uploadQueue.length) {
        this.uploadProgress = null;
        this.uploadStatus = "";
        return;
      }
      this.uploading = true;
      while (this.uploadQueue.length) {
        const task = this.uploadQueue.shift();
        const file = task.file;
        const key = joinKey(task.basedir, file.name);
        this.uploadStatus = `正在上传（${this.uploadFinishedCount + 1}/${this.uploadTotalCount}）：${file.name}`;
        this.uploadProgress = 0;
        try {
          await uploadWithThumbnail(key, file, {
            onUploadProgress: (progress) => {
              this.uploadProgress = progress.total
                ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
                : 0;
            },
          });
        } catch (error) {
          console.error("上传失败", key, error);
          this.uploadErrors.push(`${file.name}：${errorMessage(error)}`);
          if (error instanceof ApiError && error.status === 401) {
            this.uploadFinishedCount++;
            break;
          }
        }
        this.uploadFinishedCount++;
      }
      this.uploading = false;
      this.uploadProgress = null;
      this.uploadStatus = "";
      this.uploadTotalCount = 0;
      this.uploadFinishedCount = 0;
      if (this.uploadErrors.length) {
        this.showNotice(`上传失败：${this.uploadErrors.join("；")}`, "error");
        this.uploadErrors = [];
      } else {
        this.showNotice("上传完成", "success");
      }
      await this.fetchFiles();
    },

    /* ---------------- 新建文件夹 ---------------- */

    openNewFolderDialog() {
      this.showUploadPopup = false;
      this.formError = "";
      this.newFolderName = "";
      this.showNewFolderDialog = true;
    },

    closeNewFolderDialog() {
      this.showNewFolderDialog = false;
      this.formError = "";
    },

    async createFolder() {
      const name = (this.newFolderName || "").trim();
      if (!name) {
        this.formError = "请输入文件夹名称";
        return;
      }
      if (name.includes("/")) {
        this.formError = "文件夹名称不能包含 /";
        return;
      }
      try {
        await createFolderRequest(joinKey(this.cwd, name));
        this.showNewFolderDialog = false;
        this.showNotice(`已创建文件夹「${name}」`, "success");
        await this.fetchFiles();
      } catch (error) {
        this.formError = `创建失败：${errorMessage(error)}`;
      }
    },

    /* ---------------- 重命名 / 移动 / 复制 / 删除 ---------------- */

    renameItem(item) {
      if (!item) return;
      this.renameTarget = item;
      this.renameName = item.name;
      this.formError = "";
      this.showRenameDialog = true;
    },

    closeRenameDialog() {
      this.showRenameDialog = false;
      this.renameTarget = null;
      this.formError = "";
    },

    async confirmRename() {
      const target = this.renameTarget;
      if (!target) return;
      const name = (this.renameName || "").trim();
      if (!name) {
        this.formError = "请输入新名称";
        return;
      }
      if (name.includes("/")) {
        this.formError = "名称不能包含 /";
        return;
      }
      if (name === target.name) {
        this.closeRenameDialog();
        return;
      }
      try {
        await moveKey(target.key, joinKey(dirname(target.key), name));
        this.closeRenameDialog();
        this.showNotice("重命名成功", "success");
        await this.fetchFiles();
      } catch (error) {
        this.formError = `重命名失败：${errorMessage(error)}`;
      }
    },

    moveItem(item) {
      if (!item) return;
      this.moveTargets = [item];
      this.showFolderPicker = true;
    },

    moveSelected() {
      const items = this.selectedItems.slice();
      if (!items.length) return;
      this.moveTargets = items;
      this.showFolderPicker = true;
    },

    async onFolderPicked(destination) {
      const items = this.moveTargets.slice();
      this.showFolderPicker = false;
      this.moveTargets = [];
      if (!items.length) return;
      const target = normalizePath(destination);
      const failures = [];
      let moved = 0;
      for (const item of items) {
        const nextKey = joinKey(target, item.name);
        if (nextKey === item.key) continue;
        try {
          await moveKey(item.key, nextKey);
          moved++;
        } catch (error) {
          failures.push(`${item.name}：${errorMessage(error)}`);
        }
      }
      this.selectedKeys = [];
      await this.fetchFiles();
      if (failures.length) this.showNotice(`移动失败：${failures.join("；")}`, "error");
      else if (moved) this.showNotice(`已移动到「${basename(target) || "全部文件"}」`, "success");
      else this.showNotice("目标位置与当前位置相同", "info");
    },

    copyItem(item) {
      if (!item) return;
      this.clipboard = [item.key];
      this.showNotice(`已复制「${item.name}」，可在目标目录执行「粘贴」`, "info");
    },

    copySelected() {
      const items = this.selectedItems.slice();
      if (!items.length) return;
      this.clipboard = items.map((item) => item.key);
      this.showNotice(`已复制 ${items.length} 个项目，可在目标目录执行「粘贴」`, "info");
    },

    async pasteFile() {
      if (!this.clipboard.length) {
        this.showNotice("剪贴板为空", "info");
        return;
      }
      if (!this.canWrite) {
        this.showNotice("当前为只读模式，无法粘贴", "error");
        return;
      }
      const existing = this.allNames.slice();
      const failures = [];
      let copied = 0;
      for (const source of this.clipboard) {
        const name = basename(source);
        let nextKey = joinKey(this.cwd, name);
        if (nextKey === source || existing.includes(name)) {
          const renamed = duplicateName(name, existing);
          nextKey = joinKey(this.cwd, renamed);
        }
        try {
          await copyKey(source, nextKey);
          existing.push(basename(nextKey));
          copied++;
        } catch (error) {
          failures.push(`${name}：${errorMessage(error)}`);
        }
      }
      await this.fetchFiles();
      if (failures.length) this.showNotice(`粘贴失败：${failures.join("；")}`, "error");
      else if (copied) this.showNotice("粘贴完成", "success");
    },

    async removeItem(item) {
      if (!item) return;
      const hint = item.type === "folder" ? "，文件夹内的全部内容都会被递归删除" : "";
      if (!window.confirm(`确定要删除「${item.name}」吗？${hint}`)) return;
      try {
        await removeKey(item.key);
        this.selectedKeys = this.selectedKeys.filter((key) => key !== item.key);
        this.showNotice("已删除", "success");
        await this.fetchFiles();
      } catch (error) {
        this.showNotice(`删除失败：${errorMessage(error)}`, "error");
      }
    },

    async removeSelected() {
      const items = this.selectedItems.slice();
      if (!items.length) return;
      const hasFolder = items.some((item) => item.type === "folder");
      const hint = hasFolder ? "，其中的文件夹会被递归删除" : "";
      if (!window.confirm(`确定要删除选中的 ${items.length} 个项目吗？${hint}`)) return;
      const failures = [];
      for (const item of items) {
        try {
          await removeKey(item.key);
        } catch (error) {
          failures.push(`${item.name}：${errorMessage(error)}`);
        }
      }
      this.selectedKeys = [];
      await this.fetchFiles();
      if (failures.length) this.showNotice(`删除失败：${failures.join("；")}`, "error");
      else this.showNotice(`已删除 ${items.length} 个项目`, "success");
    },

    /* ---------------- 菜单与杂项 ---------------- */

    openContextMenu(item) {
      this.focusedItem = item;
      this.showContextMenu = true;
    },

    runAction(action) {
      this.showContextMenu = false;
      this.showMenu = false;
      if (typeof action === "function") action();
    },

    onMenuClick(text) {
      switch (text) {
        case "名称A-Z":
          this.order = "name";
          break;
        case "大小↑":
          this.order = "size-asc";
          break;
        case "大小↓":
          this.order = "size-desc";
          break;
        case "粘贴":
          this.pasteFile();
          break;
        case "登录":
          this.openLoginDialog();
          break;
        case "退出登录":
          this.logout();
          break;
        default:
          break;
      }
    },

    showNotice(text, type) {
      this.notice = text;
      this.noticeType = type || "info";
      if (this._noticeTimer) clearTimeout(this._noticeTimer);
      this._noticeTimer = setTimeout(() => {
        this.notice = "";
      }, type === "error" ? 8000 : 3000);
    },

    formatSize,
    formatDate,
    rawUrl,
  },
};
</script>

<style>
.main {
  height: 100%;
  padding-bottom: 96px;
}

.app-bar {
  position: sticky;
  top: 0;
  padding: 8px;
  background-color: white;
  display: flex;
  align-items: center;
  z-index: 10;
}

.menu-button {
  display: flex;
  position: relative;
  margin-left: 4px;
}

.menu-button > button {
  transition: background-color 0.2s ease;
}

.menu-button > button:hover {
  background-color: whitesmoke;
}

.menu {
  position: absolute;
  top: 100%;
  right: 0;
}

.readonly-badge {
  flex-shrink: 0;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 10px;
  background-color: #eee;
  color: dimgray;
  font-size: 0.75em;
  white-space: nowrap;
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  padding: 0 12px 8px;
  font-size: 0.85em;
  color: #444;
}

.crumb {
  color: #0b5fa5;
  padding: 2px 4px;
  border-radius: 4px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb:hover {
  background-color: whitesmoke;
}

.crumb.current {
  color: #222;
  font-weight: 600;
}

.crumb-separator {
  color: #bbb;
  padding: 0 2px;
}

.page-hint {
  margin: 0 12px 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background-color: #fff8e6;
  color: #8a6d3b;
  font-size: 0.85em;
}

.file-body {
  flex: 1;
}

.file-more {
  flex-shrink: 0;
  color: #888;
  padding: 4px;
  margin-right: 8px;
}

.file-more svg {
  width: 24px;
  height: 24px;
  display: block;
}

.file-item.selected {
  background-color: #e8f1fb;
}

.page-state {
  margin-top: 12px;
  text-align: center;
  color: dimgray;
}

.page-state.error {
  color: #b00020;
}

.text-button {
  color: #0b5fa5;
  padding: 4px 8px;
  font-size: inherit;
}

.primary-button {
  background-color: rgb(243, 128, 32);
  color: white;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: inherit;
}

.primary-button:hover {
  filter: brightness(0.95);
}

.danger {
  color: #b00020;
}

.selection-toolbar {
  position: fixed;
  left: 12px;
  right: 76px;
  bottom: 16px;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 12px;
  background-color: rgba(32, 32, 32, 0.92);
  color: white;
  box-shadow: 2px 4px 6px rgba(0, 0, 0, 0.3);
}

.selection-toolbar button {
  color: white;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 0.85em;
}

.selection-toolbar button:hover {
  background-color: rgba(255, 255, 255, 0.15);
}

.selection-toolbar .danger {
  color: #ff9d9d;
}

.selection-count {
  font-size: 0.8em;
  color: #ddd;
  margin-right: 4px;
}

.upload-status {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  background-color: rgba(32, 32, 32, 0.86);
  color: white;
  font-size: 0.8em;
}

.upload-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background-color: rgba(243, 128, 32, 0.12);
  border: 3px dashed rgb(243, 128, 32);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.drop-hint {
  background-color: white;
  padding: 12px 20px;
  border-radius: 10px;
  box-shadow: 2px 4px 8px rgba(0, 0, 0, 0.2);
}

.notice {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 72px;
  z-index: 50;
  max-width: min(560px, 90vw);
  padding: 8px 14px;
  border-radius: 8px;
  color: white;
  background-color: rgba(32, 32, 32, 0.9);
  font-size: 0.85em;
  box-shadow: 2px 4px 8px rgba(0, 0, 0, 0.25);
  word-break: break-word;
}

.notice.error {
  background-color: #b00020;
}

.notice.success {
  background-color: #1b7f3b;
}

.form-dialog {
  padding: 16px;
  min-width: min(320px, 80vw);
}

.dialog-title {
  margin: 0 0 12px;
  font-size: 1em;
}

.form-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: inherit;
}

.form-hint {
  margin: 8px 0 0;
  color: dimgray;
  font-size: 0.8em;
}

.form-error {
  margin: 8px 0 0;
  color: #b00020;
  font-size: 0.8em;
}

.form-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.contextmenu {
  min-width: 200px;
}

.contextmenu-filename {
  border-bottom: 1px solid #eee;
}

@media only screen and (max-width: 768px) {
  .selection-toolbar {
    left: 8px;
    right: 8px;
    bottom: 72px;
  }

  .notice {
    bottom: 132px;
  }
}
</style>
