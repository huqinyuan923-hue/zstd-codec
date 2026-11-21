/**
 * 帧结构分析（Web UI / 博客配图用）：不解压，只解析结构。
 * 同时导出预定义 FSE 表供 FSE 状态机可视化。
 */
import { parseFrameHeader } from './frame.js';
import { decodeLiterals } from './literals.js';
import { decodeSequences } from './sequences.js';
import { buildFseTable } from './fse.js';
import { LL_DEFAULT_DIST, ML_DEFAULT_DIST, OF_DEFAULT_DIST } from './sequences.js';

export interface BlockInfo {
  index: number;
  last: boolean;
  type: 'Raw' | 'RLE' | 'Compressed' | 'Reserved';
  compressedSize: number;
  decompressedSize?: number;
  literals?: {
    blockType: string;
    regenSize: number;
    compressedSize?: number;
    streams?: number;
    maxBits?: number;
    nbSymbols?: number;
  };
  nbSeq?: number;
}

export interface FrameStructure {
  header: {
    singleSegment: boolean;
    windowSize: number;
    frameContentSize: number; // -1 未知
    contentChecksum: boolean;
    dictionaryId: number;
    headerLen: number;
  };
  blocks: BlockInfo[];
}

/** 解析帧结构（容忍解压失败：块级错误时截断并标注）。 */
export function analyzeFrame(data: Uint8Array): FrameStructure {
  const { header, headerLen } = parseFrameHeader(data, 4, data.length);
  const structure: FrameStructure = {
    header: {
      singleSegment: header.singleSegment,
      windowSize: header.windowSize,
      frameContentSize: header.frameContentSize,
      contentChecksum: header.contentChecksum,
      dictionaryId: header.dictionaryId,
      headerLen,
    },
    blocks: [],
  };

  const litState = { huf: null };
  const seqTables = { ll: null, of: null, ml: null };
  let p = 4 + headerLen;
  let produced = 0;
  let index = 0;
  for (;;) {
    if (p + 3 > data.length) break;
    const bh = data[p]! + data[p + 1]! * 256 + data[p + 2]! * 65536;
    p += 3;
    const last = (bh & 1) === 1;
    const typeNum = (bh >>> 1) & 3;
    const blockSize = bh >>> 3;
    const type = (['Raw', 'RLE', 'Compressed', 'Reserved'] as const)[typeNum]!;
    const info: BlockInfo = { index, last, type, compressedSize: blockSize };
    try {
      if (typeNum === 0) {
        produced += blockSize;
        info.decompressedSize = blockSize;
        p += blockSize;
      } else if (typeNum === 1) {
        produced += blockSize;
        info.decompressedSize = blockSize;
        p += 1;
      } else if (typeNum === 2) {
        const blockStart = p;
        const blockEnd = p + blockSize;
        const blockMax = Math.min(Math.max(header.windowSize, 1024), 128 * 1024);
        const lit = decodeLiterals(data, blockStart, blockEnd, litState, blockMax);
        info.literals = {
          blockType: ['Raw', 'RLE', 'Huffman(新表)', 'Huffman(复用)'][ (data[blockStart]! & 3) ]!,
          regenSize: lit.literals.length,
          compressedSize: lit.sectionLength,
        };
        const seqs = decodeSequences(data, blockStart + lit.sectionLength, blockEnd, seqTables);
        info.nbSeq = seqs.length;
        produced += lit.literals.length + seqs.reduce((a, s) => a + s.literalLength + s.matchLength, 0);
        info.decompressedSize = produced > 0 ? produced : undefined;
        // 只记录增量
        info.decompressedSize = undefined;
        p = blockEnd;
      } else {
        break;
      }
      structure.blocks.push(info);
      index++;
      if (last) break;
    } catch (e) {
      info.decompressedSize = undefined;
      structure.blocks.push(info);
      break;
    }
  }
  // 修正累计输出：用最后位置差值标注（简化：RLE/Raw 精确，Compressed 用 FCS 或省略）
  if (header.frameContentSize >= 0 && structure.blocks.length > 0) {
    // 无法逐块精确归因（无二次解码），保留 FCS 作为总量参考
  }
  return structure;
}

/** 预定义 FSE 解码表（状态机可视化用）。 */
export interface FseVisualizationTable {
  name: string;
  accuracyLog: number;
  rows: { state: number; symbol: number; nbBits: number; baseline: number }[];
  /** "小于 1"概率（-1）符号——行属性与 p=1 符号相同，需从分布判定 */
  resetSymbols: number[];
}

export function predefinedFseTables(): FseVisualizationTable[] {
  const mk = (name: string, dist: number[], maxSymbol: number, accuracyLog: number): FseVisualizationTable => {
    const t = buildFseTable([...dist], maxSymbol, accuracyLog);
    return {
      name,
      accuracyLog,
      rows: Array.from(t.symbols, (_, state) => ({
        state,
        symbol: t.symbols[state]!,
        nbBits: t.numBits[state]!,
        baseline: t.newStateBase[state]!,
      })),
      resetSymbols: dist.map((p, s) => (p === -1 ? s : -1)).filter((s) => s >= 0),
    };
  };
  return [
    mk('Literals Length（精度 6 · 64 状态）', [...LL_DEFAULT_DIST], 35, 6),
    mk('Match Length（精度 6 · 64 状态）', [...ML_DEFAULT_DIST], 52, 6),
    mk('Offset（精度 5 · 32 状态）', [...OF_DEFAULT_DIST], 31, 5),
  ];
}
