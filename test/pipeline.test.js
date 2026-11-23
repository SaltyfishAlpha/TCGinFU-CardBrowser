'use strict';
// 表格往返的端到端测试。用 test/generic 里一套和 TCGinFU 无关的数据结构，
// 证明导出 / 导入 / Lua 占位 / 任务单只依赖 profile，不依赖具体项目。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProfile } = require('../src/profile');
const { ContentStore } = require('../src/store');
const { exportWorkbook, planImport } = require('../src/sheet');
const { applyPlan, tasksMarkdown, planMarkdown } = require('../src/apply');
const { writeXlsx, readXlsx } = require('../src/xlsx');

const GENERIC = path.join(__dirname, 'generic');
const profile = loadProfile(path.join(GENERIC, 'profile'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function freshContent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbrowser-'));
  copyDir(path.join(GENERIC, 'content'), dir);
  return dir;
}

const open = (dir) => new ContentStore(dir, profile).load();

/** 导出 → 走一遍真正的 xlsx 编码 / 解码 → 交给 edit 改 → 再编码 / 解码，模拟「在 Excel 里改完保存」 */
function roundTrip(dir, edit) {
  const sheets = exportWorkbook(open(dir), profile);
  const decoded = readXlsx(writeXlsx(sheets));
  if (edit) edit(new Book(decoded));
  // 改完的表再编码一次（列定义用表头重建）
  const again = decoded.map((s) => ({
    name: s.name, hidden: s.hidden,
    columns: (s.rows[0] || []).map((h) => ({ header: h })),
    rows: s.rows.slice(1),
  }));
  return readXlsx(writeXlsx(again));
}

class Book {
  constructor(sheets) { this.sheets = sheets; }
  sheet(name) { return this.sheets.find((s) => s.name === name); }
  col(name, header) { return this.sheet(name).rows[0].indexOf(header); }
  row(name, id) { return this.sheet(name).rows.find((r) => r[0] === id); }
  set(name, id, header, value) { this.row(name, id)[this.col(name, header)] = value; }
  add(name, obj) {
    const s = this.sheet(name);
    const r = [];
    for (const [h, v] of Object.entries(obj)) r[s.rows[0].indexOf(h)] = v;
    s.rows.push(r);
  }
}

function run(dir, sheets, opts = {}) {
  const store = open(dir);
  const plan = planImport(store, profile, sheets, opts);
  const result = plan.errors.length || (plan.conflicts.length && !opts.force) ? null : applyPlan(store, profile, plan);
  if (result && opts.apply) store.commit();
  return { store, plan, result };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('原样导出再导入：零改动，一个文件都不写', () => {
  const dir = freshContent();
  const { plan, result } = run(dir, roundTrip(dir));
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.changes.length, 0);
  assert.strictEqual(result.writes.length, 0);
});

test('改字段、加新项、改子表：json 只动改过的地方，未列出的字段原样保留', () => {
  const dir = freshContent();
  const before = read(dir, 'monsters/fire.json');
  const sheets = roundTrip(dir, (b) => {
    b.set('怪物', 'imp', '生命', 15);
    // 子表：改威力。power.scale 不在列里，应该保留下来
    b.sheet('技能').rows.find((r) => r[0] === 'imp')[b.col('技能', '威力')] = 4;
    b.add('怪物', { 编号: 'nixie', 名字: '水妖', 属性: '水', 描述: '回合开始时治疗队友2点。' });
    b.add('技能', { 怪物id: 'nixie', 序号: 1, 类型: '增益', 威力: 2 });
  });
  const { plan, result } = run(dir, sheets, { apply: true });
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.conflicts, []);

  const fire = JSON.parse(read(dir, 'monsters/fire.json'));
  const imp = fire.find((m) => m.key === 'imp');
  assert.strictEqual(imp.hp, 15);
  assert.deepStrictEqual(imp.skills, [{ type: 'hit', power: { base: 4, scale: 1.5 } }]);
  assert.deepStrictEqual(imp.loot, ['ember'], '表里没有的字段不能丢');
  assert.ok(!('hp' in fire.find((m) => m.key === 'salamander')), '没写 hp 的项不能被补上默认值');
  // 只有两行变了
  const diff = before.split('\n').filter((l, i) => l !== read(dir, 'monsters/fire.json').split('\n')[i]);
  assert.strictEqual(diff.length, 2);

  // 新项：按规则放进 monsters/water.json（新建），默认值、行为名都补上
  const water = JSON.parse(read(dir, 'monsters/water.json'));
  assert.deepStrictEqual(water, [{ key: 'nixie', title: '水妖', element: 'water', hp: 10, desc: '回合开始时治疗队友2点。', script: 'nixie', skills: [{ type: 'buff', power: { base: 2 } }] }]);

  // Lua 占位：新文件 ai/water.lua，带文件头
  const lua = read(dir, 'ai/water.lua');
  assert.match(lua, /^-- ai\/water\.lua/);
  assert.match(lua, /-- 「回合开始时治疗队友2点。」/);
  assert.match(lua, /-- register\("nixie", \{/);
  assert.ok(result.tasks.implement.some((t) => t.obj.key === 'nixie'));
});

test('卡面改了：已实现的进任务单；还是占位的直接更新占位里的原文', () => {
  const dir = freshContent();
  const sheets = roundTrip(dir, (b) => {
    b.set('怪物', 'imp', '描述', '每回合对随机目标造成4点火焰伤害。');
    b.set('怪物', 'salamander', '描述', '被攻击时反击2点。');
  });
  const { result } = run(dir, sheets, { apply: true });
  assert.strictEqual(result.tasks.textChanged.length, 1);
  assert.strictEqual(result.tasks.textChanged[0].after.key, 'imp');
  const lua = read(dir, 'ai/fire.lua');
  assert.match(lua, /「被攻击时反击2点。」/);
  assert.ok(!lua.includes('「被攻击时反击。」'));
  assert.match(lua, /「每回合对随机目标造成3点火焰伤害。」/, '已实现的 Lua 不能被工具改');
  assert.ok(lua.includes('\r\n') && !/[^\r]\n/.test(lua), 'Lua 文件保持 CRLF');
  const md = tasksMarkdown(profile, result, open(dir), { source: 'test' });
  assert.match(md, /卡面改了/);
});

test('删除：被引用的拒绝；没被引用的删掉，它的 Lua 占位一起移除', () => {
  const dir = freshContent();
  const sheets = roundTrip(dir, (b) => {
    b.set('怪物', 'imp', '删除', '删除');
    b.set('怪物', 'salamander', '删除', '删除');
  });
  const blocked = run(dir, sheets);
  assert.ok(blocked.plan.errors.some((e) => e.message.includes('imp') && e.message.includes('火山')));

  const sheets2 = roundTrip(dir, (b) => b.set('怪物', 'salamander', '删除', '删除'));
  const { plan } = run(dir, sheets2, { apply: true });
  assert.deepStrictEqual(plan.errors, []);
  const fire = JSON.parse(read(dir, 'monsters/fire.json'));
  assert.deepStrictEqual(fire.map((m) => m.key), ['imp']);
  const lua = read(dir, 'ai/fire.lua');
  assert.ok(!lua.includes('salamander'));
  assert.ok(lua.includes('register("imp"'));
});

test('冲突：导出后 json 和表改了同一格 → 不覆盖；只有 json 改了的格子保留 json 的值', () => {
  const dir = freshContent();
  const sheets = roundTrip(dir, (b) => {
    b.set('怪物', 'imp', '生命', 20);
  });
  // 模拟导出之后 agent 改了 json
  const f = path.join(dir, 'monsters/fire.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data[0].hp = 30;
  data[0].title = '大恶魔';
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');

  const { plan } = run(dir, sheets);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0].header, '生命');
  assert.ok(!plan.changes.some((c) => c.fields.some((x) => x.header === '名字')), '表里没动的名字不能被改回去');

  const forced = run(dir, sheets, { force: true, apply: true });
  assert.strictEqual(forced.plan.conflicts.length, 0);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'))[0];
  assert.strictEqual(after.hp, 20);
  assert.strictEqual(after.title, '大恶魔');
});

test('校验：枚举写错、id 不合规、缺必填 → 报错，不写入', () => {
  const dir = freshContent();
  const sheets = roundTrip(dir, (b) => {
    b.set('怪物', 'imp', '属性', '雷');
    b.add('怪物', { 编号: 'Bad-Id', 名字: 'x', 属性: '火', 描述: 'x' });
    b.add('怪物', { 编号: 'no_desc', 名字: 'y', 属性: '火' });
    b.add('技能', { 怪物id: 'ghost', 类型: '攻击' });
  });
  const { plan, result } = run(dir, sheets);
  const msgs = plan.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /「雷」不在「属性」的可选值里/);
  assert.match(msgs, /Bad-Id/);
  assert.match(msgs, /no_desc.*描述/);
  assert.match(msgs, /ghost/);
  assert.strictEqual(result, null);
  const md = planMarkdown(plan, null, { applied: false, source: 't', enums: {} });
  assert.match(md, /错误/);
});

test('中英文都认：英文原值、多余空格', () => {
  const dir = freshContent();
  const sheets = roundTrip(dir, (b) => b.set('怪物', 'imp', '属性', ' Water '));
  const { plan } = run(dir, sheets);
  assert.deepStrictEqual(plan.errors, []);
  const ch = plan.changes.find((c) => c.id === 'imp');
  assert.strictEqual(ch.obj.element, 'water');
});
