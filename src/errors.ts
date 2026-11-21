/** 解码错误：所有非法/不支持的输入统一抛出本类型。 */
export class ZstdError extends Error {
  /** 错误类别，便于测试断言与 Web UI 展示 */
  readonly kind: 'corrupt' | 'unsupported';
  constructor(kind: 'corrupt' | 'unsupported', message: string) {
    super(`zstd: ${kind === 'corrupt' ? '数据损坏' : '不支持'}：${message}`);
    this.name = 'ZstdError';
    this.kind = kind;
  }
}

/** 数据损坏（格式非法、校验失败、越界引用等） */
export function corrupt(message: string): ZstdError {
  return new ZstdError('corrupt', message);
}

/** 合法但本实现不支持（字典、magicless、多标准帧拼接等二期项） */
export function unsupported(message: string): ZstdError {
  return new ZstdError('unsupported', message);
}
