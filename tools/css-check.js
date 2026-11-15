/**
 * CSS 语法校验：catch 游离引号/括号不平衡这类会让整段样式失效的低级错误。
 * 用法：node css-check.js ../app/server/public/index.html
 */
const fs = require('fs');
const postcss = require('postcss');

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const css = html.split('<style>')[1].split('</style>')[0];

const open = (css.match(/{/g) || []).length;
const close = (css.match(/}/g) || []).length;
console.log(`CSS 长度 ${css.length}，花括号 ${open}/${close}`);

try {
  const root = postcss.parse(css, { from: 'inline.css' });
  console.log(`✅ 语法正常，${root.nodes.filter((n) => n.type === 'rule').length} 条规则`);
} catch (e) {
  console.log(`❌ ${e.reason}（行 ${e.line} 列 ${e.column}）`);
  const lines = css.split('\n');
  for (let i = Math.max(0, e.line - 2); i < Math.min(lines.length, e.line + 1); i++) {
    console.log(String(i + 1).padStart(4), lines[i]);
  }
  process.exit(1);
}