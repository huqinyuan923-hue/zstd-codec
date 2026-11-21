/**
 * XXH64 独立验证：已知向量 + BigInt 第二实现对拍。
 * 空串向量 0xEF46DB3751D8E999 来自 xxHash 官方规范。
 */
import { describe, expect, it } from 'vitest';
import { xxh64 } from '../src/xxh64.js';
import { prng } from './helpers.js';

/** BigInt 参考实现（独立第二实现，与 src 的 u32 半字实现逐位交叉验证）。 */
function xxh64BigInt(data: Uint8Array): bigint {
  const P1 = 0x9e3779b185ebca87n;
  const P2 = 0xc2b2ae3d27d4eb4fn;
  const P3 = 0x165667b19e3779f9n;
  const P4 = 0x85ebca77c2b2ae63n;
  const P5 = 0x27d4eb2f165667c5n;
  const M = (1n << 64n) - 1n;
  const rotl = (x: bigint, n: number): bigint => ((x << BigInt(n)) | (x >> (64n - BigInt(n)))) & M;
  const rd = (pos: number, n: number): bigint => {
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(data[pos + i] ?? 0) << (8n * BigInt(i));
    return v;
  };
  const len = BigInt(data.length);
  if (data.length < 16) {
    let acc = (P5 + len) & M;
    let p = 0;
    while (p + 4 <= data.length) {
      acc = (acc + rd(p, 4) * P1) & M;
      acc = (rotl(acc, 23) * P2 + P3) & M;
      p += 4;
    }
    while (p < data.length) {
      acc = (acc + BigInt(data[p]!) * P5) & M;
      acc = (rotl(acc, 11) * P1) & M;
      p++;
    }
    acc ^= acc >> 33n;
    acc = (acc * P2) & M;
    acc ^= acc >> 29n;
    acc = (acc * P3) & M;
    acc ^= acc >> 32n;
    return acc;
  }
  let p = 0;
  let v1 = (P1 + P2) & M;
  let v2 = P2 & M;
  let v3 = 0n;
  let v4 = -P1 & M;
  const round = (acc: bigint, lane: bigint): bigint => (rotl((acc + lane * P2) & M, 31) * P1) & M;
  while (p + 32 <= data.length) {
    v1 = round(v1, rd(p, 8));
    v2 = round(v2, rd(p + 8, 8));
    v3 = round(v3, rd(p + 16, 8));
    v4 = round(v4, rd(p + 24, 8));
    p += 32;
  }
  let acc = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
  const merge = (a: bigint, v: bigint): bigint => ((a ^ ((rotl((v * P2) & M, 31) * P1) & M)) * P1 + P4) & M;
  acc = merge(acc, v1);
  acc = merge(acc, v2);
  acc = merge(acc, v3);
  acc = merge(acc, v4);
  acc = (acc + len) & M;
  while (p + 8 <= data.length) {
    const lane = rd(p, 8);
    acc ^= (rotl((lane * P2) & M, 31) * P1) & M;
    acc = (rotl(acc, 27) * P1 + P4) & M;
    p += 8;
  }
  while (p + 4 <= data.length) {
    acc = (acc ^ ((rd(p, 4) * P1) & M)) & M;
    acc = (rotl(acc, 23) * P2 + P3) & M;
    p += 4;
  }
  while (p < data.length) {
    acc = (acc ^ ((BigInt(data[p]!) * P5) & M)) & M;
    acc = (rotl(acc, 11) * P1) & M;
    p++;
  }
  acc ^= acc >> 33n;
  acc = (acc * P2) & M;
  acc ^= acc >> 29n;
  acc = (acc * P3) & M;
  acc ^= acc >> 32n;
  return acc;
}

function asBig(h: { low: number; high: number }): bigint {
  return (BigInt(h.high >>> 0) << 32n) | BigInt(h.low >>> 0);
}

describe('XXH64 已知向量', () => {
  it('空串 = 0xEF46DB3751D8E999', () => {
    expect(asBig(xxh64(new Uint8Array(0)))).toBe(0xef46db3751d8e999n);
  });

  it("单字节 'a'", () => {
    const ref = xxh64BigInt(new Uint8Array([0x61]));
    // 与 BigInt 实现对拍（外部常量交叉确认见空串向量）
    expect(asBig(xxh64(new Uint8Array([0x61])))).toBe(ref);
  });

  it('全零 4 字节', () => {
    expect(asBig(xxh64(new Uint8Array(4)))).toBe(xxh64BigInt(new Uint8Array(4)));
  });
});

describe('XXH64 与 BigInt 参考实现对拍', () => {
  const sizes = [0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17, 23, 24, 31, 32, 33, 39, 40, 47, 48, 63, 64, 65, 100, 255, 256, 1000, 4095, 4096, 4097, 65537, 131073];
  for (const size of sizes) {
    it(`长度 ${size}`, () => {
      const data = prng(size, size + 1);
      expect(asBig(xxh64(data))).toBe(xxh64BigInt(data));
    });
  }

  it('随机 100 条（含子区间读法）', () => {
    const base = prng(4096, 999);
    for (let i = 0; i < 100; i++) {
      const s = (i * 41) % 3000;
      const e = s + ((i * 97) % 1096);
      const view = base.subarray(s, e);
      expect(asBig(xxh64(view))).toBe(xxh64BigInt(view));
    }
  });
});
