'use strict';
// 打发布包：release/TCGinFU卡牌工具/ 文件夹 + 同名 zip。
// 包里自带 Node 运行时（runtime\node.exe），策划解压后双击 .cmd 就能用，电脑上不用装任何东西。
//
//   node scripts/release.js              用当前这台机器的 node.exe 打包
//   node scripts/release.js --no-runtime 不带运行时（给已经装了 Node 的人，包小很多）

const fs = require('fs');
const path = require('path');
const { zip } = require('../src/xlsx');
const { writeLaunchers } = require('./make-launchers');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = 'TCGinFU卡牌工具';
const withRuntime = !process.argv.includes('--no-runtime');

const OUT = path.join(ROOT, 'release');
const DIR = path.join(OUT, NAME);

function copy(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(DIR, rel);
  if (fs.statSync(src).isDirectory()) {
    for (const e of fs.readdirSync(src)) copy(path.join(rel, e));
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const NODE_NOTICE = `runtime\\node.exe 是 Node.js ${process.version}（https://nodejs.org/），按 MIT 许可证随本工具分发。

Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

Node.js 自带的第三方组件许可证见：
https://github.com/nodejs/node/blob/${process.version}/LICENSE
`;

const GUIDE = `TCGinFU 卡牌工具 v${pkg.version}
====================================

不用安装任何东西。把这个文件夹放在游戏工程附近，它会自己找到工程，任选一种摆法：

  和工程并排：   某个文件夹\\TCGinFU\\              和  某个文件夹\\TCGinFU卡牌工具\\
  放进工程里：   TCGinFU\\Tools\\TCGinFU卡牌工具\\
  隔一层并排：   某个文件夹\\TCGinFU\\              和  某个文件夹\\工具\\TCGinFU卡牌工具\\

找到后记在 cardbrowser.local.json 里，记的是相对位置（比如 ../TCGinFU/...），
所以工程和工具一起挪到别处、换一台电脑，都不用重新设置。
附近有好几个工程（比如主工程和一个分支副本）时，第一次运行会问你用哪个。

三个按钮
--------
  导出卡牌表.cmd      导出最新的卡牌表，并用 Excel 打开：卡牌表.xlsx
  导入卡牌表.cmd      把改好的卡牌表写回游戏。先列出所有改动，输入 y 回车才写入
                     （也可以把别的 xlsx 文件拖到它上面导入那个文件）
  打开卡牌浏览器.cmd  在浏览器里看所有卡、Lua 实现情况和检查报告；游戏数据一改页面就自动刷新

如果附近没找到游戏工程，会提示上面几种摆法，也可以把工程文件夹拖进黑色窗口回车（要和工具在同一个盘上）。
想换成别的工程：删掉 cardbrowser.local.json，再运行一次。

日常流程
--------
  1. 双击「导出卡牌表」。每次改之前都重新导出一份，拿到最新的数据。
  2. 在 Excel 里改：
       - 改：直接改格子。只有你改过的格子会写回。
       - 加新卡：在「卡牌」表最下面加一行，id 用小写英文 + 下划线（比如 frost_nova）；
         能用数据表达的效果（造成 X 点伤害、获得 X 点护盾……）在「效果」表里加行。
       - 删：在「删除」列选「删除」。
       - 填表规则详见表格里的「说明」页。
  3. 保存并关掉 Excel，双击「导入卡牌表」，看清楚改动后输入 y 回车。
  4. 导入后，「输出\\agent-tasks.md」是给 agent 的任务单：
     新卡要实现哪些 Lua、改了卡面的卡要核对哪些 Lua。把它交给 agent 即可。

常见问题
--------
  - 导出时说「文件可能正在 Excel 里打开着」：先关掉 Excel 里的卡牌表。
  - 导入时有「冲突」：你导出之后，同一格在游戏数据里也被别人改过。重新导出一份再改，
    或者确认用你的值：在本文件夹打开命令行，运行
      runtime\\node.exe build.js import --apply --force
  - 导入时有「错误」：按提示改好表格再导入，有错误时什么都不会写。
  - 每次导入的预览、记录、任务单都存在「输出\\import\\」下，带时间。
`;

function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const rel of ['build.js', 'package.json', 'src', 'profiles']) copy(rel);
  writeLaunchers(DIR);
  fs.writeFileSync(path.join(DIR, 'cardbrowser.config.json'), JSON.stringify({
    $comment: '发布版设置。contentDir 留空 = 自动在工具附近找游戏工程，找到后以相对路径记进 cardbrowser.local.json。所有路径都相对本文件夹。',
    contentDir: '',
    outDir: '输出',
    xlsx: '卡牌表.xlsx',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(DIR, '使用说明.txt'), '﻿' + GUIDE.replace(/\n/g, '\r\n'));
  if (withRuntime) {
    fs.mkdirSync(path.join(DIR, 'runtime'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(DIR, 'runtime', 'node.exe'));
    fs.writeFileSync(path.join(DIR, 'runtime', 'NODE_LICENSE.txt'), '﻿' + NODE_NOTICE.replace(/\n/g, '\r\n'));
  }

  // 打 zip：包里顶层是一个文件夹，解压后不会散一地
  const files = [];
  const walk = (rel) => {
    const abs = path.join(DIR, rel);
    if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${e}` : e); return; }
    files.push([`${NAME}/${rel}`, fs.readFileSync(abs)]);
  };
  walk('');
  const zipName = `${NAME}-v${pkg.version}${withRuntime ? '' : '-无运行时'}.zip`;
  const zipPath = path.join(OUT, zipName);
  fs.writeFileSync(zipPath, zip(files));
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`发布文件夹：${DIR}`);
  console.log(`压缩包：${zipPath}（${mb(fs.statSync(zipPath).size)}，${files.length} 个文件）`);
}

main();
