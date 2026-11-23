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
//
// 表格往返（策划改卡）：
//   node build.js export [--xlsx 文件]           导出卡牌表（默认 dist/卡牌表.xlsx）
//   node build.js import <文件.xlsx>             预览：列出会改什么、冲突和错误，不写任何文件
//   node build.js import <文件.xlsx> --apply     写回 json，生成 Lua 占位和 agent 任务单
//   node build.js import <文件.xlsx> --confirm   预览后在命令行里问一句再写（双击导入用的就是这个）
//   --force                                     冲突时用表里的值；允许删除仍被引用的项
//   --profile <目录>                            项目描述，默认 profiles/tcginfu

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadContent } = require('./src/load');
const { buildModel } = require('./src/model');
const { findEngineHooks } = require('./src/engine');
const { renderHtml, renderMarkdown, renderReportMd, renderCsv } = require('./src/render');
const { loadProfile, resolveEnums } = require('./src/profile');
const { ContentStore } = require('./src/store');
const { exportWorkbook, planImport } = require('./src/sheet');
const { applyPlan, planMarkdown, tasksMarkdown } = require('./src/apply');
const { writeXlsx, readXlsx } = require('./src/xlsx');

function parseArgs(argv) {
  const a = { open: false, watch: false, check: false, serve: false, port: 5178, apply: false, force: false, cmd: null };
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
    else if (k === '--apply') a.apply = true;
    else if (k === '--force') a.force = true;
    else if (k === '--confirm') a.confirm = true;
    else if (k === '--ask') a.ask = true;
    else if (k === '--xlsx') a.xlsx = argv[++i];
    else if (k === '--profile') a.profile = argv[++i];
    else if (k === '-h' || k === '--help') a.help = true;
    else if (!k.startsWith('-') && !a.cmd && ['export', 'import', 'build', 'check'].includes(k)) a.cmd = k;
    else if (!k.startsWith('-') && a.cmd === 'import' && !a.xlsx) a.xlsx = k;
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
      for (const k of ['contentDir', 'engineDir', 'outDir', 'profile', 'xlsx']) if (c[k]) cfg[k] = path.resolve(__dirname, c[k]);
      // 旧版本记的是绝对路径：同盘的话顺手改成相对路径，以后整体挪位置也不用改配置
      if (name === 'cardbrowser.local.json' && c.contentDir && path.isAbsolute(c.contentDir)) {
        const rel = relToTool(path.resolve(c.contentDir));
        if (rel) {
          c.contentDir = rel;
          fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n', 'utf8');
        }
      }
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
  const profileDir = path.resolve(args.profile || cfg.profile || path.join(__dirname, 'profiles', 'tcginfu'));
  const xlsxPath = path.resolve(args.xlsx || cfg.xlsx || path.join(outDir, '卡牌表.xlsx'));
  return { contentDir, engineDir, outDir, profileDir, xlsxPath, explicitContent: !!args.content };
}

function build(paths) {
  const profile = loadProfile(paths.profileDir);
  require('./src/labels').applyProfile(profile);
  const content = loadContent(paths.contentDir, { lua: profile.lua });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  let paths = resolvePaths(args);
  if (!hasPack(paths.contentDir) && !paths.explicitContent) {
    const found = await locateContent(args.ask);
    if (!found) { process.exitCode = 1; return; }
    paths = resolvePaths(args);
  }
  if (args.cmd === 'check') args.check = true;
  if (args.cmd === 'export') return cmdExport(paths, args);
  if (args.cmd === 'import') return cmdImport(paths, args);

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

const PACK_REL = path.join('Assets', 'StreamingAssets', 'Content');

function hasPack(dir) {
  return fs.existsSync(path.join(dir, 'pack.json'));
}

/** 用户给的路径可以是内容包目录，也可以是 Unity 工程根目录 */
function normalizeContentDir(p) {
  const d = path.resolve(p.trim().replace(/^["']|["']$/g, ''));
  if (hasPack(d)) return d;
  if (hasPack(path.join(d, PACK_REL))) return path.join(d, PACK_REL);
  return null;
}

/** 相对工具目录的写法（统一用 /），跨盘符时没法相对，返回 null */
function relToTool(abs) {
  const rel = path.relative(__dirname, abs);
  if (!rel) return '.';
  if (path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const PLACEMENT_HINT = [
  '工具要放在游戏工程附近，任选一种摆法：',
  '  · 和工程并排：   <某个文件夹>\\TCGinFU\\  和  <某个文件夹>\\TCGinFU卡牌工具\\',
  '  · 放进工程里：   TCGinFU\\Tools\\TCGinFU卡牌工具\\',
  '  · 隔一层并排：   <某个文件夹>\\TCGinFU\\  和  <某个文件夹>\\工具\\TCGinFU卡牌工具\\',
].join('\n');

/**
 * 在工具「附近」找 Unity 工程的内容包，由近到远：
 *   1. 工具在工程里面（往上 4 层以内的某个祖先就是工程）
 *   2. 工具和工程并排（上一层文件夹里的兄弟）
 *   3. 隔一层并排（上两层文件夹里的兄弟）
 * 同一距离找到多个工程时返回全部，交给调用方决定。
 */
function nearbyContentDirs() {
  let dir = __dirname;
  for (let up = 0; up < 4; up++) {
    dir = path.dirname(dir);
    if (hasPack(path.join(dir, PACK_REL))) return [path.join(dir, PACK_REL)];
    if (path.dirname(dir) === dir) break;
  }
  const parent = path.dirname(__dirname);
  for (const base of [parent, path.dirname(parent)]) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    const found = entries
      .filter((e) => e.isDirectory() && path.join(base, e.name) !== __dirname)
      .map((e) => normalizeContentDir(path.join(base, e.name)))
      .filter(Boolean);
    if (found.length) return found;
    if (path.dirname(base) === base) break;
  }
  return [];
}

function saveLocalConfig(patch) {
  const p = path.join(__dirname, 'cardbrowser.local.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 第一次 */ }
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch }, null, 2) + '\n', 'utf8');
  return p;
}

/** 记住内容包位置：只存相对工具目录的路径，整个摆法一起挪、换电脑都不用改 */
function rememberContent(dir) {
  const rel = relToTool(dir);
  if (!rel) {
    console.error(`${dir} 和工具不在同一个盘上，没法用相对路径记住它。`);
    console.error(PLACEMENT_HINT);
    return null;
  }
  saveLocalConfig({ contentDir: rel });
  console.log(`使用内容包：${rel}（已记住，下次不用再找）`);
  return dir;
}

async function locateContent(interactive) {
  const near = nearbyContentDirs();
  const canAsk = interactive && process.stdin.isTTY;
  if (near.length === 1) return rememberContent(near[0]);
  if (near.length > 1) {
    if (!canAsk) {
      console.error(`附近有多个游戏工程：\n${near.map((d) => '  ' + relToTool(d)).join('\n')}\n在 cardbrowser.local.json 里写 "contentDir"（相对工具目录）指定用哪个。`);
      return null;
    }
    console.log('附近有多个游戏工程：');
    near.forEach((d, i) => console.log(`  ${i + 1}. ${relToTool(d)}`));
    const a = await ask('用哪个？输入编号回车：');
    const pick = near[Number(a) - 1];
    return pick ? rememberContent(pick) : null;
  }
  console.error('在工具附近没找到游戏工程（Assets\\StreamingAssets\\Content\\pack.json）。');
  if (!canAsk) {
    console.error(PLACEMENT_HINT);
    return null;
  }
  console.error(PLACEMENT_HINT);
  for (;;) {
    const a = await ask('或者把 TCGinFU 工程文件夹拖进这个窗口回车（直接回车退出）：');
    if (!a) return null;
    const dir = normalizeContentDir(a);
    if (!dir) { console.log('这个文件夹里没找到 pack.json，再试一次。'); continue; }
    const ok = rememberContent(dir);
    if (ok) return ok;
  }
}

function loadStore(paths) {
  const profile = loadProfile(paths.profileDir);
  const store = new ContentStore(paths.contentDir, profile).load();
  for (const p of store.problems.filter((x) => x.severity === 'error')) console.error(`内容包问题：${p.message}`);
  return { profile, store };
}

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function cmdExport(paths, args) {
  const { profile, store } = loadStore(paths);
  const sheets = exportWorkbook(store, profile);
  const file = paths.xlsxPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, writeXlsx(sheets));
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      console.error(`写不进 ${file}：文件可能正在 Excel 里打开着。关掉它再导出，或者用 --xlsx 换个文件名。`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  const counts = sheets.filter((s) => !s.hidden && s.name !== '枚举' && s.name !== '说明').map((s) => `${s.name} ${s.rows.length} 行`).join('，');
  console.log(`已导出 ${file}`);
  console.log(`  ${counts}`);
  if (args.open) openFile(file);
}

function ask(question) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function cmdImport(paths, args) {
  const src = paths.xlsxPath;
  // 报告和任务单里写相对工具目录的路径：任务单要交给别人，绝对路径对别人没意义
  const shown = relToTool(src) || path.basename(src);
  if (!fs.existsSync(src)) { console.error(`找不到表格 ${src}。先导出一份，或者指定文件：node build.js import <文件.xlsx>`); process.exitCode = 2; return; }
  let sheets;
  try {
    sheets = readXlsx(fs.readFileSync(src));
  } catch (e) {
    console.error(`读不了 ${src}：${e.code === 'EBUSY' ? '文件被占用（先在 Excel 里保存并关闭）' : e.message}`);
    process.exitCode = 1;
    return;
  }
  const { profile, store } = loadStore(paths);
  const plan = planImport(store, profile, sheets, { force: args.force });
  const blocked = plan.errors.length > 0 || (plan.conflicts.length > 0 && !args.force);
  const result = blocked ? null : applyPlan(store, profile, plan);
  const dir = path.join(paths.outDir, 'import');
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp();
  const enums = resolveEnums(profile, store.collections);
  const writeReport = (applied) => {
    const file = path.join(dir, `${ts}-${applied ? '导入记录' : '预览'}.md`);
    fs.writeFileSync(file, planMarkdown(plan, result, { applied, source: shown, enums }), 'utf8');
    return file;
  };

  const n = (t) => plan.changes.filter((c) => c.type === t).length;
  console.log(`新增 ${n('add')} · 修改 ${n('update')} · 删除 ${n('delete')} · 冲突 ${plan.conflicts.length} · 错误 ${plan.errors.length} · 提示 ${plan.warnings.length}`);
  for (const e of plan.errors) console.log(`  错误 ${e.sheet ? '「' + e.sheet + '」' : ''}${e.row ? '第 ' + e.row + ' 行' : ''}：${e.message}`);
  for (const c of plan.conflicts) console.log(`  冲突 ${c.collection}「${c.id}」${c.header}`);
  if (result) for (const a of result.actions) console.log(`  ${a}`);

  if (blocked) {
    console.log(`详情：${writeReport(false)}`);
    console.log(plan.errors.length ? '有错误，没有写入任何文件。改好表格再导入。' : '有冲突，没有写入任何文件。确认用表里的值请加 --force。');
    process.exitCode = 1;
    return;
  }
  let doApply = args.apply;
  if (!doApply && args.confirm && plan.changes.length) {
    const preview = writeReport(false);
    console.log(`详情：${preview}`);
    if (args.open) openFile(preview);
    const a = await ask('确认写入以上改动？输入 y 回车写入，直接回车取消：');
    doApply = /^(y|yes|是|确认)$/i.test(a);
    if (!doApply) { console.log('已取消，没有写入任何文件。'); return; }
  }
  if (!doApply) {
    console.log(`详情：${writeReport(false)}`);
    if (plan.changes.length) console.log('这是预览，没有写入。确认无误后加 --apply 写入。');
    return;
  }
  console.log(`记录：${writeReport(true)}`);
  const writes = store.commit();
  console.log(`已写入 ${writes.length} 个文件：${writes.map((w) => w.rel).join('、') || '无'}`);
  const tasksMd = tasksMarkdown(profile, result, store, { source: shown });
  const tasksFile = path.join(dir, `${ts}-agent任务单.md`);
  fs.writeFileSync(tasksFile, tasksMd, 'utf8');
  fs.writeFileSync(path.join(paths.outDir, 'agent-tasks.md'), tasksMd, 'utf8');
  console.log(`agent 任务单：${tasksFile}`);
  try { write(build(paths), paths.outDir); console.log('卡牌浏览器已重新生成。'); } catch (e) { console.error(e.message); }
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

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
