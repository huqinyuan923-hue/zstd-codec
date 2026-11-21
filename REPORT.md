# zstd-codec · 从零手写 Zstd 解码器 · 结题报告

> 规格：RFC 8878（zstd 格式规范，以仓库 doc/zstd_compression_format.md v0.4.5 为最终澄清版）。
> 零 npm 运行时依赖；TypeScript strict；oracle = devDependency `zstd-codec@0.1.5`（真 zstd wasm），
> 只出现在 `tests/` 当裁判。

---

## 0. 开工前体检（公共规范二·五）

| # | 检查项 | 结论 |
|---|--------|------|
| 1 | oracle `zstd-codec@0.1.5` 存在性 | ✅ npm registry 存在，wasm 绑定可用。API：`new Simple().compress(data, level)` / `.decompress()`；`Streaming` 类同源。**注意：wasm 堆固定 16MB 不可增长**（绑定里无 ALLOW_MEMORY_GROWTH），实测包络：不可压数据 ≤1MB 全级别可用（1MB+level19 会 OOM）、2MB 仅低级别、可压数据 3MB+ 安全 |
| 2 | 任务书"官方语料数万条" | ❌ 不符。官方 `tests/golden-decompression/` 实际只有 **4 条**，另有 `golden-decompression-errors/` 3 条坏流样本（已一并入库作坏流裁判）。"数万条"缺口由 oracle 各级别生成语料补足（随机 2000 + 文本/结构化各大小 3000+ + 手造边界帧） |
| 3 | 任务书"long-distance matching 标志" | ❌ 不存在。RFC 8878 与 v0.4.5 格式文档中解码端**没有任何 LDM 标志位**——LDM 是纯压缩端特性，线上只表现为"更大的 offset"。按规范实现（解码器不识别该标志），oracle 未暴露 LDM 开关，长 offset 覆盖改用高窗口级别 + 大体积重复语料 |
| 4 | 教育版参考解码器权重 FSE 精度上限写 7 | 规范与参考实现（`HUF_readStats`）均为 **6**，取 6。教育版注释陈旧 |
| 5 | 规范与参考实现交叉核对 | ✅ 关键歧义点全部落定：FSE 表头 `remaining=(1<<accuracy)+1`（无 12-bit 总数字段）；2 状态终止语义（educational 与 fse_decompress.c 一致）；Huffman 权重隐式末符号 + rank1≥2 校验与规范等价；nbSeq==0（任意格式）→ 无模式字节；RLE 符号 >max → corrupt；4 流模式 regen≥6、compressed≥10；截断初始状态必须报错（v1.5.6+） |
| 6 | 窗口口径 | 规范原文"offset must be smaller than Window_Size"，参考流式解码器实际强制 offset ≤ min(已产出, window)。按后者实现（offset > min(产出, window) → corrupt），规范原文的 "smaller than" 视为措辞（等号场景参考解码器可接受）；差分中与 oracle 实测对齐 |
| 7 | deflate 前作约定 | ✅ REPORT 四节结构 / build-web.mjs 模板 / bench 脚本模式沿用 |
| 8 | 目录独占 | ✅ `zstd-codec/` 全新目录开工，无其他会话占用 |

> 体检发现 #2、#3 为任务书与现实不符项，按公共规范回主会话裁决：任务书口径
> "数万条、含 LDM"不成立，实现与验收按上述修正执行（oracle 当裁判的差分验收不变）。

---

## 1. 实现决策

（随里程碑填充）

## 2. 验收清单对照

（收尾填充）

## 3. 已知限制

（收尾填充）

## 4. 博客素材要点

（收尾填充）
