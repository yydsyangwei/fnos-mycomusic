#!/usr/bin/env node
/**
 * 把 pnpm 的符号链接依赖树「摊平」成真实目录。
 *
 * 为什么需要：pnpm 默认用软链接 + .pnpm 虚拟store，复制进 fpk 包后会全部失效。
 * 这个脚本把所有实际包目录复制到 node_modules/ 根下，然后删掉 .pnpm 与残留软链，
 * 得到一个可以整体打包、原样复制就能跑的标准 node_modules。
 *
 * 用法：node tools/materialize-modules.js [serverDir]
 */

const fs = require('fs');
const path = require('path');

const serverDir = process.argv[2] || path.join(__dirname, '..', 'app', 'server');
const nm = path.join(serverDir, 'node_modules');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    let st;
    try { st = fs.statSync(s); } catch { continue; }
    if (st.isDirectory()) {
      copyDir(s, d);
    } else if (st.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function main() {
  if (!isDir(nm)) {
    console.error('找不到 node_modules：' + nm);
    process.exit(1);
  }

  const stage = path.join(serverDir, '.nm_flat');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const copied = new Set();

  // 1) 先按包名收集真实目录（.pnpm/<pkg@ver>/node_modules/<name>）
  const pnpmDir = path.join(nm, '.pnpm');
  if (isDir(pnpmDir)) {
    for (const v of fs.readdirSync(pnpmDir)) {
      const inner = path.join(pnpmDir, v, 'node_modules');
      if (!isDir(inner)) continue;
      for (const name of fs.readdirSync(inner)) {
        if (name.startsWith('.')) continue;
        const src = path.join(inner, name);
        let real;
        try { real = fs.realpathSync(src); } catch { continue; }
        if (!isDir(real)) continue;
        // 顶层已复制过就不覆盖（保留第一个版本）
        if (copied.has(name)) continue;
        copied.add(name);
        copyDir(real, path.join(stage, name));
      }
    }
  }

  // 2) 再补上 node_modules 根下直接出现、但 .pnpm 里没有的条目
  for (const name of fs.readdirSync(nm)) {
    if (name.startsWith('.')) continue;
    if (copied.has(name)) continue;
    let real;
    try { real = fs.realpathSync(path.join(nm, name)); } catch { continue; }
    if (!isDir(real)) continue;
    copied.add(name);
    copyDir(real, path.join(stage, name));
  }

  // 3) 用摊平结果替换 node_modules
  fs.rmSync(nm, { recursive: true, force: true });
  fs.renameSync(stage, nm);

  let count = 0;
  let bytes = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else { count++; bytes += st.size; }
    }
  })(nm);

  console.log(`摊平完成：${copied.size} 个包，${count} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
}

main();
