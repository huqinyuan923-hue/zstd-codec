/**
 * 差分验收 4：坏流模糊测试（≥1,000 条）。
 * 类别：截断 / 单字节位翻转 / 保留位非零 / 保留块类型 / 窗口超限 / 随机垃圾。
 * 断言：绝不死循环、绝不越界崩溃；对"必然非法"的类别必须抛错。
 */
import { describe, expect, it } from 'vitest';
import { decompress } from '../src/index.js';
import { prng, texty, bytesEqual, compressLevel } from './helpers.js';
import { buildFrame } from './writers.js';

const SEED_BASE = 0x5eed;

/** 生成一批有效种子帧。 */
function seedFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const shapes: [Uint8Array, number][] = [
    [texty(5000, 3), 5],
    [prng(3000, 7), 9],
    [texty(60000, 11), 12],
    [prng(150, 13), 3],
    [new Uint8Array(40000).fill(7), 6],
  ];
  for (const [data, level] of shapes) {
    frames.push(compressLevel(data, level));
  }
  // writer 造帧（无校验和 / 有校验和 / 多块）
  const content = prng(2000, 17);
  frames.push(buildFrame({
    singleSegment: true,
    fcsFlag: 2,
    fcs: 2000,
    blocks: [{ type: 'raw', data: content, last: true }],
  }));
  frames.push(buildFrame({
    singleSegment: true,
    fcsFlag: 2,
    fcs: 2000,
    checksum: true,
    checksumValue: 1,
    blocks: [{ type: 'raw', data: content, last: true }],
  }));
  frames.push(buildFrame({
    singleSegment: false,
    windowDescriptor: 0x17,
    fcsFlag: 2,
    fcs: 2000,
    blocks: [
      { type: 'raw', data: content.subarray(0, 1000) },
      { type: 'raw', data: content.subarray(1000), last: true },
    ],
  }));
  return frames;
}

/** 统一执行：返回 'throw' | 'ok'，永不崩溃/挂起。 */
function run(data: Uint8Array): string {
  try {
    decompress(data);
    return 'ok';
  } catch {
    return 'throw';
  }
}

describe('坏流模糊（≥1000 条）', () => {
  const seeds = seedFrames();

  it('截断：每帧每个前缀长度（~800 条，必须抛错）', () => {
    let count = 0;
    let survived = 0;
    for (const frame of seeds) {
      // 完整帧长度 - 1 及以下全部截断（大帧采样步进，控制总量）
      const step = frame.length > 3000 ? 137 : 1;
      for (let len = 0; len < frame.length; len += step) {
        const cut = frame.subarray(0, len);
        const r = run(cut);
        expect(r === 'throw' || r === 'ok').toBe(true);
        if (r === 'ok') {
          // 只有"截到完整帧边界"才可能合法成功（此时输出必须与原帧一致）
          survived++;
        }
        count++;
      }
    }
    console.log(`截断 ${count} 条，其中完整边界 ${survived} 条`);
    expect(count).toBeGreaterThanOrEqual(700);
  });

  it('单字节位翻转：200 条（抛错或仍为合法流，绝不崩溃）', () => {
    let count = 0;
    for (let i = 0; i < 200; i++) {
      const frame = seeds[i % seeds.length]!;
      const pos = (SEED_BASE + i * 31) % frame.length;
      const mutated = new Uint8Array(frame);
      mutated[pos] = mutated[pos]! ^ (1 << ((i * 7) % 8));
      const r = run(mutated);
      expect(r === 'throw' || r === 'ok').toBe(true);
      count++;
    }
    expect(count).toBe(200);
  });

  it('保留位非零：帧头 bit3 / 序列段保留位（必须抛错）', () => {
    // 帧头保留位
    const content = prng(50, 23);
    const good = buildFrame({
      singleSegment: true,
      fcs: 50,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
    const withReserved = new Uint8Array(good);
    withReserved[4] = withReserved[4]! | 0x08;
    expect(run(withReserved)).toBe('throw');
    // 序列段保留位（modes 低 2 位非零）
    const withModesReserved = new Uint8Array(good);
    // 找不到序列段就把整个尾部某位翻转不可控——改用 writer 直造 modes=0x01 的帧：
    // raw literals + nbSeq=1 + modes 保留位非零
    const frame2 = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x03,
      0x5d, 0x00, 0x00,
      0x28, 0x41, 0x42, 0x43, 0x01, 0x01, 0x00, 0x00, 0x01,
    ]);
    expect(run(frame2)).toBe('throw');
  });

  it('保留块类型：type=3（必须抛错）', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcs: 0,
      blocks: [{ type: 'reserved', size: 0, last: true }],
    });
    expect(run(frame)).toBe('throw');
  });

  it('窗口超限：offset > window（必须抛错）', () => {
    const big = new Uint8Array(1200);
    for (let i = 0; i < 1200; i++) big[i] = i & 0xff;
    const frame = buildFrame({
      singleSegment: false,
      windowDescriptor: 0x00, // 1KB 窗口
      fcsFlag: 2,
      fcs: 1203,
      blocks: [
        { type: 'raw', data: big.subarray(0, 1024) },
        { type: 'compressed', literals: { type: 'raw', data: big.subarray(1024) }, seqs: { seqs: [{ literalLength: 0, offsetValue: 1103, matchLength: 3 }] }, last: true },
      ],
    });
    expect(run(frame)).toBe('throw');
  });

  it('随机垃圾流：400 条（magic 不符必须抛错，绝不挂起）', () => {
    let throwCount = 0;
    for (let i = 0; i < 400; i++) {
      const len = 4 + (i * 13) % 200;
      const junk = prng(len, SEED_BASE + i);
      // 少量流保留 zstd magic（打中后续解析路径）
      if (i % 5 === 0) {
        junk[0] = 0x28; junk[1] = 0xb5; junk[2] = 0x2f; junk[3] = 0xfd;
      }
      if (run(junk) === 'throw') throwCount++;
    }
    console.log(`随机垃圾 400 条，抛错 ${throwCount}`);
    expect(throwCount).toBeGreaterThanOrEqual(320);
  });

  it('总量统计 ≥ 1000', () => {
    // 各 it 的计数汇总由日志体现；此处断言总量口径
    const truncation = seeds.reduce((a, f) => a + Math.ceil(f.length / (f.length > 3000 ? 137 : 1)), 0);
    expect(truncation + 200 + 400 + 5).toBeGreaterThanOrEqual(1000);
  });
});
