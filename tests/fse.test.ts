/**
 * FSE 熵解码单元测试。
 * 锚点一：规范 Appendix A 预定义解码表（逐行对照，规范级 ground truth）。
 * 锚点二：tests/writers.ts 的写入器（解码方向的镜像实现）做写读往返。
 * 边界：RLE 表、单符号分布、最大精度、零游程链、"小于 1"概率、越界报错。
 */
import { describe, expect, it } from 'vitest';
import { BitReaderForward, BitReaderReverse } from '../src/bits.js';
import { buildFseTable, buildFseTableRle, fseDecodeInterleaved2, fsePeekSymbol, parseFseDescription, readFseTable } from '../src/fse.js';
import { LL_DEFAULT_DIST } from '../src/sequences.js';
import { buildWeightsBitstream, fseStateChain, writeFseDescription } from './writers.js';
import { prng } from './helpers.js';

// 规范 Appendix A 预定义表（[symbol, nbBits, baseline] 按状态序）
const APPENDIX_LL: [number, number, number][] = [
  [0, 4, 0], [0, 4, 16], [1, 5, 32], [3, 5, 0], [4, 5, 0], [6, 5, 0], [7, 5, 0], [9, 5, 0],
  [10, 5, 0], [12, 5, 0], [14, 6, 0], [16, 5, 0], [18, 5, 0], [19, 5, 0], [21, 5, 0], [22, 5, 0],
  [24, 5, 0], [25, 5, 32], [26, 5, 0], [27, 6, 0], [29, 6, 0], [31, 6, 0], [0, 4, 32], [1, 4, 0],
  [2, 5, 0], [4, 5, 32], [5, 5, 0], [7, 5, 32], [8, 5, 0], [10, 5, 32], [11, 5, 0], [13, 6, 0],
  [16, 5, 32], [17, 5, 0], [19, 5, 32], [20, 5, 0], [22, 5, 32], [23, 5, 0], [25, 4, 0], [25, 4, 16],
  [26, 5, 32], [28, 6, 0], [30, 6, 0], [0, 4, 48], [1, 4, 16], [2, 5, 32], [3, 5, 32], [5, 5, 32],
  [6, 5, 32], [8, 5, 32], [9, 5, 32], [11, 5, 32], [12, 5, 32], [15, 6, 0], [17, 5, 32], [18, 5, 32],
  [20, 5, 32], [21, 5, 32], [23, 5, 32], [24, 5, 32], [35, 6, 0], [34, 6, 0], [33, 6, 0], [32, 6, 0],
];
const APPENDIX_ML: [number, number, number][] = [
  [0, 6, 0], [1, 4, 0], [2, 5, 32], [3, 5, 0], [5, 5, 0], [6, 5, 0], [8, 5, 0], [10, 6, 0],
  [13, 6, 0], [16, 6, 0], [19, 6, 0], [22, 6, 0], [25, 6, 0], [28, 6, 0], [31, 6, 0], [33, 6, 0],
  [35, 6, 0], [37, 6, 0], [39, 6, 0], [41, 6, 0], [43, 6, 0], [45, 6, 0], [1, 4, 16], [2, 4, 0],
  [3, 5, 32], [4, 5, 0], [6, 5, 32], [7, 5, 0], [9, 6, 0], [12, 6, 0], [15, 6, 0], [18, 6, 0],
  [21, 6, 0], [24, 6, 0], [27, 6, 0], [30, 6, 0], [32, 6, 0], [34, 6, 0], [36, 6, 0], [38, 6, 0],
  [40, 6, 0], [42, 6, 0], [44, 6, 0], [1, 4, 32], [1, 4, 48], [2, 4, 16], [4, 5, 32], [5, 5, 32],
  [7, 5, 32], [8, 5, 32], [11, 6, 0], [14, 6, 0], [17, 6, 0], [20, 6, 0], [23, 6, 0], [26, 6, 0],
  [29, 6, 0], [52, 6, 0], [51, 6, 0], [50, 6, 0], [49, 6, 0], [48, 6, 0], [47, 6, 0], [46, 6, 0],
];
const APPENDIX_OF: [number, number, number][] = [
  [0, 5, 0], [6, 4, 0], [9, 5, 0], [15, 5, 0], [21, 5, 0], [3, 5, 0], [7, 4, 0], [12, 5, 0],
  [18, 5, 0], [23, 5, 0], [5, 5, 0], [8, 4, 0], [14, 5, 0], [20, 5, 0], [2, 5, 0], [7, 4, 16],
  [11, 5, 0], [17, 5, 0], [22, 5, 0], [4, 5, 0], [8, 4, 16], [13, 5, 0], [19, 5, 0], [1, 5, 0],
  [6, 4, 16], [10, 5, 0], [16, 5, 0], [28, 5, 0], [27, 5, 0], [26, 5, 0], [25, 5, 0], [24, 5, 0],
];

function checkAppendix(
  name: string,
  dist: number[],
  maxSymbol: number,
  accuracy: number,
  expected: [number, number, number][],
): void {
  it(`Appendix A · ${name}（${expected.length} 行逐项对照）`, () => {
    const t = buildFseTable(dist, maxSymbol, accuracy);
    expect(t.symbols.length).toBe(1 << accuracy);
    for (let i = 0; i < expected.length; i++) {
      const [sym, nb, base] = expected[i]!;
      expect(t.symbols[i], `state ${i} symbol`).toBe(sym);
      expect(t.numBits[i], `state ${i} nbBits`).toBe(nb);
      expect(t.newStateBase[i], `state ${i} baseline`).toBe(base);
    }
  });
}

describe('FSE 表构建 vs 规范 Appendix A', () => {
  checkAppendix('Literals Length（36 符号/精度 6）', [...LL_DEFAULT_DIST], 35, 6, APPENDIX_LL);
  checkAppendix('Match Length（53 符号/精度 6）',
    [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
      -1, -1, -1, -1, -1], 52, 6, APPENDIX_ML);
  checkAppendix('Offset（29 符号/精度 5）',
    [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 31, 5, APPENDIX_OF);

  it('"小于 1"符号全状态复位（nb = accuracy, base = 0）', () => {
    const t = buildFseTable([...LL_DEFAULT_DIST], 35, 6);
    // LL 分布的 -1 符号是 32..35，各占一行且行属性为全复位（注意 TypedArray.map 仍返回 TypedArray）
    const resetRows: { s: number; i: number }[] = [];
    for (let i = 0; i < t.symbols.length; i++) {
      if (t.symbols[i]! >= 32) resetRows.push({ s: t.symbols[i]!, i });
    }
    expect(resetRows.length).toBe(4);
    for (const r of resetRows) {
      expect(t.numBits[r.i]).toBe(6);
      expect(t.newStateBase[r.i]).toBe(0);
    }
  });
});

// ---- 描述往返（writer ↔ parser）----

/** 确定性 RNG。 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 0;
  };
}

/** 随机生成归一化分布（去重符号、保证 Σ=2^accuracy）。 */
function randomNorm(rand: () => number, accuracyLog: number, maxSymbol: number, pMinus1 = 0.15): number[] {
  const norm = new Array<number>(maxSymbol + 1).fill(0);
  let total = 1 << accuracyLog;
  const set = new Set<number>();
  while (set.size < Math.min(maxSymbol + 1, 2 + (rand() % 8))) {
    set.add(rand() % (maxSymbol + 1));
  }
  const symbols = [...set];
  for (let k = 0; k < symbols.length; k++) {
    const s = symbols[k]!;
    if (k === symbols.length - 1) {
      norm[s] = total; // 最后一个符号拿走全部余量，保证归一
    } else {
      const cap = total - (symbols.length - k - 1);
      norm[s] = 1 + (rand() % Math.max(1, cap - 1));
      norm[s] = Math.min(norm[s]!, cap);
      if (norm[s]! === 1 && rand() % 100 < pMinus1 * 100) norm[s] = -1;
    }
    total -= Math.abs(norm[s]!);
  }
  return norm;
}

function roundtrip(norm: number[], accuracyLog: number, maxSymbolValue: number, maxAccuracy: number): ReturnType<typeof parseFseDescription> {
  const bytes = writeFseDescription(norm, accuracyLog);
  const r = new BitReaderForward(bytes, 0, bytes.length);
  return parseFseDescription(r, maxSymbolValue, maxAccuracy);
}

/** 裁剪尾部 0（解析器按"最后非零符号"截断）。 */
function trimTail(norm: number[]): number[] {
  const out = [...norm];
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}

describe('FSE 描述写读往返', () => {
  for (const accuracyLog of [5, 6, 7, 8, 9]) {
    for (let seed = 1; seed <= 7; seed++) {
      const maxSymbol = 8 + ((seed * 13 + accuracyLog * 7) % 28);
      it(`精度 ${accuracyLog} / 种子 ${seed} / maxSymbol ${maxSymbol}`, () => {
        const rand = rng(seed * 7919 + accuracyLog);
        const norm = randomNorm(rand, accuracyLog, maxSymbol);
        const desc = roundtrip(norm, accuracyLog, maxSymbol, 9);
        expect(desc.accuracyLog).toBe(accuracyLog);
        expect(desc.norm).toEqual(trimTail(norm));
        expect(desc.maxSymbol).toBe(Math.max(...norm.map((p, i) => (p !== 0 ? i : -1))));
      });
    }
  }

  it('最小分布：两符号各半（精度 5）', () => {
    const desc = roundtrip([16, 16], 5, 255, 20);
    expect(desc.norm).toEqual([16, 16]);
  });

  it('单符号占满 + 1 点（RLE 型边界）', () => {
    const desc = roundtrip([31, 1], 5, 255, 20);
    expect(desc.norm).toEqual([31, 1]);
  });

  it('首符号为 0（previous0 从头开始）', () => {
    const desc = roundtrip([0, 3, 29], 5, 255, 20);
    expect(desc.norm).toEqual([0, 3, 29]);
  });

  it('零游程链：5 个连续 0（3+2 旗标）', () => {
    const norm = [20, 0, 0, 0, 0, 0, 12];
    const desc = roundtrip(norm, 5, 255, 20);
    expect(desc.norm).toEqual(norm);
  });

  it('零游程链：12 个连续 0（3+3+3+3 旗标）', () => {
    const norm = [20, ...new Array<number>(12).fill(0), 12];
    const desc = roundtrip(norm, 5, 255, 20);
    expect(desc.norm).toEqual(norm);
  });

  it('"小于 1"概率在最前', () => {
    const desc = roundtrip([-1, 31], 5, 255, 20);
    expect(desc.norm).toEqual([-1, 31]);
  });

  it('最大精度 9（序列表上限）', () => {
    const norm = new Array<number>(16).fill(0);
    norm[0] = 256;
    norm[1] = 256;
    const desc = roundtrip(norm, 9, 255, 9);
    expect(desc.accuracyLog).toBe(9);
    expect(desc.norm).toEqual(trimTail(norm));
  });
});

describe('FSE 描述非法输入（必须报错）', () => {
  it('概率不归一/流截断 → 报错', () => {
    const norm = [16, 16];
    const bytes = writeFseDescription(norm, 5);
    const cut = bytes.subarray(0, bytes.length - 1);
    const r = new BitReaderForward(cut, 0, cut.length);
    expect(() => parseFseDescription(r, 255, 20)).toThrow();
  });

  it('符号域越界（分布符号数超过 maxSymbolValue）', () => {
    const norm = [8, 8, 8, 8]; // 4 个非零符号
    const bytes = writeFseDescription(norm, 5);
    const r = new BitReaderForward(bytes, 0, bytes.length);
    expect(() => parseFseDescription(r, 1, 20)).toThrow();
  });

  it('精度超上限', () => {
    const norm = [16, 16];
    const bytes = writeFseDescription(norm, 5);
    const r = new BitReaderForward(bytes, 0, bytes.length);
    expect(() => parseFseDescription(r, 255, 4)).toThrow();
  });
});

// ---- 解码表 + 状态链 + 双状态权重流 ----

describe('FSE 状态链与双状态权重流往返', () => {
  it('RLE 表：恒定符号、0 位转移', () => {
    const t = buildFseTableRle(7);
    expect(fsePeekSymbol(t, 0)).toBe(7);
    expect(t.numBits[0]).toBe(0);
    expect(t.newStateBase[0]).toBe(0);
  });

  for (let seed = 1; seed <= 12; seed++) {
    it(`随机权重列表往返 #${seed}`, () => {
      const rand = rng(seed * 104729);
      const accuracyLog = 5 + (seed % 3); // 5..7 → 权重上限 6
      const normLen = 2 + (seed % 4);
      const norm = new Array<number>(13).fill(0);
      let total = 1 << accuracyLog;
      const symSet = new Set<number>();
      while (symSet.size < Math.min(normLen, 4)) symSet.add(rand() % 12);
      const syms = [...symSet];
      for (let k = 0; k < syms.length; k++) {
        const p = k === syms.length - 1 ? total : 1 + (rand() % Math.max(1, total - syms.length));
        norm[syms[k]!] = p;
        total -= p;
      }
      if (total !== 0) norm[syms[0]!]! += total;
      const table = buildFseTable(norm, 12, accuracyLog);
      // 随机权重列表（符号必须在表内有概率）
      const present: number[] = [];
      for (let i = 0; i < norm.length; i++) if (norm[i]! !== 0 && i <= 11) present.push(i);
      const m = 2 + (rand() % 20);
      const weights: number[] = [];
      for (let i = 0; i < m; i++) weights.push(present[rand() % present.length]!);
      const stream = buildWeightsBitstream(table, weights);
      const rev = new BitReaderReverse(stream, 0, stream.length);
      const out = fseDecodeInterleaved2(table, rev, 255);
      expect([...out]).toEqual(weights);
    });
  }

  it('权重流输出超限（>255）报错', () => {
    const norm = [16, 16];
    const table = buildFseTable(norm, 1, 5);
    const stream = buildWeightsBitstream(table, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    const rev = new BitReaderReverse(stream, 0, stream.length);
    expect(() => fseDecodeInterleaved2(table, rev, 5)).toThrow();
  });

  it('截断初始状态（参考 v1.5.6 勘误）报错', () => {
    const norm = [16, 16];
    const table = buildFseTable(norm, 1, 5);
    const stream = buildWeightsBitstream(table, [0, 1, 0, 1]);
    // 截掉尾部若干字节使初始状态不足
    const cut = stream.subarray(0, Math.max(1, stream.length - 2));
    const rev = new BitReaderReverse(cut, 0, cut.length);
    expect(() => fseDecodeInterleaved2(table, rev, 255)).toThrow();
  });

  it('状态链可行性：任意符号序列均能编码（覆盖定理实证）', () => {
    const norm = [3, 5, 8, 16]; // Σ=32
    const table = buildFseTable(norm, 3, 5);
    const rand = rng(42);
    for (let i = 0; i < 200; i++) {
      const seq: number[] = [];
      for (let k = 0; k < 10; k++) {
        // 只选有概率的符号
        const cands = norm.map((p, s) => (p !== 0 ? s : -1)).filter((s) => s >= 0);
        seq.push(cands[rand() % cands.length]!);
      }
      expect(() => fseStateChain(table, seq), `序列 ${seq.join(',')}`).not.toThrow();
    }
  });
});

describe('readFseTable 一条龙（描述 → 表）', () => {
  it('与分布直建一致', () => {
    const norm = [7, 0, 0, 0, 9, 16];
    const bytes = writeFseDescription(norm, 5);
    const r = new BitReaderForward(bytes, 0, bytes.length);
    const t = readFseTable(r, 5, 9);
    const direct = buildFseTable(norm, 5, 5);
    expect([...t.symbols]).toEqual([...direct.symbols]);
    expect([...t.numBits]).toEqual([...direct.numBits]);
    expect([...t.newStateBase]).toEqual([...direct.newStateBase]);
  });
});
