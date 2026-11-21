/**
 * 测试侧写入器：从规范正方向构造合法 zstd 流（FSE 表描述、FSE/Huffman 反向位流、
 * 帧装配）。编码方向 = 解码方向的镜像：
 * - 解码器从流尾向流首读，写入器按"读取序的逆序"落位（先读的组写在最高位）；
 * - 每组以 LSB-first 写入（bit pos 为组内最低位），与反向读取器的 readBitsLE 对偶；
 * - 流末尾追加结束标志 1 位，再补 0 到字节边界。
 * FSE 状态链可行性依据：概率 p 的符号占 c ∈ [p, 2p-1] 行，其转移块（dyadic 划分）
 * 并集恰为整张表 —— 因此"任选目标行、反查来源行"必然成功。
 */
import { buildFseTable, type FseTable } from '../src/fse.js';
import { buildTableFromWeights, type HufTable } from '../src/huffman.js';
import { xxh64 } from '../src/xxh64.js';
import { LL_BASELINE, LL_EXTRA, ML_BASELINE, ML_EXTRA, LL_DEFAULT_DIST, ML_DEFAULT_DIST, OF_DEFAULT_DIST } from '../src/sequences.js';

function highbit(x: number): number {
  return 31 - Math.clz32(x);
}

/** LSB-first 正向位写入器。 */
export class BitWriter {
  private bytes: number[] = [];
  bitPos = 0;

  write(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const bit = Math.floor(value / 2 ** i) & 1;
      const byte = this.bitPos >>> 3;
      while (this.bytes.length <= byte) this.bytes.push(0);
      if (bit) this.bytes[byte]! |= 1 << (this.bitPos & 7);
      this.bitPos++;
    }
  }

  /** 对齐到字节边界（补 0）。 */
  align(): void {
    this.bitPos = (this.bitPos + 7) & ~7;
  }

  /** 结束：追加结束标志 1 位并补齐字节。 */
  finish(): Uint8Array {
    this.write(1, 1);
    this.align();
    return new Uint8Array(this.bytes);
  }

  /** 正向整段落位（无结束标志，用于 FSE 表描述）。 */
  toBytes(): Uint8Array {
    this.align();
    return new Uint8Array(this.bytes);
  }
}

/** 反向位流组：读取序的 {值, 位宽} 列表。写入时逆序落位 + 结束标志。 */
export interface BitGroup {
  value: number;
  nbits: number;
}

export function writeReverseGroups(groups: BitGroup[]): Uint8Array {
  const w = new BitWriter();
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    w.write(g.value, g.nbits);
  }
  return w.finish();
}

// ---- FSE 表描述 ----

/** 编码归一化分布（正向位流）。要求 Σ|norm| == 1<<accuracyLog 且最后非零符号之后无符号。 */
export function writeFseDescription(norm: number[], accuracyLog: number): Uint8Array {
  const w = new BitWriter();
  w.write(accuracyLog - 5, 4);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  let i = 0;
  const maxSymbol = (() => {
    for (let s = norm.length - 1; s >= 0; s--) if (norm[s] !== 0) return s;
    return -1;
  })();

  for (;;) {
    const p = i <= maxSymbol ? norm[i]! : 0;
    const v = p + 1; // -1 → 0；0 → 1；p → p+1
    const max = 2 * threshold - 1 - remaining;
    if (v < max) {
      w.write(v, nbBits - 1);
    } else if (v < threshold) {
      w.write(v, nbBits);
    } else {
      w.write(v + max, nbBits);
    }
    remaining -= Math.abs(p);
    i++;
    if (remaining < threshold) {
      if (remaining <= 1) break;
      nbBits = highbit(remaining) + 1;
      threshold = 1 << (nbBits - 1);
    }
    // 概率 0 → 零游程旗标链（每 0b11 旗标接 3 个 0；末旗标 0..2 恒消耗 2 位）
    if (p === 0) {
      let run = 0;
      while (i + run <= maxSymbol && norm[i + run] === 0) run++;
      let r = run;
      while (r >= 3) {
        w.write(3, 2);
        r -= 3;
      }
      w.write(r, 2);
      i += run;
      if (i > maxSymbol) break;
    }
    if (i > maxSymbol) break;
  }
  if (remaining !== 1) throw new Error(`writeFseDescription: 分布不归一 (remaining=${remaining})`);
  return w.toBytes();
}

// ---- 预定义表（与 src 同分布构建）----

export function predefinedTable(which: 'll' | 'of' | 'ml'): FseTable {
  if (which === 'll') return buildFseTable([...LL_DEFAULT_DIST], 35, 6);
  if (which === 'of') return buildFseTable([...OF_DEFAULT_DIST], 31, 5);
  return buildFseTable([...ML_DEFAULT_DIST], 52, 6);
}

// ---- FSE 状态链 ----

function rowsOf(t: FseTable): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < t.symbols.length; i++) {
    const s = t.symbols[i]!;
    (rows[s] ??= []).push(i);
  }
  return rows;
}

/**
 * 反向构造状态链：states[k] 的符号 == symbols[k]；rests[k] = states[k+1] - base(states[k])
 * 且 0 ≤ rests[k] < 2^nbBits(states[k])。
 */
export function fseStateChain(t: FseTable, symbols: number[]): { states: number[]; rests: number[] } {
  if (symbols.length === 0) return { states: [], rests: [] };
  const rows = rowsOf(t);
  const states = new Array<number>(symbols.length);
  const rests = new Array<number>(symbols.length - 1);
  const lastRows = rows[symbols[symbols.length - 1]!];
  if (!lastRows || lastRows.length === 0) throw new Error('fseStateChain: 末符号不在表中');
  states[symbols.length - 1] = lastRows[0]!;
  for (let k = symbols.length - 2; k >= 0; k--) {
    const target = states[k + 1]!;
    const candidates = rows[symbols[k]!];
    if (!candidates) throw new Error('fseStateChain: 符号不在表中');
    let found = -1;
    for (const u of candidates) {
      const base = t.newStateBase[u]!;
      const span = 1 << t.numBits[u]!;
      const rest = target - base;
      if (rest >= 0 && rest < span) {
        found = u;
        rests[k] = rest;
        break;
      }
    }
    if (found < 0) throw new Error(`fseStateChain: 符号 ${symbols[k]} 无法转移到状态 ${target}`);
    states[k] = found;
  }
  return { states, rests };
}

// ---- 序列段位流 ----

export interface SeqSpec {
  literalLength: number;
  offsetValue: number;
  matchLength: number;
}

function findCode(baselines: readonly number[], extras: readonly number[], value: number): number {
  for (let c = baselines.length - 1; c >= 0; c--) {
    if (value >= baselines[c]! && value - baselines[c]! < 2 ** extras[c]!) return c;
  }
  throw new Error(`findCode: 值 ${value} 超出码域`);
}

/**
 * 构造序列段反向位流（读取序：initLL/initOF/initML → 每序列 OF/ML/LL 附加位 →
 * 非最后序列的 LL/ML/OF 转移）。要求流精确耗尽（末组后 offset==0）。
 */
export function buildSeqBitstream(ll: FseTable, of: FseTable, ml: FseTable, seqs: SeqSpec[]): Uint8Array {
  const llCodes = seqs.map((s) => findCode(LL_BASELINE, LL_EXTRA, s.literalLength));
  const mlCodes = seqs.map((s) => findCode(ML_BASELINE, ML_EXTRA, s.matchLength));
  const ofCodes = seqs.map((s) => highbit(s.offsetValue));

  const llChain = fseStateChain(ll, llCodes);
  const mlChain = fseStateChain(ml, mlCodes);
  const ofChain = fseStateChain(of, ofCodes);

  const groups: BitGroup[] = [];
  groups.push({ value: llChain.states[0]!, nbits: ll.accuracyLog });
  groups.push({ value: ofChain.states[0]!, nbits: of.accuracyLog });
  groups.push({ value: mlChain.states[0]!, nbits: ml.accuracyLog });

  for (let i = 0; i < seqs.length; i++) {
    const s = seqs[i]!;
    const oc = ofCodes[i]!;
    groups.push({ value: s.offsetValue - 2 ** oc, nbits: oc });
    groups.push({ value: s.matchLength - ML_BASELINE[mlCodes[i]!]!, nbits: ML_EXTRA[mlCodes[i]!]! });
    groups.push({ value: s.literalLength - LL_BASELINE[llCodes[i]!]!, nbits: LL_EXTRA[llCodes[i]!]! });
    if (i + 1 < seqs.length) {
      groups.push({ value: llChain.rests[i]!, nbits: ll.numBits[llChain.states[i]!]! });
      groups.push({ value: mlChain.rests[i]!, nbits: ml.numBits[mlChain.states[i]!]! });
      groups.push({ value: ofChain.rests[i]!, nbits: of.numBits[ofChain.states[i]!]! });
    }
  }
  return writeReverseGroups(groups);
}

// ---- Huffman 权重 2 状态位流 ----

/**
 * 构造权重双状态流。m 个权重：偶数下标走 State1，奇数走 State2；
 * 两条链各建 (出现数 - 1) 个完整转移；末组之后 offset==0，截断转移读越界触发终止。
 */
export function buildWeightsBitstream(t: FseTable, weights: number[]): Uint8Array {
  const even = weights.filter((_, i) => i % 2 === 0);
  const odd = weights.filter((_, i) => i % 2 === 1);
  const c1 = fseStateChain(t, even);
  const c2 = fseStateChain(t, odd);

  const groups: BitGroup[] = [];
  groups.push({ value: c1.states[0]!, nbits: t.accuracyLog });
  groups.push({ value: c2.states[0]!, nbits: t.accuracyLog });
  const n1 = c1.rests.length;
  const n2 = c2.rests.length;
  for (let k = 0; k < Math.max(n1, n2); k++) {
    if (k < n1) groups.push({ value: c1.rests[k]!, nbits: t.numBits[c1.states[k]!]! });
    if (k < n2) groups.push({ value: c2.rests[k]!, nbits: t.numBits[c2.states[k]!]! });
  }
  // 终止行必须 ≥1 位（0 位时 offset 不会变负，解码器会多吐符号）
  const truncRow = weights.length % 2 === 0 ? c1.states[n1]! : c2.states[n2]!;
  if (t.numBits[truncRow]! === 0) throw new Error('buildWeightsBitstream: 终止行 0 位，需调整分布');
  return writeReverseGroups(groups);
}

// ---- Huffman 树描述与字面量流 ----

/** 从解码表提取每个符号的前缀码值。 */
export function hufCodes(t: HufTable): number[] {
  const codes = new Array<number>(256).fill(-1);
  for (let idx = 0; idx < t.symbols.length; idx++) {
    const s = t.symbols[idx]!;
    if (codes[s] === -1) codes[s] = idx >>> (t.maxBits - t.numBits[idx]!);
  }
  return codes;
}

function codeLength(t: HufTable, s: number): number {
  for (let i = 0; i < t.symbols.length; i++) if (t.symbols[i] === s) return t.numBits[i]!;
  throw new Error(`符号 ${s} 不在表中`);
}

/** 编码 Huffman 字面量流（逆序写码 + 结束标志）。 */
export function buildHufStream(t: HufTable, literals: Uint8Array): Uint8Array {
  const codes = hufCodes(t);
  const groups: BitGroup[] = [];
  for (let i = 0; i < literals.length; i++) {
    const s = literals[i]!;
    groups.push({ value: codes[s]!, nbits: codeLength(t, s) });
  }
  return writeReverseGroups(groups);
}

/** 直接表示的树描述（headerByte ≥ 128）。 */
export function writeHufDirectWeights(weights: number[]): Uint8Array {
  const n = weights.length;
  const bytes: number[] = [127 + n];
  for (let i = 0; i < n; i += 2) {
    const hi = weights[i]!;
    const lo = i + 1 < n ? weights[i + 1]! : 0;
    bytes.push((hi << 4) | lo);
  }
  return new Uint8Array(bytes);
}

/**
 * FSE 压缩权重的树描述（headerByte < 128）：覆盖所有用到的权重值的简单分布
 * （每个权重 p=2，余量给哑符号），写表描述 + 双状态位流。
 * 组合塞不进 127 字节或链构造失败时返回 null（调用方回退直接表示）。
 */
export function writeHufFseWeights(weights: number[]): Uint8Array | null {
  const used = [...new Set(weights)];
  if (used.some((w) => w > 11)) throw new Error('权重值必须 ≤ 11');
  let dummy = 12;
  while (dummy >= 0 && used.includes(dummy)) dummy--;
  if (dummy < 0) return null;
  const count = used.length + 1;
  let accuracy = Math.max(5, highbit(2 * count - 1) + 1);
  while (2 ** accuracy < 2 * count) accuracy++;
  if (accuracy > 6) return null;
  const norm = new Array<number>(13).fill(0);
  for (const w of used) norm[w] = 2;
  norm[dummy] = 2 ** accuracy - 2 * used.length;
  if (norm[dummy]! <= 0) return null;

  const desc = writeFseDescription(norm, accuracy);
  const table = buildFseTable(norm, 12, accuracy);
  let stream: Uint8Array;
  try {
    stream = buildWeightsBitstream(table, weights);
  } catch {
    return null;
  }
  const total = desc.length + stream.length;
  if (total > 127) return null;
  const out = new Uint8Array(1 + total);
  out[0] = total;
  out.set(desc, 1);
  out.set(stream, 1 + desc.length);
  return out;
}

/** 权重 → Huffman 表（转发 src 实现，保证写读同源）。 */
export function makeHufTable(weights: number[]): HufTable {
  return buildTableFromWeights(new Uint8Array(weights));
}

// ---- 通用字节工具 ----

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 把 value 以 LE 写入 n 字节（>32 位安全）。 */
function leBytes(value: number, n: number): number[] {
  const b: number[] = [];
  for (let i = 0; i < n; i++) b.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  return b;
}

// ---- literals 段 ----

export type LitSpec =
  | { type: 'raw'; data: Uint8Array }
  | { type: 'rle'; byte: number; count: number }
  | { type: 'huf1'; weights: number[]; literals: Uint8Array }
  | { type: 'huf4'; weights: number[]; literals: Uint8Array }
  | { type: 'treeless'; literals: Uint8Array }
  /** 故意无先前表的 treeless（流内容随意，用于测试解码器报错路径） */
  | { type: 'treeless-invalid'; literals: Uint8Array };

/** 编码 literals 段（头 + 树描述 + 流）。 */
export function buildLiterals(spec: LitSpec, prevTable?: HufTable): { bytes: Uint8Array; table: HufTable | null } {
  if (spec.type === 'raw') {
    const n = spec.data.length;
    if (n <= 31) return { bytes: concat(new Uint8Array([0 | (n << 3)]), spec.data), table: null };
    if (n <= 4095) {
      return { bytes: concat(new Uint8Array([0 | (1 << 2) | ((n & 0xf) << 4), n >>> 4]), spec.data), table: null };
    }
    return {
      bytes: concat(new Uint8Array([0 | (3 << 2) | (n & 0xf), ...leBytes(n >>> 4, 2)]), spec.data),
      table: null,
    };
  }
  if (spec.type === 'rle') {
    const n = spec.count;
    if (n <= 31) return { bytes: new Uint8Array([1 | (n << 3), spec.byte]), table: null };
    if (n <= 4095) {
      return { bytes: new Uint8Array([1 | (1 << 2) | ((n & 0xf) << 4), n >>> 4, spec.byte]), table: null };
    }
    return {
      bytes: new Uint8Array([1 | (3 << 2) | (n & 0xf), ...leBytes(n >>> 4, 2), spec.byte]),
      table: null,
    };
  }

  // Huffman 路径（头 = 位域 type(2) sf(2) regen(N) comp(N)，LSB-first 连续）
  let table: HufTable;
  let treeDesc: Uint8Array | null = null;
  if (spec.type === 'treeless-invalid') {
    // 写合法的 treeless 头 + 任意流字节（解码器应在"无先前表"处先报错）
    table = null as unknown as HufTable;
    const regen = spec.literals.length;
    const comp = Math.max(1, spec.literals.length + 1);
    const v = 3 | (0 << 2) | (regen << 4) + comp * 2 ** 14;
    const hdr = new Uint8Array(leBytes(v, 3));
    const payload = new Uint8Array(comp);
    payload.set(spec.literals.subarray(0, Math.min(regen, comp)), 0);
    return { bytes: concat(hdr, payload), table: null };
  } else if (spec.type === 'treeless') {
    if (!prevTable) throw new Error('treeless 需要先前表');
    table = prevTable;
  } else {
    table = makeHufTable(spec.weights);
    treeDesc = writeHufDirectWeights(spec.weights);
  }

  const fourStreams = spec.type === 'huf4';
  const streams = fourStreams ? buildHuf4Streams(table, spec.literals) : buildHufStream(table, spec.literals);
  const payload = treeDesc ? concat(treeDesc, streams) : streams;
  const regen = spec.literals.length;
  const comp = payload.length;

  const emit = (litType: number, sf: number, fieldBits: number): Uint8Array => {
    // 连续位域：低 2 位 type，次 2 位 sf，随后 regen、comp；总位宽 = 4 + 2×fieldBits
    let v = (litType & 3) | (sf << 2) | (regen << 4);
    v += comp * 2 ** (4 + fieldBits);
    const totalBytes = (4 + 2 * fieldBits + 7) >> 3;
    return new Uint8Array(leBytes(v, totalBytes));
  };

  const litType = spec.type === 'treeless' ? 3 : 2;
  if (!fourStreams) {
    if (comp > 1023 || regen > 1023) throw new Error('单流 literals 尺寸超 10 位域');
    return { bytes: concat(emit(litType, 0, 10), payload), table };
  }
  if (comp <= 1023 && regen <= 1023) return { bytes: concat(emit(litType, 1, 10), payload), table };
  if (comp <= 16383 && regen <= 16383) return { bytes: concat(emit(litType, 2, 14), payload), table };
  if (comp <= 262143 && regen <= 262143) return { bytes: concat(emit(litType, 3, 18), payload), table };
  throw new Error('literals 尺寸超 18 位域');
}

function buildHuf4Streams(table: HufTable, literals: Uint8Array): Uint8Array {
  const seg = Math.ceil(literals.length / 4);
  const enc = [
    buildHufStream(table, literals.subarray(0, seg)),
    buildHufStream(table, literals.subarray(seg, 2 * seg)),
    buildHufStream(table, literals.subarray(2 * seg, 3 * seg)),
    buildHufStream(table, literals.subarray(3 * seg)),
  ];
  const s1 = enc[0]!.length, s2 = enc[1]!.length, s3 = enc[2]!.length;
  const jump = new Uint8Array(leBytes(s1, 2).concat(leBytes(s2, 2), leBytes(s3, 2)));
  return concat(jump, enc[0]!, enc[1]!, enc[2]!, enc[3]!);
}

// ---- 序列段 ----

export type SeqTableMode =
  | 'predefined'
  | 'repeat'
  | { rle: number }
  | { fse: { norm: number[]; accuracyLog: number } };

export interface SeqSectionSpec {
  seqs: SeqSpec[];
  llMode?: SeqTableMode;
  ofMode?: SeqTableMode;
  mlMode?: SeqTableMode;
}

function encodeMode(m: SeqTableMode | undefined): number {
  if (m === 'predefined' || m === undefined) return 0;
  if (m === 'repeat') return 3;
  if ('rle' in m) return 1;
  return 2;
}

function tableFor(m: SeqTableMode | undefined): FseTable {
  if (m === 'predefined' || m === undefined) throw new Error('tableFor: predefined 用 predefinedTable() 显式传入');
  if (m === 'repeat') throw new Error('tableFor: repeat 用上一块的表');
  if ('rle' in m) {
    return { accuracyLog: 0, symbols: new Uint8Array([m.rle]), numBits: new Uint16Array([0]), newStateBase: new Uint16Array([0]) };
  }
  const maxSymbol = (() => {
    for (let s = m.fse.norm.length - 1; s >= 0; s--) if (m.fse.norm[s] !== 0) return s;
    return -1;
  })();
  return buildFseTable(m.fse.norm, maxSymbol, m.fse.accuracyLog);
}

/** 编码序列段（nbSeq + 模式字节 + 表描述 + 位流）。返回段字节与本块生效的三张表（nbSeq=0 时为 null）。 */
export function buildSeqSection(
  spec: SeqSectionSpec,
  prev?: { ll: FseTable; of: FseTable; ml: FseTable },
): { bytes: Uint8Array; tables: { ll: FseTable; of: FseTable; ml: FseTable } | null } {
  const n = spec.seqs.length;
  const head: number[] = [];
  if (n < 128) head.push(n);
  else if (n < 0x7f00) head.push(128 + (n >>> 8), n & 0xff);
  else {
    const v = n - 0x7f00;
    head.push(255, v & 0xff, v >>> 8);
  }
  if (n === 0) return { bytes: new Uint8Array(head), tables: null };

  const modes: SeqTableMode[] = [spec.llMode ?? 'predefined', spec.ofMode ?? 'predefined', spec.mlMode ?? 'predefined'];
  const modeByte = (encodeMode(modes[0]) << 6) | (encodeMode(modes[1]) << 4) | (encodeMode(modes[2]) << 2);
  const parts: Uint8Array[] = [new Uint8Array(head), new Uint8Array([modeByte])];

  const resolve = (m: SeqTableMode, which: 'll' | 'of' | 'ml'): FseTable => {
    if (m === 'predefined') return predefinedTable(which);
    if (m === 'repeat') {
      if (!prev) throw new Error('repeat 需要先前表');
      return prev[which];
    }
    return tableFor(m);
  };
  const ll = resolve(modes[0]!, 'll');
  const of = resolve(modes[1]!, 'of');
  const ml = resolve(modes[2]!, 'ml');

  for (const m of modes) {
    if (m !== 'predefined' && m !== 'repeat') {
      if ('rle' in m) parts.push(new Uint8Array([m.rle]));
      else parts.push(writeFseDescription(m.fse.norm, m.fse.accuracyLog));
    }
  }
  parts.push(buildSeqBitstream(ll, of, ml, spec.seqs));
  return { bytes: concat(...parts), tables: { ll, of, ml } };
}

// ---- 帧装配 ----

export interface FrameSpec {
  fcsFlag?: 0 | 1 | 2 | 3;
  singleSegment?: boolean;
  reservedBit?: boolean;
  checksum?: boolean;
  checksumValue?: number; // 校验标志开启时写入的低 32 位（缺省按内容现算）
  dictIdFlag?: 0 | 1 | 2 | 3;
  dictId?: number;
  windowDescriptor?: number;
  fcs?: number; // 写入帧头 FCS 字段的原始值（2 字节格式时调用方自行减 256）
  fcsBytes?: 0 | 1 | 2 | 4 | 8;
  blocks: BlockSpec[];
  trailer?: Uint8Array;
  magic?: Uint8Array; // 覆盖默认 magic（坏流用）
}

export type BlockSpec =
  | { type: 'raw'; data: Uint8Array; last?: boolean }
  | { type: 'rle'; byte: number; count: number; last?: boolean }
  | { type: 'compressed'; literals: LitSpec; seqs?: SeqSectionSpec; last?: boolean; prevTables?: { ll: FseTable; of: FseTable; ml: FseTable } }
  | { type: 'reserved'; size: number; last?: boolean };

export function frameChecksum(content: Uint8Array): number {
  return xxh64(content).low;
}

/** 装配完整帧。 */
export function buildFrame(spec: FrameSpec): Uint8Array {
  const singleSegment = spec.singleSegment ?? false;
  const checksum = spec.checksum ?? false;
  const dictIdFlag = spec.dictIdFlag ?? 0;
  const fcsFlag = spec.fcsFlag ?? 0;

  const fhd =
    (fcsFlag << 6) |
    ((singleSegment ? 1 : 0) << 5) |
    ((spec.reservedBit ? 1 : 0) << 3) |
    ((checksum ? 1 : 0) << 2) |
    dictIdFlag;

  const parts: Uint8Array[] = [spec.magic ?? new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), new Uint8Array([fhd])];
  if (!singleSegment) parts.push(new Uint8Array([spec.windowDescriptor ?? 0x00]));
  if (dictIdFlag !== 0) {
    const size = [0, 1, 2, 4][dictIdFlag]!;
    parts.push(new Uint8Array(leBytes(spec.dictId ?? 0, size)));
  }
  if (singleSegment || fcsFlag !== 0) {
    // FCS 域宽：flag 0 → 1（仅 singleSegment）；1 → 2；2 → 4；3 → 8
    const size = spec.fcsBytes ?? (singleSegment && fcsFlag === 0 ? 1 : [2, 4, 8][fcsFlag - 1]!);
    parts.push(new Uint8Array(leBytes(spec.fcs ?? 0, size)));
  }

  {
    // 逐块装配，跨块跟踪 Huffman 表与序列表（treeless / repeat 模式复用）
    let prevTable: HufTable | null = null;
    let prevSeqTables: { ll: FseTable; of: FseTable; ml: FseTable } | null = null;
    for (const blk of spec.blocks) {
      const built = buildBlock(blk, prevTable, prevSeqTables);
      prevTable = built.table ?? prevTable;
      prevSeqTables = built.seqTables ?? prevSeqTables;
      parts.push(built.bytes);
    }
  }
  if (checksum) {
    // 校验值：显式给出优先；否则对"预期内容"现算——由调用方传 checksumValue
    parts.push(new Uint8Array(leBytes(spec.checksumValue ?? 0, 4)));
  }
  if (spec.trailer) parts.push(spec.trailer);
  return concat(...parts);
}

function buildBlock(
  blk: BlockSpec,
  prevTable: HufTable | null,
  prevSeqTables: { ll: FseTable; of: FseTable; ml: FseTable } | null,
): { bytes: Uint8Array; table: HufTable | null; seqTables: { ll: FseTable; of: FseTable; ml: FseTable } | null } {
  const last = blk.last === true ? 1 : 0;
  let body: Uint8Array;
  let type: number;
  let table: HufTable | null = prevTable;
  let seqTables = prevSeqTables;
  if (blk.type === 'raw') {
    type = 0;
    body = blk.data;
  } else if (blk.type === 'rle') {
    type = 1;
    body = new Uint8Array([blk.byte]);
  } else if (blk.type === 'reserved') {
    type = 3;
    body = new Uint8Array(0);
    const bh = last | (type << 1) | (blk.size << 3);
    return { bytes: new Uint8Array([bh & 0xff, (bh >>> 8) & 0xff, (bh >>> 16) & 0xff]), table, seqTables };
  } else {
    type = 2;
    const lit = buildLiterals(blk.literals, prevTable ?? undefined);
    const seq = buildSeqSection(blk.seqs ?? { seqs: [] }, prevSeqTables ?? undefined);
    body = concat(lit.bytes, seq.bytes);
    table = lit.table ?? prevTable;
    if (seq.tables) seqTables = seq.tables;
  }
  const size = blk.type === 'rle' ? blk.count : body.length;
  const bh = last | (type << 1) | (size << 3);
  return { bytes: concat(new Uint8Array([bh & 0xff, (bh >>> 8) & 0xff, (bh >>> 16) & 0xff]), body), table, seqTables };
}
