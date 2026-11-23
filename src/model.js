'use strict';
// 把读进来的内容包整理成浏览器要用的模型：互相连好引用（卡 ↔ Lua ↔ 卡组 ↔ 状态），
// 再跑一遍一致性检查。检查只报告，不改任何东西。

const L = require('./labels');

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

function normalize(s) {
  return String(s || '').replace(/[\s*`]/g, '');
}

/** 去掉（……）括注，比如「（本5级构筑为12点）」——那是给读者的换算提示，不算规则改动 */
function stripNotes(s) {
  return String(s || '').replace(/（[^（）]*）|\([^()]*\)/g, '');
}

/**
 * Lua 注释引用的卡面原文能不能在 text 里找到。允许用「…」省略中间部分；
 * 双方的括注都忽略后能对上也算对上。
 */
function quoteMatches(quote, text) {
  return quoteMatchesExact(quote, text) || quoteMatchesExact(stripNotes(quote), stripNotes(text));
}

function quoteMatchesExact(quote, text) {
  const t = normalize(text);
  const parts = normalize(quote).split(/…+|\.{3,}/).filter((p) => p.length >= 2);
  if (!parts.length) return true;
  let from = 0;
  for (const p of parts) {
    const i = t.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

/**
 * 字级别的差异（最长公共子序列）。返回 [{t:'same'|'del'|'ins', s}]：
 * del = 只在 Lua 注释里有，ins = 只在当前文字里有。
 */
function diffSegments(quote, text) {
  const a = [...normalize(quote)];
  let b = [...normalize(text)];
  if (a.length * b.length > 600000) return [{ t: 'del', s: a.join('') }, { t: 'ins', s: b.join('') }];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (t, ch) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += ch; else out.push({ t, s: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; } else { push('ins', b[j]); j++; }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);
  // 一两个字的巧合匹配夹在大段改动中间只会让人眼花：并进改动里
  const merged = [];
  for (const seg of out) {
    if (seg.t === 'same' && seg.s.length <= 1 && merged.length && merged[merged.length - 1].t !== 'same') {
      merged.push({ t: 'del', s: seg.s }, { t: 'ins', s: seg.s });
    } else merged.push(seg);
  }
  return merged;
}

function buildModel(content, options = {}) {
  const knownHooks = new Set(options.engineHooks ? options.engineHooks.hooks : Object.keys(L.hook));
  const issues = [];
  const add = (severity, code, entity, message, detail) => issues.push({ severity, code, entity, message, detail });

  for (const p of content.problems) {
    add(p.severity, p.code, { type: 'file', id: p.file, line: p.line }, p.message);
  }

  const cardById = new Map();
  for (const c of content.cards) {
    if (cardById.has(c.id)) {
      add('error', 'duplicate-id', { type: 'card', id: c.id },
        `卡牌 id「${c.id}」重复：${cardById.get(c.id)._file} 和 ${c._file} 都有，后加载的会覆盖前面的`);
    } else cardById.set(c.id, c);
  }
  const statusById = new Map(content.statuses.map((s) => [s.id, s]));
  const stubById = new Map((content.stubs || []).map((s) => [s.id, s]));
  const behaviourById = new Map();
  for (const b of content.behaviours) {
    if (behaviourById.has(b.id)) {
      const prev = behaviourById.get(b.id);
      add('error', 'duplicate-behaviour', { type: 'behaviour', id: b.id },
        `Lua 行为「${b.id}」定义了两次（${prev.file}:${prev.line} 和 ${b.file}:${b.line}），后加载的会覆盖前面的`);
    }
    behaviourById.set(b.id, b);
  }
  const intents = [];
  for (const e of content.enemies) {
    for (const i of e.intents || []) intents.push({ ...i, enemyId: e.id, enemyName: e.name });
  }

  // ── 谁引用了哪个 Lua 行为 ──
  const behaviourUsers = new Map(); // behaviourId → [{type,id,name,text}]
  const use = (bid, user) => {
    if (!bid) return;
    if (!behaviourUsers.has(bid)) behaviourUsers.set(bid, []);
    behaviourUsers.get(bid).push(user);
  };
  for (const c of content.cards) use(c.behaviourId, { type: 'card', id: c.id, name: c.name, text: c.rulesText });
  for (const s of content.statuses) use(s.behaviourId, { type: 'status', id: s.id, name: s.name, text: s.rulesText });
  for (const i of intents) use(i.behaviourId, { type: 'intent', id: i.id, name: i.name, text: i.text });

  // ── 卡组：每张卡出现在哪些卡组里 ──
  const deckUses = new Map(); // cardId → [{deckId, deckName, section, count}]
  const useDeck = (cardId, entry) => {
    if (!deckUses.has(cardId)) deckUses.set(cardId, []);
    deckUses.get(cardId).push(entry);
  };
  const decks = content.decks.map((d) => {
    const sections = [];
    const main = (d.main || []).map((x) => ({ card: x.card, count: x.count || 1 }));
    sections.push({ key: 'main', title: '主卡组', transformCard: null, cards: main });
    for (const f of d.formDecks || []) {
      sections.push({
        key: `form:${f.transformCard}`,
        title: `形态卡组 · ${cardById.get(f.transformCard)?.name || f.transformCard}`,
        transformCard: f.transformCard,
        cards: (f.cards || []).map((x) => ({ card: x.card, count: x.count || 1 })),
      });
    }
    for (const s of sections) {
      for (const x of s.cards) {
        useDeck(x.card, { deckId: d.id, deckName: d.name, section: s.title, count: x.count });
        if (!cardById.has(x.card)) {
          add('error', 'deck-missing-card', { type: 'deck', id: d.id },
            `卡组「${d.name}」的${s.title}里引用了不存在的卡「${x.card}」`);
        }
      }
      if (s.transformCard && !cardById.has(s.transformCard)) {
        add('error', 'deck-missing-card', { type: 'deck', id: d.id },
          `卡组「${d.name}」的形态卡组挂在不存在的升变牌「${s.transformCard}」上`);
      }
    }
    return {
      id: d.id, name: d.name, characterId: d.characterId, file: d._file, sections,
      total: sections.map((s) => ({ title: s.title, count: s.cards.reduce((a, x) => a + x.count, 0) })),
    };
  });

  // ── 角色 ──
  const characters = content.characters.map((ch) => {
    for (const [field, label] of [['weaponCardId', '武器'], ['armorCardId', '防具']]) {
      if (ch[field] && !cardById.has(ch[field])) {
        add('error', 'character-missing-card', { type: 'character', id: ch.id },
          `角色「${ch.name}」的${label}牌「${ch[field]}」不存在`);
      }
    }
    if (ch.deckId && !content.decks.some((d) => d.id === ch.deckId)) {
      add('error', 'character-missing-deck', { type: 'character', id: ch.id },
        `角色「${ch.name}」的起始卡组「${ch.deckId}」不存在`);
    }
    return { ...ch };
  });

  // ── 卡牌 ──
  const cards = content.cards.map((c) => {
    const ent = { type: 'card', id: c.id };
    const text = c.rulesText || '';
    const b = c.behaviourId ? behaviourById.get(c.behaviourId) : null;
    const stub = c.behaviourId && !b ? stubById.get(c.behaviourId) : null;
    const effects = Array.isArray(c.effects) ? c.effects : [];
    const hasBase = c.armorBaseShield != null || c.weaponBaseDamage != null;

    if (!c.behaviourId) {
      add('info', 'no-behaviour-id', ent, `「${c.name}」没有 behaviourId 字段，这张卡只有数据效果`);
    } else if (stub) {
      add('info', 'behaviour-pending', ent,
        `「${c.name}」的 Lua 行为「${c.behaviourId}」还是待实现的占位（${stub.file}:${stub.startLine}）${effects.length ? '，目前只有数据效果在生效' : '，目前打出后什么都不会发生'}`);
    } else if (!b) {
      if (effects.length === 0 && !hasBase) {
        add('error', 'behaviour-missing', ent,
          `「${c.name}」的行为「${c.behaviourId}」在 Lua 里找不到，而且它没有任何数据效果——打出后什么都不会发生`);
      } else if (effects.length === 0) {
        add('warn', 'behaviour-missing', ent,
          `「${c.name}」的行为「${c.behaviourId}」在 Lua 里找不到，也没有数据效果；卡面文字只有${c.armorBaseShield != null ? '基础护盾' : '基础伤害'}在生效`);
      } else {
        add('warn', 'behaviour-missing', ent,
          `「${c.name}」的行为「${c.behaviourId}」在 Lua 里找不到：只有数据效果（${effects.map(L.effectSentence).join('；')}）在生效，卡面上其余的部分没有实现`);
      }
    }

    // 暴击标记 vs 卡面
    const textCrit = /伤害【[^】]*暴击】/.test(text);
    if (textCrit && !c.hasCrit) {
      add('warn', 'crit-flag', ent, `「${c.name}」卡面写着「伤害【暴击】」，但 hasCrit 是 false`);
    } else if (c.hasCrit && !/【[^】]*暴击】/.test(text)) {
      add('warn', 'crit-flag', ent, `「${c.name}」hasCrit 是 true，但卡面上没有【暴击】`);
    }

    // 数据效果里的数值在卡面上能不能找到
    for (const e of effects) {
      const a = e.amount;
      if (!a || typeof a !== 'object') continue;
      const add0 = Number(a.add || 0);
      if (a.source === 'Flat' && (e.kind === 'Damage' || e.kind === 'GainShield')) {
        if (!new RegExp(`(^|[^\\d])${add0}点`).test(text)) {
          add('warn', 'number-mismatch', ent,
            `「${c.name}」数据效果是「${L.effectSentence(e)}」，但卡面上找不到「${add0}点」`);
        }
      } else if (a.source === 'FormAttack' || a.source === 'FormDefense') {
        const base = a.source === 'FormAttack' ? 'B_atk' : 'B_def';
        const want = add0 ? `${base}\\s*\\+\\s*${add0}点` : `${base}(?!\\s*\\+)`;
        if (!new RegExp(want).test(text)) {
          add('warn', 'number-mismatch', ent,
            `「${c.name}」数据效果是「${L.effectSentence(e)}」，但卡面上找不到「${base}${add0 ? '+' + add0 : ''}」`);
        }
      }
    }

    return {
      id: c.id, name: c.name, owner: c.owner, category: c.category, kind: c.kind, classId: c.classId,
      colors: c.colors || [], ap: c.ap ?? 0, mp: c.mp ?? 0, charge: c.charge ?? 0, hasCrit: !!c.hasCrit,
      rulesText: text, behaviourId: c.behaviourId || null, formId: c.formId || null,
      armorBaseShield: c.armorBaseShield ?? null, shieldKind: c.shieldKind || null,
      weaponBaseDamage: c.weaponBaseDamage ?? null, twoHanded: c.twoHanded ?? null,
      effects, effectTexts: effects.map(L.effectSentence),
      unmapped: c.unmapped || {}, art: c.art || null, file: c._file,
      hooks: b ? b.hooks.map((h) => h.name) : [],
      luaPending: stub ? { file: stub.file, line: stub.startLine } : null,
      decks: deckUses.get(c.id) || [],
    };
  });

  for (const c of cards) {
    if (c.decks.length === 0) {
      add('info', 'not-in-deck', { type: 'card', id: c.id }, `「${c.name}」不在任何卡组里`);
    }
  }

  // ── 状态 ──
  for (const s of content.statuses) {
    if (s.behaviourId && !behaviourById.has(s.behaviourId)) {
      add('error', 'behaviour-missing', { type: 'status', id: s.id },
        `状态「${s.name}」的行为「${s.behaviourId}」在 Lua 里找不到——状态挂上后它的效果不会生效`);
    }
  }

  // ── 敌人意图 ──
  for (const e of content.enemies) {
    const ids = new Set((e.intents || []).map((i) => i.id));
    for (const [pool, list] of Object.entries(e.intentPools || {})) {
      for (const id of list) {
        if (!ids.has(id)) {
          add('error', 'intent-missing', { type: 'enemy', id: e.id },
            `「${e.name}」的意图池 ${pool} 里有「${id}」，但它的 intents 里没有这条`);
        }
      }
    }
    for (const i of e.intents || []) {
      if (i.behaviourId && !behaviourById.has(i.behaviourId)) {
        add('warn', 'behaviour-missing', { type: 'intent', id: i.id },
          `「${e.name}」的意图「${i.name}」的行为「${i.behaviourId}」在 Lua 里找不到`);
      } else if (!i.behaviourId && behaviourById.has(i.id)) {
        add('warn', 'behaviour-unlinked', { type: 'intent', id: i.id },
          `「${e.name}」的意图「${i.name}」没写 behaviourId，但 Lua 里有同名的行为「${i.id}」——大概率是漏写了`);
      }
    }
  }

  // ── Lua 行为 ──
  const allTexts = [
    ...content.cards.map((c) => c.rulesText),
    ...content.statuses.map((s) => s.rulesText),
    ...intents.map((i) => i.text),
  ].filter(Boolean);

  const behaviours = content.behaviours.map((b) => {
    const users = behaviourUsers.get(b.id) || [];
    const ent = { type: 'behaviour', id: b.id };
    if (users.length === 0) {
      add('warn', 'behaviour-unused', ent,
        `Lua 行为「${b.id}」（${b.file}:${b.line}）没有任何卡、状态或意图引用，不会被调用`);
    }
    for (const r of b.statusRefs) {
      if (!statusById.has(r.id)) {
        add('error', 'status-missing', ent,
          `Lua 行为「${b.id}」里 ${r.fn}(…, "${r.id}") 用到的状态在 statuses.json 里不存在`);
      }
    }
    let quoteState = null;
    if (b.quote) {
      const own = users.map((u) => u.text).filter(Boolean);
      if (own.some((t) => quoteMatches(b.quote, t))) quoteState = 'ok';
      else if (allTexts.some((t) => quoteMatches(b.quote, t))) quoteState = 'elsewhere';
      else {
        quoteState = 'drift';
        const target = own[0] || '';
        add('warn', 'text-drift', ent,
          `Lua 行为「${b.id}」注释里抄的卡面原文，和现在的${users[0] ? `「${users[0].name}」` : ''}文字对不上——可能卡面改过，脚本没跟上`,
          { quote: b.quote, current: target, diff: diffSegments(b.quote, target) });
      }
    }
    for (const h of b.hooks) {
      if (!knownHooks.has(h.name)) {
        add('warn', 'unknown-hook', ent,
          `Lua 行为「${b.id}」里的钩子「${h.name}」引擎不认识${options.engineHooks ? '（按 C# 源码核对）' : ''}，不会被调用——是不是拼错了？`);
      }
    }
    return { ...b, users: users.map(({ type, id, name }) => ({ type, id, name })), quoteState };
  });

  // ── 迁移遗留字段汇总 ──
  const unmappedSummary = {};
  for (const c of content.cards) {
    for (const [k, v] of Object.entries(c.unmapped || {})) {
      const row = (unmappedSummary[k] ||= { key: k, cards: [], values: {} });
      row.cards.push(c.id);
      const vs = JSON.stringify(v);
      row.values[vs] = (row.values[vs] || 0) + 1;
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  issues.forEach((x, i) => { x.n = i + 1; });

  const issueIndex = {};
  for (const x of issues) {
    const k = `${x.entity.type}:${x.entity.id}`;
    (issueIndex[k] ||= []).push(x.n);
  }

  return {
    pack: content.pack,
    contentDir: content.contentDir,
    generatedAt: new Date().toISOString(),
    engineHooks: options.engineHooks || null,
    cards, statuses: content.statuses.map(({ _file, ...s }) => ({ ...s, file: _file })),
    characters: characters.map(({ _file, ...c }) => c),
    enemies: content.enemies.map(({ _file, ...e }) => ({ ...e, file: _file })),
    decks, behaviours, stubs: content.stubs || [], scripts: content.scripts, issues, issueIndex,
    unmappedSummary: Object.values(unmappedSummary).sort((a, b) => b.cards.length - a.cards.length),
  };
}

module.exports = { buildModel, quoteMatches };
