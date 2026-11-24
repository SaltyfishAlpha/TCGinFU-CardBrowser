'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { parseLuaFile } = require('../src/lua');
const { loadContent } = require('../src/load');
const { buildModel, quoteMatches } = require('../src/model');
const { renderHtml, renderCsv, renderMarkdown } = require('../src/render');

const FIXTURE = path.join(__dirname, 'fixture');

test('Lua：切块、钩子、注释原文都能取出，字符串和块注释里的括号不干扰配对', () => {
  const src = fs.readFileSync(path.join(FIXTURE, 'scripts', 'cards.lua'), 'utf8');
  const { blocks, errors } = parseLuaFile('scripts/cards.lua', src);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(blocks.map((b) => b.id), ['strike', 'drifted', 'form_hit', 'orphan']);
  const strike = blocks[0];
  assert.strictEqual(strike.title, '打击');
  assert.strictEqual(strike.quote, '造成6点物理伤害【暴击】。命中后令目标获得【破绽】。');
  assert.deepStrictEqual(strike.hooks.map((h) => h.name), ['on_resolved']);
  assert.deepStrictEqual(strike.statusRefs, [{ fn: 'apply_status', id: 'exposed' }]);
  // 嵌套表里的 key 不能被当成钩子
  assert.deepStrictEqual(blocks[1].hooks.map((h) => h.name), ['on_attack', 'on_attak_typo']);
  assert.strictEqual(blocks[3].quote, null);
});

test('引文比对：允许省略号、忽略括注', () => {
  assert.ok(quoteMatches('造成6点伤害…抽1张牌', '造成6点伤害，然后抽1张牌。'));
  assert.ok(quoteMatches('造成B_atk+4点物理伤害。', '造成B_atk+4点物理伤害（本5级构筑为12点）。'));
  assert.ok(!quoteMatches('造成5点物理伤害', '造成7点物理伤害'));
});

test('检查：能发现各类问题', () => {
  const model = buildModel(loadContent(FIXTURE), { engineHooks: null });
  const has = (code, pred = () => true) => model.issues.some((x) => x.code === code && pred(x));

  assert.ok(has('missing-file', (x) => x.entity.id === 'scripts/missing.lua'), 'pack.json 列了不存在的脚本');
  assert.ok(has('behaviour-missing', (x) => x.entity.id === 'empty' && x.severity === 'error'), '没数据也没 Lua 的卡');
  assert.ok(has('behaviour-missing', (x) => x.entity.id === 'ghost'), '状态指向不存在的行为');
  assert.ok(has('text-drift', (x) => x.entity.id === 'drifted'), 'Lua 注释和卡面不一致');
  assert.ok(!has('text-drift', (x) => x.entity.id === 'form_hit'), '只差括注不算不一致');
  assert.ok(has('number-mismatch', (x) => x.entity.id === 'drifted'), '数据 5 点 vs 卡面 7 点');
  assert.ok(!has('number-mismatch', (x) => x.entity.id === 'form_hit'), 'B_atk+4 能对上');
  assert.ok(has('unknown-hook', (x) => x.message.includes('on_attak_typo')));
  assert.ok(has('status-missing', (x) => x.message.includes('no_such_status')));
  assert.ok(has('behaviour-unused', (x) => x.entity.id === 'orphan'));
  assert.ok(has('deck-missing-card', (x) => x.message.includes('nope')));
  assert.ok(has('crit-flag', (x) => x.entity.id === 'empty'), '卡面有伤害【暴击】但 hasCrit=false');
  assert.ok(!has('crit-flag', (x) => x.entity.id === 'strike'));

  const strike = model.cards.find((c) => c.id === 'strike');
  assert.deepStrictEqual(strike.decks.map((d) => d.count), [3]);
  assert.deepStrictEqual(strike.effectTexts, ['对单个敌人造成 6 点物理伤害']);
  const drift = model.issues.find((x) => x.code === 'text-drift');
  assert.ok(drift.detail.diff.some((s) => s.t === 'del' && s.s.includes('5')));
  assert.ok(drift.detail.diff.some((s) => s.t === 'ins' && s.s.includes('7')));
});

test('输出：HTML 内嵌数据可解析，CSV 带 BOM，Markdown 有卡名', () => {
  const model = buildModel(loadContent(FIXTURE));
  const html = renderHtml(model);
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, '找到内嵌数据');
  const data = JSON.parse(m[1]);
  assert.strictEqual(data.cards.length, 5);
  assert.ok(renderCsv(model).startsWith('﻿'));
  assert.ok(renderMarkdown(model).includes('#### 打击 `strike`'));
});
