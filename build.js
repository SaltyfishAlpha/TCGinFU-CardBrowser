#!/usr/bin/env node
'use strict';
// 用法：
//   node build.js                 生成 dist/ 下的网页、Markdown、CSV 和检查报告
//   node build.js --open          生成后用默认浏览器打开
//   node build.js --watch         内容包有改动就重新生成（浏览器里按 F5 刷新）
//   node build.js --serve --open  开本机网页 http://localhost:5178/，改动后页面自动刷新
//   --port <端口>                 --serve 用的端口，默认 5178
//   node build.js --check         只跑检查，有「错误」级问题时退出码为 1（给 CI 或提交前用）
//   --content <目录>              内容包目录（含 pack.json），默认读 cardbrowser.config.json
//   --engine <目录>               Unity 工程根目录，用来核对 Lua 钩子名；默认由内容包目录往上推
//   --out <目录>                  输出目录

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadContent } = require('./src/load');
const { buildModel } = require('./src/model');
const { findEngineHooks } = require('./src/engine');
const { renderHtml, renderMarkdown, renderReportMd, renderCsv } = require('./src/render');

function parseArgs(argv) {
  const a = { open: false, watch: false, check: false, serve: false, port: 5178 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--open') a.open = true;
    else if (k === '--serve') a.serve = true;
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--watch') a.watch = true;
    else if (k === '--check') a.check = true;
    else if (k === '--content') a.content = argv[++i];
    else if (k === '--engine') a.engine = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '-h' || k === '--help') a.help = true;
    else if (!k.startsWith('-') && !a.content) a.content = k;
    else { console.error(`不认识的参数：${k}`); process.exit(2); }
  }
  return a;
}

function readConfig() {
  const cfg = {};
  for (const name of ['cardbrowser.config.json', 'cardbrowser.local.json']) {
    const p = path.join(__dirname, name);
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const k of ['contentDir', 'engineDir', 'outDir']) if (c[k]) cfg[k] = path.resolve(__dirname, c[k]);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`读 ${name} 出错：${e.message}`);
    }
  }
  return cfg;
}

function resolvePaths(args) {
  const cfg = readConfig();
  const contentDir = path.resolve(args.content || cfg.contentDir || '.');
  let engineDir = args.engine ? path.resolve(args.engine) : cfg.engineDir;
  if (!engineDir) {
    // Assets/StreamingAssets/Content → 工程根
    const guess = path.resolve(contentDir, '..', '..', '..');
    if (fs.existsSync(path.join(guess, 'Assets'))) engineDir = guess;
  }
  const outDir = path.resolve(args.out || cfg.outDir || path.join(__dirname, 'dist'));
  return { contentDir, engineDir, outDir };
}

function build(paths, { quiet } = {}) {
  const content = loadContent(paths.contentDir);
  const engineHooks = findEngineHooks(paths.engineDir);
  const model = buildModel(content, { engineHooks });
  return model;
}

function write(model, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    'index.html': renderHtml(model),
    'cards.md': renderMarkdown(model),
    'report.md': renderReportMd(model),
    'cards.csv': renderCsv(model),
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), text, 'utf8');
  return path.join(outDir, 'index.html');
}

function summary(model) {
  const n = (s) => model.issues.filter((x) => x.severity === s).length;
  return `${model.cards.length} 张卡 · ${model.behaviours.length} 个 Lua 行为 · 错误 ${n('error')} · 警告 ${n('warn')} · 提示 ${n('info')}`;
}

function openFile(file) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const paths = resolvePaths(args);

  if (args.check) {
    const model = build(paths);
    for (const x of model.issues.filter((i) => i.severity !== 'info')) {
      console.log(`${x.severity === 'error' ? '错误' : '警告'} [${x.code}] ${x.message}`);
    }
    console.log(summary(model));
    process.exitCode = model.issues.some((x) => x.severity === 'error') ? 1 : 0;
    return;
  }

  const run = () => {
    const model = build(paths);
    const file = write(model, paths.outDir);
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 已生成 ${file}`);
    console.log(`  ${summary(model)}`);
    return file;
  };

  let file;
  try {
    file = run();
  } catch (e) {
    console.error(e.message);
    if (!args.watch) { process.exitCode = 1; return; }
  }
  let notify = () => {};
  if (args.serve) {
    const server = serve(paths.outDir, args.port);
    notify = server.notify;
    const url = `http://localhost:${args.port}/`;
    console.log(`网页地址：${url}（内容包改动后页面会自动刷新）`);
    if (args.open) openFile(url);
  } else if (args.open && file) openFile(file);

  if (args.watch || args.serve) {
    console.log(`正在监视 ${paths.contentDir}，改动后自动重新生成。Ctrl+C 退出。`);
    let timer = null;
    fs.watch(paths.contentDir, { recursive: true }, (_, name) => {
      if (name && name.endsWith('.meta')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { run(); notify(); } catch (e) { console.error(e.message); }
      }, 300);
    });
  }
}

/** 本机静态服务 + 一个 SSE 通道，重新生成后通知页面刷新。只监听 127.0.0.1。 */
function serve(dir, port) {
  const http = require('http');
  const clients = new Set();
  const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : path.basename(decodeURIComponent(url.pathname));
    const file = path.join(dir, name);
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  server.listen(port, '127.0.0.1');
  return { notify: () => { for (const c of clients) c.write('data: reload\n\n'); } };
}

main();
