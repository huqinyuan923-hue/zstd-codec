/** 测试帮手：oracle 单例、伪随机数据、hex 工具。 */
import { zstdDecompressSync } from 'node:zlib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any;

/**
 * 独立裁判：node:zlib 内置 zstd（Node 24 捆绑现代 zstd ≥1.5.7）。
 * 与 deflate 项目的 node:zlib 裁判同构。返回 null 表示 node 拒绝该流。
 */
export function nodeZstd(data: Uint8Array): Uint8Array | null {
  try {
    const out = zstdDecompressSync(data);
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

let oraclePromise: Promise<AnyRecord> | null = null;

/** 载入 oracle（zstd-codec wasm，进程内单例）。 */
export async function getOracle(): Promise<{ simple: AnyRecord; streaming: AnyRecord }> {
  if (!oraclePromise) {
    oraclePromise = (async () => {
      const mod = (await import('zstd-codec')) as AnyRecord;
      const ZstdCodec = mod.ZstdCodec ?? mod.default?.ZstdCodec;
      const binding = await new Promise<AnyRecord>((res, rej) => ZstdCodec.run(res, rej));
      return { simple: new binding.Simple(), streaming: new binding.Streaming() };
    })();
  }
  return oraclePromise;
}

/** oracle 解压裁判：Simple.decompress 对未知 FCS 帧返回 null，回退 Streaming。 */
export async function oracleDecompress(data: Uint8Array): Promise<Uint8Array | null> {
  const { simple, streaming } = await getOracle();
  let out: Uint8Array | null = null;
  try {
    out = simple.decompress(data);
  } catch {
    out = null;
  }
  if (out === null || out === undefined) {
    out = streaming.decompress(data);
  }
  return out ?? null;
}

/** 确定性伪随机字节。 */
export function prng(n: number, seed = 42): Uint8Array {
  const a = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s >>> 24;
  }
  return a;
}

/** 文本型（可压缩）数据：重复词表 + 变长重复段。 */
export function texty(n: number, seed = 7): Uint8Array {
  const words = [
    'the ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'lazy ', 'dog ',
    'zstd ', 'fse ', 'entropy ', 'frame ', 'block ', 'literals ', 'sequence ',
  ];
  const a = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  let w = 0;
  let wi = 0;
  for (let i = 0; i < n; i++) {
    if (wi === 0) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      w = s % words.length;
      wi = 2 + (s % 9); // 词长
    }
    const word = words[w]!;
    a[i] = word.charCodeAt(i % word.length) & 0x7f;
    wi--;
  }
  return a;
}

/** 高重复数据（长偏移/长匹配来源）。 */
export function repetitive(n: number, seed = 11): Uint8Array {
  const chunk = prng(4096, seed);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i += chunk.length) {
    a.set(chunk.subarray(0, Math.min(chunk.length, n - i)), i);
  }
  return a;
}

export function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
