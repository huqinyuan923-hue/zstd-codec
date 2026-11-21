/**
 * XXH64（xxHash 64 位，seed 固定 0）——zstd 帧内容校验用。
 * JS 没有原生 64 位整数乘法，这里用 32 位半字模拟 u64（乘法按 16 位切片，
 * 所有中间量 < 2^36，double 精确）。为什么不用 BigInt：热路径性能差一个数量级。
 */
import { corrupt } from './errors.js';

// 64 位素数的高低 32 位（P1 = 0x9E3779B1_85EBCA87 等；H = 高半字）
const P1 = 0x85ebca87;
const P1H = 0x9e3779b1;
const P2 = 0x27d4eb4f;
const P2H = 0xc2b2ae3d;
const P3 = 0x9e3779f9;
const P3H = 0x165667b1;
const P4 = 0xc2b2ae63;
const P4H = 0x85ebca77;
const P5 = 0x165667c5;
const P5H = 0x27d4eb2f;

/** {h, l} 表示 u64。实现内部用可变对象避免分配。 */
interface U64 {
  h: number;
  l: number;
}

function mul64Into(a: U64, bH: number, bL: number, out: U64): void {
  const a0 = a.l & 0xffff, a1 = a.l >>> 16, a2 = a.h & 0xffff, a3 = a.h >>> 16;
  const b0 = bL & 0xffff, b1 = bL >>> 16, b2 = bH & 0xffff, b3 = bH >>> 16;
  // 部分积按位权 16(i+j) 合成，≥2^64 的项对结果无贡献，直接丢弃。
  // 注意：lane 和可达 2^33+，进位必须用 Math.floor(x/65536)（>>>16 会截断在 32 位）。
  const lane0 = a0 * b0;
  const lane1 = a0 * b1 + a1 * b0;
  const lane2 = a0 * b2 + a1 * b1 + a2 * b0;
  const lane3 = a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;
  const c1 = Math.floor(lane0 / 65536);
  const sum1 = lane1 + c1;
  const c2 = Math.floor(sum1 / 65536);
  const sum2 = lane2 + c2;
  const c3 = Math.floor(sum2 / 65536);
  const sum3 = lane3 + c3;
  out.l = (((sum1 % 65536) << 16) | (lane0 % 65536)) >>> 0;
  out.h = (((sum3 % 65536) << 16) | (sum2 % 65536)) >>> 0;
}

function add64Into(a: U64, bH: number, bL: number, out: U64): void {
  const l = a.l + bL;
  const carry = l > 0xffffffff ? 1 : 0;
  out.l = l >>> 0;
  out.h = (a.h + bH + carry) >>> 0;
}

function xor64Into(a: U64, bH: number, bL: number, out: U64): void {
  out.h = (a.h ^ bH) >>> 0;
  out.l = (a.l ^ bL) >>> 0;
}

/** 循环左移（1..31；zstd 只用 1/7/11/12/18/23/27/29/31/32，无 0）。 */
function rotl64Into(a: U64, n: number, out: U64): void {
  if (n === 32) {
    out.h = a.l;
    out.l = a.h;
    return;
  }
  if (n < 32) {
    out.h = ((a.h << n) | (a.l >>> (32 - n))) >>> 0;
    out.l = ((a.l << n) | (a.h >>> (32 - n))) >>> 0;
    return;
  }
  const m = n - 32;
  out.h = ((a.l << m) | (a.h >>> (32 - m))) >>> 0;
  out.l = ((a.h << m) | (a.l >>> (32 - m))) >>> 0;
}

function shr64Into(a: U64, n: number, out: U64): void {
  if (n === 32) {
    out.h = 0;
    out.l = a.h;
    return;
  }
  if (n < 32) {
    out.h = a.h >>> n;
    out.l = ((a.l >>> n) | (a.h << (32 - n))) >>> 0;
    return;
  }
  const m = n - 32;
  out.h = 0;
  out.l = a.h >>> m;
}

const tmpA: U64 = { h: 0, l: 0 };
const tmpB: U64 = { h: 0, l: 0 };

/**
 * 计算 XXH64(data, seed=0)，返回低 32 位与高 32 位（zstd 校验只存低 32 位）。
 * 返回 { low, high }。
 */
export function xxh64(data: Uint8Array, byteStart = 0, byteEnd = data.length): { low: number; high: number } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = byteEnd - byteStart;
  // 四路累加器（v1..v4）
  const v1: U64 = { h: 0, l: 0 };
  const v2: U64 = { h: 0, l: 0 };
  const v3: U64 = { h: 0, l: 0 };
  const v4: U64 = { h: 0, l: 0 };
  const acc: U64 = { h: 0, l: 0 };

  let pos = byteStart;
  const end = byteEnd;

  if (len < 16) {
    // 小输入路径：acc = seed + P5 + len
    acc.h = P5H;
    acc.l = P5;
    add64Into(acc, 0, len, acc);
    // 剩余按 4 字节 / 1 字节消费
    while (pos + 4 <= end) {
      const lane = dv.getUint32(pos, true);
      // acc += lane * P1
      tmpA.h = 0; tmpA.l = lane;
      mul64Into(tmpA, P1H, P1, tmpB);
      add64Into(acc, tmpB.h, tmpB.l, acc);
      rotl64Into(acc, 23, tmpA);
      mul64Into(tmpA, P2H, P2, tmpB);
      add64Into(tmpB, P3H, P3, acc);
      pos += 4;
    }
    while (pos < end) {
      tmpA.h = 0; tmpA.l = data[pos]!;
      mul64Into(tmpA, P5H, P5, tmpB);
      add64Into(acc, tmpB.h, tmpB.l, acc);
      rotl64Into(acc, 11, tmpA);
      mul64Into(tmpA, P1H, P1, acc);
      pos++;
    }
  } else {
    // v1 = seed + P1 + P2; v2 = seed + P2; v3 = seed; v4 = seed - P1
    v1.h = P1H; v1.l = P1;
    add64Into(v1, P2H, P2, v1);
    v2.h = P2H; v2.l = P2;
    v3.h = 0; v3.l = 0;
    sub64(P1H, P1, v4); // v4 = -P1 mod 2^64

    const stripeEnd = end - 31;
    while (pos < stripeEnd) {
      round64(v1, dv, pos, tmpA);
      round64(v2, dv, pos + 8, tmpA);
      round64(v3, dv, pos + 16, tmpA);
      round64(v4, dv, pos + 24, tmpA);
      pos += 32;
    }
    // h64 = rotl(v1,1) + rotl(v2,7) + rotl(v3,12) + rotl(v4,18)
    rotl64Into(v1, 1, acc);
    rotl64Into(v2, 7, tmpA);
    add64Into(acc, tmpA.h, tmpA.l, acc);
    rotl64Into(v3, 12, tmpA);
    add64Into(acc, tmpA.h, tmpA.l, acc);
    rotl64Into(v4, 18, tmpA);
    add64Into(acc, tmpA.h, tmpA.l, acc);
    // mergeRound ×4
    mergeRound(acc, v1, tmpA, tmpB);
    mergeRound(acc, v2, tmpA, tmpB);
    mergeRound(acc, v3, tmpA, tmpB);
    mergeRound(acc, v4, tmpA, tmpB);
    add64Into(acc, 0, len, acc);
    // 尾部（<32 字节）
    while (pos + 8 <= end) {
      const l = dv.getUint32(pos, true);
      const h = dv.getUint32(pos + 4, true);
      // acc ^= round(0, lane); acc = rotl(acc,27)*P1 + P4
      mul64Into({ h, l } as U64, P2H, P2, tmpA);
      rotl64Into(tmpA, 31, tmpB);
      mul64Into(tmpB, P1H, P1, tmpA);
      xor64Into(acc, tmpA.h, tmpA.l, acc);
      rotl64Into(acc, 27, tmpA);
      mul64Into(tmpA, P1H, P1, tmpB);
      add64Into(tmpB, P4H, P4, acc);
      pos += 8;
    }
    while (pos + 4 <= end) {
      const lane = dv.getUint32(pos, true);
      // acc ^= lane * P1; acc = rotl(acc,23)*P2 + P3
      tmpA.h = 0; tmpA.l = lane;
      mul64Into(tmpA, P1H, P1, tmpB);
      xor64Into(acc, tmpB.h, tmpB.l, acc);
      rotl64Into(acc, 23, tmpA);
      mul64Into(tmpA, P2H, P2, tmpB);
      add64Into(tmpB, P3H, P3, acc);
      pos += 4;
    }
    while (pos < end) {
      // acc ^= byte * P5; acc = rotl(acc,11)*P1
      tmpA.h = 0; tmpA.l = data[pos]!;
      mul64Into(tmpA, P5H, P5, tmpB);
      xor64Into(acc, tmpB.h, tmpB.l, acc);
      rotl64Into(acc, 11, tmpA);
      mul64Into(tmpA, P1H, P1, acc);
      pos++;
    }
  }
  // 雪崩
  shr64Into(acc, 33, tmpA);
  xor64Into(acc, tmpA.h, tmpA.l, acc);
  mul64Into(acc, P2H, P2, tmpB);
  shr64Into(tmpB, 29, tmpA);
  xor64Into(tmpB, tmpA.h, tmpA.l, acc);
  mul64Into(acc, P3H, P3, tmpB);
  shr64Into(tmpB, 32, tmpA);
  xor64Into(tmpB, tmpA.h, tmpA.l, acc);
  return { low: acc.l, high: acc.h };
}

/** seed - P1 mod 2^64（seed=0 → 即 -P1） */
function sub64(xH: number, xL: number, out: U64): void {
  // 0 - x = ~x + 1
  const nh = (~xH) >>> 0;
  const nl = (~xL) >>> 0;
  const l = nl + 1;
  out.l = l >>> 0;
  out.h = (nh + (l > 0xffffffff ? 1 : 0)) >>> 0;
}

/** round(acc, lane)：acc = rotl(acc + lane*P2, 31) * P1 */
function round64(acc: U64, dv: DataView, at: number, tmp: U64): void {
  const lane: U64 = { h: dv.getUint32(at + 4, true), l: dv.getUint32(at, true) };
  const t: U64 = { h: 0, l: 0 };
  mul64Into(lane, P2H, P2, t);
  add64Into(t, acc.h, acc.l, t);
  rotl64Into(t, 31, tmp);
  mul64Into(tmp, P1H, P1, acc);
}

/** mergeRound(acc, v)：acc = (acc ^ round(0, v)) * P1 + P4 */
function mergeRound(acc: U64, v: U64, t1: U64, t2: U64): void {
  mul64Into(v, P2H, P2, t1);
  rotl64Into(t1, 31, t2);
  mul64Into(t2, P1H, P1, t1);
  xor64Into(acc, t1.h, t1.l, t1);
  mul64Into(t1, P1H, P1, t2);
  add64Into(t2, P4H, P4, acc);
}
