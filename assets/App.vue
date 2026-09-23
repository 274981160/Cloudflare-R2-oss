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

    <ul class="file-list" @click="onBackgroundClick">
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
          @pointerdown="onRowPointerDown($event, folder)"
          @pointerup="onRowPointerUp"
          @pointercancel="onRowPointerUp"
          @pointerleave="cancelLongPress"
          @pointermove="onRowPointerMove($event)"
          @click.stop="onRowClick(folder, $event)"
          @dblclick.stop="openItem(folder)"
          @keydown.enter.prevent="onRowEnter($event, folder)"
          @contextmenu.prevent="openContextMenu(folder)"
        >
          <span v-if="selectionMode" class="file-check" aria-hidden="true">
            <svg viewBox="0 0 448 512" width="12" height="12">
              <path
                fill="currentColor"
                d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
              />
            </svg>
          </span>
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
          @pointerdown="onRowPointerDown($event, file)"
          @pointerup="onRowPointerUp"
          @pointercancel="onRowPointerUp"
          @pointerleave="cancelLongPress"
          @pointermove="onRowPointerMove($event)"
          @click.stop="onRowClick(file, $event)"
          @dblclick.stop="openItem(file)"
          @keydown.enter.prevent="onRowEnter($event, file)"
          @contextmenu.prevent="openContextMenu(file)"
          :data-thumb="thumbDigestOf(file)"
        >
          <span v-if="selectionMode" class="file-check" aria-hidden="true">
            <svg viewBox="0 0 448 512" width="12" height="12">
              <path
                fill="currentColor"
                d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
              />
            </svg>
          </span>
          <MimeIcon :content-type="file.contentType" :thumbnail="thumbnailSrc(file)" />
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

    <div v-if="selectedItems.length || selectionMode" class="selection-toolbar">
      <span class="selection-count" v-text="`已选 ${selectedItems.length} 项`"></span>
      <button @click="downloadSelected">下载</button>
      <button v-if="canWrite" @click="openCompressDialog(selectedItems)">压缩为zip</button>
      <button v-if="canWrite" @click="moveSelected">移动</button>
      <button v-if="canWrite" @click="copySelected">复制</button>
      <button v-if="canWrite" class="danger" @click="removeSelected">删除</button>
      <button @click="finishSelection" v-text="selectionMode ? '完成' : '取消选择'"></button>
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

    <Dialog v-model="showCompressDialog">
      <div class="form-dialog" @click.stop>
        <h3 class="dialog-title">压缩为 zip</h3>
        <input
          type="text"
          class="form-input"
          v-model="compressName"
          placeholder="压缩包名称"
          @keyup.enter="confirmCompress"
        />
        <p class="form-hint" v-text="`将打包 ${compressSourceCount} 项，保存到「${currentFolderName}」`"></p>
        <p v-if="formError" class="form-error" v-text="formError"></p>
        <div class="form-actions">
          <button type="button" class="text-button" @click="closeCompressDialog">取消</button>
          <button type="button" class="primary-button" @click="confirmCompress">压缩</button>
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
            <button @click="runAction(() => enterSelectionMode(focusedItem))"><span>多选</span></button>
          </li>
          <li>
            <button @click="runAction(() => downloadItem(focusedItem))">
              <span>下载 (zip)</span>
            </button>
          </li>
          <li>
            <button @click="runAction(() => copyShareLink(focusedItem))"><span>复制分享链接</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => openCompressDialog([focusedItem]))"><span>压缩为 zip</span></button>
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
          <li>
            <button @click="runAction(() => enterSelectionMode(focusedItem))"><span>多选</span></button>
          </li>
          <li v-if="isTextItem(focusedItem)">
            <button @click="runAction(() => openEditor(focusedItem))"><span>编辑</span></button>
          </li>
          <li>
            <button @click="runAction(() => openAsText(focusedItem))">
              <span>以文本方式打开</span>
            </button>
          </li>
          <li v-if="directDownload">
            <a :href="rawUrl(focusedItem.key)" :download="focusedItem.name">
              <span>下载</span>
            </a>
          </li>
          <li v-else>
            <button @click="runAction(() => downloadItem(focusedItem))"><span>下载</span></button>
          </li>
          <li v-if="canWrite && isZipFile(focusedItem)">
            <button @click="runAction(() => extractItem(focusedItem))"><span>在线解压</span></button>
          </li>
          <li v-if="canWrite">
            <button @click="runAction(() => openCompressDialog([focusedItem]))"><span>压缩为 zip</span></button>
          </li>
          <li>
            <button @click="runAction(() => copyShareLink(focusedItem))"><span>复制分享链接</span></button>
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

    <TextEditor
      v-model="showTextEditor"
      :item="editorItem"
      :force-text="editorForceText"
      @saved="onEditorSaved"
    ></TextEditor>

    <ApiKeys v-model="showApiKeys"></ApiKeys>

    <Shares v-model="showShares"></Shares>

    <PreviewOverlay
      v-model="showPreview"
      :item="previewItem"
      :siblings="previewSiblings"
      @select="onPreviewSelect"
    ></PreviewOverlay>

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
import TextEditor from "./TextEditor.vue";
import ApiKeys from "./ApiKeys.vue";
import Shares from "./Shares.vue";
import PreviewOverlay from "./PreviewOverlay.vue";
import {
  ApiError,
  basename,
  clearAuth,
  copyKey,
  copyTextToClipboard,
  createArchive,
  createFolder as createFolderRequest,
  createShare,
  dirname,
  downloadKey,
  downloadZip,
  duplicateName,
  errorMessage,
  extractArchive,
  formatDate,
  formatSize,
  isImageFile,
  isTextFile,
  joinKey,
  listDirectory,
  loadThumbnail,
  moveKey,
  normalizePath,
  rawUrl,
  removeKey,
  setUnauthorizedHandler,
  stripExtension,
  thumbnailDigest,
  signedDownloadUrl,
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
    TextEditor,
    ApiKeys,
    Shares,
    PreviewOverlay,
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
    showCompressDialog: false,
    compressName: "",
    compressSources: [],
    showFolderPicker: false,
    showTextEditor: false,
    showApiKeys: false,
    showShares: false,
    showPreview: false,
    previewItem: null,
    /** 缩略图摘要 → blob URL；空串表示取回失败（不再重试，回退 MIME 图标） */
    thumbnailUrls: {},
    editorItem: null,
    editorForceText: false,
    focusedItem: null,
    /** 打开右键菜单时预取的签名直链，让下载走浏览器原生下载 */
    signedUrl: "",
    signedForKey: "",
    newFolderName: "",
    renameTarget: null,
    renameName: "",
    formError: "",
    moveTargets: [],
    clipboard: [],
    selectedKeys: [],
    /**
     * 触屏多选模式：手机端「单击=打开」以后，需要一个显式模式来多选
     * （⋮ 菜单或长按菜单的「多选」进入，选完点「完成」退出）。
     * 桌面端不依赖它：单击仍然直接加/减选中项。
     */
    selectionMode: false,
    dragging: false,
    notice: "",
    noticeType: "info",
    uploadQueue: [],
    uploadDirQueue: [],
    uploadTotalCount: 0,
    uploadFinishedCount: 0,
    uploadProgress: null,
    uploadStatus: "",
    uploadErrors: [],
    uploadDirErrors: [],
    uploading: false,
  }),

  computed: {
    folderIcon: () => FOLDER_ICON,

    canWrite() {
      return this.profile.canWriteAny && this.dirCanWrite && !this.profile.readOnly;
    },

    /** 仅当账号权限含 "*"（全部目录）时才展示「API 密钥」入口 */
    manageKeys() {
      const permissions = Array.isArray(this.profile.permissions) ? this.profile.permissions : [];
      return this.profile.authenticated === true && permissions.indexOf("*") !== -1;
    },

    /** 当前目录里的图片（顺序与列表一致），供预览左右切换 */
    previewSiblings() {
      return this.visibleFiles.filter((file) =>
        isImageFile(file && file.name, file && file.contentType)
      );
    },

    compressSourceCount() {
      return Array.isArray(this.compressSources) ? this.compressSources.length : 0;
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
      // 手机端单击=打开，多选需要从这里进（桌面端也可以用来批量勾选）
      if (this.files.length || this.folders.length) items.push({ text: "多选" });
      if (this.canWrite && this.clipboard.length) items.push({ text: "粘贴" });
      if (this.manageKeys) items.push({ text: "API 密钥" });
      // 分享是普通功能，任何已登录账号都能管理自己创建的分享
      if (this.profile.authenticated) items.push({ text: "分享管理" });
      items.push({ text: this.profile.authenticated ? "退出登录" : "登录" });
      return items;
    },
  },

  watch: {
    // 列表内容或视图变化后，重新为新出现的行安排按需加载
    visibleFiles() {
      this.observeThumbnails();
    },

    view() {
      this.observeThumbnails();
    },

    focusedItem(item) {
      this.prefetchSignedUrl(item);
    },

    cwd: {
      handler() {
        this.selectedKeys = [];
        this.selectionMode = false;
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

  mounted() {
    /**
     * 触屏长按弹出菜单后，松手时浏览器会补发一次 click，它会落在菜单遮罩上
     * 把刚打开的菜单立刻关掉。这里在捕获阶段按时间窗吞掉这次 click——
     * 纯时间判断，不用任何需要手动复位的标记，不会影响后续点击。
     */
    this._onCaptureClick = (event) => {
      if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    document.addEventListener("click", this._onCaptureClick, true);

    this._thumbsLoading = new Set();
    if (typeof IntersectionObserver === "function") {
      this._thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const digest = entry.target.getAttribute("data-thumb");
            this._thumbObserver.unobserve(entry.target);
            void this.loadOneThumbnail(digest);
          }
        },
        { rootMargin: "200px 0px" }
      );
    }
  },

  beforeUnmount() {
    window.removeEventListener("popstate", this._onPopState);
    document.removeEventListener("click", this._onCaptureClick, true);
    if (this._thumbObserver) this._thumbObserver.disconnect();
    setUnauthorizedHandler(null);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this.cancelLongPress();
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
        // 缩略图改为「进入视口才加载」（见 observeThumbnails）
        this.observeThumbnails();
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

    /* ---------------- 单击语义：触屏打开，桌面选中 ---------------- */

    /**
     * 记下最后一次按下用的是什么指针。
     * 只存「类型 + 时间」，不做任何粘住的标记——上次就是粘住的标记
     * 把你多选时的第一下点击吃掉了，这里改用时间窗判断，过期自动失效。
     */
    notePointer(event) {
      if (!event) return;
      this._lastPointer = { type: event.pointerType || "mouse", time: Date.now() };
    },

    /**
     * 行按下：记下指针类型，并在触屏上启动长按计时（480ms 开操作菜单）。
     *
     * 为什么要自己计时：iOS Safari 长按不派发 contextmenu；同时单击=打开之后，
     * 长按松手时浏览器补发的那次 click 有可能把文件也打开，先开菜单能把这次
     * click 用时间窗挡掉（onRowClick 里判断 800ms）。
     * 手指移动超过 10px（滚动）或抬起即取消，不影响正常滑动。
     */
    onRowPointerDown(event, item) {
      this.notePointer(event);
      if (!event || event.pointerType === "mouse") return;
      this.cancelLongPress();
      this._pressStart = { x: event.clientX, y: event.clientY };
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = 0;
        this._pressStart = null;
        this._longPressAt = Date.now();
        this.openContextMenu(item);
      }, 480);
    },

    /**
     * 行松手：如果这次是「长按」，就在松手后的极短窗口（150ms）里吞掉浏览器
     * 补发的那一次 click——它通常会落在菜单遮罩上把菜单关掉，或误触菜单项。
     * 窗口很短，所以菜单打开后你正常点菜单项不会被影响。
     */
    onRowPointerUp() {
      if (this._longPressAt && Date.now() - this._longPressAt < 1200) {
        this._suppressClickUntil = Date.now() + 150;
      }
      this._longPressAt = 0;
      this.cancelLongPress();
    },

    onRowPointerMove(event) {
      if (!this._pressStart || !event) return;
      const movedX = Math.abs(event.clientX - this._pressStart.x);
      const movedY = Math.abs(event.clientY - this._pressStart.y);
      if (movedX > 10 || movedY > 10) this.cancelLongPress();
    },

    cancelLongPress() {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = 0;
      }
      this._pressStart = null;
    },

    /** 这一次交互是不是触屏/触控笔；拿不到指针信息时按设备能力兜底 */
    isTouchInteraction() {
      const last = this._lastPointer;
      if (last && Date.now() - last.time < 1500) {
        return last.type === "touch" || last.type === "pen";
      }
      return (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(hover: none) and (pointer: coarse)").matches
      );
    },

    /**
     * 行单击：
     * - 长按/右键刚弹过菜单（800ms 内）→ 忽略浏览器补发的那次 click，避免又打开一次
     * - 多选模式 → 勾选/取消勾选
     * - 带 Ctrl/Cmd/Shift → 保持「加选/减选」的老习惯
     * - 触屏轻触 → 打开（文件夹进入 / 文件预览）
     * - 鼠标 → 与原来完全一致：加/减选中项
     */
    onRowClick(item, event) {
      if (!item) return;
      // 兜底：菜单刚弹出的一瞬间（250ms）内忽略行点击；正常点菜单项不受影响
      if (this._menuOpenedAt && Date.now() - this._menuOpenedAt < 250) return;
      if (this.selectionMode) {
        this.toggleSelect(item);
        return;
      }
      const modifier = !!(event && (event.ctrlKey || event.metaKey || event.shiftKey));
      if (!modifier && this.isTouchInteraction()) {
        this.openItem(item);
        return;
      }
      this.toggleSelect(item);
    },

    /** 键盘回车打开当前行（只在行本身获得焦点时触发，避免和行内按钮的 Enter 打架） */
    onRowEnter(event, item) {
      if (!item) return;
      if (event && event.target !== event.currentTarget) return;
      this.openItem(item);
    },

    /** 点空白处：清空选择，并退出多选模式 */
    onBackgroundClick() {
      this.selectedKeys = [];
      this.selectionMode = false;
    },

    /** 底部工具条右侧按钮：多选模式下是「完成」，否则是原来的「取消选择」 */
    finishSelection() {
      this.selectedKeys = [];
      this.selectionMode = false;
    },

    enterSelectionMode(item) {
      this.selectionMode = true;
      if (item && !this.isSelected(item.key)) this.toggleSelect(item);
    },

    exitSelectionMode() {
      this.selectionMode = false;
      this.selectedKeys = [];
    },

    /* ---------------- 缩略图（带认证取回，见 main.mjs 的 loadThumbnail） ---------------- */

    /**
     * 取当前目录里所有文件的缩略图 blob URL。
     * 缓存由 main.mjs 维护（同一摘要只请求一次，失败也记住），这里只负责把
     * 结果落到响应式数据上；取不到就留空串，MimeIcon 会自动回退到 MIME 图标。
     */
    /** 该项的缩略图摘要（没有则空串），写进 data-thumb 供观察器读取 */
    thumbDigestOf(item) {
      return thumbnailDigest(item && item.thumbnail) || "";
    },

    /**
     * 只给「进入视口」的行加载缩略图。
     *
     * 原来进目录会把该目录所有文件的缩略图一次性并发拉下来：照片多的目录
     * 在手机上又慢又费流量。现在用 IntersectionObserver 按需加载，
     * 并保留 200px 的提前量，滚动时不会看到明显空白。
     * 不支持 IntersectionObserver 的环境退回原来的「全部加载」。
     */
    observeThumbnails() {
      if (!this._thumbObserver) {
        void this.ensureThumbnails(this.visibleFiles);
        return;
      }
      this.$nextTick(() => {
        const nodes = this.$el ? this.$el.querySelectorAll("[data-thumb]") : [];
        for (const node of nodes) {
          const digest = node.getAttribute("data-thumb");
          if (!digest) continue;
          if (this.thumbnailUrls[digest] !== undefined) continue;
          this._thumbObserver.observe(node);
        }
      });
    },

    /** 加载单个缩略图（同一摘要不会重复请求） */
    async loadOneThumbnail(digest) {
      if (!digest) return;
      if (this.thumbnailUrls[digest] !== undefined) return;
      if (this._thumbsLoading.has(digest)) return;
      this._thumbsLoading.add(digest);
      try {
        const url = await loadThumbnail(digest);
        this.thumbnailUrls = Object.assign({}, this.thumbnailUrls, {
          [digest]: url || "",
        });
      } finally {
        this._thumbsLoading.delete(digest);
      }
    },

    async ensureThumbnails(files) {
      const pending = [];
      for (const file of files || []) {
        const digest = thumbnailDigest(file && file.thumbnail);
        if (!digest) continue;
        if (this.thumbnailUrls[digest] !== undefined) continue;
        if (pending.indexOf(digest) === -1) pending.push(digest);
      }
      if (!pending.length) return;
      const results = await Promise.all(
        pending.map((digest) => loadThumbnail(digest).then((url) => ({ digest, url })))
      );
      const next = Object.assign({}, this.thumbnailUrls);
      for (const result of results) next[result.digest] = result.url || "";
      this.thumbnailUrls = next;
    },

    /** 列表里 `<img src>` 用的地址；返回空串时 MimeIcon 回退到 MIME 图标 */
    thumbnailSrc(item) {
      const digest = thumbnailDigest(item && item.thumbnail);
      if (!digest) return "";
      return this.thumbnailUrls[digest] || "";
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

    /**
     * 应用内预览：/raw/{key} 默认需要认证，新标签页带不上认证头，
     * 所以统一交给 PreviewOverlay 用 apiFetch 取回 Blob 后渲染。
     * 不能在线渲染的类型由 PreviewOverlay 直接触发下载并提示。
     */
    preview(item) {
      if (!item) return;
      if (item.type === "folder") {
        this.navigate(item.key);
        return;
      }
      this.previewItem = {
        key: item.key,
        name: item.name,
        size: item.size,
        contentType: item.contentType,
      };
      this.showPreview = true;
    },

    /* ---------------- 在线文本编辑 ---------------- */

    /** 文本类判定：MIME 类型优先，其次扩展名白名单（见 main.mjs 的 isTextFile） */
    isTextItem(item) {
      if (!item || item.type === "folder") return false;
      return isTextFile(item.name || item.key, item.contentType);
    },

    openEditor(item) {
      if (!item || item.type === "folder") return;
      this.editorItem = {
        key: item.key,
        name: item.name,
        size: item.size,
        contentType: item.contentType,
        writable: item.writable,
        thumbnail: item.thumbnail,
      };
      this.editorForceText = false;
      this.showTextEditor = true;
    },

    /** 兜底入口：任何文件都可以强行按文本打开（先确认，避免损坏内容） */
    openAsText(item) {
      if (!item || item.type === "folder") return;
      if (!window.confirm("该文件可能不是文本，强行按文本打开可能损坏内容，确定继续？")) return;
      this.editorItem = {
        key: item.key,
        name: item.name,
        size: item.size,
        contentType: item.contentType,
        writable: item.writable,
        thumbnail: item.thumbnail,
      };
      this.editorForceText = true;
      this.showTextEditor = true;
    },

    /** 预览里切到上一张/下一张：只换对象，预览层会自己重新拉取 */
    onPreviewSelect(item) {
      if (!item || !item.key) return;
      this.previewItem = item;
    },

    async onEditorSaved() {
      this.showNotice("已保存", "success");
      await this.fetchFiles();
    },

    /** 打开菜单时就把签名直链取好，点击下载时才能同步触发（浏览器手势不失效） */
    async prefetchSignedUrl(item) {
      this.signedUrl = "";
      this.signedForKey = "";
      if (!item || !item.key) return;
      try {
        const url = await signedDownloadUrl(item.key);
        if (url) {
          this.signedUrl = url;
          this.signedForKey = item.key;
        }
      } catch (error) {
        // 取不到签名就退回「取回 Blob」的方式
      }
    },

    async downloadItem(item) {
      if (!item) return;
      try {
        // 签名直链已就绪：同步点击，交给浏览器原生下载（有进度、秒弹保存框）
        if (this.signedUrl && this.signedForKey === item.key) {
          const anchor = document.createElement("a");
          anchor.href = this.signedUrl;
          if (item.name) anchor.download = item.name;
          anchor.rel = "noopener";
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          this.showNotice(`已开始下载「${item.name}」`, "success");
          return;
        }
        if (item.type === "folder") {
          // 文件夹打包：优先临时签一个 zip 直链（原生下载带进度），
          // 签名不可用再退回带进度的 XHR 取 Blob，避免「点了没反应」。
          this.showNotice(`正在打包「${item.name}」...`, "info");
          let zipUrl = "";
          if (this.signedForKey !== item.key) {
            try {
              zipUrl = (await signedDownloadUrl(item.key)) || "";
            } catch (error) {
              zipUrl = "";
            }
          }
          if (zipUrl) {
            const anchor = document.createElement("a");
            anchor.href = zipUrl;
            anchor.download = `${item.name}.zip`;
            anchor.rel = "noopener";
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            this.showNotice(`已开始打包下载「${item.name}」`, "success");
            return;
          }
          let lastPercent = -1;
          await downloadZip(item.key, {
            onProgress: (event) => {
              if (!event || !event.lengthComputable || !event.total) return;
              const percent = Math.floor((event.loaded / event.total) * 100);
              if (percent === lastPercent) return;
              lastPercent = percent;
              this.showNotice(`正在打包「${item.name}」 ${percent}%`, "info");
            },
          });
          this.showNotice(`「${item.name}」打包完成`, "success");
          return;
        }
        // 私有模式下要先带认证把文件取回来，耗时取决于文件大小，
        // 因此这里立刻给反馈并显示进度，避免看起来「点了没反应」
        this.showNotice(`正在下载「${item.name}」...`, "info");
        let lastPercent = -1;
        await downloadKey(item.key, {
          publicRead: this.directDownload,
          onProgress: (event) => {
            if (!event || !event.lengthComputable || !event.total) return;
            const percent = Math.floor((event.loaded / event.total) * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            this.showNotice(`正在下载「${item.name}」 ${percent}%`, "info");
          },
        });
        this.showNotice(`已下载「${item.name}」`, "success");
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
          await this.downloadItem(item);
        } catch (error) {
          failed++;
          console.error("下载失败", item.key, error);
        }
      }
      if (failed) this.showNotice(`有 ${failed} 个项目下载失败`, "error");
    },

    /**
     * 「复制分享链接」：/raw/{key} 默认私有，直接把 raw 地址发给别人会 401，
     * 所以先 POST /api/shares 创建（或复用）分享链接，再把绝对地址写进剪贴板。
     * 目录同样走这条流程，type 以服务端返回的为准。
     */
    async copyShareLink(item) {
      if (!item) return;
      const key = normalizePath(item.key);
      if (!key) {
        this.showNotice("根目录不能单独分享，请对具体的文件或文件夹操作", "error");
        return;
      }
      try {
        const share = await createShare(key);
        const link = share.absoluteUrl || share.url;
        if (!link) {
          this.showNotice("服务端没有返回分享链接", "error");
          return;
        }
        const ok = await copyTextToClipboard(link);
        if (!ok) {
          this.showNotice(`复制失败，链接：${link}`, "error");
          return;
        }
        if (share.type === "folder" || item.type === "folder") {
          this.showNotice("已分享该文件夹，分享链接已复制（任何拿到链接的人都能访问）", "success");
        } else {
          this.showNotice("分享链接已复制（任何拿到链接的人都能访问）", "success");
        }
      } catch (error) {
        this.showNotice(`创建分享失败：${errorMessage(error)}`, "error");
      }
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
          const collected = [].concat(...groups.map((group) => group.files));
          // 空目录拖进来会一个文件都没有，单独记下来，稍后用 MKCOL 建出来
          const emptyDirs = [].concat(...groups.map((group) => group.dirs));
          if (!collected.length && !emptyDirs.length) {
            this.showNotice("没有可上传的文件", "error");
            return;
          }
          this.uploadFiles(collected, this.cwd, emptyDirs);
        })
        .catch((error) => {
          console.error("读取拖入内容失败", error);
          this.showNotice("读取拖入内容失败", "error");
        });
    },

    /**
     * 把拖入项解析成 { files, dirs }：
     * - files：`{ file, relativePath }` 列表，支持整个文件夹
     * - dirs：整棵子树里一个文件都没有的目录（相对路径），用于补建空目录
     */
    async resolveDroppedItem(item) {
      if (item.file) return { files: [item], dirs: [] };
      const files = [];
      const dirs = [];
      await this.walkEntry(item.entry, "", files, dirs);
      return { files, dirs };
    },

    /** 递归遍历拖入项；返回该子树里是否存在文件 */
    async walkEntry(entry, prefix, output, emptyDirs) {
      if (!entry) return false;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) =>
          entry.file(resolve, reject)
        );
        output.push({ file, relativePath: prefix });
        return true;
      }
      if (!entry.isDirectory) return false;
      const directory = `${prefix}${entry.name}/`;
      const reader = entry.createReader();
      let hasFile = false;
      for (;;) {
        const batch = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (!batch || !batch.length) break;
        for (const child of batch) {
          const childHasFile = await this.walkEntry(child, directory, output, emptyDirs);
          if (childHasFile) hasFile = true;
        }
      }
      if (!hasFile && Array.isArray(emptyDirs)) {
        emptyDirs.push(directory.replace(/\/+$/, ""));
      }
      return hasFile;
    },

    onUploadClicked(inputElement) {
      if (!inputElement || !inputElement.files || !inputElement.files.length) return;
      this.uploadFiles(Array.from(inputElement.files), this.cwd);
      this.showUploadPopup = false;
      inputElement.value = "";
    },

    /**
     * 入队上传。
     * @param {File[]|{file: File, relativePath?: string}[]} fileList
     * @param {string} [basedir] 目标目录
     * @param {string[]} [emptyDirs] 需要补建的空目录（相对 basedir 的路径）
     */
    uploadFiles(fileList, basedir, emptyDirs) {
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
          // <input webkitdirectory> 选中的文件夹：webkitRelativePath 自带多级目录
          const relative = item && typeof item.webkitRelativePath === "string"
            ? item.webkitRelativePath
            : "";
          const relativeDir = relative ? dirname(relative) : "";
          return {
            basedir: relativeDir ? joinKey(directory, relativeDir) : directory,
            file: item,
          };
        });
      const dirTasks = this.normalizeEmptyDirs(emptyDirs, directory);
      if (!tasks.length && !dirTasks.length) return;
      if (tasks.length) {
        this.uploadQueue.push(...tasks);
        this.uploadTotalCount += tasks.length;
      }
      if (dirTasks.length) this.uploadDirQueue.push(...dirTasks);
      this.processUploadQueue();
    },

    /** 空目录去重并按层级从浅到深排序（父目录要先于子目录创建） */
    normalizeEmptyDirs(emptyDirs, basedir) {
      const list = Array.isArray(emptyDirs) ? emptyDirs : [];
      const seen = new Set();
      const result = [];
      for (const relative of list) {
        const key = joinKey(basedir, relative || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(key);
      }
      return result.sort(
        (left, right) =>
          left.split("/").length - right.split("/").length ||
          left.localeCompare(right)
      );
    },

    /** 上传进度里显示相对当前目录的路径（文件夹上传时能看清结构） */
    uploadDisplayPath(key) {
      const full = normalizePath(key);
      const dir = normalizePath(this.cwd);
      if (!dir) return full;
      const prefix = `${dir}/`;
      return full.indexOf(prefix) === 0 ? full.slice(prefix.length) : full;
    },

    async processUploadQueue() {
      if (this.uploading) return;
      if (!this.uploadQueue.length && !this.uploadDirQueue.length) {
        this.uploadProgress = null;
        this.uploadStatus = "";
        return;
      }
      this.uploading = true;
      let aborted = false;
      let createdDirs = 0;
      // 外层循环：上传过程中可能又有新任务入队（例如空目录阶段又拖入了文件）
      while (!aborted && (this.uploadQueue.length || this.uploadDirQueue.length)) {
        while (this.uploadQueue.length) {
          const task = this.uploadQueue.shift();
          const file = task.file;
          const key = joinKey(task.basedir, file.name);
          this.uploadStatus = `正在上传（${this.uploadFinishedCount + 1}/${this.uploadTotalCount}）：${this.uploadDisplayPath(key)}`;
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
            this.uploadErrors.push(`${this.uploadDisplayPath(key)}：${errorMessage(error)}`);
            if (error instanceof ApiError && error.status === 401) {
              this.uploadFinishedCount++;
              aborted = true;
              break;
            }
          }
          this.uploadFinishedCount++;
        }
        if (aborted) break;
        // 文件传完后父目录都已存在，再按层级把「一个文件都没有」的目录补建出来
        while (this.uploadDirQueue.length) {
          const key = this.uploadDirQueue.shift();
          this.uploadStatus = `正在创建空文件夹：${this.uploadDisplayPath(key)}`;
          try {
            await createFolderRequest(key);
            createdDirs++;
          } catch (error) {
            // 目录已存在时服务端返回 405，按成功处理
            if (error instanceof ApiError && error.status === 405) {
              createdDirs++;
              continue;
            }
            console.warn("创建空文件夹失败", key, error);
            if (error instanceof ApiError && error.status === 401) {
              aborted = true;
              break;
            }
            this.uploadDirErrors.push(`${this.uploadDisplayPath(key)}：${errorMessage(error)}`);
          }
        }
      }
      if (aborted) {
        this.uploadQueue.length = 0;
        this.uploadDirQueue.length = 0;
      }
      this.uploading = false;
      this.uploadProgress = null;
      this.uploadStatus = "";
      this.uploadTotalCount = 0;
      this.uploadFinishedCount = 0;
      const failures = this.uploadErrors.concat(this.uploadDirErrors);
      this.uploadErrors = [];
      this.uploadDirErrors = [];
      if (failures.length) {
        this.showNotice(`上传完成，但有失败项：${failures.join("；")}`, "error");
      } else if (createdDirs) {
        this.showNotice(`上传完成，并创建了 ${createdDirs} 个空文件夹`, "success");
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

    /* ---------------- 在线压缩 / 解压 ---------------- */

    isZipFile(item) {
      if (!item || item.type === "folder") return false;
      const name = item.name || "";
      return /\.zip$/i.test(name);
    },

    openCompressDialog(items) {
      const list = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!list.length) return;
      this.compressSources = list.map((item) => item.key);
      const single = list.length === 1 ? list[0] : null;
      const base = single
        ? stripExtension(single.name || "归档")
        : "归档";
      this.compressName = base || "归档";
      this.formError = "";
      this.showContextMenu = false;
      this.showCompressDialog = true;
    },

    closeCompressDialog() {
      this.showCompressDialog = false;
      this.compressSources = [];
      this.compressName = "";
      this.formError = "";
    },

    async confirmCompress() {
      const name = (this.compressName || "").trim().replace(/\.zip$/i, "");
      if (!name) {
        this.formError = "请输入压缩包名称";
        return;
      }
      if (name.includes("/")) {
        this.formError = "名称不能包含 /";
        return;
      }
      const sources = this.compressSources.slice();
      if (!sources.length) return;
      const targetKey = joinKey(this.cwd, `${name}.zip`);
      this.showCompressDialog = false;
      this.showNotice(`正在压缩 ${sources.length} 项...`, "info");
      try {
        const result = await createArchive(targetKey, sources);
        this.showNotice(`已生成 ${result.key}（${formatSize(result.size || 0)}）`, "success");
        await this.fetchFiles();
      } catch (error) {
        this.showNotice(`压缩失败：${errorMessage(error)}`, "error");
      }
    },

    async extractItem(item) {
      if (!item || item.type === "folder") return;
      if (
        !window.confirm(
          `确定把「${item.name}」解压到当前目录吗？将创建 ${stripExtension(item.name)}/ 文件夹。`
        )
      ) {
        return;
      }
      const base = stripExtension(item.name || "解压") || "解压";
      const targetDir = joinKey(this.cwd, base);
      try {
        // 先问后端目标里有没有同名文件，再让用户决定「跳过」还是「覆盖」，
        // 默认跳过，绝不静默覆盖已有文件
        this.showNotice(`正在检查「${item.name}」里的同名文件...`, "info");
        const pre = await extractArchive(item.key, targetDir, { mode: "check" });
        let mode = "skip";
        const conflictCount = Number(pre && pre.conflictCount) || 0;
        if (conflictCount > 0) {
          const preview = (pre.conflicts || []).slice(0, 5).join("、");
          const more = conflictCount > 5 ? ` 等 ${conflictCount} 个` : "";
          const overwrite = window.confirm(
            `目标文件夹里已有 ${conflictCount} 个同名文件：\n${preview}${more}\n\n` +
              `点「确定」= 用压缩包里的内容覆盖它们\n` +
              `点「取消」= 跳过这些同名文件，保留现有文件（默认）`
          );
          mode = overwrite ? "overwrite" : "skip";
        }

        this.showNotice(`正在解压「${item.name}」...`, "info");
        const result = await extractArchive(item.key, targetDir, { mode });
        const failed = Array.isArray(result.errors) ? result.errors.length : 0;
        const skipped = Number(result.skipped) || 0;
        const parts = [`解压完成，共 ${result.files || 0} 个文件`];
        if (skipped) parts.push(`跳过同名 ${skipped} 个`);
        if (failed) parts.push(`失败 ${failed} 个（${result.errors[0]}）`);
        this.showNotice(parts.join("，"), failed ? "error" : "success");
        await this.fetchFiles();
      } catch (error) {
        this.showNotice(`解压失败：${errorMessage(error)}`, "error");
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
      // 触屏长按后浏览器还会补发一次 click，记下时间让 onRowClick 忽略它
      this._menuOpenedAt = Date.now();
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
        case "多选":
          this.enterSelectionMode();
          break;
        case "粘贴":
          this.pasteFile();
          break;
        case "API 密钥":
          if (this.manageKeys) this.showApiKeys = true;
          break;
        case "分享管理":
          this.showShares = true;
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
