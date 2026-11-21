/**
 * Web 构建脚本（npm run build:web）：把 web/main.ts 打包成 IIFE 并内联进
 * dist/index.html —— 交付物是单文件，双击即可用，纯本地。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const r = await build({
  entryPoints: [join(root, 'web', 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  charset: 'utf8',
  write: false,
});

// </script> 字面量会截断内联标签，转义之
const js = r.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
const tpl = readFileSync(join(root, 'web', 'index.html'), 'utf8');
const html = tpl.replace('{{BUNDLE}}', () => js);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html 生成完毕（${(html.length / 1024).toFixed(1)} KB，含内联 bundle）`);
