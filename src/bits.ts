/**
 * 位读取器。
 *
 * zstd 有两套位流方向（对照 DEFLATE 的单方向 LSB 累加器，这是本项目的核心趣味点之一）：
 * - 正向（LSB-first）：FSE 概率表描述、帧头字段。位从字节低位向高位消费，跨字节连续。
 * - 反向（backward）：FSE/Huffman 编码数据流。从流末尾的"结束标志位"（最后字节中
 *   最高位的 1）之下开始，向流首方向消费；一次读 n 位时，先读到的位是结果的
 *   高位（MSB）。读到流首之后按 0 填充（由各协议层的"精确耗尽"检查兜底）。
 */
import { corrupt } from './errors.js';

/** 正向位读取器（小端位序：bit pos = 字节 pos>>3 的第 pos&7 位，为读取值的最低位）。 */
export class BitReaderForward {
  readonly data: Uint8Array;
  readonly bitEnd: number; // 末尾（位），越过即错
  pos = 0; // 下一个要读的位位置

  constructor(data: Uint8Array, byteStart: number, byteEnd: number) {
    this.data = data;
    this.bitEnd = byteEnd * 8;
    this.pos = byteStart * 8;
  }

  /** 读取 n 位（n ≤ 24），作为 LSB-first 整数返回。越过 bitEnd 抛错。 */
  read(n: number): number {
    if (this.pos + n > this.bitEnd) throw corrupt('位流意外结束');
    const byteIdx = this.pos >>> 3;
    const shift = this.pos & 7;
    this.pos += n;
    if (shift + n <= 8) {
      return (this.data[byteIdx]! >>> shift) & ((1 << n) - 1);
    }
    // 跨字节：一次读出 3 字节窗口（此时 n ≤ 24 保证不越界 4 字节，调用方保证 buffer 末尾+4 可读
    // ——由调用处保证 data 为拷贝或读取点距末尾 ≥4 字节；为稳妥走慢路径）
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const p = byteIdx * 8 + shift + i;
      acc |= ((this.data[p >>> 3]! >>> (p & 7)) & 1) << i;
    }
    return acc >>> 0;
  }

  /** 对齐到下一字节边界（若已在边界则原地不动）。 */
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  get bytePos(): number {
    return this.pos >>> 3;
  }
}

/**
 * 反向位读取器（FSE/Huffman 数据流）。
 * offset 语义与教育版参考解码器一致：流内下一个读取组的最低位位置（从流首起算），
 * 初始化时跳过末字节的填充 0 与"结束标志 1 位"；此后每次 read(n) 消费 [offset-n, offset)，
 * 其中位 offset+n-1 是结果的最高位。offset 可以变负（用 0 填充），由上层做精确耗尽检查。
 */
export class BitReaderReverse {
  readonly data: Uint8Array;
  readonly dv: DataView;
  readonly totalBits: number; // 有效位总数（不含填充与标志位）
  offset: number;

  constructor(data: Uint8Array, byteStart: number, byteEnd: number) {
    const view = data.subarray(byteStart, byteEnd);
    const len = view.length;
    const last = len > 0 ? view[len - 1]! : 0;
    if (len === 0 || last === 0) throw corrupt('反向位流为空或结束标志缺失（末字节为 0）');
    const highbit = 31 - Math.clz32(last);
    this.data = view;
    this.dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    this.totalBits = len * 8 - (8 - highbit);
    this.offset = this.totalBits;
  }

  /** 从流末尾方向读取 n 位（n ≤ 32）：结果的最高位是最先读到的位。不足时低位补 0。 */
  read(n: number): number {
    const avail = this.offset;
    this.offset -= n;
    if (avail <= 0) return 0;
    if (avail < n) {
      // 剩余 avail 位（流首 [0, avail)）作为高位，低位补 0
      return (readBitsLE(this.data, this.dv, avail, 0) * POW2[n - avail]!) >>> 0;
    }
    return readBitsLE(this.data, this.dv, n, this.offset);
  }
}

const POW2: number[] = [];
for (let i = 0; i <= 32; i++) POW2.push(2 ** i);

/**
 * 读取以位位置 pos 开始的 n 位（bit pos 为结果最低位），n ≤ 32。
 * 越过 data 末尾的位置按 0 处理（合法路径不会用到，仅防御）。
 */
function readBitsLE(data: Uint8Array, dv: DataView, n: number, pos: number): number {
  const byteIdx = pos >>> 3;
  const shift = pos & 7;
  if (shift + n <= 32 && byteIdx + 4 <= data.length) {
    // 快路径：一次 32 位小端读取
    const word = dv.getUint32(byteIdx, true);
    return (word >>> shift) & (POW2[n]! - 1);
  }
  if (byteIdx + 4 <= data.length) {
    // n + shift > 32：需要高半字（n ≤ 32 保证高位最多 7 位）
    const lo = dv.getUint32(byteIdx, true);
    const hi = dv.getUint32(byteIdx + 4, true);
    const fromLo = 32 - shift;
    const hiBits = n - fromLo;
    const hiPart = (hi & (POW2[hiBits]! - 1)) >>> 0;
    return (hiPart * POW2[fromLo]! + (lo >>> shift)) >>> 0;
  }
  // 慢路径：靠近数据末尾（或越界零填充）
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    const b = p >>> 3;
    if (b < data.length) acc |= ((data[b]! >>> (p & 7)) & 1) << i;
  }
  return acc >>> 0;
}

/** 位扫描：最高置位下标（0 起算）；x 必须非 0。 */
export function highbit32(x: number): number {
  return 31 - Math.clz32(x);
}
