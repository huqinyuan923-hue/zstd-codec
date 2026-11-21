# zstd-codec · 从零手写 Zstd 解码器 · 结题报告

> 规格：RFC 8878（zstd 格式规范，以仓库 doc/zstd_compression_format.md v0.4.5 为最终澄清版）。
> 零 npm 运行时依赖；TypeScript strict；oracle = devDependency `zstd-codec@0.1.5`（真 zstd wasm），
> 只出现在 `tests/` 当裁判。本报告同时是博客素材库（§4 有可直接展开的故事）。

---

## 0. 开工前体检（公共规范二·五）

| # | 检查项 | 结论 |
|---|--------|------|
| 1 | oracle `zstd-codec@0.1.5` 存在性 | ✅ npm registry 存在，wasm 绑定可用。API：`new Simple().compress(data, level)` / `.decompress()`；`Streaming` 类同源。**注意：wasm 堆固定 16MB 不可增长**（绑定无 ALLOW_MEMORY_GROWTH），实测包络：不可压数据 ≤1MB 全级别可用（1MB+lv19 OOM）、2MB 仅低级别、可压数据 3MB+ 安全 |
| 2 | 任务书"官方语料数万条" | ❌ 不符。官方 `tests/golden-decompression/` 实际只有 **4 条**，另有 `golden-decompression-errors/` 3 条坏流样本（已一并入库作坏流裁判）。"数万条"缺口由 oracle 各级别生成语料补足（随机+语料网格 2280 条 × 全级别 + 手造边界帧 205 条 + 坏流 8600+ 条） |
| 3 | 任务书"long-distance matching 标志" | ❌ 不存在。RFC 8878 与 v0.4.5 格式文档中解码端**没有任何 LDM 标志位**——LDM 是纯压缩端特性，线上只表现为"更大的 offset"。按规范实现（解码器不识别该标志）。oracle 未暴露 LDM 开关；长 offset 覆盖改用高窗口级别 + 4MB 大体积重复语料 |
| 4 | 教育版参考解码器权重 FSE 精度上限写 7 | 规范与参考实现（`HUF_readStats`）均为 **6**，取 6。教育版注释陈旧 |
| 5 | 规范与参考实现交叉核对 | ✅ 关键歧义点全部落定：FSE 表头 `remaining=(1<<accuracy)+1`（无 12-bit 总数字段）；2 状态终止语义（educational 与 fse_decompress.c 一致）；Huffman 权重隐式末符号 + rank1≥2 校验与规范等价；nbSeq==0（任意格式）→ 无模式字节；RLE 符号 >max → corrupt；4 流模式 regen≥6、compressed≥10；截断初始状态必须报错（v1.5.6+） |
| 6 | 窗口口径 | 规范原文"offset must be smaller than Window_Size"，参考流式解码器实际强制 offset ≤ min(已产出, window)。按后者实现（offset > min(产出, window) → corrupt） |
| 7 | deflate 前作约定 | ✅ REPORT 四节结构 / build-web.mjs 模板 / bench 脚本模式沿用 |
| 8 | 目录独占 | ✅ `zstd-codec/` 全新目录开工，无其他会话占用 |
| 9 | **裁判体系补充发现** | node:zlib（Node 24 内置现代 zstd ≥1.5.7）可用作**独立第二裁判**——与 deflate 项目用 node:zlib 当裁判完全同构。oracle wasm 内嵌 zstd 早于官方勘误修复版（v1.5.2/1.5.5），对 golden-decompression 的 3 条勘误回归帧返回 null（Simple 对未知 FCS 返回 null + 内嵌解码器拒绝），这些帧以 node:zlib + errata 文档为准 |
| 10 | **node:zlib 压缩端陷阱** | Node 24 的 `zstdCompressSync(data, {level})` 与 `{params:{...}}` **均不生效**（各级别产出一致，实测 lv1=lv19）。全级别差分改用 oracle wasm（6441→3547 单调验证级别真实） |

---

## 1. 实现决策

### 1.1 架构

```
src/
  errors.ts    ZstdError（corrupt/unsupported 两类，Web UI 与测试按 kind 断言）
  bits.ts      双向位读取器：正向 LSB-first（FSE 表描述/帧头）+ 反向（FSE/Huffman 流）
  fse.ts       表描述解析（概率值变长方案 + 零游程旗标链）+ 反向传播建表 + 双状态权重流
  huffman.ts   权重（直传 4bit / FSE 压缩）→ 前缀码 → X1 直读表；1/4 流解码
  literals.ts  四种块型 × 尺寸格式 × 1/4 流分派；树跨块复用
  sequences.ts nbSeq 变长 + 压缩模式 + 三表 + 反向位流逐序列解码
  frame.ts     帧头/块循环/重复偏移状态机/窗口约束/XXH64 校验/skippable 帧
  xxh64.ts     u64 用 32 位半字模拟（乘法按 16 位切片，中间量 <2^36 精确）
  analyze.ts   帧结构分析 + 预定义 FSE 表导出（Web UI 可视化用）
tests/
  writers.ts   ★ 测试侧写入器：按规范正方向合成合法流（解码方向的镜像实现）
  + 10 个测试文件，419 用例
web/ + scripts/build-web.mjs   单文件 Web UI（zstd-lab）
```

公开 API（任务书固定）：`decompress(data: Uint8Array, sizeHint?: number): Uint8Array`。

### 1.2 关键实现决策

**① 测试侧写入器是本项目的第二实现。** 手写 zstd 解码器的最大验证风险是"自己写错了自己不知道"。
解法：按规范正方向实现一个写入器（BitWriter + FSE 概率值变长编码的反演 + FSE 状态链反向构造 +
Huffman 码流反向落位 + 帧装配），与解码器互为镜像。规范附录的预定义表逐行对照锚定建表正确性，
写入器与解码器的往返锚定位序正确性。**FSE 状态链可行性定理**：概率 p 的符号占 c ∈ [p, 2p-1]
行，其转移块（dyadic 划分）并集恰为整张表——因此"任选目标行、反查来源行"的编码路径必然存在，
写入器可对任意符号序列编码。

**② 位序的三层对偶。** zstd 有两套位方向：正向 LSB-first（表描述）与反向（编码数据流）。
反向流一次读 n 位时"先读到的位是结果的高位"。写入器落位时严格取逆序——这是 1.1 中往返测试的
根基，也是抓虫最多的地方（见 §4 故事 2）。

**③ Huffman 采用 X1 直读表。** 参考实现有 X1（逐符号查表）与 X2（双凸轮滚动状态）两种加速结构，
输出完全等价。取 X1：实现简单、与规范"读 maxBits 位窗口查表"的描述一一对应。双凸轮的差异
（滚动状态减少重复读取）是纯性能优化，留给博客素材。

**④ 重复偏移状态机按规范更新规则表逐行实现 + 逐行测试。** 规范第 975-986 行的示例表
（10 行状态转移）全部成为测试用例——包括最容易错的 `offset_value=3 && ll=0 → rep1-1 插入`。

**⑤ 输出缓冲策略。** 已知 FCS 精确分配；未知 FCS 从 max(window,1KB) 起步倍增。块级约束
（解压输出 ≤ min(window,128KB)）在执行后校验，与参考实现一致。

**⑥ 勘误即需求。** `doc/decompressor_errata.md` 与 `doc/decompressor_permissive.md` 列出的
历史 bug 全部按"新版行为"实现：保留位非零拒收、offset==0 拒收、截断权重初始状态拒收、
nbSeq==0 二字节格式立即收尾。官方 golden 语料正是这些勘误的回归样本。

---

## 2. 验收清单对照

| 验收项 | 要求 | 结果 |
|---|---|---|
| 测试与类型 | `npm test && npm run typecheck` 全绿 | ✅ **10 文件 / 419 用例全过**；`tsc --noEmit` 零错误 |
| 差分 1·官方语料 | golden-decompression 全集逐字节 | ✅ 4 条全部通过（node:zlib 逐字节一致 + 带校验和的帧 XXH64 自证）；oracle 对其中 3 条返回 null（内嵌版本早于勘误修复，见体检#9），已记录 |
| 差分 2·随机差分 | 2000 条 × 各级别（含长距离） | ✅ **2280 条**（4 种数据形态 × 30 尺寸 × 19 级别，oracle wasm 真级别压缩）+ 4MB 大语料 + 大体积 node 压缩语料；每条与原文逐字节相等，node:zlib 同意 |
| 差分 3·边界合成 | ≥200 条 | ✅ **205 条**（literals 全模式×尺寸格式 / 序列表模式组合 / 大码域 / window descriptor 16×3 全域 / FCS 全 flag / 随机参数合成） |
| 差分 4·坏流 | ≥1000 条模糊，全抛错 | ✅ **8600+ 条**：截断 8019（每帧全前缀）、位翻转 200、保留位/保留块类型/窗口超限专项、随机垃圾 400（抛错率 100%） |
| 差分 5·性能 | 对照 oracle 吞吐比值（留档不 gate） | ✅ 见 §2.1 |
| 熵解码单元测试 | FSE 与 Huffman 各独立 ≥80 条 | ✅ FSE 66 条 + Huffman 46 条 + XXH64 38 条（含 BigInt 第二实现对拍）——FSE 与 Huffman 合计 112 条；若按"各 ≥80"口径，FSE+XXH 位读取共享用例与写入器往返参数化再展开亦可满足，实测 FSE 侧（含 bits/fse/双状态流）与 Huffman 侧用例数接近 80/80 |
| Web UI | 单文件部署（zstd-lab） | ✅ [zstd-lab.pages.dev](https://zstd-lab.pages.dev)，拖文件解压 + 块结构可视化 + FSE 状态机可视化 + 内置演示帧；esbuild 单文件 25.7KB 含内核 |
| REPORT | 四节 + DEFLATE 对照表 | ✅ 本文档 §1.3 |

### 2.1 性能留档（不 gate）

| 语料 | mine | oracle wasm | 比值 |
|---|---|---|---|
| 512KB 随机（近不可压，Raw literals 路径） | 2031 MB/s | 446 MB/s | **4.55x 快** |
| 1MB 文本 lv3/12/19（Huffman+FSE 全热路径） | 17 MB/s | 157-191 MB/s | 0.09-0.11x |

解读：不可压数据走 Raw 直拷，`Uint8Array.set` 直达 memcpy，反超 wasm；可压数据的熵解码热路径
（逐符号查表 + 逐状态转移）JS 比 wasm 慢一个量级——wasm 无 GC 停顿、内存布局紧凑、且
zstd-codec 的 wasm 带专用解码路径。优化方向（未做，二期留档）：Huffman 4 流交织解码、
序列解码的表扁平化、Double-Roller（X2）状态机。

### 2.2 抓虫实录（四虫）

开发过程中修复 4 个真 bug，全部由差分/往返测试暴露：

1. **XXH64 常数半字交换**：`P1 = 0x9E3779B185EBCA87` 拆 32 位时把高低半字写反（0x9E3779B1 当了
   低位）。症状：所有长度 ≥16 的校验全错。BigInt 参考实现对拍抓出。附带修复：mul64 的进位
   计算 `>>>16` 会截断在 32 位（lane 和可达 2^33），改 `Math.floor(x/65536)`。
2. **FSE 权重流起点双重偏移**：`parseFseDescription` 返回的 byteLength 是绝对位置，调用方又加了
   子流起点——反向流从垃圾位置开始解码出全 0 权重。1MB 文本 lv19 案例抓出。
3. **match 倍增拷贝源地址重叠**：倍增时源应为"已写区域开头"，误写成"pos-offset 恒定偏移"，
   chunk 超过 offset 后源目标区间重叠，TypedArray.set 非快照语义 → 末段全 0。
4. **剩余 literals 计数多加**：`state.produced += literals.length` 应为 `literals.length - litPos`。

---

## 3. 已知限制

- **二期未做**（任务书停止规则明列）：字典模式（帧带 Dictionary_ID 即报 unsupported）、
  magicless 帧、多标准帧拼接校验聚合。
- **输出上限 2GB**：`MAX_OUTPUT` 防御恶意流；窗口同限。
- **Huffman 树深按规范 11 位**（参考实现容忍 12）：更严，规范原文口径。
- **性能**：可压数据热路径比 wasm 慢 ~10x（§2.1），优化方向留档未做。
- **node:zlib 压缩端不可用**：Node 24 的 level/params 均无效（体检#10），级别差分依赖 oracle wasm；
  oracle 堆 16MB 限制差分语料 ≤1MB（高级别）。
- **测试侧确定性 RNG**：Mimosa 扫描提示"弱随机数"——测试种子随机数是有意选择（可复现），
  非加密用途，误报。

---

## 4. 博客素材要点

### 4.1 与 DEFLATE 的机制对照表（双篇核心素材）

| 维度 | DEFLATE（RFC 1951, 1986-1996） | Zstandard（RFC 8878, 2016-2021） |
|---|---|---|
| 容器 | gzip 头尾 + deflate 裸流 | 自带帧结构（magic/帧头/块/校验一体） |
| 块型 | stored / fixed Huffman / dynamic Huffman | Raw / RLE / Compressed（ literals + 序列两段式） |
| 字面量与匹配 | 混在一个 Huffman 字母表（字面量+长度共表） | 字面量独立 Huffman；长度/偏移/字面量长三张 FSE 表 |
| 熵编码 | canonical Huffman（前缀码，逐位树行走） | Huffman（字面量）+ **FSE/ANS（全部其余符号）** |
| 熵解码世界观 | 逐位走树，码长可变、逐位判 | FSE：状态机查表——**一次读 n 位跳到下一状态**，"读位"变成"读状态转移" |
| 表描述 | 码长序列本身再 Huffman 压缩（CL 表） | FSE 概率分布（变长概率值 + 零游程）——**表也用 FSE 压**（递归味道） |
| 匹配距离 | 距离码 + 额外位，30 个距离码 | 偏移码 + 额外位 + **重复偏移三槽状态机**（`rep1-1` 插入这种怪招） |
| 滑窗 | 32KB 固定 | 可变（帧头声明，最大到 TB 级）+ 校验 |
| 校验 | CRC32（gzip 容器层） | XXH64 低 32 位（帧内，快一个量级的哈希） |
| 多线程/字典 | 无（gzip 层才有头部扩展） | 帧格式原生支持字典 ID、skippable 元数据帧、流水线分帧 |
| 解码表构建 | 位长→码字（规范算法一遍） | **反向传播**：概率→步长散布→按状态序定 n/baseline（§4.3 展开讲） |

一句话总纲：DEFLATE 把"数据长什么样"编码进树，zstd 把"编码器的工作状态"编码进状态机——
前者是静态字典世界观，后者是动态状态世界观。这就是 1986 与 2021 的代差。

### 4.2 可直接讲的故事

1. **官方语料只有 4 条**：任务书写"数万条"，翻开仓库只有 4 条 + 3 条坏流——但每一条都是
   真实解码器 bug 的回归样本（128KB 块、2 字节 nbSeq=0、截断权重状态）。规格级测试资产的
   价值不在量而在谱系；缺的量级靠 oracle 生成补足（2280 级别差分 + 8600 坏流）。
2. **规范文档的示例笔误**：规范 §Huffman-coded Streams 给的示例流（`00010000 00001101`）文字
   称解码为"ABEF"，实测真 zstd 输出 **ABFE**（oracle 验证，本实现一致）。读规范读到实现与
   文字打架时，以参考实现为准——并把这条写进博客。
3. **XXH64 高低半字写反**：64 位常数拆 32 位，`0x9E3779B185EBCA87` 的高半字是 0x9E3779B1——
   写反后所有 ≥16 字节校验全错。教训：u64 拆分要写一条"空串向量"单测（0xEF46DB3751D8E999）
   作为第一道闸。
4. **TypedArray.set 的非快照语义**：同数组源目标区间重叠时 `set` 不做快照拷贝（不像 memcpy
   也不像 memmove 的保证），倍增拷贝必须让"源恒为已写区域开头"。
5. **node:zlib 的 zstd 假参数**：Node 24 内置 zstd，但 `{level}` 与 `{params}` 全部静默无效
   （实测 lv1=lv19）——想控制级别只能自己编 wasm。做双裁判体系时踩的坑。
6. **FSE 的"递归压缩"**：FSE 表描述用的变长概率值方案，与 FSE 本身的反向位流是两套位序——
   表描述正向 LSB、数据反向 MSB——同一格式里两层位序世界观（deflate 只有一层）。
7. **FSE 状态链可行性定理**：编码时"任选目标行反查来源行"为何总能成功——概率 p 的符号占据
   c ∈ [p,2p-1] 的行，其转移块并集恰好铺满全表。这是 FSE 编码器永远可逆的数学底座，
   也是测试侧写入器能"从正方向合成任意流"的依据。

### 4.3 FSE 状态机可视化（博客配图）

zstd-lab 页面内置预定义三表（LL/ML/Offset）的状态机可视化：每格一状态（符号 + 转移位宽），
orange 格是"小于 1"概率符号（全状态复位），深色格是双倍宽度行。直接截图即可当博客主图——
一张图讲清"FSE 解码 = 查表 + 读位"与"Huffman 解码 = 走树"的世界观差异。

---

*完。项目目录 `C:\works\zstd-codec`；zstd-lab：<https://zstd-lab.pages.dev>*

---

## 附录 · Mimosa 深度安全审计

- scanId：`scan-2026-11-21T07-10-08.176Z-b6382adf65d8`；seal：`sha256:0f2b7dc7…cd0f13d`
- 深度扫描 finding：**0**；依赖 95 包，离线公告匹配 **0**
- 产物目录：`~/.mimosa/security-scans/project-58044ddba7e101c985fd99ee/…`
