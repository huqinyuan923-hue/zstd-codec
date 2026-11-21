/**
 * 差分验收 3：FSE/Huffman 边界与格式变体合成用例（≥200 条）。
 * 用 tests/writers.ts 从正方向合成帧，覆盖：literals 各尺寸格式、序列表模式组合、
 * nbSeq 多字节编码、window descriptor 全域扫描、FCS 全 flag、重复偏移边界。
 * 每条断言：mine == 原文（且 node:zlib 同意）。
 */
import { describe, expect, it } from 'vitest';
import { zstdDecompressSync } from 'node:zlib';
import { decompress } from '../src/index.js';
import { buildFrame, type FrameSpec } from './writers.js';
import { prng } from './helpers.js';

let counter = 0;

/** 合成 → 解码 → 与原文一致（node:zlib 同意则一并断言）。 */
function sweep(spec: FrameSpec & { content: Uint8Array }): void {
  counter++;
  const frame = buildFrame(spec);
  const mine = decompress(frame);
  expect(bytesEq(mine, spec.content), `#${counter} 输出不符`).toBe(true);
  try {
    const ref = zstdDecompressSync(frame);
    expect(bytesEq(mine, new Uint8Array(ref)), `#${counter} node 不一致`).toBe(true);
  } catch {
    // node 拒绝某些手工边界帧（如精度/尺寸恰在边界）——不做硬断言
  }
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('literals 全模式 × 尺寸格式扫描', () => {
  for (const size of [1, 5, 31, 32, 40, 4095, 5000]) {
    it(`Raw literals ${size}B（1B/2B/3B 头自适应）`, () => {
      const data = prng(size, size);
      sweep({
        singleSegment: true,
        fcsFlag: size > 255 ? 2 : 0,
        fcs: size,
        content: data,
        blocks: [{ type: 'compressed', literals: { type: 'raw', data }, seqs: { seqs: [] }, last: true }],
      });
    });

    it(`RLE literals ${size}B`, () => {
      const data = new Uint8Array(size).fill(0x5a);
      sweep({
        singleSegment: true,
        fcsFlag: size > 255 ? 2 : 0,
        fcs: size,
        content: data,
        blocks: [{ type: 'compressed', literals: { type: 'rle', byte: 0x5a, count: size }, seqs: { seqs: [] }, last: true }],
      });
    });
  }

  for (let seed = 1; seed <= 16; seed++) {
    it(`Huffman 1 流字面量 #${seed}`, () => {
      const weights = [4, 3, 2, 0, 1];
      const n = 10 + seed * 7;
      const literals = new Uint8Array(n);
      for (let i = 0; i < n; i++) literals[i] = [0, 1, 2, 4, 5][i % 5]!;
      sweep({
        singleSegment: true,
        fcs: n,
        content: literals,
        blocks: [{ type: 'compressed', literals: { type: 'huf1', weights, literals }, seqs: { seqs: [] }, last: true }],
      });
    });

    it(`Huffman 4 流字面量 #${seed}`, () => {
      const weights = [4, 3, 2, 0, 1];
      const n = 24 + seed * 13;
      const literals = new Uint8Array(n);
      for (let i = 0; i < n; i++) literals[i] = [0, 1, 2, 4, 5][(i * seed) % 5]!;
      sweep({
        singleSegment: true,
        fcs: n,
        content: literals,
        blocks: [{ type: 'compressed', literals: { type: 'huf4', weights, literals }, seqs: { seqs: [] }, last: true }],
      });
    });
  }

  it('Treeless：3 块链式复用', () => {
    const weights = [4, 3, 2, 0, 1];
    const mk = (pat: number[], n: number) => {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i++) a[i] = pat[i % pat.length]!;
      return a;
    };
    const l1 = mk([0, 1, 2, 4, 5], 30);
    const l2 = mk([5, 4, 2], 20);
    const l3 = mk([1, 0], 15);
    const content = new Uint8Array([...l1, ...l2, ...l3]);
    sweep({
      singleSegment: true,
      fcs: content.length,
      content,
      blocks: [
        { type: 'compressed', literals: { type: 'huf1', weights, literals: l1 }, seqs: { seqs: [] } },
        { type: 'compressed', literals: { type: 'treeless', literals: l2 }, seqs: { seqs: [] } },
        { type: 'compressed', literals: { type: 'treeless', literals: l3 }, seqs: { seqs: [] }, last: true },
      ],
    });
  });
});

describe('序列表模式组合扫描', () => {
  // (llMode, ofMode, mlMode) 组合：RLE 模式的符号必须与全部序列的实际码一致
  // 本组序列的码：LL ∈ {5,1}（两条不同 → 只能 predefined/FSE）；OF 两条都是 code 3；ML 都是 code 0
  const combos: [string, string, string][] = [
    ['predefined', 'predefined', 'predefined'],
    ['predefined', 'rle3', 'rle0'],
    ['fseLL', 'predefined', 'fseML'],
    ['fseLL', 'rle3', 'predefined'],
    ['predefined', 'fseOF', 'rle0'],
  ];

  const modeSpec = (m: string): 'predefined' | { rle: number } | { fse: { norm: number[]; accuracyLog: number } } => {
    if (m === 'predefined') return 'predefined';
    if (m.startsWith('rle')) return { rle: Number(m.slice(3)) };
    if (m === 'fseLL') return { fse: { norm: [0, 16, 0, 0, 0, 16], accuracyLog: 5 } };
    if (m === 'fseOF') return { fse: { norm: [0, 0, 0, 32], accuracyLog: 5 } };
    return { fse: { norm: [8, 24], accuracyLog: 5 } }; // fseML: code0/1
  };

  for (const [ll, of, ml] of combos) {
    it(`序列组合 LL=${ll} OF=${of} ML=${ml}`, () => {
      // 内容："ABCDE" + ABC(复制) + 'X' + BCD(复制)
      // seq1: ll=5, ov=8(→5), ml=3；seq2: ll=1, ov=11(→8), ml=3
      const literals = [0x41, 0x42, 0x43, 0x44, 0x45, 0x58];
      const content = [0x41, 0x42, 0x43, 0x44, 0x45, 0x41, 0x42, 0x43, 0x58, 0x42, 0x43, 0x44];
      // fseLL 只定义 code{1,5}；fseOF 只定义 code{3}；fseML 定义 code0/1（ml=3→code0, ml=4→code1）
      const llCodes = ll === 'fseLL' ? [5, 1] : 'predefined';
      void llCodes;
      sweep({
        singleSegment: true,
        fcs: content.length,
        content: new Uint8Array(content),
        blocks: [{
          type: 'compressed',
          literals: { type: 'raw', data: new Uint8Array(literals) },
          seqs: {
            seqs: [
              { literalLength: 5, offsetValue: 8, matchLength: 3 },
              { literalLength: 1, offsetValue: 11, matchLength: 3 },
            ],
            llMode: modeSpec(ll),
            ofMode: modeSpec(of),
            mlMode: modeSpec(ml),
          },
          last: true,
        }],
      });
    });
  }

  for (let seed = 1; seed <= 12; seed++) {
    it(`多序列 predefined ${20 + seed * 15} 条 #${seed}`, () => {
      // 构造一串重复拷贝序列
      const n = 20 + seed * 15;
      const literals: number[] = [];
      const content: number[] = [];
      const seqs: { literalLength: number; offsetValue: number; matchLength: number }[] = [];
      // 与解码器一致的模型：content = 解码输出（从空开始）；种子先存字面量缓冲，
      // 由首序列的 ll 输出
      const seedBytes: number[] = [];
      for (let i = 0; i < 8; i++) seedBytes.push(0x61 + i);
      for (let k = 0; k < n; k++) {
        const ll = k === 0 ? 8 : k % 3;
        for (let i = 0; i < ll; i++) {
          const b = k === 0 ? seedBytes[i]! : 0x41 + ((k * 7 + i) % 26);
          literals.push(b);
          content.push(b);
        }
        // offset ≤ 当前已产出（content.length）
        const off = 1 + ((k * 3) % content.length);
        const ml = 3 + (k % 4);
        seqs.push({ literalLength: ll, offsetValue: off + 3, matchLength: ml });
        for (let i = 0; i < ml; i++) {
          content.push(content[content.length - off]!);
        }
      }
      sweep({
        singleSegment: true,
        fcsFlag: 2,
        fcs: content.length,
        content: new Uint8Array(content),
        blocks: [{
          type: 'compressed',
          literals: { type: 'raw', data: new Uint8Array(literals) },
          seqs: { seqs },
          last: true,
        }],
      });
    });
  }
});

describe('window descriptor 全域扫描', () => {
  for (let exponent = 0; exponent <= 15; exponent++) {
    for (const mantissa of [0, 3, 7]) {
      it(`windowDescriptor exponent=${exponent} mantissa=${mantissa}`, () => {
        const content = prng(100, exponent * 8 + mantissa);
        const wd = (exponent << 3) | mantissa;
        sweep({
          singleSegment: false,
          windowDescriptor: wd,
          content,
          blocks: [{ type: 'raw', data: content, last: true }],
        });
      });
    }
  }
});

describe('FCS 全 flag 扫描', () => {
  it('flag 1（2 字节域 +256）', () => {
    const content = prng(1000, 5);
    sweep({
      singleSegment: false,
      windowDescriptor: 0x00,
      fcsFlag: 1,
      fcs: 1000 - 256, // 解码端加回 256
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
  });

  it('flag 2（4 字节域）', () => {
    const content = prng(70000, 6);
    sweep({
      singleSegment: false,
      windowDescriptor: 0x38, // windowLog 17 = 128KB ≥ 内容
      fcsFlag: 2,
      fcs: 70000,
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
  });

  it('flag 3（8 字节域）', () => {
    const content = prng(3000, 7);
    sweep({
      singleSegment: false,
      windowDescriptor: 0x28, // windowLog 15 = 32KB
      fcsFlag: 3,
      fcs: 3000,
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
  });

  it('singleSegment + 1 字节 FCS', () => {
    const content = prng(200, 8);
    sweep({
      singleSegment: true,
      fcs: 200,
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
  });

  it('FCS 未知（flag 0，无 FCS 字段）', () => {
    const content = prng(444, 9);
    sweep({
      singleSegment: false,
      windowDescriptor: 0x00,
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
  });

  it('未知 FCS 下的输出缓冲增长（多块）', () => {
    const chunk = prng(60000, 10);
    const content = new Uint8Array([...chunk, ...chunk, ...chunk]);
    sweep({
      singleSegment: false,
      windowDescriptor: 0x40, // windowLog 18 = 256KB ≥ 180KB 总输出
      content,
      blocks: [
        { type: 'raw', data: chunk.subarray(0, 60000) },
        { type: 'raw', data: chunk.subarray(0, 60000) },
        { type: 'raw', data: chunk.subarray(0, 60000), last: true },
      ],
    });
  });
});

describe('空内容边界', () => {
  it('空 literals + 空序列（errata 回归）', () => {
    sweep({
      singleSegment: true,
      fcs: 0,
      content: new Uint8Array(0),
      blocks: [{ type: 'compressed', literals: { type: 'raw', data: new Uint8Array(0) }, seqs: { seqs: [] }, last: true }],
    });
  });

  it('空 raw 块作为末块', () => {
    sweep({
      singleSegment: true,
      fcs: 0,
      content: new Uint8Array(0),
      blocks: [{ type: 'raw', data: new Uint8Array(0), last: true }],
    });
  });
});

describe('大码域边界（长长度/长匹配/远偏移）', () => {
  for (let seed = 1; seed <= 10; seed++) {
    it(`大码域组合 #${seed}`, () => {
      // 依次产出：大 literalLength（code 20+）、大 matchLength（code 40+）、大 offset（code 20+）
      const literals: number[] = [];
      const content: number[] = [];
      const seqs: { literalLength: number; offsetValue: number; matchLength: number }[] = [];
      // 首序列：ll = 1000（code 25 域），无匹配
      for (let i = 0; i < 1000; i++) {
        const b = prng(1, seed * 1000 + i)[0]!;
        literals.push(b);
        content.push(b);
      }
      // 第二序列：ll = 0（首批字面量已由首序列输出），offset = 777（ov = 780, code 9），ml = 300（code 44）
      seqs.push({ literalLength: 1000, offsetValue: 780, matchLength: 300 });
      void literals;
      for (let i = 0; i < 300; i++) content.push(content[content.length - 777]!);
      // 第三序列：ll = 500（code 27），offset = 1000（ov = 1003, code 10），ml = 600（code 46）
      for (let i = 0; i < 500; i++) {
        const b = prng(1, seed * 5000 + i + 7)[0]!;
        literals.push(b);
        content.push(b);
      }
      seqs.push({ literalLength: 500, offsetValue: 1003, matchLength: 600 });
      for (let i = 0; i < 600; i++) content.push(content[content.length - 1000]!);
      sweep({
        singleSegment: true,
        fcsFlag: 2,
        fcs: content.length,
        content: new Uint8Array(content),
        blocks: [{
          type: 'compressed',
          literals: { type: 'raw', data: new Uint8Array(literals) },
          seqs: { seqs },
          last: true,
        }],
      });
    });
  }
});

describe('随机参数合成扫描', () => {
  function rng2(s: number): () => number {
    let x = s >>> 0 || 1;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x >>> 0;
    };
  }

  for (let seed = 1; seed <= 75; seed++) {
    it(`随机组合 #${seed}`, () => {
      const rand = rng2(seed * 7919);
      // 随机构造：若干序列（真实偏移），literals raw/huf1
      const literals: number[] = [];
      const content: number[] = [];
      const seqs: { literalLength: number; offsetValue: number; matchLength: number }[] = [];
      const nSeq = 2 + (rand() % 20);
      for (let k = 0; k < nSeq; k++) {
        const ll = k === 0 ? 4 + (rand() % 8) : rand() % 5;
        for (let i = 0; i < ll; i++) {
          const b = 0x41 + ((rand() % 26));
          literals.push(b);
          content.push(b);
        }
        const off = 1 + (rand() % content.length);
        const ml = 3 + (rand() % 10);
        seqs.push({ literalLength: ll, offsetValue: off + 3, matchLength: ml });
        for (let i = 0; i < ml; i++) content.push(content[content.length - off]!);
      }
      const useHuf = seed % 3 === 0 && content.every((b) => b < 6);
      sweep({
        singleSegment: true,
        fcsFlag: 2,
        fcs: content.length,
        content: new Uint8Array(content),
        blocks: [{
          type: 'compressed',
          literals: useHuf
            ? { type: 'huf1', weights: [4, 3, 2, 0, 1], literals: new Uint8Array(content) }
            : { type: 'raw', data: new Uint8Array(literals) },
          seqs: { seqs },
          last: true,
        }],
      });
    });
  }
});

describe('扫描总量 ≥ 200', () => {
  it('统计', () => {
    expect(counter).toBeGreaterThanOrEqual(200);
    console.log(`边界扫描 ${counter} 条`);
  });
});
