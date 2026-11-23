'use strict';
// 读项目描述（profile），并提供按描述在「json 值」和「表格单元格」之间转换的工具。
// 工具代码里不出现任何具体项目的字段名——字段、表头、枚举、文件规则都在 profile.json 里。

const fs = require('fs');
const path = require('path');

function loadProfile(dir) {
  const file = path.join(dir, 'profile.json');
  let p;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`读不到项目描述 ${file}：${e.message}`);
  }
  p.dir = dir;
  p.collections = p.collections || [];
  for (const c of p.collections) {
    c.columns = c.columns || [];
    c.children = c.children || [];
    c.references = c.references || [];
  }
  return p;
}

// ───────── 点路径：amount.add → obj.amount.add ─────────

function getPath(obj, p) {
  let cur = obj;
  for (const k of p.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function hasPath(obj, p) {
  let cur = obj;
  for (const k of p.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return false;
    cur = cur[k];
  }
  return true;
}

function setPath(obj, p, v) {
  const ks = p.split('.');
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = v;
}

function deletePath(obj, p) {
  const ks = p.split('.');
  const stack = [obj];
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    cur = cur?.[ks[i]];
    if (cur == null || typeof cur !== 'object') return;
    stack.push(cur);
  }
  delete cur[ks[ks.length - 1]];
  // 删完变成空对象的中间层一并去掉（amount: {} 没有意义）
  for (let i = ks.length - 2; i >= 0; i--) {
    const parent = stack[i];
    const child = parent[ks[i]];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete parent[ks[i]];
    else break;
  }
}

/** 被列覆盖的顶层字段（amount.add 覆盖的是 amount 下的 add，不是整个 amount） */
function coveredPaths(columns) {
  return columns.map((c) => c.field).filter((f) => f && !f.startsWith('_'));
}

/** obj 里没有被任何列覆盖的部分 → 放进「其它字段」 */
function otherFields(obj, columns, exclude = []) {
  const covered = coveredPaths(columns);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (exclude.includes(k)) continue;
    if (covered.includes(k)) continue;
    const sub = covered.filter((f) => f.startsWith(k + '.')).map((f) => f.slice(k.length + 1));
    if (sub.length && v && typeof v === 'object' && !Array.isArray(v)) {
      const rest = {};
      for (const [kk, vv] of Object.entries(v)) if (!sub.includes(kk)) rest[kk] = vv;
      if (Object.keys(rest).length) out[k] = rest;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ───────── 枚举 ─────────

/** 把 profile 里的枚举展开成 { value → label }。$from 的枚举从已加载的集合里取。 */
function resolveEnums(profile, collections) {
  const out = {};
  for (const [name, def] of Object.entries(profile.enums || {})) {
    if (def && def.$from) {
      const src = collections[def.$from.collection];
      const m = {};
      for (const it of src ? src.items : []) m[getPath(it.obj, def.$from.value)] = getPath(it.obj, def.$from.label) ?? getPath(it.obj, def.$from.value);
      out[name] = m;
    } else out[name] = { ...def };
  }
  return out;
}

const normKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '');

/** 单元格里的文字 → 枚举值。中文标签和英文原值都认。 */
function parseEnum(map, raw) {
  const s = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(map, s)) return { ok: true, value: s };
  const n = normKey(s);
  for (const [v, label] of Object.entries(map)) {
    if (normKey(label) === n || normKey(v) === n) return { ok: true, value: v };
  }
  return { ok: false };
}

const TRUE_WORDS = new Set(['是', 'true', '1', 'y', 'yes', '✓', '√', 'x', '有']);
const FALSE_WORDS = new Set(['否', 'false', '0', 'n', 'no', '无', '']);

/**
 * 单元格 → json 值。返回 { empty } | { value } | { error }。
 * 空单元格的含义由调用方决定（用默认值 / 删字段）。
 */
function parseCell(col, raw, enums) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { empty: true };
  const str = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : raw;
  switch (col.type) {
    case 'int':
    case 'number': {
      const n = typeof str === 'number' ? str : Number(String(str).trim().replace(/^＋/, '+').replace(/[，,]/g, ''));
      if (!Number.isFinite(n)) return { error: `「${raw}」不是数字` };
      if (col.type === 'int' && !Number.isInteger(n)) return { error: `「${raw}」应该是整数` };
      return { value: n };
    }
    case 'bool': {
      if (typeof str === 'boolean') return { value: str };
      const s = normKey(str);
      if (TRUE_WORDS.has(s)) return { value: true };
      if (FALSE_WORDS.has(s)) return { value: false };
      return { error: `「${raw}」不是 是/否` };
    }
    case 'enum': {
      const map = enums[col.enum] || {};
      const r = parseEnum(map, str);
      return r.ok ? { value: r.value } : { error: `「${raw}」不在「${col.header}」的可选值里（${Object.values(map).join('、')}）` };
    }
    case 'list': {
      const parts = String(str).split(/[+＋,，、/／\n]/).map((s) => s.trim()).filter(Boolean);
      if (!col.enum) return { value: parts };
      const map = enums[col.enum] || {};
      const out = [];
      for (const p of parts) {
        const r = parseEnum(map, p);
        if (!r.ok) return { error: `「${p}」不在「${col.header}」的可选值里（${Object.values(map).join('、')}）` };
        out.push(r.value);
      }
      return { value: out };
    }
    case 'json': {
      try { return { value: JSON.parse(String(str)) }; } catch (e) { return { error: `不是合法的 JSON：${e.message}` }; }
    }
    default: {
      const s = String(str);
      return { value: col.type === 'text' ? s.trim() : s.trim() };
    }
  }
}

/** json 值 → 单元格 */
function formatCell(col, value, enums) {
  if (value === undefined || value === null) return null;
  switch (col.type) {
    case 'int':
    case 'number': return typeof value === 'number' ? value : String(value);
    case 'bool': return value ? '是' : '否';
    case 'enum': return (enums[col.enum] || {})[value] ?? String(value);
    case 'list': return Array.isArray(value) ? value.map((v) => (col.enum ? (enums[col.enum] || {})[v] ?? v : v)).join('+') : String(value);
    case 'json': return JSON.stringify(value);
    default: return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** 规则列表里挑第一条匹配的：[{ when: {kind:'Form'}, collection?, file }] */
function pickRule(rules, obj, collectionKey) {
  for (const r of rules || []) {
    if (r.collection && r.collection !== collectionKey) continue;
    if (r.when && !Object.entries(r.when).every(([k, v]) => getPath(obj, k) === v)) continue;
    return r;
  }
  return null;
}

function fillTemplate(tpl, obj) {
  return tpl.replace(/\{([\w.]+)\}/g, (_, k) => {
    const v = getPath(obj, k);
    return v == null ? '' : String(v);
  });
}

/** 按 fieldOrder 排键；没列出的键保持原相对顺序放在后面 */
function orderKeys(obj, order) {
  if (!order || !order.length) return obj;
  const out = {};
  for (const k of order) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = obj[k];
  return out;
}

module.exports = {
  loadProfile, getPath, hasPath, setPath, deletePath, otherFields, resolveEnums, parseEnum, parseCell, formatCell,
  pickRule, fillTemplate, orderKeys,
};
