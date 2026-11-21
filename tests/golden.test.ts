/**
 * 官方语料与勘误帧测试。
 * golden 语料是官方"历轮解码器 bug 回归样本"（spec 级裁判）；
 * errata 手造帧来自 doc/decompressor_errata.md（每条对应一次真实解码器 bug）。
 * 带 Content_Checksum 的帧自带端到端正确性证据（XXH64 不通过即抛错）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decompress } from '../src/index.js';
import { bytesEqual, getOracle, hex, nodeZstd, oracleDecompress, prng } from './helpers.js';

const GOLDEN = join(import.meta.dirname, 'fixtures/golden');

const GOLDEN_FILES = [
  'block-128k.zst',
  'empty-block.zst',
  'rle-first-block.zst',
  'zeroSeq_2B.zst',
] as const;

const GOLDEN_ERROR_FILES = [
  'errors/off0.bin.zst',
  'errors/truncated_huff_state.zst',
  'errors/zeroSeq_extraneous.zst',
] as const;

describe('官方 golden 解压语料', () => {
  for (const f of GOLDEN_FILES) {
    it(`解码 ${f}（无异常 + 与 node:zlib / oracle 逐字节相等）`, async () => {
      const data = new Uint8Array(readFileSync(join(GOLDEN, f)));
      const out = decompress(data);
      // 独立裁判一：node:zlib（现代 zstd，接受全部勘误修复帧）
      const expected = nodeZstd(data);
      expect(expected, 'node:zlib 应能解码官方语料').not.toBeNull();
      expect(bytesEqual(out, expected!), `${f} 与 node:zlib 不一致`).toBe(true);
      // 独立裁判二：wasm oracle（内嵌 zstd 版本早于勘误修复，仅对它接受的帧对拍）
      const wasm = await oracleDecompress(data);
      if (wasm !== null) {
        expect(bytesEqual(out, wasm), `${f} 与 wasm oracle 不一致`).toBe(true);
      }
    });
  }

  it('block-128k.zst 触发 128KB 压缩块路径', () => {
    const data = new Uint8Array(readFileSync(join(GOLDEN, 'block-128k.zst')));
    // 勘误：压缩块 Block_Size 恰为 128KB 合法 —— 输出应 > 0 且不抛错
    const out = decompress(data);
    expect(out.length).toBeGreaterThan(0);
  });

  it('rle-first-block.zst：首块 RLE 大块路径', () => {
    const out = decompress(new Uint8Array(readFileSync(join(GOLDEN, 'rle-first-block.zst'))));
    expect(out.length).toBe(1048576);
  });
});

describe('官方 golden 坏流语料（必须抛错）', () => {
  for (const f of GOLDEN_ERROR_FILES) {
    it(`拒绝 ${f}`, () => {
      const data = new Uint8Array(readFileSync(join(GOLDEN, f)));
      expect(() => decompress(data)).toThrow();
    });
  }
});

describe('勘误文档手造帧', () => {
  it('压缩块 0 literals + 0 sequences → 空输出（errata v1.5.2 修复项）', () => {
    const frame = hex('28b5 2ffd 2000 1500 0000 00');
    expect(decompress(frame).length).toBe(0);
  });

  it('首块 RLE 131072 + 次块 RLE 1（errata v1.4.3 CLI 修复项）', () => {
    const frame = hex('28b5 2ffd a001 0002 0002 0010 000b 0000 00');
    const out = decompress(frame);
    expect(out.length).toBe(131073);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('微型 FSE 表 + 1 字节位流块（errata v1.3.4 修复项）', () => {
    const frame = hex('28b5 2ffd 2027 c500 0080 f3f1 f0ec ebc6 c5c7 f09d 4300 0000 e0e0 0658 0100 603e 52');
    const out = decompress(frame);
    expect(out.length).toBeGreaterThan(0);
  });

  it('offset==0 用例（ll=0, offset_value=3, rep1=1）→ corrupt（errata v1.5.5 修复项）', () => {
    const frame = hex('28b5 2ffd 0000 4500 0008 0002 002f 430b ae');
    expect(() => decompress(frame)).toThrow(/Repeated_Offset1|损坏|损坏/);
  });

  it('截断 Huffman 权重初始状态 → corrupt（errata v1.5.6 修复项）', () => {
    const frame = hex('28b5 2ffd 0000 5500 0072 8001 0420 7e1f 02aa 00');
    expect(() => decompress(frame)).toThrow();
  });

  it('magicless 帧头（27b5 2ffd）→ 报错（二期）', () => {
    const frame = hex('27 b5 2f fd 00 03 19 00 00 66 6f 6f 3f ba c4 59');
    expect(() => decompress(frame)).toThrow();
  });
});

describe('oracle 压缩帧基础往返', () => {
  it('随机 64KB × level 9 逐字节相等', async () => {
    const { simple } = await getOracle();
    const data = prng(65536, 123);
    const compressed = simple.compress(data, 9);
    expect(bytesEqual(decompress(compressed), data)).toBe(true);
  });

  it('文本 256KB × level 19 逐字节相等', async () => {
    const { simple } = await getOracle();
    const data = prng(0) && textyBytes();
    void data;
    const t = textyBytes();
    const compressed = simple.compress(t, 19);
    expect(bytesEqual(decompress(compressed), t)).toBe(true);
  });

  it('Streaming 压缩（未知 FCS）逐字节相等', async () => {
    const { streaming } = await getOracle();
    const data = prng(200000, 77);
    const compressed = streaming.compress(data, 5);
    expect(bytesEqual(decompress(compressed), data)).toBe(true);
  });
});

function textyBytes(): Uint8Array {
  // 文本型数据（重复词表）
  const words = ['the quick brown fox ', 'jumps over the lazy dog ', 'zstd fse huffman entropy '];
  const parts: number[] = [];
  let s = 7 >>> 0;
  while (parts.length < 256 * 1024) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    for (const ch of words[s % words.length]!) parts.push(ch.charCodeAt(0));
  }
  return new Uint8Array(parts.slice(0, 256 * 1024));
}
