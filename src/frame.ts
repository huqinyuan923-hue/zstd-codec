/**
 * 帧解码：帧头（描述符/窗口/字典 ID/内容尺寸）→ 块循环 → 校验。
 * 标准帧（0xFD2FB528）与 skippable 帧（0x184D2A50..5F，跳过）；
 * magicless、字典、多标准帧拼接列二期（明确报错）。
 */
import { corrupt, unsupported } from './errors.js';
import { xxh64 } from './xxh64.js';
import { decodeLiterals, type LiteralsState } from './literals.js';
import { decodeSequences, type Seq, type SeqTableState } from './sequences.js';

const MAGIC_ZSTD = 0xfd2fb528;
const MAGIC_SKIPPABLE_MIN = 0x184d2a50;
const MAGIC_SKIPPABLE_MAX = 0x184d2a5f;

const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;
const BLOCK_RESERVED = 3;

const BLOCK_MAX = 128 * 1024;
/** 输出/窗口的实现上限（防恶意流撑爆内存；与参考解码器默认窗口上限同量级） */
const MAX_OUTPUT = 2 ** 31 - 1;

export interface FrameHeader {
  windowSize: number;
  frameContentSize: number; // -1 表示未知
  contentChecksum: boolean;
  dictionaryId: number;
  singleSegment: boolean;
}

/** 解析帧头。 */
export function parseFrameHeader(data: Uint8Array, start: number, end: number): { header: FrameHeader; headerLen: number } {
  let p = start;
  const read8 = (): number => {
    if (p >= end) throw corrupt('帧头意外结束');
    return data[p++]!;
  };

  const descriptor = read8();
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const reservedBit = (descriptor >>> 3) & 1;
  const checksumFlag = (descriptor >>> 2) & 1;
  const dictIdFlag = descriptor & 3;
  if (reservedBit !== 0) throw corrupt('帧头保留位非零');

  let windowSize = 0;
  if (!singleSegment) {
    const wd = read8();
    const exponent = wd >>> 3;
    const mantissa = wd & 7;
    const windowBase = 2 ** (10 + exponent);
    windowSize = windowBase + (windowBase / 8) * mantissa;
  }

  let dictionaryId = 0;
  if (dictIdFlag !== 0) {
    const size = [0, 1, 2, 4][dictIdFlag]!;
    if (p + size > end) throw corrupt('帧头意外结束');
    for (let i = 0; i < size; i++) dictionaryId += data[p + i]! * 2 ** (8 * i);
    p += size;
  }

  let frameContentSize = -1;
  if (singleSegment || fcsFlag !== 0) {
    const size = [1, 2, 4, 8][fcsFlag]!;
    if (p + size > end) throw corrupt('帧头意外结束');
    let v = 0;
    for (let i = 0; i < size; i++) v += data[p + i]! * 2 ** (8 * i);
    p += size;
    if (size === 2) v += 256;
    frameContentSize = v;
    if (v > MAX_OUTPUT) throw unsupported('帧内容尺寸超出实现上限（2GB）');
  }
  if (singleSegment) windowSize = frameContentSize === -1 ? 0 : frameContentSize;
  if (dictionaryId !== 0) throw unsupported('字典模式列二期（帧要求 Dictionary_ID）');

  return {
    header: { windowSize, frameContentSize, contentChecksum: checksumFlag === 1, dictionaryId, singleSegment: singleSegment === 1 },
    headerLen: p - start,
  };
}

interface FrameState {
  windowSize: number;
  frameContentSize: number;
  blockMax: number;
  output: Uint8Array;
  produced: number;
  literals: LiteralsState;
  seqTables: SeqTableState;
  repOffsets: [number, number, number];
}

/**
 * 解码一个标准帧（data 从 frameStart 起，含 magic；frameEnd 为输入缓冲终点，
 * 帧自身的结构决定实际结束位置）。返回解压输出与帧结束位置。
 */
function decodeFrame(data: Uint8Array, frameStart: number, frameEnd: number): { out: Uint8Array; frameEndPos: number } {
  const { header, headerLen } = parseFrameHeader(data, frameStart + 4, frameEnd);
  if (header.windowSize > MAX_OUTPUT) throw unsupported('窗口尺寸超出实现上限（2GB）');

  const blockMax = Math.min(header.windowSize, BLOCK_MAX);
  // 输出缓冲：已知 FCS 精确分配；未知则按窗口起步、按需倍增
  const capacity = header.frameContentSize >= 0
    ? header.frameContentSize
    : Math.min(Math.max(header.windowSize, 1024), 8 * 1024 * 1024);
  const state: FrameState = {
    windowSize: header.windowSize,
    frameContentSize: header.frameContentSize,
    blockMax,
    output: new Uint8Array(capacity),
    produced: 0,
    literals: { huf: null },
    seqTables: { ll: null, of: null, ml: null },
    repOffsets: [1, 4, 8],
  };

  let p = frameStart + 4 + headerLen;
  let lastBlock = false;
  do {
    if (p + 3 > frameEnd) throw corrupt('块头意外结束');
    const bh = data[p]! + data[p + 1]! * 256 + data[p + 2]! * 65536;
    p += 3;
    lastBlock = (bh & 1) === 1;
    const blockType = (bh >>> 1) & 3;
    const blockSize = bh >>> 3;
    if (blockType === BLOCK_RESERVED) throw corrupt('保留块类型');

    switch (blockType) {
      case BLOCK_RAW: {
        // Raw 块的 Block_Size 即解压尺寸 → 受 blockMax 约束（与参考一致）
        if (blockSize > blockMax) throw corrupt('块尺寸超过 Block_Maximum_Size');
        if (p + blockSize > frameEnd) throw corrupt('Raw 块数据越界');
        ensureCapacity(state, state.produced + blockSize);
        state.output.set(data.subarray(p, p + blockSize), state.produced);
        state.produced += blockSize;
        p += blockSize;
        break;
      }
      case BLOCK_RLE: {
        if (blockSize > blockMax) throw corrupt('块尺寸超过 Block_Maximum_Size');
        if (p + 1 > frameEnd) throw corrupt('RLE 块数据越界');
        const value = data[p]!;
        p += 1;
        ensureCapacity(state, state.produced + blockSize);
        state.output.fill(value, state.produced, state.produced + blockSize);
        state.produced += blockSize;
        break;
      }
      case BLOCK_COMPRESSED: {
        if (p + blockSize > frameEnd) throw corrupt('Compressed 块数据越界');
        if (blockSize === 0) throw corrupt('Compressed 块尺寸为 0');
        const blockOutStart = state.produced;
        p = decodeCompressedBlock(data, p, p + blockSize, state);
        if (state.produced - blockOutStart > blockMax) throw corrupt('块解压输出超过 Block_Maximum_Size');
        break;
      }
      default:
        throw corrupt('保留块类型');
    }
  } while (!lastBlock);

  if (header.contentChecksum) {
    if (p + 4 > frameEnd) throw corrupt('校验和缺失');
    const stored = data[p]! + data[p + 1]! * 256 + data[p + 2]! * 65536 + data[p + 3]! * 16777216;
    p += 4;
    const calc = xxh64(state.output, 0, state.produced);
    if (calc.low !== stored) throw corrupt('XXH64 内容校验失败');
  }

  if (header.frameContentSize >= 0 && state.produced !== header.frameContentSize) {
    throw corrupt('解压输出与 Frame_Content_Size 不符');
  }

  return { out: state.output.subarray(0, state.produced), frameEndPos: p };
}

/** 解码压缩块：literals 段 + 序列段 + 序列执行。返回新的块内位置。 */
function decodeCompressedBlock(data: Uint8Array, blockStart: number, blockEnd: number, state: FrameState): number {
  const lit = decodeLiterals(data, blockStart, blockEnd, state.literals, state.blockMax);
  const seqs = decodeSequences(data, blockStart + lit.sectionLength, blockEnd, state.seqTables);
  executeSequences(state, lit.literals, seqs);
  return blockEnd;
}

/** 序列执行：literal 拷贝 + match 拷贝（重复偏移状态机 + 窗口约束）。 */
function executeSequences(state: FrameState, literals: Uint8Array, seqs: Seq[]): void {
  const rep = state.repOffsets;
  let litPos = 0;
  const out = state.output;

  for (let i = 0; i < seqs.length; i++) {
    const seq = seqs[i]!;
    // 1. 拷贝字面量
    const ll = seq.literalLength;
    if (litPos + ll > literals.length) throw corrupt('字面量长度超出 literals 段');
    ensureCapacity(state, state.produced + ll);
    if (ll > 0) {
      out.set(literals.subarray(litPos, litPos + ll), state.produced);
      state.produced += ll;
      litPos += ll;
    }

    // 2. 计算偏移（重复偏移状态机，规范 "Repeat offsets" 与更新规则表）
    const ov = seq.offsetValue;
    let offset: number;
    if (ov <= 3) {
      let idx = ov - 1;
      if (seq.literalLength === 0) idx++;
      if (idx === 0) {
        // 重复最近偏移：历史不变
        offset = rep[0]!;
      } else {
        if (idx === 3 && rep[0] === 1) throw corrupt('Repeated_Offset1 - 1 = 0');
        offset = idx < 3 ? rep[idx]! : rep[0]! - 1;
        if (idx > 1) rep[2] = rep[1]!;
        rep[1] = rep[0]!;
        rep[0] = offset;
      }
    } else {
      offset = ov - 3;
      rep[2] = rep[1]!;
      rep[1] = rep[0]!;
      rep[0] = offset;
    }

    // 3. 窗口约束：offset ≤ min(已产出, Window_Size)
    if (offset > state.produced || offset > state.windowSize) throw corrupt('偏移超过窗口/历史范围');

    // 4. match 拷贝（倍增法处理重叠）
    const ml = seq.matchLength;
    ensureCapacity(state, state.produced + ml);
    const pos = state.produced;
    let done = 0;
    while (done < ml) {
      const chunk = Math.min(done === 0 ? offset : done, ml - done);
      // 经典倍增：首块从已有数据 [pos-offset, pos) 取，此后源恒为已写区域开头 [pos, pos+chunk)
      // —— chunk ≤ done 保证源与目标不重叠（TypedArray.set 对同数组重叠区间非快照语义）
      const srcStart = done === 0 ? pos - offset : pos;
      out.set(out.subarray(srcStart, srcStart + chunk), pos + done);
      done += chunk;
    }
    state.produced += ml;
  }

  // 5. 剩余 literals 追加
  if (litPos < literals.length) {
    const rest = literals.length - litPos;
    ensureCapacity(state, state.produced + rest);
    out.set(literals.subarray(litPos), state.produced);
    state.produced += rest;
  }
}

/** 确保输出缓冲容量（未知 FCS 时按需倍增）。 */
function ensureCapacity(state: FrameState, required: number): void {
  if (required <= state.output.length) return;
  if (required > MAX_OUTPUT) throw unsupported('输出超出实现上限（2GB）');
  let cap = state.output.length;
  while (cap < required) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(state.output.subarray(0, state.produced), 0);
  state.output = next;
}

/**
 * 流级入口：skippable 帧任意穿插 + 单个标准帧（多标准帧拼接列二期）。
 * 仅含 skippable 帧的输入 → 空输出。
 */
export function decodeStream(data: Uint8Array): Uint8Array {
  let p = 0;
  const end = data.length;
  let result: Uint8Array | null = null;

  while (p < end) {
    if (p + 4 > end) throw corrupt('帧头 magic 不完整');
    const magic = data[p]! + data[p + 1]! * 256 + data[p + 2]! * 65536 + data[p + 3]! * 16777216;
    if (magic >= MAGIC_SKIPPABLE_MIN && magic <= MAGIC_SKIPPABLE_MAX) {
      if (p + 8 > end) throw corrupt('skippable 帧头不完整');
      const size = data[p + 4]! + data[p + 5]! * 256 + data[p + 6]! * 65536 + data[p + 7]! * 16777216;
      if (p + 8 + size > end) throw corrupt('skippable 帧数据越界');
      p += 8 + size;
      continue;
    }
    if (magic !== MAGIC_ZSTD) throw corrupt('未知 magic（既非 zstd 帧也非 skippable 帧）');
    if (result !== null) throw unsupported('多标准帧拼接列二期');
    const { out, frameEndPos } = decodeFrame(data, p, end);
    result = out;
    p = frameEndPos; // 继续扫：允许标准帧后跟 skippable 帧
  }

  if (result === null) return new Uint8Array(0);
  return result;
}
