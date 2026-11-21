/** oracle（zstd-codec wasm）的类型声明——仅测试侧使用。 */
declare module 'zstd-codec' {
  export interface ZstdBinding {
    Simple: new () => {
      compress(data: Uint8Array, level?: number): Uint8Array;
      decompress(data: Uint8Array): Uint8Array | null;
      compressUsingDict(data: Uint8Array, dict: unknown, level?: number): Uint8Array | null;
      decompressUsingDict(data: Uint8Array, dict: unknown): Uint8Array | null;
    };
    Streaming: new () => {
      compress(data: Uint8Array, level?: number): Uint8Array;
      decompress(data: Uint8Array, sizeHint?: number): Uint8Array;
      compressChunks(chunks: Uint8Array[], level?: number): Uint8Array;
      decompressChunks(chunks: Uint8Array[], sizeHint?: number): Uint8Array;
    };
    Generic: new () => {
      compressBound(size: number): number;
      contentSize(data: Uint8Array): number | null;
    };
  }
  export const ZstdCodec: { run(onReady: (b: ZstdBinding) => void, onError?: (e: Error) => void): void };
}
