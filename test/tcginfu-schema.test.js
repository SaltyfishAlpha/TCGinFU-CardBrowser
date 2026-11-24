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

test('新升变牌 + 它的新形态牌一次导入：形态卡组写在升变牌上，形态牌进 forms.json，都不带 formId', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => {
    b.add('卡牌', { id: 'parry_form', 卡名: '形态格挡', ...BASE, 标记: '形态牌', 打法: '时机' });
    b.add('卡牌', { id: 'storm_stance', 卡名: '风暴架势', ...BASE, 标记: '升变牌' });
    b.add('形态卡组', { 升变牌id: 'storm_stance', 序号: 1, 形态牌: 'parry_form', 张数: 6 });
    b.add('形态卡组', { 升变牌id: 'storm_stance', 序号: 2, 形态牌: 'form_hit', 张数: 4 });
  });
  const { plan } = run(dir, sheets, true);
  assert.deepStrictEqual(plan.errors, []);
  const forms = JSON.parse(fs.readFileSync(path.join(dir, 'cards/forms.json'), 'utf8')).cards;
  const c = forms.find((x) => x.id === 'parry_form');
  assert.strictEqual(c.role, 'Form');
  assert.strictEqual(c.play, 'Timing');
  assert.ok(!('formId' in c) && !('kind' in c) && !('formDeck' in c), '形态牌上不该有 formId / kind / formDeck');
  assert.deepStrictEqual(Object.keys(c).slice(0, 6), ['id', 'name', 'owner', 'category', 'role', 'play']);
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'cards/hero.json'), 'utf8')).cards;
  const t = all.find((x) => x.id === 'storm_stance');
  assert.deepStrictEqual(t.formDeck, [{ card: 'parry_form', count: 6 }, { card: 'form_hit', count: 4 }]);
  assert.ok(!('play' in t));
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  assert.ok(pack.cards.includes('cards/forms.json') && pack.scripts.includes('scripts/forms.lua'));
  assert.match(fs.readFileSync(path.join(dir, 'scripts/forms.lua'), 'utf8'), /-- behaviour\("parry_form"/);
});

test('内容包规则：打法、形态卡组、职业的两个方向都拦', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => {
    b.add('卡牌', { id: 'bad_transform', 卡名: '坏升变', ...BASE, 标记: '升变牌', 打法: '技能' });
    b.add('卡牌', { id: 'no_play', 卡名: '没打法', ...BASE });
    b.add('卡牌', { id: 'transform_no_deck', 卡名: '缺形态卡组', ...BASE, 标记: '升变牌' });
    b.add('卡牌', { id: 'class_no_class', 卡名: '缺职业', ...BASE, 职业: null, 打法: '技能' });
    b.add('卡牌', { id: 'weapon_with_class', 卡名: '带职业的武器', ...BASE, 类别: '武器', 打法: '技能' });
    b.add('卡牌', { id: 'normal_with_deck', 卡名: '普通牌带形态卡组', ...BASE, 打法: '技能' });
    b.add('形态卡组', { 升变牌id: 'normal_with_deck', 形态牌: 'form_hit', 张数: 10 });
    b.add('卡牌', { id: 'three_colors', 卡名: '三色', ...BASE, 打法: '技能', 颜色: '力量+敏捷+洞察' });
    b.add('卡牌', { id: 'good_weapon', 卡名: '好武器', ...BASE, 类别: '武器', 职业: null, 打法: '技能' });
  });
  const { plan } = run(dir, sheets);
  const msg = (id) => plan.errors.filter((e) => e.message.includes(id)).map((e) => e.message).join(' ');
  assert.match(msg('bad_transform'), /升变牌不按打法结算/);
  assert.match(msg('no_play'), /都要填「打法」/);
  assert.match(msg('transform_no_deck'), /形态卡组/);
  assert.match(msg('class_no_class'), /职业牌必须填「职业」/);
  assert.match(msg('weapon_with_class'), /不带职业/);
  assert.match(msg('normal_with_deck'), /只有升变牌才有形态卡组/);
  assert.match(plan.errors.map((e) => e.message).join(' '), /「颜色」最多 2 项/);
  assert.strictEqual(msg('good_weapon'), '');
});

test('形态卡组校验：合计 10 张、只能放形态牌、职业要和升变牌一致、引用要存在', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => {
    b.add('卡牌', { id: 'other_class_form', 卡名: '别的职业的形态牌', ...BASE, 职业: '法师', 标记: '形态牌', 打法: '技能' });
    for (const [tid, rows] of Object.entries({
      t_short: [['form_hit', 9]],
      t_not_form: [['form_hit', 9], ['strike', 1]],
      t_other_class: [['form_hit', 9], ['other_class_form', 1]],
      t_missing: [['form_hit', 9], ['ghost_card', 1]],
    })) {
      b.add('卡牌', { id: tid, 卡名: tid, ...BASE, 标记: '升变牌' });
      rows.forEach(([card, n], i) => b.add('形态卡组', { 升变牌id: tid, 序号: i + 1, 形态牌: card, 张数: n }));
    }
  });
  const { plan } = run(dir, sheets);
  const msg = (id) => plan.errors.filter((e) => e.message.includes(`「${id}」`)).map((e) => e.message).join(' ');
  assert.match(msg('t_short'), /合计必须是 10 张（现在是 9 张）/);
  assert.match(msg('t_not_form'), /「strike」不符合要求/);
  assert.match(msg('t_other_class'), /职业要和它所在升变牌一致/);
  assert.match(msg('t_missing'), /「ghost_card」不存在/);
});

test('删除保护：被升变牌的形态卡组引用的形态牌不能删', () => {
  const dir = fresh();
  const sheets = sheetsAfter(dir, (b) => b.set('卡牌', 'form_hit', '删除', '删除'));
  const { plan } = run(dir, sheets);
  assert.ok(plan.errors.some((e) => e.message.includes('form_hit') && e.message.includes('剑之架势')));
});

test('「远程」缺省时读 unmapped.ranged：导出显示得出来，没改不写，改了写到顶层 ranged', () => {
  const dir = fresh();
  const sheets0 = sheetsAfter(dir);
  const s = sheets0.find((x) => x.name === '卡牌');
  assert.strictEqual(s.rows.find((r) => r[0] === 'strike')[s.rows[0].indexOf('远程')], '是');
  assert.strictEqual(run(dir, sheets0).plan.changes.length, 0);

  const sheets1 = sheetsAfter(dir, (b) => b.set('卡牌', 'strike', '远程', '否'));
  const { plan } = run(dir, sheets1, true);
  assert.deepStrictEqual(plan.errors, []);
  const strike = JSON.parse(fs.readFileSync(path.join(dir, 'cards/a.json'), 'utf8')).cards.find((c) => c.id === 'strike');
  assert.strictEqual(strike.ranged, false);
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
