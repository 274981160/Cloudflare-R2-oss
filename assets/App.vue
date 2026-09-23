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
      <button
        class="circle icon-button"
        :class="{ active: selectionMode }"
        aria-label="多选"
        title="多选（也可长按文件后选「多选」）"
        @click="selectionMode ? exitSelectionMode() : enterSelectionMode()"
      >
        <svg viewBox="0 0 448 512" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
          />
        </svg>
      </button>
      <div class="menu-button">
        <button class="circle icon-button" aria-label="菜单" @click="showMenu = true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 448 512"
            width="22"
            height="22"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
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

    <ul
      class="file-list"
      :class="`view-${view}`"
      role="listbox"
      aria-label="文件列表"
      :aria-multiselectable="true"
      tabindex="0"
      @click="onBackgroundClick"
      @keydown="onListKeydown"
    >
      <li v-if="cwd" role="presentation">
        <div class="file-item" @click.stop="goUp" @contextmenu.prevent>
          <div class="file-icon">
            <FolderIcon :size="iconSize" />
          </div>
          <div class="file-body">
            <div class="file-name">..</div>
            <div class="file-attr"><span>返回上一级</span></div>
          </div>
        </div>
      </li>
      <li v-for="(folder, index) in visibleFolders" :key="folder.key" role="presentation">
        <div
          class="file-item"
          role="option"
          :aria-selected="isSelected(folder.key)"
          :aria-label="`文件夹 ${folder.name}`"
          :class="{ selected: isSelected(folder.key), focused: isFocused(folder) }"
          @pointerdown="onItemPointerDown($event, folder, index)"
          @pointerup="cancelLongPress"
          @pointercancel="cancelLongPress"
          @pointerleave="cancelLongPress"
          @click.stop="onItemActivate(folder, $event)"
          @dblclick.stop="openItem(folder)"
          @contextmenu.prevent="openContextMenu(folder)"
        >
          <span v-if="showCheckboxes" class="file-check" aria-hidden="true">
            <svg viewBox="0 0 448 512" width="12" height="12">
              <path
                fill="currentColor"
                d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
              />
            </svg>
          </span>
          <div class="file-icon">
            <FolderIcon :size="iconSize" />
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
      <li v-for="(file, index) in visibleFiles" :key="file.key" role="presentation">
        <div
          class="file-item"
          role="option"
          :aria-selected="isSelected(file.key)"
          :aria-label="`文件 ${file.name}`"
          :class="{ selected: isSelected(file.key), focused: isFocused(file) }"
          @pointerdown="onItemPointerDown($event, file, visibleFolders.length + index)"
          @pointerup="cancelLongPress"
          @pointercancel="cancelLongPress"
          @pointerleave="cancelLongPress"
          @click.stop="onItemActivate(file, $event)"
          @dblclick.stop="openItem(file)"
          @contextmenu.prevent="openContextMenu(file)"
        >
          <span v-if="showCheckboxes" class="file-check" aria-hidden="true">
            <svg viewBox="0 0 448 512" width="12" height="12">
              <path
                fill="currentColor"
                d="M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z"
              />
            </svg>
          </span>
          <MimeIcon
            :content-type="file.contentType"
            :thumbnail="thumbnailSrc(file)"
            :size="iconSize"
          />
          <div class="file-body">
            <div class="file-name" v-text="file.name"></div>
            <div class="file-attr">
              <span class="file-date" v-text="formatDate(file.uploaded)"></span>
              <span class="file-size" v-text="formatSize(file.size)"></span>
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
      <span class="page-spinner" aria-hidden="true"></span>
      <span>加载中...</span>
    </div>
    <div v-else-if="readError" class="page-state error">
      <span v-text="readError"></span>
      <button class="text-button" @click="reload">重试</button>
    </div>
    <div v-else-if="!visibleFiles.length && !visibleFolders.length" class="page-state empty">
      <svg viewBox="0 0 512 512" width="56" height="56" aria-hidden="true">
        <path
          fill="currentColor"
          d="M512 416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96C0 60.7 28.7 32 64 32H181.5c17 0 33.3 6.7 45.3 18.7l26.5 26.5c12 12 28.3 18.7 45.3 18.7H448c35.3 0 64 28.7 64 64V416z"
        />
      </svg>
      <span v-text="emptyText"></span>
      <button v-if="canWrite && !search" class="primary-button" @click="showUploadPopup = true">
        上传文件
      </button>
    </div>

    <div v-if="selectedItems.length || selectionMode" class="selection-toolbar">
      <span class="selection-count" v-text="`已选 ${selectedItems.length} 项`"></span>
      <button @click="toggleSelectAll">
        <span v-text="allSelected ? '取消全选' : '全选'"></span>
      </button>
      <button v-if="selectedItems.length" @click="downloadSelected">下载</button>
      <button v-if="canWrite && selectedItems.length" @click="openCompressDialog(selectedItems)">
        压缩为zip
      </button>
      <button v-if="canWrite && selectedItems.length" @click="moveSelected">移动</button>
      <button v-if="canWrite && selectedItems.length" @click="copySelected">复制</button>
      <button v-if="canWrite && selectedItems.length" class="danger" @click="removeSelected">
        删除
      </button>
      <button @click="exitSelectionMode">完成</button>
    </div>

    <button
      v-if="canWrite"
      class="upload-button circle"
      aria-label="上传"
      @click="showUploadPopup = true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="26"
        height="26"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        @contextmenu.prevent
      >
        <path d="M12 16V4" />
        <path d="M7.5 8.5 12 4l4.5 4.5" />
        <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
      </svg>
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

    <PreviewOverlay v-model="showPreview" :item="previewItem"></PreviewOverlay>

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
import FolderIcon from "./FolderIcon.vue";
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
  isTextFile,
  joinKey,
  listDirectory,
  loadPreference,
  loadThumbnail,
  moveKey,
  normalizePath,
  rawUrl,
  removeKey,
  savePreference,
  setUnauthorizedHandler,
  stripExtension,
  thumbnailDigest,
  signedDownloadUrl,
  uploadWithThumbnail,
  whoami as fetchWhoami,
} from "/assets/main.mjs";

export default {
  components: {
    Dialog,
    FolderIcon,
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
     * 多选模式：触屏下「单击=打开」，所以要有一个显式模式来多选
     * （⋮ 菜单 / 长按菜单的「多选」进入，选完点「完成」退出）。
     */
    selectionMode: false,
    /** 键盘导航当前聚焦项（对应 orderedItems 的下标，-1 表示无） */
    focusedIndex: -1,
    /** 视图：list（一行一项）/ grid（卡片网格） */
    view: "list",
    /**
     * 单击是「打开」还是「选中」。
     * 默认按设备推断：触屏（无 hover + 粗指针）= 打开，桌面 = 选中；
     * 用户可在 ⋮ 菜单里改，改动会记住。
     */
    tapToOpen: false,
    /** 主题：auto | light | dark */
    theme: "auto",
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
    canWrite() {
      return this.profile.canWriteAny && this.dirCanWrite && !this.profile.readOnly;
    },

    /** 仅当账号权限含 "*"（全部目录）时才展示「API 密钥」入口 */
    manageKeys() {
      const permissions = Array.isArray(this.profile.permissions) ? this.profile.permissions : [];
      return this.profile.authenticated === true && permissions.indexOf("*") !== -1;
    },

    compressSourceCount() {
      return Array.isArray(this.compressSources) ? this.compressSources.length : 0;
    },

    /** 列表里可见项的顺序（文件夹在前），用于键盘导航与范围选择 */
    orderedItems() {
      return this.visibleFolders.concat(this.visibleFiles);
    },

    /** 是否显示勾选圈：多选模式，或已有选中项 */
    showCheckboxes() {
      return this.selectionMode || this.selectedKeys.length > 0;
    },

    /** 图标尺寸随视图变化（网格视图用大图标/缩略图） */
    iconSize() {
      return this.view === "grid" ? 52 : 36;
    },

    allSelected() {
      const items = this.orderedItems;
      return items.length > 0 && items.every((item) => this.isSelected(item.key));
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
      const items = [];
      // 排序
      items.push({ text: "名称 A-Z", active: this.order === "name" });
      items.push({ text: "大小 小→大", active: this.order === "size-asc" });
      items.push({ text: "大小 大→小", active: this.order === "size-desc" });
      items.push({ divider: true });
      // 视图与交互习惯（都记在本机）
      items.push({ text: "网格视图", active: this.view === "grid" });
      items.push({ text: "列表视图", active: this.view === "list" });
      items.push({
        text: this.tapToOpen ? "单击：打开（当前）" : "单击：打开",
        active: this.tapToOpen,
      });
      items.push({
        text: this.tapToOpen ? "单击：选中" : "单击：选中（当前）",
        active: !this.tapToOpen,
      });
      items.push({ divider: true });
      items.push({ text: "主题：跟随系统", active: this.theme === "auto" });
      items.push({ text: "主题：浅色", active: this.theme === "light" });
      items.push({ text: "主题：深色", active: this.theme === "dark" });
      items.push({ divider: true });
      items.push({ text: "多选", disabled: this.orderedItems.length === 0 });
      if (this.canWrite && this.clipboard.length) items.push({ text: "粘贴" });
      if (this.manageKeys) items.push({ text: "API 密钥" });
      // 分享是普通功能，任何已登录账号都能管理自己创建的分享
      if (this.profile.authenticated) items.push({ text: "分享管理" });
      items.push({ text: this.profile.authenticated ? "退出登录" : "登录" });
      return items;
    },
  },

  watch: {
    focusedItem(item) {
      this.prefetchSignedUrl(item);
    },

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
    this.loadPreferences();
    this._onPopState = () => {
      const target = normalizePath(new URL(window.location).searchParams.get("p") || "");
      if (target !== this.cwd) this.cwd = target;
    };
    window.addEventListener("popstate", this._onPopState);
    setUnauthorizedHandler(() => this.onUnauthorized());
    this.init();
  },

  mounted() {
    // 捕获阶段吞掉「长按后补发的那次 click」，避免刚弹出的菜单被立刻关闭
    this._onCaptureClick = (event) => {
      if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    document.addEventListener("click", this._onCaptureClick, true);
  },

  beforeUnmount() {
    window.removeEventListener("popstate", this._onPopState);
    document.removeEventListener("click", this._onCaptureClick, true);
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
        this.ensureThumbnails(listing.files);
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

    /* ---------------- 交互模型：单击/双击/长按/多选/键盘 ---------------- */

    /**
     * 单击（轻触）的语义，按设备习惯自适应：
     * - 多选模式：勾选/取消勾选
     * - 按住 Ctrl/Cmd：加选；按住 Shift：范围选择（桌面习惯）
     * - tapToOpen（触屏默认）：直接打开文件夹 / 预览文件
     * - 否则（桌面默认）：只选中，双击才打开
     */
    onItemActivate(item, event) {
      if (!item) return;
      // 长按已经弹出了操作菜单，紧随其后的 click 不应再「打开」
      if (this._longPressFired) {
        this._longPressFired = false;
        return;
      }
      this.focusList();
      if (this.selectionMode) {
        this.toggleSelect(item);
        return;
      }
      const modifier = !!(event && (event.ctrlKey || event.metaKey || event.shiftKey));
      if (modifier) {
        if (event.shiftKey) this.selectRange(item);
        else this.toggleSelect(item);
        return;
      }
      if (this.tapToOpen) {
        this.openItem(item);
        return;
      }
      this.selectedKeys = [item.key];
      this.focusedIndex = this.orderedItems.findIndex((entry) => entry.key === item.key);
    },

    /** 让文件列表容器拿到焦点（键盘导航需要） */
    focusList() {
      this.$nextTick(() => {
        const list = this.$el ? this.$el.querySelector(".file-list") : null;
        if (list && typeof list.focus === "function") {
          try {
            list.focus({ preventScroll: true });
          } catch (error) {
            /* 忽略 */
          }
        }
      });
    },

    /** 多选模式下点空白处：退出（清空并关闭多选） */
    onBackgroundClick() {
      if (this.selectedKeys.length) this.selectedKeys = [];
      if (this.selectionMode) this.selectionMode = false;
      this.focusedIndex = -1;
    },

    /** Shift+单击：从上次选中项到当前项整段选中 */
    selectRange(item) {
      const items = this.orderedItems;
      const index = items.findIndex((entry) => entry.key === item.key);
      if (index < 0) return;
      const anchorKey = this.selectedKeys[this.selectedKeys.length - 1];
      const anchor = anchorKey ? items.findIndex((entry) => entry.key === anchorKey) : -1;
      if (anchor < 0) {
        this.selectedKeys = [item.key];
        return;
      }
      const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
      const keys = items.slice(from, to + 1).map((entry) => entry.key);
      this.selectedKeys = Array.from(new Set(this.selectedKeys.concat(keys)));
      this.focusedIndex = index;
    },

    /** 进入多选模式（可选：顺带选中当前项） */
    enterSelectionMode(item) {
      this.selectionMode = true;
      if (item && !this.isSelected(item.key)) this.toggleSelect(item);
    },

    exitSelectionMode() {
      this.selectionMode = false;
      this.selectedKeys = [];
      this.focusedIndex = -1;
    },

    toggleSelectAll() {
      if (this.allSelected) {
        this.selectedKeys = [];
        return;
      }
      this.selectedKeys = this.orderedItems.map((item) => item.key);
    },

    isFocused(item) {
      if (this.focusedIndex < 0 || !item) return false;
      const items = this.orderedItems;
      return items[this.focusedIndex] ? items[this.focusedIndex].key === item.key : false;
    },

    /** 桌面键盘导航：方向键移动、回车打开、空格勾选、Esc 退出、Home/End 跳首尾 */
    onListKeydown(event) {
      if (!event) return;
      const items = this.orderedItems;
      if (!items.length) return;
      const key = event.key;
      const move = (delta) => {
        event.preventDefault();
        const current = this.focusedIndex;
        const next = Math.min(
          items.length - 1,
          Math.max(0, current < 0 ? (delta > 0 ? 0 : items.length - 1) : current + delta)
        );
        this.focusedIndex = next;
        const target = items[next];
        if (target) this.selectedKeys = [target.key];
        this.scrollItemIntoView(target);
      };

      if (key === "ArrowDown" || key === "ArrowRight") return move(1);
      if (key === "ArrowUp" || key === "ArrowLeft") return move(-1);
      if (key === "Home") return move(-items.length);
      if (key === "End") return move(items.length);
      if (key === "Enter") {
        const target = items[this.focusedIndex];
        if (target) {
          event.preventDefault();
          this.openItem(target);
        }
        return;
      }
      if (key === " " || key === "Spacebar") {
        const target = items[this.focusedIndex];
        if (target) {
          event.preventDefault();
          this.toggleSelect(target);
        }
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        if (this.selectionMode || this.selectedKeys.length) this.exitSelectionMode();
        else this.search = "";
        return;
      }
      if ((key === "a" || key === "A") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.selectionMode = true;
        this.selectedKeys = items.map((item) => item.key);
      }
    },

    scrollItemIntoView(item) {
      if (!item) return;
      this.$nextTick(() => {
        const nodes = this.$el ? this.$el.querySelectorAll(".file-item[role=option]") : [];
        const index = this.orderedItems.findIndex((entry) => entry.key === item.key);
        const node = nodes && nodes[index];
        if (node && typeof node.scrollIntoView === "function") {
          node.scrollIntoView({ block: "nearest" });
        }
      });
    },

    /* ---------------- 长按：触屏打开右键菜单 ---------------- */

    /**
     * 触屏长按（480ms）打开操作菜单；手指移动超过阈值或抬起则取消，
     * 不影响滚动。iOS Safari 不派发 contextmenu，这里用计时器兜底。
     */
    onItemPointerDown(event, item, index) {
      if (!event) return;
      this._pointerType = event.pointerType || "mouse";
      this._longPressFired = false;
      if (index !== undefined && index >= 0) this.focusedIndex = index;
      if (event.pointerType === "mouse") return;
      this.cancelLongPress();
      this._pressStart = { x: event.clientX, y: event.clientY };
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = 0;
        this._longPressFired = true;
        // 触摸结束后浏览器还会补发一次 click，不吞掉会立刻把刚弹出的菜单关掉
        this._suppressClickUntil = Date.now() + 700;
        this.openContextMenu(item);
      }, 480);
    },

    cancelLongPress() {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = 0;
      }
      this._pressStart = null;
    },

    /* ---------------- 偏好设置（本地记住） ---------------- */

    loadPreferences() {
      // 触屏（无 hover + 粗指针）默认「单击打开」，桌面默认「单击选中」
      const touchLike =
        typeof window !== "undefined" && typeof window.matchMedia === "function"
          ? window.matchMedia("(hover: none) and (pointer: coarse)").matches
          : false;
      this.tapToOpen = loadPreference("tapToOpen", touchLike) === true;
      this.view = loadPreference("view", "list") === "grid" ? "grid" : "list";
      const theme = loadPreference("theme", "auto");
      this.theme = ["auto", "light", "dark"].includes(theme) ? theme : "auto";
      const order = loadPreference("order", "name");
      if (["name", "size-asc", "size-desc"].includes(order)) this.order = order;
      this.applyTheme();
    },

    applyTheme() {
      if (typeof document === "undefined") return;
      document.documentElement.setAttribute("data-theme", this.theme);
    },

    setView(view) {
      this.view = view === "grid" ? "grid" : "list";
      savePreference("view", this.view);
    },

    setTapToOpen(value) {
      const next = value !== false;
      if (next === this.tapToOpen) return;
      this.tapToOpen = next;
      savePreference("tapToOpen", this.tapToOpen);
      this.showNotice(
        this.tapToOpen ? "已切换为：单击打开" : "已切换为：单击选中，双击打开",
        "success"
      );
    },

    setTheme(theme) {
      this.theme = ["auto", "light", "dark"].includes(theme) ? theme : "auto";
      savePreference("theme", this.theme);
      this.applyTheme();
    },

    /* ---------------- 缩略图（带认证取回，见 main.mjs 的 loadThumbnail） ---------------- */

    /**
     * 取当前目录里所有文件的缩略图 blob URL。
     * 缓存由 main.mjs 维护（同一摘要只请求一次，失败也记住），这里只负责把
     * 结果落到响应式数据上；取不到就留空串，MimeIcon 会自动回退到 MIME 图标。
     */
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
      this.showNotice(`正在解压「${item.name}」...`, "info");
      try {
        const result = await extractArchive(item.key, targetDir);
        const failed = Array.isArray(result.errors) ? result.errors.length : 0;
        if (failed) {
          this.showNotice(`解压完成但有 ${failed} 项失败：${result.errors[0]}`, "error");
        } else {
          this.showNotice(`解压完成，共 ${result.files || 0} 个文件`, "success");
        }
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
    },

    runAction(action) {
      this.showContextMenu = false;
      this.showMenu = false;
      if (typeof action === "function") action();
    },

    onMenuClick(text) {
      switch (text) {
        case "名称 A-Z":
          this.order = "name";
          savePreference("order", this.order);
          break;
        case "大小 小→大":
          this.order = "size-asc";
          savePreference("order", this.order);
          break;
        case "大小 大→小":
          this.order = "size-desc";
          savePreference("order", this.order);
          break;
        case "网格视图":
          this.setView("grid");
          break;
        case "列表视图":
          this.setView("list");
          break;
        case "单击：打开":
        case "单击：打开（当前）":
          this.setTapToOpen(true);
          break;
        case "单击：选中":
        case "单击：选中（当前）":
          this.setTapToOpen(false);
          break;
        case "主题：跟随系统":
          this.setTheme("auto");
          break;
        case "主题：浅色":
          this.setTheme("light");
          break;
        case "主题：深色":
          this.setTheme("dark");
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
/* 说明：文件行、列表/网格视图、图标等基础样式在 assets/main.css；
   这里只放应用外壳（工具栏、面包屑、提示、弹窗、选择条等）的样式。 */

.main {
  height: 100%;
  padding-bottom: 96px;
}

/* ---------------- 顶部工具栏 ---------------- */

.app-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background-color: var(--fd-surface);
  border-bottom: 1px solid var(--fd-border);
}

@supports (backdrop-filter: blur(12px)) {
  .app-bar {
    background-color: color-mix(in srgb, var(--fd-surface) 86%, transparent);
    backdrop-filter: saturate(180%) blur(12px);
  }
}

.app-bar input[type="search"] {
  flex: 1;
}

.icon-button {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--fd-text-soft);
  transition: background-color 0.15s ease, color 0.15s ease;
}

.icon-button:hover {
  background-color: var(--fd-surface-2);
  color: var(--fd-text);
}

.icon-button.active {
  background-color: var(--fd-primary-soft);
  color: var(--fd-primary);
}

.menu-button {
  display: flex;
  position: relative;
}

.menu {
  position: absolute;
  top: 100%;
  right: 0;
}

.readonly-badge {
  flex-shrink: 0;
  padding: 3px 9px;
  border-radius: 999px;
  background-color: var(--fd-surface-3);
  color: var(--fd-text-muted);
  font-size: 0.72em;
  white-space: nowrap;
}

/* ---------------- 面包屑 ---------------- */

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  font-size: 0.85em;
  color: var(--fd-text-soft);
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
  background-color: var(--fd-bg);
}

.breadcrumb::-webkit-scrollbar {
  display: none;
}

.crumb {
  color: var(--fd-primary);
  padding: 3px 7px;
  border-radius: 999px;
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background-color 0.15s ease;
}

.crumb:hover {
  background-color: var(--fd-surface-2);
}

.crumb.current {
  color: var(--fd-text);
  font-weight: 600;
  background-color: var(--fd-surface-3);
}

.crumb-separator {
  color: var(--fd-border-strong);
  padding: 0 1px;
}

.page-hint {
  margin: 0 12px 8px;
  padding: 8px 12px;
  border-radius: var(--fd-radius-sm);
  background-color: var(--fd-accent-soft);
  color: var(--fd-accent-strong);
  font-size: 0.82em;
}

/* ---------------- 页面状态（加载/错误/空） ---------------- */

.page-state {
  margin: 36px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  color: var(--fd-text-muted);
}

.page-state.error {
  color: var(--fd-danger);
}

.page-state.empty svg {
  color: var(--fd-border-strong);
}

.page-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--fd-border);
  border-top-color: var(--fd-primary);
  border-radius: 50%;
  animation: fd-spin 0.8s linear infinite;
}

@keyframes fd-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .page-spinner {
    animation-duration: 2s;
  }
}

/* ---------------- 按钮 ---------------- */

.text-button {
  color: var(--fd-primary);
  padding: 6px 10px;
  border-radius: var(--fd-radius-sm);
  font-size: inherit;
  transition: background-color 0.15s ease;
}

.text-button:hover {
  background-color: var(--fd-primary-soft);
}

.primary-button {
  background-color: var(--fd-accent);
  color: #fff;
  border-radius: var(--fd-radius-sm);
  padding: 9px 18px;
  font-size: inherit;
  box-shadow: var(--fd-shadow-1);
  transition: filter 0.15s ease;
}

.primary-button:hover {
  filter: brightness(0.95);
}

.danger {
  color: var(--fd-danger);
}

/* ---------------- 底部选择工具条 ---------------- */

.selection-toolbar {
  position: fixed;
  left: 12px;
  right: 76px;
  bottom: 20px;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--fd-radius-lg);
  background-color: rgba(28, 30, 34, 0.94);
  color: #fff;
  box-shadow: var(--fd-shadow-2);
  backdrop-filter: blur(8px);
}

.selection-toolbar button {
  color: inherit;
  padding: 7px 10px;
  border-radius: var(--fd-radius-sm);
  font-size: 0.82em;
  transition: background-color 0.15s ease;
}

.selection-toolbar button:hover {
  background-color: rgba(255, 255, 255, 0.16);
}

.selection-toolbar .danger {
  color: #ff9d9d;
}

.selection-count {
  font-size: 0.78em;
  color: #d6d8dd;
  margin-right: 6px;
  white-space: nowrap;
}

@media only screen and (max-width: 480px) {
  .selection-toolbar {
    left: 8px;
    right: 70px;
    gap: 0;
  }

  .selection-toolbar button {
    padding: 7px 8px;
    font-size: 0.78em;
  }
}

/* ---------------- 上传状态与拖放提示 ---------------- */

.upload-status {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 30;
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--fd-radius);
  background-color: rgba(28, 30, 34, 0.92);
  color: #fff;
  font-size: 0.82em;
  box-shadow: var(--fd-shadow-2);
}

.upload-status-text {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(11, 95, 165, 0.18);
  border: 2px dashed var(--fd-primary);
}

.drop-hint {
  padding: 14px 20px;
  border-radius: var(--fd-radius);
  background-color: var(--fd-surface);
  color: var(--fd-text);
  font-size: 0.9em;
  box-shadow: var(--fd-shadow-2);
}

/* ---------------- 轻提示 ---------------- */

.notice {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 50;
  max-width: min(560px, 88vw);
  padding: 10px 16px;
  border-radius: 999px;
  background-color: rgba(28, 30, 34, 0.94);
  color: #fff;
  font-size: 0.85em;
  text-align: center;
  word-break: break-word;
  box-shadow: var(--fd-shadow-2);
}

.notice.error {
  background-color: #b3261e;
}

.notice.success {
  background-color: #1b7f3b;
}

/* ---------------- 表单弹窗 ---------------- */

.form-dialog {
  padding: 18px;
  min-width: min(360px, 86vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
  background-color: var(--fd-surface);
  color: var(--fd-text);
  border-radius: var(--fd-radius-lg);
}

.dialog-title {
  margin: 0;
  font-size: 1.05em;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--fd-border-strong);
  border-radius: var(--fd-radius-sm);
  background-color: var(--fd-surface);
  color: var(--fd-text);
  font: inherit;
}

.form-input:focus {
  outline: none;
  border-color: var(--fd-primary);
  box-shadow: 0 0 0 3px var(--fd-primary-soft);
}

.form-hint {
  margin: 0;
  color: var(--fd-text-muted);
  font-size: 0.8em;
}

.form-error {
  margin: 0;
  color: var(--fd-danger);
  font-size: 0.82em;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

/* ---------------- 右键 / 长按菜单 ---------------- */

.contextmenu {
  min-width: min(280px, 86vw);
  padding: 6px;
  background-color: var(--fd-surface);
  color: var(--fd-text);
  border-radius: var(--fd-radius);
  box-shadow: var(--fd-shadow-2);
}

.contextmenu-filename {
  padding: 10px 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--fd-border);
  margin-bottom: 4px;
}
</style>
