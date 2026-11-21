/**
 * zstd-codec 公共入口。
 * 公开 API（任务书固定）：decompress(data: Uint8Array, sizeHint?: number): Uint8Array
 * 支持标准帧（0x28B52FFD 字节序）与 skippable 帧（跳过）。
 * magicless 帧、字典模式、多标准帧拼接列二期。
 */
import { decodeStream } from './frame.js';
import { xxh64 } from './xxh64.js';

export function decompress(data: Uint8Array, sizeHint?: number): Uint8Array {
  void sizeHint; // 输出尺寸由帧头 FCS/窗口决定；sizeHint 仅作容量提示，暂无必要区分
  return decodeStream(data);
}

/** XXH64 校验（供测试与 Web UI 使用；帧校验内部自动执行）。 */
export function checksum(data: Uint8Array): { low: number; high: number } {
  return xxh64(data);
}

export { ZstdError } from './errors.js';
