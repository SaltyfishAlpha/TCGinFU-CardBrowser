'use strict';
// 跨项的校验：一项本身看不出来，要结合别的项才知道对不对。
//   - ref 列：引用的 id 必须存在，并满足 where（比如形态卡组里只能放 role 为 Form 的牌）
//   - matchParent：被引用的项的某个字段要和父项一致（形态牌的职业要和升变牌一致）
//   - sum：子数组某个字段的合计（形态卡组合计 10 张）
//   - checks：子数组每个元素自己的数值约束（amount.times ≠ 0）
//   - rules：profile 里的字段约束（升变牌不填打法 等）
// 导入时用它拦截，网页检查报告也用它，两边说的是同一套话。

const P = require('./profile');

/**
 * view: { [collectionKey]: Map<id, obj> }，是「改完之后」的全貌。
 * 返回 [{ id, message }]
 */
function checkItem(def, obj, view) {
  const out = [];
  const id = obj[def.idField || 'id'];
  for (const r of P.checkRules(def.rules, obj)) out.push({ id, message: r.message });

  const refProblems = (col, value, where) => {
    if (value === undefined || value === null || value === '') return null;
    const target = view[col.collection];
    if (!target) return null;
    const hit = target.get(value);
    if (!hit) return `${where}「${col.header}」填的「${value}」不存在`;
    if (col.where && !P.matchesWhen(hit, col.where)) {
      return `${where}「${col.header}」填的「${value}」不符合要求（${Object.entries(col.where).map(([k, v]) => `${k} 要是 ${v}`).join('，')}）`;
    }
    return null;
  };

  for (const c of def.columns || []) {
    if (c.type !== 'ref') continue;
    const m = refProblems(c, P.getPath(obj, c.field), '');
    if (m) out.push({ id, message: m });
  }

  for (const ch of def.children || []) {
    const arr = P.getPath(obj, ch.field);
    if (!Array.isArray(arr)) continue;
    arr.forEach((e, i) => {
      const where = `「${ch.sheet}」第 ${i + 1} 条的`;
      for (const c of ch.columns) {
        if (c.type !== 'ref') continue;
        const value = P.getPath(e, c.field);
        const m = refProblems(c, value, where);
        if (m) { out.push({ id, message: m }); continue; }
        for (const mp of ch.matchParent || []) {
          const target = view[c.collection] && view[c.collection].get(value);
          if (target && P.getPath(target, mp.field) !== P.getPath(obj, mp.field)) {
            out.push({ id, message: `${mp.message}：「${target[def.nameField] || value}」是「${P.getPath(target, mp.field) ?? '（空）'}」，这张是「${P.getPath(obj, mp.field) ?? '（空）'}」` });
          }
        }
      }
      for (const k of ch.checks || []) {
        if (!P.hasPath(e, k.field)) continue;
        const v = P.getPath(e, k.field);
        if (k.notEqual !== undefined && v === k.notEqual) out.push({ id, message: `${where}${k.message}` });
        if (k.min !== undefined && typeof v === 'number' && v < k.min) out.push({ id, message: `${where}${k.message}` });
      }
    });
    if (ch.sum && arr.length) {
      const total = arr.reduce((a, e) => a + (P.hasPath(e, ch.sum.field) ? Number(P.getPath(e, ch.sum.field)) : ch.sum.default ?? 0), 0);
      if (ch.sum.equals !== undefined && total !== ch.sum.equals) out.push({ id, message: `${ch.sum.message}（现在是 ${total} 张）` });
    }
  }
  return out;
}

/** 从 store 的当前内容 + 导入计划，拼出「改完之后」的全貌 */
function finalView(store, changes) {
  const view = {};
  for (const [key, col] of Object.entries(store.collections)) {
    view[key] = new Map(col.items.map((it) => [String(it.id), it.obj]));
  }
  for (const ch of changes || []) {
    const m = view[ch.collection];
    if (!m) continue;
    if (ch.type === 'delete') m.delete(String(ch.id));
    else m.set(String(ch.id), ch.obj);
  }
  return view;
}

module.exports = { checkItem, finalView };
