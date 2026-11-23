'use strict';
// 内容包 ⇄ 表格。
//
// 导出：每个可编辑集合一张主表（一行一项），每个子数组一张子表（一行一个元素，比如一条效果），
//      外加「枚举」（下拉框的数据源）、「说明」和隐藏的「_meta」（导出时每一项的原样 JSON）。
// 导入：按表头认列（列可以挪、可以删），和 _meta 里的导出时版本做三方比对——
//      只有策划在表里改过的格子才会写回；导出后 json 被别人（比如 agent）改过、表里也改了同一格，
//      记为冲突，不覆盖。

const P = require('./profile');

const SPECIAL = { file: '文件', del: '删除', other: '其它字段(JSON)', lua: 'Lua状态', seq: '序号' };
const META_SHEET = '_meta';
const ENUM_SHEET = '枚举';
const HELP_SHEET = '说明';
const ABSENT = Symbol('absent');

// ───────── 比较 ─────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === ABSENT || b === ABSENT || a === undefined || b === undefined) return (a === ABSENT || a === undefined) && (b === ABSENT || b === undefined);
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const clone = (v) => (v === undefined || v === ABSENT ? v : JSON.parse(JSON.stringify(v)));

/** 字段在「表格语义」下的值：缺省字段视为默认值，这样「json 里没写 ap」和「表里 ap 填 0」算同一回事 */
function normField(col, obj) {
  if (!obj || !P.hasPath(obj, col.field)) return col.default !== undefined ? col.default : ABSENT;
  return P.getPath(obj, col.field);
}

// ───────── 导出 ─────────

function luaStatus(def, obj, index) {
  if (!def.behaviourField) return null;
  const b = obj[def.behaviourField];
  if (!b) return '无（纯数据）';
  if (index.blocks.has(b)) {
    const hooks = index.blocks.get(b).hooks.map((h) => h.name);
    return `已实现：${hooks.join(', ') || '（没有钩子）'}`;
  }
  if (index.stubs.has(b)) return '待实现（占位）';
  return '缺失';
}

function enumColumnsFor(profile, enums, store) {
  // 枚举表的每一列：[{ key, header, values }]
  const out = [];
  const seen = new Set();
  const add = (key, header, values) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, header, values });
  };
  for (const def of profile.collections.filter((d) => d.editable)) {
    const cols = [...def.columns, ...def.children.flatMap((c) => c.columns)];
    for (const c of cols) {
      if ((c.type === 'enum' || c.type === 'list') && c.enum) add(`enum:${c.enum}`, c.header, Object.values(enums[c.enum] || {}));
      if (c.suggest) {
        const vals = [...new Set(store.collections[def.key].items.map((it) => P.getPath(it.obj, c.field)).filter((v) => v != null && v !== ''))];
        add(`suggest:${def.key}:${c.field}`, `${c.header}（已有）`, vals);
      }
    }
  }
  add('bool', '是/否', ['是', '否']);
  add('del', '删除', ['删除']);
  return out;
}

function exportWorkbook(store, profile, options = {}) {
  const enums = P.resolveEnums(profile, store.collections);
  const index = store.behaviourIndex();
  const enumCols = enumColumnsFor(profile, enums, store);
  const listRef = (key) => {
    const i = enumCols.findIndex((e) => e.key === key);
    if (i < 0 || !enumCols[i].values.length) return null;
    const { colName } = require('./xlsx');
    return `'${ENUM_SHEET}'!$${colName(i)}$2:$${colName(i)}$${enumCols[i].values.length + 1}`;
  };
  const listFor = (def, c) => {
    if (c.type === 'enum') return listRef(`enum:${c.enum}`);
    if (c.type === 'bool') return listRef('bool');
    if (c.suggest) return listRef(`suggest:${def.key}:${c.field}`);
    return null;
  };

  const sheets = [];
  const meta = [['__export__', new Date().toISOString(), profile.name || '']];

  for (const def of profile.collections.filter((d) => d.editable)) {
    const col = store.collections[def.key];
    const childFields = def.children.map((ch) => ch.field);
    const columns = def.columns.map((c) => ({
      header: c.header, width: c.width, key: c.type === 'id', wrap: c.type === 'text', list: listFor(def, c),
    }));
    const extra = [];
    if (def.behaviourField) extra.push({ header: SPECIAL.lua, width: 24, readonly: true });
    extra.push({ header: SPECIAL.file, width: 18 });
    extra.push({ header: SPECIAL.del, width: 7, list: listRef('del') });
    extra.push({ header: SPECIAL.other, width: 30, wrap: true });
    const rows = col.items.map((it) => {
      const r = def.columns.map((c) => {
        const v = P.getPath(it.obj, c.field);
        // 「留空 = 用 id 当行为名」，所以没有行为的项要明确写「无」，否则再导入会被补上行为
        if (c.type === 'behaviour' && (v === undefined || v === null || v === '') && def.newBehaviour === 'id') return '无';
        return P.formatCell(c, v, enums);
      });
      if (def.behaviourField) r.push(luaStatus(def, it.obj, index));
      r.push(it.file);
      r.push(null);
      const other = P.otherFields(it.obj, def.columns, childFields);
      r.push(Object.keys(other).length ? JSON.stringify(other) : null);
      meta.push([def.key, String(it.id), JSON.stringify(it.obj), it.file]);
      return r;
    });
    sheets.push({ name: def.label, columns: [...columns, ...extra], rows, autoFilter: true, freezeCols: 2, tabSelected: sheets.length === 0 });

    for (const ch of def.children) {
      const parentHeader = `${def.label}id`;
      const chCols = [
        { header: parentHeader, width: 24, key: true },
        { header: `${def.label}名`, width: 14, readonly: true },
        { header: SPECIAL.seq, width: 6 },
        ...ch.columns.map((c) => ({ header: c.header, width: c.width, wrap: c.type === 'text', list: listFor(def, c) })),
        { header: SPECIAL.other, width: 30, wrap: true },
      ];
      const chRows = [];
      for (const it of col.items) {
        const arr = P.getPath(it.obj, ch.field);
        if (!Array.isArray(arr)) continue;
        arr.forEach((e, i) => {
          const other = P.otherFields(e, ch.columns);
          chRows.push([
            String(it.id), it.obj[def.nameField] ?? null, i + 1,
            ...ch.columns.map((c) => P.formatCell(c, P.getPath(e, c.field), enums)),
            Object.keys(other).length ? JSON.stringify(other) : null,
          ]);
        });
      }
      sheets.push({ name: ch.sheet, columns: chCols, rows: chRows, autoFilter: true, freezeCols: 2 });
    }
  }

  const maxLen = Math.max(0, ...enumCols.map((e) => e.values.length));
  sheets.push({
    name: ENUM_SHEET,
    columns: enumCols.map((e) => ({ header: e.header, width: 14 })),
    rows: Array.from({ length: maxLen }, (_, i) => enumCols.map((e) => e.values[i] ?? null)),
  });
  sheets.push({ name: HELP_SHEET, columns: [{ header: '怎么用这张表', width: 120, wrap: true }], rows: helpLines(profile).map((l) => [l]), freeze: false });
  sheets.push({ name: META_SHEET, hidden: true, columns: [{ header: '集合' }, { header: 'id' }, { header: '导出时的 JSON' }, { header: '导出时的文件' }], rows: meta });
  return sheets;
}

function helpLines(profile) {
  const editable = profile.collections.filter((d) => d.editable);
  const lines = [
    `这张表由卡牌浏览器从 ${profile.name || '内容包'} 导出。改完保存，用「导入卡牌表」导回去。`,
    '',
    '■ 改：直接改格子。只有你改过的格子会写回，其它格子原样保留。',
    '■ 加：在表格最下面新起一行。id 必填，只能用小写英文、数字和下划线（比如 frost_nova），一旦定了就不要再改。',
    '■ 删：在「删除」列选「删除」。被卡组或角色引用的项不能删，导入时会提示是谁在用它。',
    '■ 改 id：不支持。请删掉旧行、新加一行。',
    '',
    '■ 浅蓝色表头的列可以改；灰色的列（Lua状态、名称）只是给你看的，改了也不会生效。',
    '■ 有下拉框的列：从下拉里选。中文和英文原值都认。',
    '■ 「颜色」这类多选列：用 + 连接，比如 敏捷+洞察。',
    '■ 「Lua行为」：新卡留空 = 用 id 作为行为名，并自动生成一段待实现的 Lua 占位；填「无」= 这张卡只靠数据效果，不要 Lua。',
    '■ 「文件」：新卡留空会按规则放进默认文件；填别的文件名会把这项挪过去。',
    '■ 「其它字段(JSON)」：表里没有单独列出来的字段。看不懂就别动。',
  ];
  for (const def of editable) {
    for (const ch of def.children) {
      lines.push(`■ 「${ch.sheet}」表：一行一条，用「${def.label}id」对应到${def.label}，「序号」决定先后。某张${def.label}的行全删掉 = 这张${def.label}没有${ch.sheet}。`);
    }
  }
  lines.push('');
  lines.push('■ 导入时会先给出预览，列出每一处改动、冲突和错误；确认后才写入。');
  lines.push('■ 冲突：你导出之后，同一格在 json 里也被别人改过（比如 agent 修了 Lua 顺手改了数值）。冲突的格子不会被覆盖，预览里会写清楚三方的值。');
  lines.push('■ 改了卡面文字、加了新卡，导入后会生成一份「agent 任务单」，交给实现 Lua 的 agent。');
  return lines;
}

// ───────── 导入 ─────────

function headerMap(row) {
  const m = new Map();
  (row || []).forEach((h, i) => {
    if (h == null) return;
    const k = String(h).trim();
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}

const isBlankRow = (r) => !r || r.every((v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
const cellStr = (v) => (v === null || v === undefined ? '' : String(v).trim());

function readMeta(sheets) {
  const s = sheets.find((x) => x.name === META_SHEET);
  const base = new Map();
  const baseFiles = new Map();
  let exportedAt = null;
  if (!s) return { base, baseFiles, exportedAt };
  for (const r of s.rows.slice(1)) {
    if (!r || !r[0]) continue;
    if (r[0] === '__export__') { exportedAt = r[1]; continue; }
    const k = `${r[0]}\u0000${r[1]}`;
    try { base.set(k, JSON.parse(r[2])); } catch { continue; /* 损坏的 meta 当没有 */ }
    if (r[3]) baseFiles.set(k, String(r[3]));
  }
  return { base, baseFiles, exportedAt };
}

/**
 * 读表 → 导入计划。不改任何东西。
 * plan.changes: [{ collection, def, id, type: 'add'|'update'|'delete', fields: [{ header, from, to }], obj, item, file }]
 */
function planImport(store, profile, sheets, options = {}) {
  const enums = P.resolveEnums(profile, store.collections);
  const { base, baseFiles, exportedAt } = readMeta(sheets);
  const plan = { errors: [], warnings: [], conflicts: [], changes: [], untouched: {}, exportedAt, hasMeta: base.size > 0, sheetsUsed: [] };
  const err = (sheet, row, msg) => plan.errors.push({ sheet, row, message: msg });
  const warn = (sheet, row, msg) => plan.warnings.push({ sheet, row, message: msg });

  if (!plan.hasMeta) {
    warn(null, null, '表里没有 _meta（不是从本工具导出的，或者被删了）。没法区分「你改的」和「别人改的」，表里的值会直接覆盖 json。');
  }

  for (const def of profile.collections.filter((d) => d.editable)) {
    const col = store.collections[def.key];
    const sheet = sheets.find((s) => s.name === def.label);
    const childSheets = def.children.map((ch) => ({ ch, sheet: sheets.find((s) => s.name === ch.sheet) }));
    if (!sheet && childSheets.every((c) => !c.sheet)) continue;
    const baseOf = (id) => base.get(`${def.key}\u0000${id}`);

    /** 三方合并一个字段。返回 { change, value } | { conflict } | null（不变） */
    const merge3 = (header, tableV, baseV, curV, id, sheetName, rowNo) => {
      const b = plan.hasMeta && baseV !== undefined ? baseV : curV;
      if (deepEqual(tableV, b)) return null; // 策划没动这格
      if (deepEqual(curV, b) || deepEqual(curV, tableV) || options.force) return deepEqual(curV, tableV) ? null : { value: tableV };
      plan.conflicts.push({ collection: def.label, id, header, base: b, current: curV, table: tableV, sheet: sheetName, row: rowNo });
      return { conflict: true };
    };

    const pending = new Map(); // id → { type, obj(working copy), item, fields: [], file }
    const seenIds = new Map();

    if (sheet) {
      plan.sheetsUsed.push(sheet.name);
      const hm = headerMap(sheet.rows[0]);
      const idCol = def.columns.find((c) => c.type === 'id') || { field: def.idField, header: def.idField };
      if (!hm.has(idCol.header)) {
        err(sheet.name, 1, `找不到「${idCol.header}」列，这张表没法导入`);
        continue;
      }
      const known = new Set([...def.columns.map((c) => c.header), ...Object.values(SPECIAL)]);
      for (const h of hm.keys()) if (!known.has(h)) warn(sheet.name, 1, `不认识的列「${h}」，已忽略`);
      for (const c of def.columns) {
        if (!hm.has(c.header) && c.type !== 'id') warn(sheet.name, 1, `表里没有「${c.header}」列：这一列对应的字段保持不变`);
      }
      const present = def.columns.filter((c) => hm.has(c.header));

      sheet.rows.slice(1).forEach((r, i) => {
        const rowNo = i + 2;
        if (isBlankRow(r)) return;
        const id = cellStr(r[hm.get(idCol.header)]);
        if (!id) { err(sheet.name, rowNo, '这一行没有 id。新加的行必须填 id（小写英文、数字、下划线）'); return; }
        if (seenIds.has(id)) { err(sheet.name, rowNo, `id「${id}」和第 ${seenIds.get(id)} 行重复`); return; }
        seenIds.set(id, rowNo);
        const item = col.byId.get(id);
        const delCell = hm.has(SPECIAL.del) ? cellStr(r[hm.get(SPECIAL.del)]) : '';
        if (delCell && !['否', 'no', 'false', '0'].includes(delCell.toLowerCase())) {
          if (!item) { warn(sheet.name, rowNo, `要删除的「${id}」在 json 里不存在，忽略`); return; }
          pending.set(id, { type: 'delete', item, fields: [], rowNo, sheet: sheet.name });
          return;
        }

        // 逐列解析
        const parsed = new Map();
        let bad = false;
        for (const c of present) {
          if (c.type === 'id') continue;
          const raw = r[hm.get(c.header)];
          if (c.type === 'behaviour') {
            const s = cellStr(raw);
            parsed.set(c, s === '' ? { empty: true } : ['无', 'none', '-', '—'].includes(s.toLowerCase()) ? { none: true } : { value: s });
            continue;
          }
          const p = P.parseCell(c, raw, enums);
          if (p.error) { err(sheet.name, rowNo, `「${c.header}」${p.error}`); bad = true; }
          parsed.set(c, p);
        }
        let otherV;
        if (hm.has(SPECIAL.other)) {
          const s = cellStr(r[hm.get(SPECIAL.other)]);
          if (s) {
            try {
              otherV = JSON.parse(s);
              if (!otherV || typeof otherV !== 'object' || Array.isArray(otherV)) throw new Error('要是一个 {…} 对象');
            } catch (e) { err(sheet.name, rowNo, `「${SPECIAL.other}」不是合法的 JSON 对象：${e.message}`); bad = true; }
          } else otherV = {};
        }
        const fileCell = hm.has(SPECIAL.file) ? cellStr(r[hm.get(SPECIAL.file)]) : '';
        if (bad) return;

        if (!item) {
          // 新增
          if (idCol.pattern && !new RegExp(idCol.pattern).test(id)) {
            err(sheet.name, rowNo, `新 id「${id}」不合规：只能用小写英文开头，后面接小写英文、数字或下划线`);
            return;
          }
          const obj = {};
          obj[def.idField] = id;
          for (const c of def.columns) {
            if (c.type === 'id') continue;
            const p = parsed.get(c);
            if (c.type === 'behaviour') {
              if (p && p.value) obj[c.field] = p.value;
              else if ((!p || p.empty) && def.newBehaviour === 'id') obj[c.field] = id;
              continue;
            }
            if (p && !p.empty) P.setPath(obj, c.field, p.value);
            else if (c.required) { err(sheet.name, rowNo, `新加的「${id}」缺「${c.header}」`); bad = true; } else if (c.default !== undefined) P.setPath(obj, c.field, clone(c.default));
          }
          if (bad) return;
          if (otherV) deepMerge(obj, otherV);
          for (const ch of def.children) if (ch.default !== undefined && obj[ch.field] === undefined) obj[ch.field] = clone(ch.default);
          const rule = P.pickRule(def.newFile, obj, def.key);
          const file = fileCell || (rule ? P.fillTemplate(rule.file, obj) : null);
          if (!file) { err(sheet.name, rowNo, `新加的「${id}」不知道该放进哪个文件，请填「${SPECIAL.file}」列`); return; }
          pending.set(id, { type: 'add', obj, fields: [], file, rowNo, sheet: sheet.name });
          return;
        }

        // 修改：三方合并
        const baseObj = baseOf(id);
        const work = clone(item.obj);
        const fields = [];
        for (const c of present) {
          if (c.type === 'id') continue;
          const p = parsed.get(c);
          let tableV;
          if (c.type === 'behaviour') tableV = p.value !== undefined ? p.value : p.empty && def.newBehaviour === 'id' ? id : ABSENT;
          else tableV = p.empty ? (c.default !== undefined ? c.default : ABSENT) : p.value;
          const res = merge3(c.header, tableV, baseObj ? normField(c, baseObj) : undefined, normField(c, item.obj), id, sheet.name, rowNo);
          if (!res || res.conflict) continue;
          fields.push({ header: c.header, from: normField(c, item.obj), to: res.value, col: c });
          if (res.value === ABSENT) P.deletePath(work, c.field); else P.setPath(work, c.field, clone(res.value));
        }
        if (otherV !== undefined) {
          const childFields = def.children.map((ch) => ch.field);
          const curO = P.otherFields(item.obj, def.columns, childFields);
          const baseO = baseObj ? P.otherFields(baseObj, def.columns, childFields) : undefined;
          const res = merge3(SPECIAL.other, otherV, baseO, curO, id, sheet.name, rowNo);
          if (res && !res.conflict) {
            for (const k of Object.keys(curO)) {
              if (typeof curO[k] === 'object' && curO[k] && !Array.isArray(curO[k]) && work[k] && def.columns.some((c) => c.field.startsWith(k + '.'))) {
                for (const kk of Object.keys(curO[k])) delete work[k][kk];
              } else delete work[k];
            }
            deepMerge(work, res.value);
            fields.push({ header: SPECIAL.other, from: curO, to: res.value });
          }
        }
        let file = null;
        const baseFile = baseFiles.get(`${def.key}\u0000${id}`);
        if (fileCell && fileCell !== item.file && fileCell !== baseFile) {
          // 表里填了和导出时、和现在都不同的文件 = 策划要挪过去
          file = fileCell;
          fields.push({ header: SPECIAL.file, from: item.file, to: fileCell, move: true });
        }
        if (fields.length) pending.set(id, { type: 'update', item, obj: work, fields, file, rowNo, sheet: sheet.name });
        else pending.set(id, { type: 'same', item, obj: work, fields: [], rowNo, sheet: sheet.name });
      });
    }

    // 子表
    for (const { ch, sheet: cs } of childSheets) {
      if (!cs) continue;
      plan.sheetsUsed.push(cs.name);
      const hm = headerMap(cs.rows[0]);
      const parentHeader = `${def.label}id`;
      if (!hm.has(parentHeader)) { err(cs.name, 1, `找不到「${parentHeader}」列，这张表没法导入`); continue; }
      const known = new Set([parentHeader, `${def.label}名`, SPECIAL.seq, SPECIAL.other, ...ch.columns.map((c) => c.header)]);
      for (const h of hm.keys()) if (!known.has(h)) warn(cs.name, 1, `不认识的列「${h}」，已忽略`);
      const groups = new Map();
      cs.rows.slice(1).forEach((r, i) => {
        const rowNo = i + 2;
        if (isBlankRow(r)) return;
        const pid = cellStr(r[hm.get(parentHeader)]);
        if (!pid) { err(cs.name, rowNo, `没填「${parentHeader}」`); return; }
        if (!groups.has(pid)) groups.set(pid, []);
        groups.get(pid).push({ r, rowNo });
      });
      // 主表里出现、但子表里一行都没有的 → 子数组清空（策划把它的效果全删了）
      const parents = new Set(groups.keys());
      for (const [id, pd] of pending) if (pd.type !== 'delete') parents.add(id);

      for (const pid of parents) {
        const pd = pending.get(pid);
        if (pd && pd.type === 'delete') { if (groups.has(pid)) warn(cs.name, groups.get(pid)[0].rowNo, `「${pid}」要被删除，它在「${ch.sheet}」里的行忽略`); continue; }
        const item = col.byId.get(pid);
        if (!item && !(pd && pd.type === 'add')) {
          err(cs.name, groups.get(pid)[0].rowNo, `「${parentHeader}」填的「${pid}」不存在（也不是这次新加的）`);
          continue;
        }
        const rows = (groups.get(pid) || []).slice();
        rows.sort((a, b) => {
          const sa = Number(a.r[hm.get(SPECIAL.seq)]);
          const sb = Number(b.r[hm.get(SPECIAL.seq)]);
          return (Number.isFinite(sa) ? sa : 1e9) - (Number.isFinite(sb) ? sb : 1e9) || a.rowNo - b.rowNo;
        });
        const curArr = item ? (P.getPath(item.obj, ch.field) || []) : [];
        let bad = false;
        const arr = rows.map(({ r, rowNo }, k) => {
          const e = {};
          for (const c of ch.columns) {
            if (!hm.has(c.header)) {
              // 列被删了：沿用原来同位置元素的值
              const old = curArr[k];
              if (old && P.hasPath(old, c.field)) P.setPath(e, c.field, clone(P.getPath(old, c.field)));
              continue;
            }
            const p = P.parseCell(c, r[hm.get(c.header)], enums);
            if (p.error) { err(cs.name, rowNo, `「${c.header}」${p.error}`); bad = true; continue; }
            if (!p.empty) P.setPath(e, c.field, p.value);
            else if (c.required) { err(cs.name, rowNo, `缺「${c.header}」`); bad = true; }
          }
          if (hm.has(SPECIAL.other)) {
            const s = cellStr(r[hm.get(SPECIAL.other)]);
            if (s) {
              try { deepMerge(e, JSON.parse(s)); } catch (ex) { err(cs.name, rowNo, `「${SPECIAL.other}」不是合法的 JSON：${ex.message}`); bad = true; }
            }
          }
          // 沿用原元素的键顺序，避免只是字段换了位置也产生 diff
          const old = curArr[k];
          return old ? P.orderKeys(e, Object.keys(old)) : e;
        });
        if (bad) continue;

        if (pd && pd.type === 'add') { pd.obj[ch.field] = arr; continue; }
        const baseObj = baseOf(pid);
        const res = merge3(ch.sheet, arr, baseObj ? (P.getPath(baseObj, ch.field) || []) : undefined, curArr, pid, cs.name, rows[0]?.rowNo);
        if (!res || res.conflict) continue;
        const target = pd || { type: 'same', item, obj: clone(item.obj), fields: [], sheet: cs.name };
        target.obj[ch.field] = res.value;
        target.fields.push({ header: ch.sheet, from: curArr, to: res.value, child: ch });
        if (target.type === 'same') target.type = 'update';
        pending.set(pid, target);
      }
    }

    // 删除保护：被别的集合引用的不能删
    for (const [id, pd] of pending) {
      if (pd.type !== 'delete') continue;
      const users = referencesTo(store, profile, def, id);
      if (users.length && !options.force) {
        err(pd.sheet, pd.rowNo, `「${id}」还被引用：${users.join('；')}。先把这些引用去掉，或者加 --force 强制删除`);
        pending.delete(id);
      }
    }

    let untouched = 0;
    for (const it of col.items) if (!pending.has(String(it.id))) untouched++;
    plan.untouched[def.label] = untouched;

    for (const [id, pd] of pending) {
      if (pd.type === 'same') continue;
      const obj = pd.obj ? P.orderKeys(pd.obj, def.fieldOrder) : undefined;
      plan.changes.push({ collection: def.key, label: def.label, def, id, type: pd.type, fields: pd.fields, obj, item: pd.item, file: pd.file || null });
    }
  }
  return plan;
}

function walkPath(obj, p, out) {
  // 支持 a.b、a[].b、a[].b[].c
  const parts = p.split('.');
  const step = (cur, i) => {
    if (cur == null) return;
    if (i === parts.length) { out.push(cur); return; }
    const k = parts[i];
    if (k.endsWith('[]')) {
      const arr = cur[k.slice(0, -2)];
      if (Array.isArray(arr)) arr.forEach((x) => step(x, i + 1));
    } else step(cur[k], i + 1);
  };
  step(obj, 0);
}

function referencesTo(store, profile, def, id) {
  const users = [];
  for (const ref of def.references || []) {
    const col = store.collections[ref.collection];
    if (!col) continue;
    for (const it of col.items) {
      for (const p of ref.paths) {
        const vals = [];
        walkPath(it.obj, p, vals);
        if (vals.includes(id)) { users.push(`${col.def.label}「${it.obj[col.def.nameField] || it.id}」`); break; }
      }
    }
  }
  return users;
}

module.exports = { exportWorkbook, planImport, deepEqual, ABSENT, SPECIAL, META_SHEET };
