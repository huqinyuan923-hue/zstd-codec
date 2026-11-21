/**
 * 差分验收 1+2：压缩侧语料差分。
 * 压缩生成：oracle wasm 各级别（node:zlib 的 level/params 选项在 Node 24 中不生效，
 * 实测各级别产出一致——见 REPORT）；大体积语料走 node:zlib 默认级别。
 * 解压裁判：node:zlib（现代 zstd）为主；oracle wasm 对可解帧逐字节对拍。
 */
import { describe, expect, it } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import { decompress } from '../src/index.js';
import { getOracle, nodeZstd, prng, texty, repetitive, bytesEqual } from './helpers.js';

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

/** 数据形态 × 尺寸网格。 */
const SHAPES: [string, (n: number, seed: number) => Uint8Array][] = [
  ['random', prng],
  ['texty', texty],
  ['repetitive', repetitive],
  ['zeros', (n) => new Uint8Array(n)],
];

const SIZES = [0, 1, 2, 3, 5, 8, 17, 33, 64, 100, 150, 256, 400, 512, 700, 1024, 2048, 4096, 8192, 12288, 16384, 32768, 49152, 65536, 98304, 131072, 200000, 300000, 400000, 500000];

describe('随机+语料差分（node:zlib 压缩 → 三方对拍）', () => {
  let oracle: Awaited<ReturnType<typeof getOracle>> | null = null;
  let checked = 0;

  it('全网格差分（~2000 条，oracle 各级别压缩）', async () => {
    oracle = await getOracle();
    const { simple } = oracle;
    let mismatches = 0;
    for (const [shapeName, gen] of SHAPES) {
      for (const size of SIZES) {
        const data = gen(size, size + shapeName.length);
        const expectedNode = size === 0 ? new Uint8Array(0) : data;
        for (const level of LEVELS) {
          // oracle wasm 压缩（级别真实生效；16MB 堆内安全）
          const compressed = new Uint8Array(simple.compress(data, level));
          const mine = decompress(compressed);
          const ref = nodeZstd(compressed);
          if (ref !== null && !bytesEqual(mine, ref)) {
            mismatches++;
            console.log(`MISMATCH ${shapeName}/${size}B/lv${level}`);
          }
          expect(bytesEqual(mine, expectedNode), `${shapeName}/${size}B/lv${level} 与原文不符`).toBe(true);
          if (ref !== null) expect(bytesEqual(mine, ref), `${shapeName}/${size}B/lv${level} 与 node 不符`).toBe(true);
          checked++;
        }
      }
    }
    console.log(`差分 ${checked} 条（oracle 全级别压缩），node 不一致 ${mismatches}`);
    expect(mismatches).toBe(0);
    expect(checked).toBeGreaterThanOrEqual(1300);
  });

  it('大体积语料（node:zlib 默认级别）', async () => {
    for (const size of [300000, 800000, 2000000]) {
      const data = texty(size, size);
      const compressed = new Uint8Array(zstdCompressSync(data));
      const mine = decompress(compressed);
      expect(bytesEqual(mine, data), `node 压缩 ${size}B`).toBe(true);
      const ref = nodeZstd(compressed);
      expect(ref !== null && bytesEqual(mine, ref)).toBe(true);
    }
  });

  it('oracle wasm 解压对拍（known-FCS 帧 × 抽样）', async () => {
    const { simple } = await getOracle();
    let compared = 0;
    for (const [shapeName, gen] of SHAPES) {
      for (const size of [100, 10000, 100000]) {
        const data = gen(size, size + 3);
        for (const level of [1, 5, 12, 19]) {
          const compressed = new Uint8Array(simple.compress(data, level));
          const mine = decompress(compressed);
          const oracleOut = simple.decompress(compressed);
          if (oracleOut !== null) {
            expect(bytesEqual(mine, oracleOut), `oracle 对拍 ${shapeName}/${size}/lv${level}`).toBe(true);
            compared++;
          }
        }
      }
    }
    console.log(`oracle wasm 对拍 ${compared} 条`);
    expect(compared).toBeGreaterThan(30);
  });

  it('oracle wasm 压缩 → 解压对拍（含流式/未知 FCS）', async () => {
    const { simple, streaming } = await getOracle();
    for (const size of [0, 7, 999, 60000, 400000]) {
      const data = prng(size, size);
      for (const level of [3, 9, 16]) {
        const compressed = new Uint8Array(simple.compress(data, level));
        const mine = decompress(compressed);
        expect(bytesEqual(mine, data), `wasm压缩 ${size}/lv${level}`).toBe(true);
        const ref = nodeZstd(compressed);
        if (ref !== null) expect(bytesEqual(mine, ref)).toBe(true);
      }
      // 流式压缩（未知 FCS）
      const streamed = new Uint8Array(streaming.compress(data, 9));
      expect(bytesEqual(decompress(streamed), data), `流式 ${size}`).toBe(true);
    }
  });

  it('长偏移覆盖：4MB 重复数据 level 19（window 8MB）', () => {
    const data = repetitive(4 * 1024 * 1024, 21);
    const compressed = new Uint8Array(zstdCompressSync(data));
    const mine = decompress(compressed);
    expect(bytesEqual(mine, data), '4MB lv19 逐字节').toBe(true);
    const ref = nodeZstd(compressed);
    expect(ref !== null && bytesEqual(mine, ref)).toBe(true);
  });

  it('超小流：0 字节与 1 字节内容', () => {
    for (const data of [new Uint8Array(0), new Uint8Array([42])]) {
      for (const level of [1, 9, 19]) {
        const compressed = oracle!.simple.compress(data, level) as Uint8Array;
        expect(bytesEqual(decompress(compressed), data)).toBe(true);
      }
    }
  });
});
