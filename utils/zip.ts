/**
 * 极简流式 ZIP 写入器（store 模式，不压缩）。
 *
 * 为什么自己写：打包下载只需要「把若干 R2 对象按目录结构串成一个 zip」，
 * 用 store 模式不需要压缩算法，代码量很小；而不引入第三方依赖可以让
 * Cloudflare Pages 在没有构建步骤、没有 npm 安装的情况下也能正常打包
 * Functions——依赖解析失败会导致整个后端构建失败，代价太大。
 *
 * 限制：不支持 ZIP64，单文件与总大小都必须小于 4GB（由 WEBDAV_MAX_ZIP_SIZE 兜底）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32Of(crc: number, chunk: Uint8Array): number {
  let value = crc;
  for (let i = 0; i < chunk.length; i++) {
    value = CRC_TABLE[(value ^ chunk[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const METHOD_STORE = 0;
const VERSION = 20; // 2.0

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: day };
}

function buildLocalHeader(
  nameBytes: Uint8Array,
  dos: { time: number; date: number },
  isDirectory: boolean
): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(
    6,
    isDirectory ? FLAG_UTF8 : FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
    true
  );
  view.setUint16(8, METHOD_STORE, true);
  view.setUint16(10, dos.time, true);
  view.setUint16(12, dos.date, true);
  view.setUint32(14, 0, true); // crc32 留空：文件条目写在数据描述符里
  view.setUint32(18, 0, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function buildDataDescriptor(crc: number, size: number): Uint8Array {
  const descriptor = new Uint8Array(16);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return descriptor;
}

interface CentralEntry {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dos: { time: number; date: number };
  isDirectory: boolean;
}

function buildCentralHeader(entry: CentralEntry): Uint8Array {
  const header = new Uint8Array(46 + entry.nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(
    8,
    entry.isDirectory ? FLAG_UTF8 : FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
    true
  );
  view.setUint16(10, METHOD_STORE, true);
  view.setUint16(12, entry.dos.time, true);
  view.setUint16(14, entry.dos.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, 0, true); // extra
  view.setUint16(32, 0, true); // comment
  view.setUint16(34, 0, true); // disk
  view.setUint16(36, 0, true); // internal attrs
  view.setUint32(
    38,
    entry.isDirectory ? ((0x41ed << 16) | 0x10) >>> 0 : ((0x81a4 << 16) | 0) >>> 0,
    true
  );
  view.setUint32(42, entry.offset, true);
  header.set(entry.nameBytes, 46);
  return header;
}

function buildEndOfCentralDirectory(
  entryCount: number,
  size: number,
  offset: number
): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);
  return record;
}

/** 把若干对象按顺序写成 zip 字节流。 */
export class ZipWriter {
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private central: CentralEntry[] = [];
  private offset = 0;
  private closed = false;

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = controller;
  }

  private emit(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
    this.offset += bytes.length;
  }

  /** 写入一个目录条目（名称必须以 / 结尾）。 */
  addDirectory(name: string, uploaded?: Date | null): void {
    const entryName = name.endsWith("/") ? name : `${name}/`;
    const nameBytes = new TextEncoder().encode(entryName);
    const dos = dosDateTime(uploaded || new Date());
    const offset = this.offset;

    this.emit(buildLocalHeader(nameBytes, dos, true));
    this.central.push({
      nameBytes,
      crc: 0,
      size: 0,
      offset,
      dos,
      isDirectory: true,
    });
  }

  /**
   * 写入一个文件条目。body 为 null 时写入空文件（源对象已不存在）。
   */
  async addFile(
    name: string,
    body: ReadableStream<Uint8Array> | null,
    uploaded?: Date | null
  ): Promise<void> {
    const nameBytes = new TextEncoder().encode(name.replace(/\\/g, "/"));
    const dos = dosDateTime(uploaded || new Date());
    const offset = this.offset;

    this.emit(buildLocalHeader(nameBytes, dos, false));

    let crc = 0xffffffff;
    let size = 0;

    if (body) {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        crc = crc32Of(crc, value);
        size += value.length;
        this.emit(value);
      }
    }

    const digest = (crc ^ 0xffffffff) >>> 0;
    this.emit(buildDataDescriptor(digest, size));

    this.central.push({
      nameBytes,
      crc: digest,
      size,
      offset,
      dos,
      isDirectory: false,
    });
  }

  /** 写入中央目录并结束流。 */
  finish(): void {
    if (this.closed) return;
    this.closed = true;

    const directoryOffset = this.offset;
    let size = 0;
    for (const entry of this.central) {
      const header = buildCentralHeader(entry);
      this.controller.enqueue(header);
      size += header.length;
    }
    this.offset += size;

    this.emit(buildEndOfCentralDirectory(this.central.length, size, directoryOffset));
    this.controller.close();
  }
}
