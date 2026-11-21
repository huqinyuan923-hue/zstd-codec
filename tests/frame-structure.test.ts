// 帧结构测试（分步构建）
import { describe, expect, it } from 'vitest';
import { decompress } from '../src/index.js';
import { buildFrame, frameChecksum, type FrameSpec } from './writers.js';
import { prng, getOracle } from './helpers.js';

function roundtrip(spec: FrameSpec & { content: Uint8Array }): Uint8Array {
  if (spec.checksum) spec.checksumValue = frameChecksum(spec.content);
  return decompress(buildFrame(spec));
}

describe('literals 全模式', () => {
  it('Raw 字面量 + 无序列 → 原样输出', () => {
    const content = prng(100, 5);
    const out = roundtrip({
      singleSegment: true,
      fcs: 100,
      content,
      blocks: [{ type: 'compressed', literals: { type: 'raw', data: content }, seqs: { seqs: [] }, last: true }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('RLE 字面量（20 位尺寸域）', () => {
    const content = new Uint8Array(70000).fill(0xab);
    const out = roundtrip({
      singleSegment: true,
      fcsFlag: 2,
      fcs: 70000,
      content,
      blocks: [{ type: 'compressed', literals: { type: 'rle', byte: 0xab, count: 70000 }, seqs: { seqs: [] }, last: true }],
    });
    expect(out.length).toBe(70000);
    expect(out[69999]).toBe(0xab);
  });

  it('Huffman 1 流字面量（规范示例树）', () => {
    const weights = [4, 3, 2, 0, 1];
    const literals = new Uint8Array([0, 1, 2, 4, 5, 2, 1, 0, 5, 4]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 10,
      content: literals,
      blocks: [{ type: 'compressed', literals: { type: 'huf1', weights, literals }, seqs: { seqs: [] }, last: true }],
    });
    expect([...out]).toEqual([...literals]);
  });

  it('Huffman 4 流字面量（含跳表）', () => {
    const weights = [4, 3, 2, 0, 1];
    const literals = new Uint8Array(40);
    for (let i = 0; i < 40; i++) literals[i] = [0, 1, 2, 4, 5][i % 5]!;
    const out = roundtrip({
      singleSegment: true,
      fcs: 40,
      content: literals,
      blocks: [{ type: 'compressed', literals: { type: 'huf4', weights, literals }, seqs: { seqs: [] }, last: true }],
    });
    expect([...out]).toEqual([...literals]);
  });

  it('Treeless 复用上一块表', () => {
    const weights = [4, 3, 2, 0, 1];
    const lit1 = new Uint8Array([0, 1, 2, 4, 5, 4, 5]);
    const lit2 = new Uint8Array([5, 4, 2, 1, 0]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 12,
      content: new Uint8Array([...lit1, ...lit2]),
      blocks: [
        { type: 'compressed', literals: { type: 'huf1', weights, literals: lit1 }, seqs: { seqs: [] } },
        { type: 'compressed', literals: { type: 'treeless', literals: lit2 }, seqs: { seqs: [] }, last: true },
      ],
    });
    expect(out.length).toBe(12);
  });

  it('Treeless 无先前表 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcs: 8,
      blocks: [
        { type: 'compressed', literals: { type: 'raw', data: new Uint8Array(5) }, seqs: { seqs: [] } },
        { type: 'compressed', literals: { type: 'treeless-invalid', literals: new Uint8Array(3) }, seqs: { seqs: [] }, last: true },
      ],
    });
    expect(() => decompress(frame)).toThrow(/无先前 Huffman 表/);
  });
});

describe('序列段模式', () => {
  it('RLE 模式序列表（LL=1 固定）', () => {
    // literals [X,A,B]：seq(ll=1 固定 → 'X', ov=1 → offset 1, ml=3) → "XXXX"，剩余 literals "AB" 追加 → "XXXXAB"
    const literals = new Uint8Array([0x58, 0x41, 0x42]);
    const content = new Uint8Array([0x58, 0x58, 0x58, 0x58, 0x41, 0x42]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 6,
      content,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: { seqs: [{ literalLength: 1, offsetValue: 1, matchLength: 3 }], llMode: { rle: 1 }, ofMode: { rle: 0 }, mlMode: { rle: 0 } },
        last: true,
      }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('FSE 模式序列表（自定义分布）', () => {
    // 自定义表：LL codes {5,1}，OF code {3}，ML RLE code0
    // literals [A,B,C,D,E,X]：
    //   seq0: ll=5(code5) "ABCDE"，ov=8(code3) → offset 5，ml=3 → 复制 [0,3)="ABC" → "ABCDEABC" (8)
    //   seq1: ll=1(code1) 'X'，ov=11(code3, extra 3) → offset 8，ml=3 → 复制 [1,4)="BCD" → "ABCDEABCXBCD" (12)
    const literals = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x58]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x41, 0x42, 0x43, 0x58, 0x42, 0x43, 0x44]);
    const out = roundtrip({
      singleSegment: true,
      fcs: content.length,
      content,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: {
          seqs: [
            { literalLength: 5, offsetValue: 8, matchLength: 3 },
            { literalLength: 1, offsetValue: 11, matchLength: 3 },
          ],
          llMode: { fse: { norm: [0, 16, 0, 0, 0, 16], accuracyLog: 5 } },
          ofMode: { fse: { norm: [0, 0, 0, 32], accuracyLog: 5 } },
          mlMode: { rle: 0 },
        },
        last: true,
      }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('Repeat 模式复用上一块序列表', () => {
    // 块1（predefined 表）：seq1: ll=5 "ABCDE"，ov=8 → offset 5，ml=3 → "ABCDEABC" (8)，rep=[5,1,4]
    //                     seq2: ll=0，ov=11 → offset 8，ml=3 → 复制 [0,3)="ABC" → "ABCDEABCABC" (11)，rep=[8,5,1]
    // 块2（repeat 模式）：seq: ll=1 'X'，ov=2 → rep2=5 → offset 5，ml=3 → 从 [7,10)="CAB" 复制 → "ABCDEABCABCCAB" (14)
    const literals1 = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]);
    const literals2 = new Uint8Array([0x58]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x41, 0x42, 0x43, 0x41, 0x42, 0x43, 0x58, 0x43, 0x41, 0x42]);
    const out = roundtrip({
      singleSegment: true,
      fcs: content.length,
      content,
      blocks: [
        { type: 'compressed', literals: { type: 'raw', data: literals1 }, seqs: { seqs: [{ literalLength: 5, offsetValue: 8, matchLength: 3 }, { literalLength: 0, offsetValue: 11, matchLength: 3 }] } },
        { type: 'compressed', literals: { type: 'raw', data: literals2 }, seqs: { seqs: [{ literalLength: 1, offsetValue: 2, matchLength: 3 }], llMode: 'repeat', ofMode: 'repeat', mlMode: 'repeat' }, last: true },
      ],
    });
    expect([...out]).toEqual([...content]);
  });

  it('Repeat 模式无先前表 → 报错', () => {
    // 手工字节：raw literals(5) + 序列段 [nbSeq=1, modes=0b11111100(全 repeat), 位流占位]
    const frame = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05,
      0x5d, 0x00, 0x00,
      0x28, 0x41, 0x42, 0x43, 0x44, 0x45, 0x01, 0xfc, 0x00, 0x00, 0x01,
    ]);
    expect(() => decompress(frame)).toThrow(/无先前表可复用/);
  });
});

describe('重复偏移状态机（规范更新规则表逐行）', () => {
  it('ov=1, ll≠0 → rep1 不变', () => {
    // literals [X,A,B]：seq(ll=1 → 'X', ov=1 → offset 1, ml=3) → "XXXX" + 剩余 "AB" → "XXXXAB"
    const literals = new Uint8Array([0x58, 0x41, 0x42]);
    const content = new Uint8Array([0x58, 0x58, 0x58, 0x58, 0x41, 0x42]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 6,
      content,
      blocks: [{ type: 'compressed', literals: { type: 'raw', data: literals }, seqs: { seqs: [{ literalLength: 1, offsetValue: 1, matchLength: 3 }] }, last: true }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('ov=1, ll=0 → 用 rep2（保持初始 4）', () => {
    // seq1: ll=4 "ABCD"，ov=1 (rep1=1，rep 不变 [1,4,8])，ml=3 → offset 1 → "ABCDDDD" (7)
    // seq2: ll=0，ov=1 → rep2=4 → offset 4，ml=4 → 从 [3,7)="DDDD" 复制 → "ABCDDDDDDDD" (11)
    const literals = new Uint8Array([0x41, 0x42, 0x43, 0x44]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 11,
      content,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: { seqs: [{ literalLength: 4, offsetValue: 1, matchLength: 3 }, { literalLength: 0, offsetValue: 1, matchLength: 4 }] },
        last: true,
      }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('ov=3, ll=0 → rep1-1 插入（规范表倒数第三行）', () => {
    // seq1: ll=5 "ABCDE"，ov=8 → offset 5，ml=3 → 复制 [0,3)="ABC" → "ABCDEABC" (8)，rep=[5,4,8]
    // seq2: ll=0，ov=3 → rep1-1 = 4，ml=3 → 从 [4,7)="EAB" 复制 → "ABCDEABCEAB" (11)
    const literals = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x41, 0x42, 0x43, 0x45, 0x41, 0x42]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 11,
      content,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: { seqs: [{ literalLength: 5, offsetValue: 8, matchLength: 3 }, { literalLength: 0, offsetValue: 3, matchLength: 3 }] },
        last: true,
      }],
    });
    expect([...out]).toEqual([...content]);
  });

  it('rep1-1 == 0 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcs: 3,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: new Uint8Array([0x41, 0x42]) },
        seqs: { seqs: [{ literalLength: 0, offsetValue: 3, matchLength: 3 }] },
        last: true,
      }],
    });
    expect(() => decompress(frame)).toThrow(/Repeated_Offset1/);
  });

  it('ov=2, ll≠0 → rep2 前移轮转', () => {
    // seq1: ll=5 "ABCDE"，ov=8 → offset 5，ml=3 → 复制 [0,3)="ABC" → "ABCDEABC" (8)，rep=[5,1,4]
    // seq2: ll=1 'X'，ov=6 → offset 3，ml=3 → 复制 [6,9)="BCX" → "ABCDEABCXBCX" (12)，rep=[3,5,1]
    // seq3: ll=0，ov=1 → rep2=5 → offset 5，ml=3 → 从 [7,10)="CXB" 复制 → "ABCDEABCXBCXCXB" (15)
    const literals = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x58]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x41, 0x42, 0x43, 0x58, 0x42, 0x43, 0x58, 0x43, 0x58, 0x42]);
    const out = roundtrip({
      singleSegment: true,
      fcs: 15,
      content,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: {
          seqs: [
            { literalLength: 5, offsetValue: 8, matchLength: 3 },
            { literalLength: 1, offsetValue: 6, matchLength: 3 },
            { literalLength: 0, offsetValue: 1, matchLength: 3 },
          ],
        },
        last: true,
      }],
    });
    expect([...out]).toEqual([...content]);
  });
});

describe('窗口与边界约束', () => {
  it('offset > 已产出 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcs: 5,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: new Uint8Array([1, 2, 3]) },
        seqs: { seqs: [{ literalLength: 0, offsetValue: 10, matchLength: 3 }] },
        last: true,
      }],
    });
    expect(() => decompress(frame)).toThrow(/偏移超过窗口/);
  });

  it('offset > Window_Size → 报错', () => {
    // window = 1KB（descriptor 0x00）；先写 1200 字节（两块），再 offset 1100 (>1024)
    const big = new Uint8Array(1200);
    for (let i = 0; i < 1200; i++) big[i] = i & 0xff;
    const frame = buildFrame({
      singleSegment: false,
      windowDescriptor: 0x00, // 2^10 = 1024
      fcsFlag: 2,
      fcs: 1201,
      blocks: [
        { type: 'raw', data: big.subarray(0, 1024) },
        { type: 'compressed', literals: { type: 'raw', data: big.subarray(1024, 1200) }, seqs: { seqs: [{ literalLength: 0, offsetValue: 1103, matchLength: 3 }] }, last: true },
      ],
    });
    expect(() => decompress(frame)).toThrow(/偏移超过窗口/);
  });

  it('块解压输出 > Block_Maximum_Size → 报错', () => {
    // RLE 块 200KB > 128KB
    const frame = buildFrame({
      singleSegment: true,
      fcsFlag: 2,
      fcs: 200000,
      blocks: [{ type: 'rle', byte: 1, count: 200000, last: true }],
    });
    expect(() => decompress(frame)).toThrow(/Block_Maximum_Size/);
  });
});

describe('校验和与帧结构', () => {
  it('XXH64 校验和正确 → 通过', () => {
    const content = prng(500, 33);
    const out = roundtrip({
      singleSegment: true,
      fcsFlag: 2,
      fcs: 500,
      checksum: true,
      content,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
    expect(out.length).toBe(500);
  });

  it('XXH64 校验和不符 → 报错', () => {
    const content = prng(100, 7);
    const frame = buildFrame({
      singleSegment: true,
      fcs: 100,
      checksum: true,
      checksumValue: 0xdeadbeef,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
    expect(() => decompress(frame)).toThrow(/XXH64 内容校验失败/);
  });

  it('FCS 与实际输出不符 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcsFlag: 2,
      fcs: 99,
      blocks: [
        { type: 'raw', data: new Uint8Array(50) },
        { type: 'raw', data: new Uint8Array(50), last: true },
      ],
    });
    expect(() => decompress(frame)).toThrow(/Frame_Content_Size 不符/);
  });

  it('帧头保留位非零 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      reservedBit: true,
      fcs: 3,
      blocks: [{ type: 'raw', data: new Uint8Array(3), last: true }],
    });
    expect(() => decompress(frame)).toThrow(/保留位非零/);
  });

  it('保留块类型 → 报错', () => {
    const frame = buildFrame({
      singleSegment: true,
      fcs: 0,
      blocks: [{ type: 'reserved', size: 0, last: true }],
    });
    expect(() => decompress(frame)).toThrow(/保留块类型/);
  });
});

describe('skippable 帧与流级行为', () => {
  const SKIP = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 0x04, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);

  it('标准帧前后的 skippable 帧被跳过', () => {
    const content = prng(50, 11);
    const inner = buildFrame({
      singleSegment: true,
      fcs: 50,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
    const stream = new Uint8Array(SKIP.length + inner.length + SKIP.length);
    stream.set(SKIP, 0);
    stream.set(inner, SKIP.length);
    stream.set(SKIP, SKIP.length + inner.length);
    expect([...decompress(stream)]).toEqual([...content]);
  });

  it('纯 skippable 帧 → 空输出', () => {
    expect(decompress(SKIP).length).toBe(0);
  });

  it('未知 magic → 报错', () => {
    expect(() => decompress(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/未知 magic/);
  });

  it('尾部垃圾 → 报错', () => {
    const content = prng(20, 3);
    const inner = buildFrame({
      singleSegment: true,
      fcs: 20,
      blocks: [{ type: 'raw', data: content, last: true }],
    });
    const stream = new Uint8Array(inner.length + 3);
    stream.set(inner, 0);
    stream.set([9, 9, 9], inner.length);
    expect(() => decompress(stream)).toThrow();
  });

  it('多标准帧拼接 → unsupported（二期）', () => {
    const inner = buildFrame({
      singleSegment: true,
      fcs: 3,
      blocks: [{ type: 'raw', data: new Uint8Array([1, 2, 3]), last: true }],
    });
    const stream = new Uint8Array(inner.length * 2);
    stream.set(inner, 0);
    stream.set(inner, inner.length);
    expect(() => decompress(stream)).toThrow(/多标准帧/);
  });
});

describe('三方对拍（writer 造帧：mine == oracle == 手算）', () => {
  it('含序列的帧与 oracle 一致', async () => {
    const { simple } = await getOracle();
    // seq1: ll=4 "ABCD"，ov=1 (rep1)，ml=3 → offset 1 → "ABCDDDD"；seq2: ll=0，ov=1 → rep2=4 → offset 4，ml=4 → "ABCDDDDDDDD"
    const literals = new Uint8Array([0x41, 0x42, 0x43, 0x44]);
    const content = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44]);
    const frame = buildFrame({
      singleSegment: true,
      fcs: 11,
      blocks: [{
        type: 'compressed',
        literals: { type: 'raw', data: literals },
        seqs: { seqs: [{ literalLength: 4, offsetValue: 1, matchLength: 3 }, { literalLength: 0, offsetValue: 1, matchLength: 4 }] },
        last: true,
      }],
    });
    const mine = decompress(frame);
    const oracleOut = simple.decompress(frame);
    expect([...mine]).toEqual([...content]);
    expect([...mine]).toEqual([...oracleOut]);
  });
});
