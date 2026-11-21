# 测试语料说明

- `golden/*.zst` 与 `golden/errors/*.zst`：来自 facebook/zstd 官方仓库
  `tests/golden-decompression/`（4 条）与 `tests/golden-decompression-errors/`（3 条）。
  zstd 以 BSD+GPLv2 双许可发布，测试语料随源码许可再分发；此批文件是官方
  "历轮解码器 bug 回归样本"（见 zstd 仓库 `doc/decompressor_errata.md`），每条
  对应一次真实解码器 bug（128KB 压缩块、2 字节 nbSeq=0、截断 Huffman 初始状态等），
  是本项目最有价值的规范级测试资产。来源：
  https://github.com/facebook/zstd/tree/dev/tests/golden-decompression
- 压缩侧对照语料：不入库。由 oracle（zstd-codec wasm）在测试运行时生成。
- 其余差分语料由测试自行生成（伪随机 + 文本型 + 手造边界帧），不入库。
