/**
 * 极简 DEFLATE 解压器（RFC 1951，原始流，不带 zlib/gzip 头）。
 *
 * 为什么自己写：在线解压 zip 里的条目绝大多数是 DEFLATE 算法压缩的，
 * 而运行时自带的 DecompressionStream 只支持带 zlib/gzip 包裹的流，
 * 无法直接解「zip 条目这种裸 deflate」。引入第三方库又会破坏
 * Cloudflare Pages 无构建、零运行时依赖的架构，所以手写一个。
 *
 * 覆盖：stored / fixed Huffman / dynamic Huffman 三种块类型，
 * 长度与距离的 extra bits、16/17/18 码长重复都按规范实现。
 */

/** 码长分布表：码长 -> 符号数。用 puff.c 同款 canonical 解码。 */
interface HuffmanTable {
  count: Int32Array; // count[len]
  symbol: Int32Array; // symbol[]
  /** 构建时起点下标：解码结果是符号在这个数组里的原始下标，减 base 得到本地符号。 */
  base: number;
}

/** 长度码：257..285 的基准长度与 extra bits */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
  5, 5, 5, 0,
];

/** 距离码：0..29 的基准距离与 extra bits */
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13,
];

/** 动态块中读取码长的顺序（RFC 1951 3.2.7） */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

/**
 * 位阅读器：DEFLATE 的位是 LSB-first 进入码流，
 * Huffman 码按「先读到的位是码的最高位」的方式逐位累积。
 */
class BitReader {
  private data: Uint8Array;
  private pos = 0;
  private bitbuf = 0;
  private bitcnt = 0;
  private limit: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.limit = data.length;
  }

  needBits(count: number): void {
    while (this.bitcnt < count) {
      if (this.pos >= this.limit) throw new InflateError("deflate 数据意外结束");
      this.bitbuf |= this.data[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
  }

  /** 读 count 位（低位在前）。 */
  bits(count: number): number {
    this.needBits(count);
    const value = this.bitbuf & ((1 << count) - 1);
    this.bitbuf >>>= count;
    this.bitcnt -= count;
    return value;
  }

  /** 读 count 位（低位在前，值可能超过 32 位安全范围之外，最大 16 位）。 */
  bits16(count: number): number {
    this.needBits(count);
    const value = this.bitbuf & ((1 << count) - 1);
    this.bitbuf >>>= count;
    this.bitcnt -= count;
    return value >>> 0;
  }

  /** 跳到下一个字节边界（stored 块）。 */
  alignByte(): void {
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  /** stored 块的小端 16 位长度。 */
  readLe16(): number {
    this.alignByte();
    this.needBits(16);
    const value = this.bitbuf & 0xffff;
    this.bitbuf = 0;
    this.bitcnt = 0;
    return value;
  }
}

/** 按码长表构建 canonical Huffman 解码表；非法时抛错。 */
function constructTable(lengths: Int32Array, start: number, end: number): HuffmanTable {
  const count = new Int32Array(16);
  for (let i = start; i < end; i++) {
    const len = lengths[i];
    if (len > 0) {
      if (len > 15) throw new InflateError("码长超过 15");
      count[len]++;
    }
  }

  // 检查是否允许多余编码（over-subscribed）
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new InflateError("Huffman 码表过密");
  }

  const symbol = new Int32Array(end - start);
  const offsets = new Int32Array(16);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + count[len];
  for (let i = start; i < end; i++) {
    const len = lengths[i];
    if (len > 0) symbol[offsets[len]++] = i;
  }
  return { count, symbol, base: start };
}

/** 从 Huffman 表解码一个符号。 */
function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    reader.needBits(1);
    code |= (reader.bitbuf & 1) as number;
    reader.bitbuf >>>= 1;
    reader.bitcnt -= 1;

    const count = table.count[len];
    if (code - first < count) {
      return table.symbol[index + (code - first)];
    }
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new InflateError("无效的 Huffman 码");
}

/** 输出缓冲：动态增长。 */
class OutBuffer {
  private data: Uint8Array;
  private size = 0;

  constructor(capacity: number) {
    this.data = new Uint8Array(Math.max(1024, capacity));
  }

  private ensure(extra: number): void {
    if (this.size + extra <= this.data.length) return;
    let next = this.data.length * 2;
    while (next < this.size + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.data.subarray(0, this.size));
    this.data = grown;
  }

  pushByte(value: number): void {
    this.ensure(1);
    this.data[this.size++] = value;
  }

  /** 从输出回看 dist 个字节，复制 len 个（允许重叠）。 */
  copy(dist: number, len: number): void {
    if (dist <= 0 || dist > this.size) throw new InflateError("距离超出输出范围");
    this.ensure(len);
    let source = this.size - dist;
    for (let i = 0; i < len; i++) {
      this.data[this.size + i] = this.data[source + i];
    }
    this.size += len;
  }

  get(): Uint8Array {
    return this.data.subarray(0, this.size);
  }
}

/** inflate 固定 Huffman 表（只建一次）。 */
const FIXED_LITLEN = (() => {
  const lengths = new Int32Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return constructTable(lengths, 0, 288);
})();

const FIXED_DIST = (() => {
  const lengths = new Int32Array(30).fill(5);
  return constructTable(lengths, 0, 30);
})();

/**
 * 解压一段原始 DEFLATE 流。
 * @param data 原始 deflate 字节
 * @param expectedSize 期望输出大小（可从 zip 中央目录拿到，用于预分配，可省略）
 */
export function inflate(data: Uint8Array, expectedSize = 0): Uint8Array {
  const reader = new BitReader(data);
  const out = new OutBuffer(expectedSize);

  let final = false;
  while (!final) {
    const blockFinal = reader.bits(1);
    final = blockFinal === 1;
    const blockType = reader.bits(2);

    if (blockType === 0) {
      // stored（无压缩）
      const len = reader.readLe16();
      const nlen = reader.readLe16();
      if ((len ^ 0xffff) !== nlen) throw new InflateError("stored 块 NLEN 校验失败");
      for (let i = 0; i < len; i++) {
        if (reader.pos >= reader.limit) throw new InflateError("stored 数据不足");
        out.pushByte(reader.data[reader.pos++]);
      }
      continue;
    }

    let litlen: HuffmanTable;
    let dist: HuffmanTable;
    if (blockType === 1) {
      litlen = FIXED_LITLEN;
      dist = FIXED_DIST;
    } else if (blockType === 2) {
      // dynamic Huffman
      const hlit = reader.bits(5) + 257;
      const hdist = reader.bits(5) + 1;
      const hclen = reader.bits(4) + 4;
      if (hlit > 286 || hdist > 30) throw new InflateError("动态块码表大小非法");

      const clenLengths = new Int32Array(19);
      for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]] = reader.bits(3);

      const clenTable = constructTable(clenLengths, 0, 19);

      const lengths = new Int32Array(hlit + hdist);
      let index = 0;
      while (index < hlit + hdist) {
        const symbol = decodeSymbol(reader, clenTable);
        if (symbol < 16) {
          lengths[index++] = symbol;
        } else if (symbol === 16) {
          if (index === 0) throw new InflateError("重复码前无码长");
          const repeat = 3 + reader.bits(2);
          const prev = lengths[index - 1];
          for (let i = 0; i < repeat; i++) {
            if (index >= hlit + hdist) throw new InflateError("码长重复越界");
            lengths[index++] = prev;
          }
        } else if (symbol === 17) {
          const repeat = 3 + reader.bits(3);
          for (let i = 0; i < repeat; i++) {
            if (index >= hlit + hdist) throw new InflateError("码长重复越界");
            lengths[index++] = 0;
          }
        } else {
          const repeat = 11 + reader.bits(7);
          for (let i = 0; i < repeat; i++) {
            if (index >= hlit + hdist) throw new InflateError("码长重复越界");
            lengths[index++] = 0;
          }
        }
      }

      litlen = constructTable(lengths, 0, hlit);
      dist = constructTable(lengths, hlit, hlit + hdist);
    } else {
      throw new InflateError("无效的块类型");
    }

    // 解码块内容
    for (;;) {
      const symbol = decodeSymbol(reader, litlen);
      if (symbol < 256) {
        out.pushByte(symbol);
        continue;
      }
      if (symbol === 256) break; // 块结束

      const lengthIndex = symbol - 257;
      if (lengthIndex >= LENGTH_BASE.length) throw new InflateError("无效的长度码");
      const length = LENGTH_BASE[lengthIndex] + reader.bits(LENGTH_EXTRA[lengthIndex]);

      const distSymbol = decodeSymbol(reader, dist);
      // 距离表的符号数组存的是 lengths 里的原始下标，减 base 得到 0..hdist-1 的距离码
      const distance =
        DIST_BASE[distSymbol - dist.base] +
        reader.bits(DIST_EXTRA[distSymbol - dist.base]);

      out.copy(distance, length);
    }
  }

  return out.get();
}