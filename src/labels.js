'use strict';
// 把内容包里的英文枚举翻成策划看得懂的中文。没收录的值原样显示，不会报错。

const category = { Class: '职业牌', Armor: '防具', Weapon: '武器', Treasure: '宝物' };
const kind = { Form: '形态牌', Transform: '升变', Skill: '技能', Timing: '时机', Continuous: '持续' };
const color = { Might: '力量', Dexterity: '敏捷', Insight: '洞察', Willpower: '意志' };
const element = {
  Physical: '物理', Dark: '暗', Light: '光', Fire: '火', Ice: '冰', Lightning: '雷',
  Wind: '风', Earth: '地', Poison: '毒', Arcane: '奥术',
};
const shieldKind = { Physical: '物理', Magical: '魔法', Universal: '全能', All: '全能' };
const target = {
  SingleEnemy: '单个敌人', AllEnemies: '全体敌人', Self: '自己', SingleAlly: '单个队友',
  AllAllies: '全体队友', AnyAlly: '任意队友', Any: '任意目标',
};
const effectKind = {
  Damage: '伤害', Heal: '回复 HP', GainShield: '护盾', RestoreMp: '回复 MP', GainAp: '获得 AP',
  Draw: '抽牌', Discard: '弃牌', GainCharge: '充能', ApplyStatus: '施加状态', MoveRow: '换排',
  GrantFreeMove: '免费换排', SwapRows: '交换前后排', Cover: '掩护',
};
const amountSource = { Flat: '', FormAttack: 'B_atk', FormDefense: 'B_def' };
const row = { Front: '前排', Back: '后排' };
const rank = { Boss: '首领', Normal: '普通' };
const affinity = { Vulnerable: '弱', Resistant: '抗', Immune: '免疫', Absorb: '吸收' };
const targeting = {
  AllPlayers: '我方全体', DefaultSingle: '单体（默认选取）', DesignatedRowSingle: '指定排的单体',
  FrontRowAoe: '前排全体', SelfOrNone: '自身 / 无目标', BackRowAoe: '后排全体',
};

// Lua 钩子：名字 → 什么时候被调用。说明取自 scripts/miku.lua 开头的写法约定。
const hook = {
  can_play: '出牌前的额外条件',
  on_play: '打出时（数据效果之前）',
  on_resolved: '结算后（数据效果之后）',
  transform_condition: '升变的前置条件',
  on_attack: '我方出手的每次攻击',
  on_defend: '我方挨打的每次攻击',
  on_crit_roll: '掷完暴击骰、判定之前',
  on_damage_taken: '受到伤害后',
  on_damage_dealt: '造成伤害后',
  on_crit_dealt: '打出暴击后',
  on_card_played: '任意一张牌打出后',
  on_charge_spent: '消耗充能指示物后',
  on_charge_spend: '即将消耗充能指示物时（可改写）',
  on_cost: '计算费用时（可改写费用）',
  on_attack_resolved: '一次攻击结算完毕后',
  on_round_start: '轮始',
  on_round_end: '轮末',
};

function t(map, v) {
  if (v === undefined || v === null || v === '') return '';
  return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : String(v);
}

function amountText(amount) {
  if (amount === undefined || amount === null) return '';
  if (typeof amount === 'number') return String(amount);
  const src = amount.source || 'Flat';
  const add = Number(amount.add || 0);
  let s;
  if (src === 'Flat') s = String(add);
  else {
    const base = Object.prototype.hasOwnProperty.call(amountSource, src) ? amountSource[src] : src;
    s = add ? `${base}${add > 0 ? '+' : ''}${add}` : base;
  }
  return s;
}

const KNOWN_EFFECT_KEYS = new Set(['kind', 'amount', 'element', 'target', 'shieldKind']);

/** 一条数据效果 → 一句中文。认不出的字段附在句末，不吞掉。 */
function effectSentence(e) {
  const tg = t(target, e.target);
  const amt = amountText(e.amount);
  const times = e.amount && e.amount.times > 1 ? ` ×${e.amount.times} 次` : '';
  let s;
  switch (e.kind) {
    case 'Damage':
      s = `对${tg}造成 ${amt} 点${t(element, e.element)}伤害${times}`;
      break;
    case 'GainShield':
      s = `${tg}获得 ${amt} 点${t(shieldKind, e.shieldKind)}护盾${times}`;
      break;
    case 'Heal':
      s = `${tg}回复 ${amt} 点 HP`;
      break;
    case 'RestoreMp':
      s = `${tg}回复 ${amt} 点 MP`;
      break;
    case 'GainAp':
      s = `${tg}获得 ${amt} AP`;
      break;
    case 'Draw':
      s = `${tg === '自己' || !tg ? '' : tg}抽 ${amt || 1} 张牌`;
      break;
    case 'Discard':
      s = `${tg}弃 ${amt || 1} 张牌`;
      break;
    case 'GainCharge':
      s = `${tg}获得 ${amt || 1} 个充能指示物`;
      break;
    case 'MoveRow':
      s = `${tg}换排`;
      break;
    default:
      s = `${t(effectKind, e.kind)}${tg ? ' → ' + tg : ''}${amt ? ' ' + amt : ''}`;
  }
  const extra = Object.entries(e).filter(([k]) => !KNOWN_EFFECT_KEYS.has(k));
  const amountExtra = e.amount && typeof e.amount === 'object'
    ? Object.entries(e.amount).filter(([k]) => !['source', 'add', 'times'].includes(k))
    : [];
  const rest = [...extra, ...amountExtra];
  if (rest.length) s += `（${rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('，')}）`;
  return s;
}

module.exports = {
  category, kind, color, element, shieldKind, target, effectKind, row, rank, affinity, targeting, hook,
  t, amountText, effectSentence,
};

/**
 * 用 profile 里的枚举和钩子说明覆盖上面的默认表，让网页、表格、任务单说同一套话。
 * amountSource 例外：网页里的效果句子用「B_atk+4」这种写法，固定值不需要前缀。
 */
function applyProfile(profile) {
  const targets = { category, kind, color, element, shieldKind, target, effectKind, row, rank, affinity, targeting };
  for (const [name, map] of Object.entries(profile.enums || {})) {
    if (targets[name] && map && !map.$from) Object.assign(targets[name], map);
  }
  if (profile.lua && profile.lua.hooks) Object.assign(hook, profile.lua.hooks);
}

module.exports.applyProfile = applyProfile;
