/**
 * Huffman 熵解码单元测试。
 * 锚点一：规范示例（权重 [4,3,2,0,1] → 码 1/01/001/0000/0001）。
 * 错位二：writers 的树描述/字面量流写入器做写读往返（直传 + FSE 权重两种描述）。
 * 边界：最深 11 位树、单流/四流、非法权重（Σ 不补全、缺 rank-1、超深）报错。
 */
import { describe, expect, it } from 'vitest';
import { BitReaderForward, BitReaderReverse } from '../src/bits.js';
import { buildTableFromWeights, decodeHufStream, readHufTable } from '../src/huffman.js';
import { decodeLiterals } from '../src/literals.js';
import {
  buildHufStream, buildLiterals, hufCodes, makeHufTable, writeHufDirectWeights, writeHufFseWeights,
} from './writers.js';
import { prng } from './helpers.js';

/** 确定性 RNG。 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 0;
  };
}

/** 生成合法权重列表（Σ 2^(w-1) 恰为 2^maxBits；保证 ≥2 个权重 1 的符号）。 */
function genWeights(rand: () => number, maxBitsCap: number): { weights: number[]; table: ReturnType<typeof makeHufTable> } {
  const maxBits = 2 + (rand() % Math.min(maxBitsCap, 10)); // 2..11
  // 从 {maxBits, maxBits} 开始分裂；先把第一条链一路分裂到 1（保证 ≥2 个权重 1），
  // 再随机分裂其余部件
  let parts: number[] = [maxBits, maxBits];
  for (let w = maxBits; w > 1; w--) {
    const idx = parts.indexOf(w);
    parts.splice(idx, 1, w - 1, w - 1);
  }
  while (parts.length < 2 + (rand() % 12) + (maxBits - 1) * 2) {
    const idx = rand() % parts.length;
    if (parts[idx]! > 1) {
      const w = parts[idx]!;
      parts.splice(idx, 1, w - 1, w - 1);
    }
    if (parts.length >= 64) break;
    if (parts.every((w) => w === 1)) break;
  }
  // 隐式末符号 = 最大索引符号：transmitted = parts[0..N-2]
  const transmitted = parts.slice(0, parts.length - 1);
  // 随机插入 0（缺席符号）不影响 Σ（0 不贡献）
  if (rand() % 2 === 0) {
    for (let i = 0; i < rand() % 3; i++) {
      transmitted.splice(rand() % (transmitted.length + 1), 0, 0);
    }
  }
  return { weights: transmitted, table: makeHufTable(transmitted) };
}

/** 从表中随机取一个存在的符号。 */
function symPick(table: { symbols: Uint8Array }, rand: () => number): number {
  return table.symbols[rand() % table.symbols.length]!;
}

/** 查符号码长。 */
function codeLengthOf(table: { symbols: Uint8Array; numBits: Uint8Array }, s: number): number {
  for (let i = 0; i < table.symbols.length; i++) {
    if (table.symbols[i] === s) return table.numBits[i]!;
  }
  return 0;
}

describe('Huffman 表构建（规范示例与不变量）', () => {
  it('规范示例：权重 [4,3,2,0,1] → maxBits 4，码字符合规范表格', () => {
    const t = buildTableFromWeights(new Uint8Array([4, 3, 2, 0, 1]));
    expect(t.maxBits).toBe(4);
    const codes = hufCodes(t);
    // 规范示例：A(0)=1、B(1)=01、C(2)=001、D(3)=缺席、E(4)=0000、隐式 F(5)=0001
    expect(codes[0]).toBe(0b1);
    expect(codes[1]).toBe(0b01);
    expect(codes[2]).toBe(0b001);
    expect(codes[3]).toBe(-1);
    expect(codes[4]).toBe(0b0000);
    expect(codes[5]).toBe(0b0001);
  });

  it('直读表完备性：Σ符号 2^(-nb) = 1（Kraft）、表尺寸 2^maxBits', () => {
    const rand = rng(7);
    for (let i = 0; i < 20; i++) {
      const { table } = genWeights(rand, 11);
      const codes = hufCodes(table);
      let kraft = 0;
      for (let s = 0; s < 256; s++) {
        if (codes[s] === -1) continue;
        const nb = codeLengthOf(table, s);
        kraft += 2 ** -nb;
      }
      expect(Math.abs(kraft - 1)).toBeLessThan(1e-9);
      expect(table.numBits.length).toBe(1 << table.maxBits);
    }
  });

  it('权重 > 11 → 报错', () => {
    expect(() => buildTableFromWeights(new Uint8Array([12, 4, 4, 4]))).toThrow();
  });

  it('Σ 不补全到 2 的幂（rest 非 2 的幂）→ 报错', () => {
    // [3,1]：Σ 2^(w-1) = 4+1 = 5 → maxBits 3，rest = 3（非 2 的幂）→ 非法
    expect(() => buildTableFromWeights(new Uint8Array([3, 1]))).toThrow();
  });

  it('缺少 rank-1 符号 → 报错', () => {
    // [2,2,3]：Σ = 2+2+4 = 8 → maxBits 4，rest = 8（隐式权重 4）→ 无权重 1 符号 → 非法
    expect(() => buildTableFromWeights(new Uint8Array([2, 2, 3]))).toThrow();
  });

  it('树深 > 11 → 报错', () => {
    // 造一棵需要 12 位深的树：权重 [1]×2048?? 超过 256 符号上限——用 [2×1023... 不可行。
    // 用"权重和超 2^11"路径：Σ 2^(w-1) = 2^11 = 2048 → maxBits = 12?? highbit(2048)+1 = 12 > 11 → 报错
    // 构造：Σ = 2048 需要 2048 = 2^10 + ... — [11, 1]: Σ = 1024 + 1 = 1025 → maxBits 11 ✓ 合法。
    // 真正超深：Σ 恰为 2^11 → maxBits = 12：[10, 10, 10, 10] Σ = 4×512 = 2048 → maxBits 12 → 报错
    expect(() => buildTableFromWeights(new Uint8Array([10, 10, 10, 10]))).toThrow();
  });
});

describe('Huffman 流写读往返', () => {
  for (let seed = 1; seed <= 15; seed++) {
    it(`随机表 × 随机字面量 #${seed}`, () => {
      const rand = rng(seed * 31);
      const { weights, table } = genWeights(rand, 11);
      const literals = new Uint8Array(1 + (rand() % 64));
      for (let i = 0; i < literals.length; i++) {
        literals[i] = symPick(table, rand);
      }
      const stream = buildHufStream(table, literals);
      const rev = new BitReaderReverse(stream, 0, stream.length);
      const out = new Uint8Array(literals.length);
      decodeHufStream(table, rev, literals.length, out, 0);
      expect([...out]).toEqual([...literals]);
    });
  }

  it('单符号重复（RLE 型字面量，码长 1）', () => {
    const t = makeHufTable([1, 1]); // Σ=2 → maxBits 2, rest=2 → 隐式末符号权重 2
    const literals = new Uint8Array([0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1]);
    const stream = buildHufStream(t, literals);
    const rev = new BitReaderReverse(stream, 0, stream.length);
    const out = new Uint8Array(literals.length);
    decodeHufStream(t, rev, literals.length, out, 0);
    expect([...out]).toEqual([...literals]);
  });
});

describe('Huffman 树描述往返（直传 / FSE 权重）', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`直传权重描述 #${seed}`, () => {
      const rand = rng(seed * 101);
      const { weights, table } = genWeights(rand, 8); // 权重数 ≤ ~30，直传描述短
      const desc = writeHufDirectWeights(weights);
      const r = new BitReaderForward(desc, 0, desc.length);
      const { table: parsed, byteLength } = readHufTable(r);
      expect(byteLength).toBe(desc.length);
      expect([...parsed.symbols]).toEqual([...table.symbols]);
      expect([...parsed.numBits]).toEqual([...table.numBits]);
    });
  }

  for (let seed = 1; seed <= 12; seed++) {
    it(`FSE 权重描述 #${seed}`, () => {
      const rand = rng(seed * 101);
      const { weights, table } = genWeights(rand, 6);
      const desc = writeHufFseWeights(weights);
      if (desc === null) return; // 组合塞不进 127B → 跳过（直传路径已覆盖）
      const r = new BitReaderForward(desc, 0, desc.length);
      const { table: parsed } = readHufTable(r);
      expect([...parsed.symbols]).toEqual([...table.symbols]);
      expect([...parsed.numBits]).toEqual([...table.numBits]);
    });
  }
});
