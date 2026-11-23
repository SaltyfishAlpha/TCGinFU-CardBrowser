'use strict';
// 用真实的 TCGinFU profile 跑 2026-11-23 的卡牌分类修订（§7.1：kind 拆成 play + role）：
// 打法 / 标记两列、内容包规则、形态牌的文件归属、整数列表、没碰过的格子不出错。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadProfile } = require('../src/profile');
const { ContentStore } = require('../src/store');
const { exportWorkbook, planImport } = require('../src/sheet');
const { applyPlan } = require('../src/apply');
const { writeXlsx, readXlsx } = require('../src/xlsx');

const profile = loadProfile(path.join(__dirname, '..', 'profiles', 'tcginfu'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbrowser-tcg-'));
  copyDir(path.join(__dirname, 'fixture'), dir);
  return dir;
}

const open = (dir) => new ContentStore(dir, profile).load();

function sheetsAfter(dir, edit) {
  const decoded = readXlsx(writeXlsx(exportWorkbook(open(dir), profile)));
  const sheet = (n) => decoded.find((s) => s.name === n);
  const api = {
    set(name, id, header, v) {
      const s = sheet(name);
      const ci = s.rows[0].indexOf(header);
      assert.ok(ci >= 0, `表「${name}」里没有列「${header}」`);
      s.rows.find((r) => r[0] === id)[ci] = v;
    },
    add(name, obj) {
      const s = sheet(name);
      const r = [];
      for (const [h, v] of Object.entries(obj)) {
        const ci = s.rows[0].indexOf(h);
        assert.ok(ci >= 0, `表「${name}」里没有列「${h}」`);
        r[ci] = v;
      }
      s.rows.push(r);
    },
    sheet,
  };
  if (edit) edit(api);
  const again = decoded.map((s) => ({ name: s.name, hidden: s.hidden, columns: (s.rows[0] || []).map((h) => ({ header: h })), rows: s.rows.slice(1) }));
  return readXlsx(writeXlsx(again));
}

function run(dir, sheets, apply) {
  const store = open(dir);
  const plan = planImport(store, profile, sheets);
  const result = plan.errors.length || plan.conflicts.length ? null : applyPlan(store, profile, plan);
  if (result && apply) store.commit();
  return { plan, result };
}

const BASE = { 角色: '勇者', 职业: '剑士', 类别: '职业牌', 卡面文字: '一些效果。' };

test('表头是「标记」「打法」，没有旧的「种类」；原样往返零改动', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir);
  const head = sheets.find((s) => s.name === '卡牌').rows[0];
  assert.ok(head.includes('标记') && head.includes('打法'));
  assert.ok(!head.includes('种类'));
  const { plan, result } = run(dir, sheets);
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.changes.length, 0);
  assert.strictEqual(result.writes.length, 0);
});

test('新形态牌：写 role + play + formId，放进 cards/forms.json，占位进 scripts/forms.lua', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => b.add('卡牌', { id: 'parry_form', 卡名: '形态格挡', ...BASE, 标记: '形态牌', 打法: '时机', 所属形态: 'blade' }));
  const { plan } = run(dir, sheets, true);
  assert.deepStrictEqual(plan.errors, []);
  const forms = JSON.parse(fs.readFileSync(path.join(dir, 'cards/forms.json'), 'utf8')).cards;
  const c = forms.find((x) => x.id === 'parry_form');
  assert.strictEqual(c.role, 'Form');
  assert.strictEqual(c.play, 'Timing');
  assert.strictEqual(c.formId, 'blade');
  assert.ok(!('kind' in c));
  assert.deepStrictEqual(Object.keys(c).slice(0, 6), ['id', 'name', 'owner', 'category', 'role', 'play']);
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  assert.ok(pack.cards.includes('cards/forms.json') && pack.scripts.includes('scripts/forms.lua'));
  assert.match(fs.readFileSync(path.join(dir, 'scripts/forms.lua'), 'utf8'), /-- behaviour\("parry_form"/);
});

test('内容包规则：升变牌不能有打法、普通牌必须有打法、formId 只给形态牌', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => {
    b.add('卡牌', { id: 'bad_transform', 卡名: '坏升变', ...BASE, 标记: '升变牌', 打法: '技能' });
    b.add('卡牌', { id: 'no_play', 卡名: '没打法', ...BASE });
    b.add('卡牌', { id: 'stray_form_id', 卡名: '乱填形态', ...BASE, 打法: '技能', 所属形态: 'blade' });
    b.add('卡牌', { id: 'form_no_id', 卡名: '缺形态', ...BASE, 标记: '形态牌', 打法: '技能' });
    b.add('卡牌', { id: 'good_transform', 卡名: '好升变', ...BASE, 标记: '升变牌' });
  });
  const { plan } = run(dir, sheets);
  const msg = (id) => plan.errors.filter((e) => e.message.includes(id)).map((e) => e.message).join(' ');
  assert.match(msg('bad_transform'), /升变牌不按打法结算/);
  assert.match(msg('no_play'), /都要填「打法」/);
  assert.match(msg('stray_form_id'), /只有形态牌才能填/);
  assert.match(msg('form_no_id'), /要填「所属形态」/);
  assert.strictEqual(msg('good_transform'), '');
});

test('可选充能「0,1」→ [0,1]；改已有卡时保持文件里原来的键顺序', () => {
  const dir = fresh();
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'cards/a.json'), 'utf8')).cards.find((c) => c.id === 'strike');
  const sheets = sheetsAfter(dir, (b) => {
    b.set('卡牌', 'strike', '可选充能', '0,1');
    b.set('卡牌', 'strike', 'AP', 2);
  });
  const { plan } = run(dir, sheets, true);
  assert.deepStrictEqual(plan.errors, []);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'cards/a.json'), 'utf8')).cards.find((c) => c.id === 'strike');
  assert.deepStrictEqual(after.chargeOptions, [0, 1]);
  assert.strictEqual(after.ap, 2);
  assert.deepStrictEqual(Object.keys(after), [...Object.keys(before), 'chargeOptions'], '原有键不挪位置，新键排在后面');
});

test('分数字段 [3,2]：显示成 3/2，没碰过不出错，改成 2/1 写回 [2,1]；数字列里写「3,2」报错而不是读成 32', () => {
  const dir = fresh();
  const sheets0 = sheetsAfter(dir);
  const st = sheets0.find((s) => s.name === '状态');
  assert.strictEqual(st.rows.find((r) => r[0] === 'overheat')[st.rows[0].indexOf('受伤倍率(分子/分母)')], '3/2');

  const sheets1 = sheetsAfter(dir, (b) => b.set('状态', 'overheat', '受伤倍率(分子/分母)', '2/1'));
  const ok = run(dir, sheets1, true);
  assert.deepStrictEqual(ok.plan.errors, []);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'statuses.json'), 'utf8')).statuses.find((x) => x.id === 'overheat');
  assert.deepStrictEqual(s.incomingMultiplier, [2, 1]);

  const sheets2 = sheetsAfter(dir, (b) => b.set('状态', 'overheat', '受伤加成', '3,2'));
  const bad = run(dir, sheets2);
  assert.ok(bad.plan.errors.some((e) => e.message.includes('3,2') && e.message.includes('不是一个数字')));
});

test('旧版导出的表（还有「种类」列）：提示忽略该列，不写出 kind', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir);
  const s = sheets.find((x) => x.name === '卡牌');
  s.rows[0].push('种类');
  for (const r of s.rows.slice(1)) r[s.rows[0].length - 1] = '技能';
  const { plan, result } = run(dir, sheets);
  assert.ok(plan.warnings.some((w) => w.message.includes('种类')));
  assert.strictEqual(plan.changes.length, 0);
  assert.strictEqual(result.writes.length, 0);
});
