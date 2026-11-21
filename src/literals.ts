/**
 * Literals 段解码：4 种块型（Raw/RLE/Compressed/Treeless）× 尺寸格式 × 流模式。
 * Treeless 复用上一 Compressed 块的 Huffman 表（跨块持久）。
 */
import { BitReaderForward, BitReaderReverse } from './bits.js';
import { corrupt } from './errors.js';
import { decodeHufStream, readHufTable, type HufTable } from './huffman.js';

const LIT_RAW = 0;
const LIT_RLE = 1;
const LIT_COMPRESSED = 2;
const LIT_TREELESS = 3;

const MIN_LITERALS_FOR_4_STREAMS = 6;

export interface LiteralsState {
  huf: HufTable | null;
}

export interface LiteralsResult {
  literals: Uint8Array;
  /** literals 段总字节数（含头），用于定位序列段 */
  sectionLength: number;
}

/**
 * 解码 literals 段。data[blockStart, blockEnd) 为压缩块内容。
 * litMax：字面量再生尺寸上限 = min(Window_Size, 128KB)。
 */
export function decodeLiterals(
  data: Uint8Array,
  blockStart: number,
  blockEnd: number,
  state: LiteralsState,
  litMax: number,
): LiteralsResult {
  const fwd = new BitReaderForward(data, blockStart, blockEnd);
  const type = fwd.read(2);

  if (type === LIT_RAW || type === LIT_RLE) {
    // 尺寸格式：bit2==0 → 1 字节头（5 位尺寸）；bit2==1 → 再读 bit3（01: 12 位 / 11: 20 位）
    let regen: number;
    if (fwd.read(1) === 0) {
      regen = fwd.read(5);
    } else if (fwd.read(1) === 0) {
      regen = fwd.read(12);
    } else {
      regen = fwd.read(20);
    }
    if (regen > litMax) throw corrupt('字面量再生尺寸超过块上限');
    const hdrLen = fwd.bytePos - blockStart;
    if (type === LIT_RAW) {
      const litStart = blockStart + hdrLen;
      if (litStart + regen > blockEnd) throw corrupt('Raw literals 数据越界');
      const out = new Uint8Array(regen);
      out.set(data.subarray(litStart, litStart + regen), 0);
      return { literals: out, sectionLength: hdrLen + regen };
    }
    // RLE：1 字节值重复 regen 次
    if (blockStart + hdrLen + 1 > blockEnd) throw corrupt('RLE literals 数据越界');
    const value = data[blockStart + hdrLen]!;
    const out = new Uint8Array(regen);
    out.fill(value);
    return { literals: out, sectionLength: hdrLen + 1 };
  }

  // Compressed / Treeless
  const sizeFormat = fwd.read(2);
  let regen: number;
  let compressedSize: number;
  let fourStreams: boolean;
  if (sizeFormat === 0) {
    fourStreams = false;
    regen = fwd.read(10);
    compressedSize = fwd.read(10);
  } else if (sizeFormat === 1) {
    fourStreams = true;
    regen = fwd.read(10);
    compressedSize = fwd.read(10);
  } else if (sizeFormat === 2) {
    fourStreams = true;
    regen = fwd.read(14);
    compressedSize = fwd.read(14);
  } else {
    fourStreams = true;
    regen = fwd.read(18);
    compressedSize = fwd.read(18);
  }
  if (regen > litMax) throw corrupt('字面量再生尺寸超过块上限');
  if (compressedSize === 0) throw corrupt('Compressed_Size 为 0');
  if (fourStreams) {
    if (regen < MIN_LITERALS_FOR_4_STREAMS) throw corrupt('4 流模式字面量数不足 6');
    if (compressedSize < 10) throw corrupt('4 流模式压缩尺寸不足 10');
  }
  const hdrLen = fwd.bytePos - blockStart;
  const hufStart = blockStart + hdrLen;
  const hufEnd = hufStart + compressedSize;
  if (hufEnd > blockEnd) throw corrupt('literals 压缩数据越界');

  const out = new Uint8Array(regen);

  if (type === LIT_COMPRESSED) {
    // 解析新树（表描述含在 Compressed_Size 内）
    const treeR = new BitReaderForward(data, hufStart, hufEnd);
    const { table, byteLength } = readHufTable(treeR);
    state.huf = table;
    decodeStreams(data, hufStart + byteLength, hufEnd, table, fourStreams, regen, out);
  } else {
    if (!state.huf) throw corrupt('Treeless literals 无先前 Huffman 表');
    decodeStreams(data, hufStart, hufEnd, state.huf, fourStreams, regen, out);
  }
  return { literals: out, sectionLength: compressedSize + hdrLen };
}

/** 解码 1 或 4 条 Huffman 流。 */
function decodeStreams(
  data: Uint8Array,
  start: number,
  end: number,
  table: HufTable,
  fourStreams: boolean,
  regen: number,
  out: Uint8Array,
): void {
  if (!fourStreams) {
    const rev = new BitReaderReverse(data, start, end);
    decodeHufStream(table, rev, regen, out, 0);
    return;
  }
  // 跳表：3 × LE16 = 前 3 条流大小；第 4 条 = 总长 - 6 - s1 - s2 - s3（必须 ≥ 1）
  if (end - start < 6 + 1) throw corrupt('4 流模式数据不足');
  const dv = new DataView(data.buffer, data.byteOffset + start, end - start);
  const s1 = dv.getUint16(0, true);
  const s2 = dv.getUint16(2, true);
  const s3 = dv.getUint16(4, true);
  const s4 = end - start - 6 - s1 - s2 - s3;
  if (s4 < 1 || s1 + s2 + s3 + 6 > end - start) throw corrupt('4 流跳表尺寸非法');

  const segSize = (regen + 3) >> 2;
  const seg4 = regen - 3 * segSize;
  if (seg4 < 0) throw corrupt('4 流分段非法');

  const r1 = new BitReaderReverse(data, start + 6, start + 6 + s1);
  decodeHufStream(table, r1, segSize, out, 0);
  const r2 = new BitReaderReverse(data, start + 6 + s1, start + 6 + s1 + s2);
  decodeHufStream(table, r2, segSize, out, segSize);
  const r3 = new BitReaderReverse(data, start + 6 + s1 + s2, start + 6 + s1 + s2 + s3);
  decodeHufStream(table, r3, segSize, out, 2 * segSize);
  const r4 = new BitReaderReverse(data, start + 6 + s1 + s2 + s3, end);
  decodeHufStream(table, r4, seg4, out, 3 * segSize);
}
