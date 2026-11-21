/**
 * Huffman 字面量解码（RFC 8878 "Huffman Coding" 一节）。
 * 权重表示：符号按权重 w ∈ [0, 11]，Number_of_Bits = w ? maxBits+1-w : 0；
 * 最后一个非零符号的权重不出现在流里，由 Σ2^(w-1) 补全到 2^maxBits 推出。
 * 解码表是"直读表"（X1 风格）：以 maxBits 位窗口为下标直接查符号与码长。
 * （参考实现的 X2"双凸轮"表是其等价加速结构，不影响字节级输出，见 REPORT。）
 */
import { BitReaderForward, BitReaderReverse } from './bits.js';
import { corrupt } from './errors.js';
import { buildFseTable, fseDecodeInterleaved2, parseFseDescription } from './fse.js';

export const HUF_MAX_BITS = 11; // 规范：码长上限 11（参考实现容忍 12，这里按规范从严）
const HUF_MAX_SYMBOLS = 256;
const HUF_WEIGHTS_MAX_ACCURACY = 6; // 权重 FSE 精度上限（规范与 HUF_readStats 一致）
const HUF_WEIGHTS_MAX_SYMBOL = 12; // 权重值域 0..11，FSE 符号域 0..12 留给校验

export interface HufTable {
  maxBits: number;
  symbols: Uint8Array; // 1 << maxBits
  numBits: Uint8Array; // 1 << maxBits
}

/**
 * 解析 Huffman 树描述（位于 literals 段内，r 已就位于描述首字节）。
 * headerByte ≥ 128：直接表示，权重数 = hb - 127，每权重 4 位（高半字节在前）；
 * headerByte < 128：权重经 FSE 压缩，子流长 = headerByte（表描述 + 反向位流）。
 * 返回表与描述消耗的总字节数。
 */
export function readHufTable(r: BitReaderForward): { table: HufTable; byteLength: number } {
  const start = r.bytePos;
  const headerByte = r.read(8);
  let weights: Uint8Array;

  if (headerByte >= 128) {
    const nbWeights = headerByte - 127;
    const bytes = (nbWeights + 1) >> 1;
    if (r.bytePos + bytes > r.bitEnd / 8) throw corrupt('Huffman 权重直传数据越界');
    weights = new Uint8Array(nbWeights);
    for (let i = 0; i < nbWeights; i++) {
      const b = r.data[r.bytePos + (i >> 1)]!;
      weights[i] = (i & 1) === 0 ? b >>> 4 : b & 0xf;
    }
    r.pos += bytes * 8;
  } else {
    if (headerByte === 0) throw corrupt('Huffman 权重 FSE 子流长度为 0');
    const subStart = r.bytePos;
    const subEnd = subStart + headerByte;
    if (subEnd > r.bitEnd / 8) throw corrupt('Huffman 权重 FSE 子流越界');
    // 表描述（正向）→ 反向位流 → 双状态交替解码
    const fwd = new BitReaderForward(r.data, subStart, subEnd);
    const desc = parseFseDescription(fwd, HUF_WEIGHTS_MAX_SYMBOL, HUF_WEIGHTS_MAX_ACCURACY);
    if (desc.byteLength >= headerByte) throw corrupt('Huffman 权重 FSE 表描述吞满子流');
    const rev = new BitReaderReverse(r.data, subStart + desc.byteLength, subEnd);
    const table = buildFseTable(desc.norm, desc.maxSymbol, desc.accuracyLog);
    weights = fseDecodeInterleaved2(table, rev, HUF_MAX_SYMBOLS - 1);
    r.pos = subEnd * 8;
  }
  return { table: buildTableFromWeights(weights), byteLength: r.bytePos - start };
}

/**
 * 权重 → 前缀码 → 解码表。
 * 校验：权重 ≤ 11；Σ2^(w-1) 必须恰好补全到 2^maxBits（残差为 2 的幂）；
 * 权重 1 的符号（含隐式末符号）至少 2 个；符号总数 ≤ 256。
 */
export function buildTableFromWeights(weights: Uint8Array): HufTable {
  const nb = weights.length;
  if (nb === 0 || nb >= HUF_MAX_SYMBOLS) throw corrupt('Huffman 权重数量非法');
  let weightSum = 0;
  for (let i = 0; i < nb; i++) {
    const w = weights[i]!;
    if (w > HUF_MAX_BITS) throw corrupt('Huffman 权重超出 11');
    weightSum += w > 0 ? 1 << (w - 1) : 0;
  }
  if (weightSum === 0) throw corrupt('Huffman 权重全零');

  const maxBits = 31 - Math.clz32(weightSum) + 1;
  if (maxBits > HUF_MAX_BITS) throw corrupt('Huffman 树深超过 11');
  const rest = (1 << maxBits) - weightSum;
  // 残差必须恰为 2 的幂（即隐式末符号的 2^(w-1)）
  if (rest <= 0 || (rest & (rest - 1)) !== 0) throw corrupt('Huffman 权重无法补全到 2 的幂');
  const lastWeight = 31 - Math.clz32(rest) + 1;
  const numSymbols = nb + 1;
  if (numSymbols > HUF_MAX_SYMBOLS) throw corrupt('Huffman 符号数超过 256');

  // rank1 ≥ 2：与规范"存在权重 1 的符号"等价（计数为偶数由补全自动保证）
  let rank1 = 0;
  for (let i = 0; i < nb; i++) if (weights[i] === 1) rank1++;
  if (lastWeight === 1) rank1++;
  if (rank1 < 2) throw corrupt('Huffman 权重缺少 rank-1 符号');

  // Number_of_Bits = maxBits + 1 - weight（weight>0），0 表示不存在
  const bits = new Uint8Array(numSymbols);
  for (let i = 0; i < nb; i++) {
    bits[i] = weights[i]! > 0 ? maxBits + 1 - weights[i]! : 0;
  }
  bits[nb] = maxBits + 1 - lastWeight;

  // 按码长分桶（rank），桶内按符号自然序分配前缀码；表下标 = maxBits 位窗口值
  const rankCount = new Uint32Array(maxBits + 1);
  for (let i = 0; i < numSymbols; i++) rankCount[bits[i]!]!++;
  const tableSize = 1 << maxBits;
  const symbols = new Uint8Array(tableSize);
  const numBitsArr = new Uint8Array(tableSize);
  const rankIdx = new Uint32Array(maxBits + 1);
  rankIdx[maxBits] = 0;
  for (let b = maxBits; b >= 1; b--) {
    rankIdx[b - 1] = rankIdx[b]! + rankCount[b]! * (1 << (maxBits - b));
    numBitsArr.fill(b, rankIdx[b]!, rankIdx[b - 1]!);
  }
  if (rankIdx[0] !== tableSize) throw corrupt('Huffman 权重未构成完备前缀码');
  for (let i = 0; i < numSymbols; i++) {
    const b = bits[i]!;
    if (b === 0) continue;
    const code = rankIdx[b]!;
    const len = 1 << (maxBits - b);
    symbols.fill(i, code, code + len);
    rankIdx[b]! += len;
  }
  return { maxBits, symbols, numBits: numBitsArr };
}

/**
 * 解码一个 Huffman 流（恰好 count 个符号）到 out 的 outPos 处。
 * 有效性判据（与参考 BIT_endOfDStream 等价）：Σ码长 == 有效位总数，
 * 即解码完成后 offset === -maxBits；count==0 时要求流不含任何有效位。
 */
export function decodeHufStream(t: HufTable, r: BitReaderReverse, count: number, out: Uint8Array, outPos: number): void {
  if (count === 0) {
    if (r.offset !== 0) throw corrupt('Huffman 流应只含结束标志');
    return;
  }
  let state = r.read(t.maxBits);
  const mask = (1 << t.maxBits) - 1;
  for (let i = 0; i < count; i++) {
    const nb = t.numBits[state]!;
    out[outPos + i] = t.symbols[state]!;
    const rest = r.read(nb);
    state = ((state << nb) | rest) & mask;
  }
  if (r.offset !== -t.maxBits) throw corrupt('Huffman 流长度与符号数不符（未精确耗尽）');
}
