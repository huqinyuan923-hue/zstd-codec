/**
 * 性能基准（差分验收 5：只留档，不 gate）。
 * 口径与 deflate 项目一致：原始数据量 / 时间。对照 oracle wasm 的解压吞吐。
 * 压缩用 oracle wasm（级别真实生效）。
 */
import { describe, expect, it } from 'vitest';
import { decompress } from '../src/index.js';
import { getOracle, texty, prng, compressLevel } from './helpers.js';

function benchMs(fn: () => void, rounds: number): number {
  fn(); // 预热
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) fn();
  return (performance.now() - t0) / rounds;
}

describe('性能基准（只留档）', () => {
  it('1MB 文本 × level 3 / level 12 / level 19 解压吞吐', async () => {
    const { simple } = await getOracle();
    const data = texty(1024 * 1024, 42);
    const rows: string[] = [];
    for (const level of [3, 12, 19]) {
      const compressed = compressLevel(data, level);
      const mineMs = benchMs(() => decompress(compressed), 5);
      const oracleMs = benchMs(() => {
        simple.decompress(compressed);
      }, 5);
      const mineMbps = (data.length / 1024 / 1024) / (mineMs / 1000);
      const oracleMbps = (data.length / 1024 / 1024) / (oracleMs / 1000);
      rows.push(`lv${level}: 压缩 ${(compressed.length / 1024).toFixed(0)}KB | mine ${mineMs.toFixed(1)}ms (${mineMbps.toFixed(0)} MB/s) | oracle ${oracleMs.toFixed(1)}ms (${oracleMbps.toFixed(0)} MB/s) | 比值 ${(mineMbps / oracleMbps).toFixed(2)}x`);
    }
    console.log('解压吞吐（1MB 文本）:\n' + rows.join('\n'));
    expect(rows.length).toBe(3);
  });

  it('随机数据（近不可压）解压吞吐', async () => {
    const { simple } = await getOracle();
    const data = prng(512 * 1024, 77);
    const compressed = compressLevel(data, 3);
    const mineMs = benchMs(() => decompress(compressed), 5);
    const oracleMs = benchMs(() => {
      simple.decompress(compressed);
    }, 5);
    const mineMbps = (data.length / 1024 / 1024) / (mineMs / 1000);
    const oracleMbps = (data.length / 1024 / 1024) / (oracleMs / 1000);
    console.log(`随机 512KB lv3: mine ${mineMbps.toFixed(0)} MB/s | oracle ${oracleMbps.toFixed(0)} MB/s | ${(mineMbps / oracleMbps).toFixed(2)}x`);
    expect(true).toBe(true);
  });
});
