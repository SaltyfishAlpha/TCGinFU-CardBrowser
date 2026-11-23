'use strict';
// 生成双击用的 .cmd。发布版和开发目录用的是同一套：
// 有 runtime\node.exe（发布版自带）就用它，没有就用系统装的 node。
// .cmd 里只写 ASCII（中文提示都由 build.js 输出），避免不同代码页下乱码。

const fs = require('fs');
const path = require('path');

const HEAD = [
  '@echo off',
  'chcp 65001 >nul',
  'set "ARG=%~f1"',
  'cd /d "%~dp0"',
  'set "NODE=%~dp0runtime\\node.exe"',
  'if not exist "%NODE%" set "NODE=node"',
  '"%NODE%" -v >nul 2>nul || (',
  '  echo Node.js not found. Use the release package, or install Node 18+ from https://nodejs.org/',
  '  pause',
  '  exit /b 1',
  ')',
];

const LAUNCHERS = {
  '打开卡牌浏览器.cmd': '"%NODE%" build.js --serve --open --ask',
  '导出卡牌表.cmd': '"%NODE%" build.js export --open --ask',
  '导入卡牌表.cmd': 'if "%ARG%"=="" ("%NODE%" build.js import --confirm --open --ask) else ("%NODE%" build.js import "%ARG%" --confirm --open --ask)',
};

function writeLaunchers(dir) {
  for (const [name, cmd] of Object.entries(LAUNCHERS)) {
    fs.writeFileSync(path.join(dir, name), [...HEAD, cmd, 'pause', ''].join('\r\n'));
  }
  return Object.keys(LAUNCHERS);
}

if (require.main === module) {
  console.log(writeLaunchers(path.join(__dirname, '..')).join('、'));
}

module.exports = { writeLaunchers, LAUNCHERS };
