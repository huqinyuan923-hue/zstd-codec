/**
 * 序列段解码：Number_of_Sequences + 符号压缩模式 + 三张 FSE 表 + 反向位流。
 * 每条序列 = (literal_length, offset_value, match_length)；
 * 三个 FSE 状态共用一条反向位流，位流里 FSE 转移位与原始附加位交织。
 */
import { BitReaderForward, BitReaderReverse } from './bits.js';
import { corrupt } from './errors.js';
import { buildFseTable, buildFseTableRle, fsePeekSymbol, fseUpdateState, readFseTable, type FseTable } from './fse.js';

// ---- 长度基线与附加位（规范 "The codes for literals lengths / match lengths / offsets"）----

export const LL_BASELINE: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
  8192, 16384, 32768, 65536,
];
export const LL_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
];
export const ML_BASELINE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41,
  43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771,
  65539,
];
export const ML_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
  2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];

// ---- 预定义分布（规范 "Default Distributions"）----

export const LL_DEFAULT_DIST: readonly number[] = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
];
export const ML_DEFAULT_DIST: readonly number[] = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
  -1, -1, -1, -1, -1,
];
export const OF_DEFAULT_DIST: readonly number[] = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
];

const MAX_LL_SYMBOL = 35;
const MAX_ML_SYMBOL = 52;
const MAX_OF_SYMBOL = 31;
const MAX_LL_ACCURACY = 9;
const MAX_ML_ACCURACY = 9;
const MAX_OF_ACCURACY = 8;

let predefinedLL: FseTable | null = null;
let predefinedOF: FseTable | null = null;
let predefinedML: FseTable | null = null;

function getPredefined(which: 0 | 1 | 2): FseTable {
  if (which === 0) {
    if (!predefinedLL) predefinedLL = buildFseTable([...LL_DEFAULT_DIST], MAX_LL_SYMBOL, 6);
    return predefinedLL;
  }
  if (which === 1) {
    if (!predefinedOF) predefinedOF = buildFseTable([...OF_DEFAULT_DIST], MAX_OF_SYMBOL, 5);
    return predefinedOF;
  }
  if (!predefinedML) predefinedML = buildFseTable([...ML_DEFAULT_DIST], MAX_ML_SYMBOL, 6);
  return predefinedML;
}

/** 一条解码后的序列。offset_value ∈ [1, 2^32-1]（1..3 为重复偏移码）。 */
export interface Seq {
  literalLength: number;
  offsetValue: number;
  matchLength: number;
}

/** 跨块持久的序列表状态（Repeat_Mode 复用；nbSeq==0 的块不更新）。 */
export interface SeqTableState {
  ll: FseTable | null;
  of: FseTable | null;
  ml: FseTable | null;
}

/** 模式字节取值 */
const MODE_PREDEFINED = 0;
const MODE_RLE = 1;
const MODE_FSE = 2;
const MODE_REPEAT = 3;

/**
 * 解码序列段。data[start, end) 为本块中紧跟 literals 段之后的字节区间。
 * 成功返回序列数组（nbSeq==0 时为空数组，且不触碰表状态）。
 */
export function decodeSequences(
  data: Uint8Array,
  start: number,
  end: number,
  tableState: SeqTableState,
): Seq[] {
  const fwd = new BitReaderForward(data, start, end);

  // Number_of_Sequences（1-3 字节）
  const byte0 = fwd.read(8);
  let nbSeq: number;
  if (byte0 < 128) {
    nbSeq = byte0;
  } else if (byte0 < 255) {
    nbSeq = ((byte0 - 128) << 8) + fwd.read(8);
  } else {
    nbSeq = fwd.read(16) + 0x7f00;
  }
  if (nbSeq === 0) {
    // 规范 0.4.0 勘误：nbSeq==0（任意编码格式）→ 立即结束，序列段不得有剩余字节
    if (fwd.bytePos !== end) throw corrupt('序列段存在多余数据（nbSeq==0）');
    return [];
  }

  // 符号压缩模式（低 2 位保留，必须为 0）
  const modes = fwd.read(8);
  if ((modes & 3) !== 0) throw corrupt('序列段保留位非零');

  const buildTable = (
    mode: number,
    which: 0 | 1 | 2,
    maxSymbol: number,
    maxAccuracy: number,
    prev: FseTable | null,
  ): FseTable => {
    switch (mode) {
      case MODE_PREDEFINED:
        return getPredefined(which);
      case MODE_RLE: {
        const sym = fwd.read(8);
        if (sym > maxSymbol) throw corrupt('RLE 表符号超出符号域');
        return buildFseTableRle(sym);
      }
      case MODE_FSE:
        return readFseTable(fwd, maxSymbol, maxAccuracy);
      case MODE_REPEAT:
        if (!prev) throw corrupt('Repeat_Mode 无先前表可复用');
        return prev;
      default:
        throw corrupt('未知压缩模式');
    }
  };

  const ll = buildTable((modes >>> 6) & 3, 0, MAX_LL_SYMBOL, MAX_LL_ACCURACY, tableState.ll);
  const of = buildTable((modes >>> 4) & 3, 1, MAX_OF_SYMBOL, MAX_OF_ACCURACY, tableState.of);
  const ml = buildTable((modes >>> 2) & 3, 2, MAX_ML_SYMBOL, MAX_ML_ACCURACY, tableState.ml);
  tableState.ll = ll;
  tableState.of = of;
  tableState.ml = ml;

  // 反向位流（剩余区间）
  const bitStart = fwd.bytePos;
  if (bitStart >= end) throw corrupt('序列位流缺失');
  const rev = new BitReaderReverse(data, bitStart, end);

  // 初始状态：LL → OF → ML
  let llState = rev.read(ll.accuracyLog);
  let ofState = rev.read(of.accuracyLog);
  let mlState = rev.read(ml.accuracyLog);
  if (rev.offset < 0) throw corrupt('序列位流初始状态被截断');

  const seqs: Seq[] = new Array(nbSeq);
  for (let i = 0; i < nbSeq; i++) {
    const ofCode = fsePeekSymbol(of, ofState);
    const llCode = fsePeekSymbol(ll, llState);
    const mlCode = fsePeekSymbol(ml, mlState);
    // 读附加位顺序：Offset → Match_Length → Literals_Length
    const offsetValue = (2 ** ofCode) + rev.read(ofCode);
    const matchLength = ML_BASELINE[mlCode]! + rev.read(ML_EXTRA[mlCode]!);
    const literalLength = LL_BASELINE[llCode]! + rev.read(LL_EXTRA[llCode]!);
    seqs[i] = { literalLength, offsetValue, matchLength };

    // 非最后一条序列才更新状态：LL → ML → OF
    if (i + 1 < nbSeq) {
      llState = fseUpdateState(ll, llState, rev);
      mlState = fseUpdateState(ml, mlState, rev);
      ofState = fseUpdateState(of, ofState, rev);
    }
  }
  if (rev.offset !== 0) throw corrupt('序列位流未精确耗尽');
  return seqs;
}
