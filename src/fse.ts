/**
 * FSE（有限状态熵，tANS）解码。
 * 与 DEFLATE 的 canonical Huffman 是两种世界观：DEFLATE 的码字按位前缀匹配；
 * FSE 的"状态"是解码表下标，每次输出状态对应符号，再按该状态的 Num_Bits 消费
 * 位流得到下一个状态（反向传播建表）。位流从尾向首读。
 */
import { BitReaderForward, BitReaderReverse, highbit32 } from './bits.js';
import { corrupt } from './errors.js';

/** 解码表：三张平行数组。RLE 表大小为 1（Num_Bits=0，状态恒 0）。 */
export interface FseTable {
  accuracyLog: number;
  symbols: Uint8Array; // Table_Size 个状态对应的符号
  numBits: Uint16Array; // 各状态转移要读的位数
  newStateBase: Uint16Array; // 各状态转移的 Baseline
}

const FSE_MIN_ACCURACY = 5;
const FSE_MAX_ACCURACY = 20; // 规范全局限；各上下文另有更严上限（9/8/9/6）

/**
 * 从"归一化概率分布"构建解码表（规范 "From normalized distribution to decoding tables"）：
 * 1. 概率 -1（"小于 1"）的符号从表尾向前各占一行，行属性 = 全状态复位（读 Accuracy_Log 位）；
 * 2. 其余符号按自然序、以步长 (size>>1)+(size>>3)+3 环形铺开（跳过已占用行）；
 * 3. 每符号按状态序递增计数：低于"下一个 2 的幂"的状态多读 1 位（宽度加倍）。
 * 结束时环形游标必须回到 0，否则分布非法。
 */
export function buildFseTable(norm: number[], maxSymbol: number, accuracyLog: number): FseTable {
  const size = 1 << accuracyLog;
  const symbols = new Uint8Array(size);
  const numBits = new Uint16Array(size);
  const newStateBase = new Uint16Array(size);
  // stateDesc：建表期计数器（符号出现次数），终值即符号的行数（-1 符号为 1）
  const stateDesc = new Uint16Array(maxSymbol + 1);

  let highThreshold = size;
  for (let s = 0; s <= maxSymbol; s++) {
    if (norm[s] === -1) {
      symbols[--highThreshold] = s;
      stateDesc[s] = 1;
    }
  }

  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let pos = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const p = norm[s]!;
    if (p <= 0) continue;
    stateDesc[s] = p;
    for (let i = 0; i < p; i++) {
      symbols[pos] = s;
      do {
        pos = (pos + step) & mask;
      } while (pos >= highThreshold);
    }
  }
  if (pos !== 0) throw corrupt('FSE 分布未精确铺满解码表');

  for (let i = 0; i < size; i++) {
    const sym = symbols[i]!;
    const next = stateDesc[sym]!++;
    const nb = accuracyLog - highbit32(next);
    numBits[i] = nb;
    newStateBase[i] = ((next << nb) - size) & 0xffff;
  }
  return { accuracyLog, symbols, numBits, newStateBase };
}

/** RLE 表：恒定符号，0 位转移。 */
export function buildFseTableRle(symbol: number): FseTable {
  return {
    accuracyLog: 0,
    symbols: new Uint8Array([symbol]),
    numBits: new Uint16Array([0]),
    newStateBase: new Uint16Array([0]),
  };
}

export interface FseDescription {
  norm: number[]; // 归一化概率（0..maxSymbol；0 = 不存在，-1 = "小于 1"）
  maxSymbol: number; // 最后一个非零概率符号
  accuracyLog: number;
  byteLength: number; // 表描述消耗的整字节数（规范：consumes a round number of bytes）
}

/**
 * 解析 FSE 表描述（概率分布，正向位流）。
 * 低 4 位 = Accuracy_Log - 5；随后逐符号读"值"，概率 = 值 - 1；
 * 值 0 表示"小于 1"（概率 -1）；概率 0 的符号后跟 2 位重复旗标（0b11 表示再接
 * 3 个 0，链式；否则旗标值即随后 0 的个数，旗标恒消耗 2 位）。
 * remaining 的位宽随已分配点数动态收缩：可读最大值 = remaining+1（终止时恰剩 1）。
 * 终止：remaining 归 1；期间任何符号下标越过 maxSymbolValue 或概率溢出均报错。
 */
export function parseFseDescription(
  r: BitReaderForward,
  maxSymbolValue: number,
  maxAccuracyLog: number,
): FseDescription {
  const startByte = r.bytePos;
  const accuracyLog = r.read(4) + FSE_MIN_ACCURACY;
  if (accuracyLog > maxAccuracyLog) throw corrupt(`FSE 精度 ${accuracyLog} 超过上限 ${maxAccuracyLog}`);

  const norm: number[] = [];
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  let symbolIdx = 0;
  let previous0 = false;

  while (true) {
    if (previous0) {
      // 零游程：2 位旗标链
      for (;;) {
        const f = r.read(2);
        if (f === 3) {
          symbolIdx += 3;
        } else {
          symbolIdx += f;
          break;
        }
      }
      for (let i = norm.length; i < symbolIdx; i++) norm[i] = 0;
    }

    const max = 2 * threshold - 1 - remaining;
    let value: number;
    const low = r.read(nbBits - 1);
    if (low < max) {
      // 小值走少 1 位的路径
      value = low;
    } else {
      value = low | (r.read(1) << (nbBits - 1));
      if (value >= threshold) value -= max;
    }
    value--;
    const prob = value;
    remaining -= prob < 0 ? -prob : prob;
    norm[symbolIdx++] = prob;
    previous0 = prob === 0;

    if (remaining < threshold) {
      if (remaining <= 1) break;
      nbBits = highbit32(remaining) + 1;
      threshold = 1 << (nbBits - 1);
    }
    if (symbolIdx > maxSymbolValue) throw corrupt('FSE 分布符号数超出上限');
  }
  if (remaining !== 1) throw corrupt('FSE 分布概率点数不归一');
  if (symbolIdx > maxSymbolValue + 1) throw corrupt('FSE 分布符号数超出上限');

  let maxSymbol = -1;
  for (let s = 0; s < norm.length; s++) {
    if (norm[s]! !== 0) maxSymbol = s;
  }
  if (maxSymbol > maxSymbolValue) throw corrupt('FSE 分布出现超出符号域的非零概率');

  r.align();
  // 相对于读取起点的整字节数（调用方用它偏移子流起点）
  return { norm, maxSymbol, accuracyLog, byteLength: r.bytePos - startByte };
}

/** 解析表描述并构建解码表（一条龙）。 */
export function readFseTable(
  r: BitReaderForward,
  maxSymbolValue: number,
  maxAccuracyLog: number,
): FseTable {
  const desc = parseFseDescription(r, maxSymbolValue, maxAccuracyLog);
  return buildFseTable(desc.norm, desc.maxSymbol, desc.accuracyLog);
}

/** 输出当前状态的符号（不推进状态）。 */
export function fsePeekSymbol(t: FseTable, state: number): number {
  return t.symbols[state]!;
}

/** 消费位流推进状态：state = Baseline + 读 Num_Bits 位。 */
export function fseUpdateState(t: FseTable, state: number, r: BitReaderReverse): number {
  const nb = t.numBits[state]!;
  const rest = r.read(nb);
  return t.newStateBase[state]! + rest;
}

/** 解码一个符号并推进状态。 */
export function fseDecodeSymbol(t: FseTable, state: number, r: BitReaderReverse): { symbol: number; state: number } {
  const symbol = t.symbols[state]!;
  const nb = t.numBits[state]!;
  const rest = r.read(nb);
  return { symbol, state: t.newStateBase[state]! + rest };
}

/**
 * 双状态交替 FSE 流（Huffman 权重专用）：State1 编码偶数下标符号，State2 编码
 * 奇数下标；State1 先初始化。终止规则：若某次状态更新所需位已不足（读入不足，
 * offset 变负），视缺失位为 0 并在输出完另一状态当前符号后结束。
 * 参考 v1.5.6 勘误：两个初始状态本身若被截断，必须报错。
 */
export function fseDecodeInterleaved2(t: FseTable, r: BitReaderReverse, maxOut: number): Uint8Array {
  const out: number[] = [];
  // 初始状态（截断即错，参考 v1.5.6 勘误）
  const s1 = r.read(t.accuracyLog);
  const s2 = r.read(t.accuracyLog);
  if (r.offset < 0) throw corrupt('FSE 权重流初始状态被截断');

  let state1 = s1;
  let state2 = s2;
  for (;;) {
    const d1 = fseDecodeSymbol(t, state1, r);
    state1 = d1.state;
    out.push(d1.symbol);
    if (r.offset < 0) {
      out.push(fsePeekSymbol(t, state2));
      break;
    }
    const d2 = fseDecodeSymbol(t, state2, r);
    state2 = d2.state;
    out.push(d2.symbol);
    if (r.offset < 0) {
      out.push(fsePeekSymbol(t, state1));
      break;
    }
    if (out.length > maxOut) throw corrupt('FSE 权重流输出超限');
  }
  if (out.length > maxOut) throw corrupt('FSE 权重流输出超限');
  return new Uint8Array(out);
}
