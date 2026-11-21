/**
 * zstd-lab 前端：拖文件解压 + 块结构可视化 + FSE 状态机配图。
 * 打包为 IIFE 内联进 index.html（scripts/build-web.mjs）。
 */
import { decompress } from '../src/index.js';
import { analyzeFrame, predefinedFseTables, type FrameStructure, type FseVisualizationTable } from '../src/analyze.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---- 拖放 ----
const drop = $('drop');
const fileInput = $('file') as HTMLInputElement;
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) loadFile(fileInput.files[0]);
});

async function loadFile(f: File): Promise<void> {
  const buf = new Uint8Array(await f.arrayBuffer());
  run(buf, f.name);
}

// ---- 解码 + 渲染 ----
function run(data: Uint8Array, name: string): void {
  const errEl = $('err');
  errEl.textContent = '';
  const statsEl = $('stats');
  const blocksEl = $('blocks');
  try {
    const t0 = performance.now();
    const out = decompress(data);
    const ms = performance.now() - t0;
    const ratio = data.length > 0 ? out.length / data.length : 0;
    statsEl.innerHTML = `
      <div class="stat"><span class="k">文件</span><span>${escapeHtml(name)}（${data.length} B）</span></div>
      <div class="stat"><span class="k">解压输出</span><span class="ok">${out.length} B</span></div>
      <div class="stat"><span class="k">压缩比</span><span>${ratio.toFixed(3)} : 1</span></div>
      <div class="stat"><span class="k">耗时</span><span>${ms.toFixed(1)} ms（${((out.length / 1024 / 1024) / (ms / 1000)).toFixed(0)} MB/s）</span></div>
      <div class="bar"><div style="width:${Math.min(100, ratio * 40)}%;background:var(--green)"></div></div>
      <div class="stat"><span class="k">输出预览</span><span style="text-align:right">${escapeHtml(preview(out))}</span></div>
    `;
  } catch (e) {
    statsEl.innerHTML = '';
    errEl.textContent = `解码失败：${(e as Error).message}`;
  }
  // 结构（无论解码成败都尝试解析）
  try {
    renderStructure(analyzeFrame(data), blocksEl);
  } catch (e) {
    blocksEl.innerHTML = `<div class="err">结构解析失败：${(e as Error).message}</div>`;
  }
}

function preview(out: Uint8Array): string {
  const n = Math.min(64, out.length);
  let s = '';
  for (let i = 0; i < n; i++) {
    const b = out[i]!;
    s += b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return s + (out.length > 64 ? ' …' : '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderStructure(st: FrameStructure, el: HTMLElement): void {
  const h = st.header;
  const fcs = h.frameContentSize >= 0 ? `${h.frameContentSize} B` : '未知';
  let html = `
    <table>
      <tr><th>帧头字段</th><th>值</th></tr>
      <tr><td>Single_Segment</td><td>${h.singleSegment ? '是（无窗口描述符）' : '否'}</td></tr>
      <tr><td>Window_Size</td><td class="num">${fmtSize(h.windowSize)}</td></tr>
      <tr><td>Frame_Content_Size</td><td class="num">${fcs}</td></tr>
      <tr><td>Content_Checksum</td><td>${h.contentChecksum ? '有（XXH64 低 32 位）' : '无'}</td></tr>
      <tr><td>Dictionary_ID</td><td class="num">${h.dictionaryId}</td></tr>
      <tr><td>帧头长度</td><td class="num">${h.headerLen + 4} B（含 magic）</td></tr>
    </table>
    <table>
      <tr><th>#</th><th>块类型</th><th>压缩尺寸</th><th>字面量</th><th>序列数</th></tr>
  `;
  for (const b of st.blocks) {
    html += `
      <tr>
        <td>${b.index}${b.last ? ' (末)' : ''}</td>
        <td>${b.type}</td>
        <td class="num">${b.compressedSize} B</td>
        <td>${b.literals ? `${b.literals.blockType} · 再生 ${b.literals.regenSize}B` : '—'}</td>
        <td class="num">${b.nbSeq ?? '—'}</td>
      </tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ---- FSE 状态机可视化 ----
const tables: FseVisualizationTable[] = predefinedFseTables();
const sel = $('fseSel') as HTMLSelectElement;
tables.forEach((t, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = t.name;
  sel.appendChild(opt);
});
sel.addEventListener('change', () => renderFse(tables[Number(sel.value)]!));

function renderFse(t: FseVisualizationTable): void {
  const size = 1 << t.accuracyLog;
  let html = '<div class="fse-grid">';
  for (const row of t.rows) {
    const cls = ['cell'];
    if (t.resetSymbols.includes(row.symbol)) cls.push('reset');
    else if (row.nbBits < t.accuracyLog - 1) cls.push('wide');
    html += `<div class="${cls.join(' ')}" title="状态 ${row.state}：符号 ${row.symbol}，读 ${row.nbBits} 位 → ${row.baseline} + rest">
      <span class="sym">${row.symbol}</span><span class="nb">${row.nbBits}b</span></div>`;
  }
  html += '</div>';
  $('fseView').innerHTML = html;
  const maxSym = Math.max(...t.rows.map((r) => r.symbol));
  $('fseNote').textContent =
    `${t.name}：共 ${size} 个状态，符号域 0..${maxSym}，"小于 1"概率符号 {${t.resetSymbols.join(',')}}（orange 格，各占表尾一行全复位）。` +
    ` 解码：输出当前状态的符号 → 读 n 位 → 新状态 = baseline + rest。`;
}
renderFse(tables[0]!);

// ---- 演示帧 ----
const demos = document.querySelectorAll('button.demo');
const DEMO_RLE = buildRleDemo();
const DEMO_HUF = buildHufDemo();
demos[0]?.addEventListener('click', () => loadDemo(DEMO_RLE, 'RLE 块帧（1 字节 ×100）'));
demos[1]?.addEventListener('click', () => loadDemo(DEMO_HUF, 'Huffman 字面量帧（规范示例树 A-F）'));

function loadDemo(data: Uint8Array, name: string): void {
  $('demoHint').textContent = `已载入：${name}（${data.length} B）`;
  run(data, name);
}

/** 构造演示帧：raw literals + 无序列的单压缩块（规范正方向手写）。 */
function buildRleDemo(): Uint8Array {
  // literals：RLE 1 字节 'z' ×100（1 字节头：type=1, regen=100 → 需 2 字节头? 100 ≤ 4095 → sf=01 12 位）
  // 头 2 字节：b0 = 1 | (1 << 2) | ((100 & 0xf) << 4) = 1 | 4 | 64 = 0x45；b1 = 100 >> 4 = 6
  // 序列段：nbSeq = 0
  const body = new Uint8Array([0x45, 0x06, 0x7a, 0x00]);
  const bh = 1 | (2 << 1) | (body.length << 3); // last + compressed + size
  const fcs = 100;
  return new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd,
    0x20, // FHD：singleSegment + 1 字节 FCS
    fcs,
    bh & 0xff, (bh >>> 8) & 0xff, (bh >>> 16) & 0xff,
    ...body,
  ]);
}

/** 构造演示帧：Huffman 字面量（规范示例树 A=1/B=01/C=001/E=0000/F=0001）+ 无序列。 */
function buildHufDemo(): Uint8Array {
  // 字面量 "ABEF"（规范示例）：码 A=1(1b) B=01(2b) F=0001(4b) E=0000(4b)
  // 反向流（写入顺序 F,E,B,A + 结束标志）：位流 00010000 00001101
  const literals = new Uint8Array([0, 1, 4, 5]); // A B E F
  // 树描述：weights [4,3,2,0,1]，直传 headerByte = 127+5 = 132 = 0x84，半字节 [4,3],[2,0],[1,0]
  const tree = new Uint8Array([0x84, 0x43, 0x20, 0x10]);
  // Huffman 流（示例字节）
  const stream = new Uint8Array([0x10, 0x0d]);
  const payload = new Uint8Array(tree.length + stream.length);
  payload.set(tree, 0);
  payload.set(stream, tree.length);
  // literals 头：type=2, sf=00（单流 10 位域），regen=4, comp=payload.length=6（树 4B + 流 2B）
  // v = 2 | 0<<2 | (4 << 4) | (6 << 14)
  const v = 2 | (4 << 4) | (payload.length * 2 ** 14);
  const litHdr = new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]);
  const seq = new Uint8Array([0x00]); // nbSeq = 0
  const body = new Uint8Array(litHdr.length + payload.length + seq.length);
  body.set(litHdr, 0);
  body.set(payload, litHdr.length);
  body.set(seq, litHdr.length + payload.length);
  const bh = 1 | (2 << 1) | (body.length << 3);
  const fcs = 4;
  return new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd,
    0x20, fcs,
    bh & 0xff, (bh >>> 8) & 0xff, (bh >>> 16) & 0xff,
    ...body,
  ]);
}
