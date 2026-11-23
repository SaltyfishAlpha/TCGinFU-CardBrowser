'use strict';
// 把导入计划落到内容包上：改 json、生成 / 更新 / 移除 Lua 占位，并写出给 agent 的任务单。
// 预览（不加 --apply）也走同一套逻辑，只是最后不写盘，所以预览里看到的就是实际会发生的。

const P = require('./profile');
const { ABSENT, deepEqual } = require('./sheet');

function fmtValue(field, value, enums) {
  if (value === ABSENT || value === undefined) return '（空）';
  if (field && field.child) {
    if (!Array.isArray(value) || !value.length) return '（无）';
    return value.map((e, i) => `${i + 1}. ${childLine(field.child, e, enums)}`).join('；');
  }
  if (field && field.col) {
    const s = P.formatCell(field.col, value, enums);
    return s === null || s === '' ? '（空）' : String(s);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function childLine(ch, e, enums) {
  const parts = ch.columns.map((c) => P.formatCell(c, P.getPath(e, c.field), enums)).filter((v) => v !== null && v !== '');
  const other = P.otherFields(e, ch.columns);
  if (Object.keys(other).length) parts.push(JSON.stringify(other));
  return parts.join(' · ');
}

function stubLines(profile, def, obj) {
  const lua = profile.lua;
  const text = String(obj[def.textField] || '').replace(/\r?\n/g, ' ');
  const vars = { ...obj, id: obj[def.behaviourField], name: obj[def.nameField] || obj[def.idField], text };
  return lua.stub.map((l) => P.fillTemplate(l, vars));
}

function stubFileFor(profile, def, obj) {
  const rule = P.pickRule(profile.lua.stubFile, obj, def.key);
  return rule ? P.fillTemplate(rule.file, obj) : null;
}

/**
 * 在 store 上执行计划（内存里），返回 { actions, tasks, writes }。
 * 调用方决定要不要 store.commit()。
 */
function applyPlan(store, profile, plan) {
  const enums = P.resolveEnums(profile, store.collections);
  const index = store.behaviourIndex();
  const actions = []; // 给人看的「做了什么」
  const tasks = { implement: [], textChanged: [], dataChanged: [], removeLua: [], dataOnly: [], reused: [] };
  const stubsPlanned = new Set();
  const usersOf = (bid, exceptId) => {
    const out = [];
    for (const def of profile.collections.filter((d) => d.behaviourField)) {
      for (const it of store.collections[def.key].items) if (it.obj[def.behaviourField] === bid && !(it.id === exceptId)) out.push(it.id);
    }
    return out;
  };

  const ensureStub = (def, obj, reason) => {
    const bid = obj[def.behaviourField];
    if (!bid || index.blocks.has(bid) || stubsPlanned.has(bid)) return null;
    if (index.stubs.has(bid)) return index.stubs.get(bid);
    const file = stubFileFor(profile, def, obj);
    if (!file) return null;
    const header = (profile.lua.newFileHeader || []).map((l) => P.fillTemplate(l, { fileTitle: file }));
    store.appendLua(file, stubLines(profile, def, obj), header);
    stubsPlanned.add(bid);
    actions.push(`Lua 占位：在 ${file} 末尾为「${obj[def.nameField]}」生成 ${bid} 的待实现占位（${reason}）`);
    return { id: bid, file, created: true };
  };

  for (const ch of plan.changes) {
    const def = ch.def;
    const name = (ch.obj && ch.obj[def.nameField]) || (ch.item && ch.item.obj[def.nameField]) || ch.id;
    const tag = `${def.label}「${name}」(${ch.id})`;

    if (ch.type === 'add') {
      store.addItem(def, ch.file, ch.obj);
      actions.push(`新增 ${tag} → ${ch.file}`);
      if (def.behaviourField) {
        const bid = ch.obj[def.behaviourField];
        if (!bid) tasks.dataOnly.push({ def, obj: ch.obj });
        else if (index.blocks.has(bid)) tasks.reused.push({ def, obj: ch.obj, block: index.blocks.get(bid) });
        else {
          const stub = ensureStub(def, ch.obj, '新卡');
          tasks.implement.push({ def, obj: ch.obj, stub, isNew: true });
        }
      }
      continue;
    }

    if (ch.type === 'delete') {
      store.removeItem(def, ch.item);
      actions.push(`删除 ${tag}（${ch.item.file}）`);
      const bid = def.behaviourField && ch.item.obj[def.behaviourField];
      if (bid && usersOf(bid, ch.item.id).length === 0) {
        if (index.stubs.has(bid)) {
          store.replaceStub(index.stubs.get(bid), null);
          actions.push(`Lua 占位：移除 ${bid} 的待实现占位（${index.stubs.get(bid).file}）`);
        } else if (index.blocks.has(bid)) {
          tasks.removeLua.push({ def, obj: ch.item.obj, block: index.blocks.get(bid) });
        }
      }
      continue;
    }

    // update
    const before = ch.item.obj;
    const after = ch.obj;
    if (ch.file && ch.file !== ch.item.file) {
      store.removeItem(def, ch.item);
      store.addItem(def, ch.file, after);
      actions.push(`修改 ${tag}，并从 ${ch.item.file} 挪到 ${ch.file}：${ch.fields.filter((f) => !f.move).map((f) => f.header).join('、') || '只挪文件'}`);
    } else {
      store.replaceItem(def, ch.item, after);
      actions.push(`修改 ${tag}：${ch.fields.map((f) => f.header).join('、')}`);
    }
    if (!def.behaviourField) continue;
    const oldB = before[def.behaviourField];
    const newB = after[def.behaviourField];
    const textChanged = def.textField && before[def.textField] !== after[def.textField];
    if (newB && newB !== oldB) {
      if (index.blocks.has(newB)) tasks.reused.push({ def, obj: after, block: index.blocks.get(newB) });
      else tasks.implement.push({ def, obj: after, stub: ensureStub(def, after, 'Lua 行为名改了'), isNew: false });
    } else if (newB && index.stubs.has(newB)) {
      // 还是占位：卡面变了就顺手把占位里的原文换成新的（占位是工具生成的，改它是安全的）
      if (textChanged) {
        store.replaceStub(index.stubs.get(newB), stubLines(profile, def, after));
        actions.push(`Lua 占位：${newB} 占位里的卡面原文已更新为新文字`);
      }
    } else if (newB && index.blocks.has(newB)) {
      const block = index.blocks.get(newB);
      const dataFields = ch.fields.filter((f) => (f.col && f.col.field !== def.textField && f.col.type !== 'behaviour') || f.child);
      // 卡面和数据一起改的，合成一条任务；只改了数据的，单列一条
      if (textChanged) tasks.textChanged.push({ def, before, after, block, fields: dataFields });
      else if (dataFields.length) tasks.dataChanged.push({ def, after, block, fields: dataFields });
    } else if (newB && !index.blocks.has(newB)) {
      tasks.implement.push({ def, obj: after, stub: ensureStub(def, after, '原本就缺 Lua'), isNew: false });
    }
    if (oldB && oldB !== newB && usersOf(oldB, ch.item.id).length === 0 && index.blocks.has(oldB)) {
      tasks.removeLua.push({ def, obj: before, block: index.blocks.get(oldB) });
    }
  }

  store.reparseLua();
  return { actions, tasks, writes: store.pendingWrites(), enums };
}

// ───────── 报告 ─────────

function planMarkdown(plan, result, { applied, source, enums: givenEnums }) {
  const enums = result ? result.enums : givenEnums;
  const out = [];
  const count = (t) => plan.changes.filter((c) => c.type === t).length;
  out.push(`# 卡牌表导入${applied ? '记录' : '预览'}`);
  out.push('');
  out.push(`- 表格：${source}`);
  if (plan.exportedAt) out.push(`- 表格导出于：${new Date(plan.exportedAt).toLocaleString('zh-CN')}`);
  out.push(`- 新增 ${count('add')} · 修改 ${count('update')} · 删除 ${count('delete')} · 冲突 ${plan.conflicts.length} · 错误 ${plan.errors.length}`);
  out.push(`- 未改动：${Object.entries(plan.untouched).map(([k, n]) => `${k} ${n}`).join('，')}`);
  out.push('');
  if (plan.errors.length) {
    out.push('## ✕ 错误（必须先改好表格，否则不会写入）');
    out.push('');
    for (const e of plan.errors) out.push(`- ${e.sheet ? `「${e.sheet}」` : ''}${e.row ? `第 ${e.row} 行` : ''}：${e.message}`);
    out.push('');
  }
  if (plan.conflicts.length) {
    out.push('## ⚠ 冲突（这些格子没有写入）');
    out.push('');
    out.push('导出之后，json 里的同一个值也被改过了。确认用表里的值的话，加 `--force` 重新导入；否则重新导出一份最新的表再改。');
    out.push('');
    out.push('| 项 | 列 | 导出时 | json 现在 | 表里 |');
    out.push('|---|---|---|---|---|');
    for (const c of plan.conflicts) out.push(`| ${c.collection}「${c.id}」 | ${c.header} | ${cell(c.base)} | ${cell(c.current)} | ${cell(c.table)} |`);
    out.push('');
  }
  if (plan.warnings.length) {
    out.push('## 提示');
    out.push('');
    for (const w of plan.warnings) out.push(`- ${w.sheet ? `「${w.sheet}」` : ''}${w.row ? `第 ${w.row} 行` : ''}：${w.message}`);
    out.push('');
  }
  if (plan.changes.length) {
    out.push('## 改动明细');
    out.push('');
    for (const c of plan.changes) {
      const name = (c.obj && c.obj[c.def.nameField]) || (c.item && c.item.obj[c.def.nameField]) || c.id;
      if (c.type === 'add') {
        out.push(`### ＋ 新增${c.label}「${name}」\`${c.id}\` → ${c.file}`);
        out.push('');
        for (const col of c.def.columns) {
          const v = P.getPath(c.obj, col.field);
          if (v !== undefined && col.type !== 'id') out.push(`- ${col.header}：${fmtValue({ col }, v, enums)}`);
        }
        for (const chd of c.def.children) out.push(`- ${chd.sheet}：${fmtValue({ child: chd }, c.obj[chd.field], enums)}`);
      } else if (c.type === 'delete') {
        out.push(`### − 删除${c.label}「${name}」\`${c.id}\`（${c.item.file}）`);
      } else {
        out.push(`### ✎ 修改${c.label}「${name}」\`${c.id}\``);
        out.push('');
        for (const f of c.fields) {
          if (f.move) out.push(`- 文件：${f.from} → ${f.to}`);
          else out.push(`- ${f.header}：${fmtValue(f, f.from, enums)} → **${fmtValue(f, f.to, enums)}**`);
        }
      }
      out.push('');
    }
  }
  if (result && result.actions.length) {
    out.push(`## ${applied ? '已执行' : '将执行'}`);
    out.push('');
    for (const a of result.actions) out.push(`- ${a}`);
    out.push('');
    out.push(`涉及文件：${result.writes.map((w) => w.rel + (w.created ? '（新建）' : '')).join('、') || '无'}`);
    out.push('');
  }
  if (!plan.changes.length && !plan.errors.length && !plan.conflicts.length) out.push('表格和 json 一致，没有需要写入的改动。');
  return out.join('\n');
}

function cell(v) {
  if (v === ABSENT || v === undefined) return '（空）';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
}

function tasksMarkdown(profile, result, store, { source }) {
  const t = result.tasks;
  const enums = result.enums;
  const out = [];
  const index = store.behaviourIndex();
  out.push('# Agent 任务单：卡牌 Lua 实现');
  out.push('');
  out.push(`生成于 ${new Date().toLocaleString('zh-CN')}，来源：${source}`);
  out.push('');
  for (const l of profile.tasks?.intro || []) out.push(`> ${l}`);
  out.push('');
  const total = t.implement.length + t.textChanged.length + t.dataChanged.length + t.removeLua.length + t.reused.length;
  if (!total) out.push('这次导入没有需要改 Lua 的地方。');

  const head = (def, obj) => `**${obj[def.nameField]}** \`${obj[def.idField]}\``;
  if (t.implement.length) {
    out.push(`## 1. 实现新行为（${t.implement.length}）`);
    out.push('');
    for (const x of t.implement) {
      const bid = x.obj[x.def.behaviourField];
      const stub = index.stubs.get(bid);
      const where = stub ? `占位在 \`${stub.file}:${stub.startLine}\`` : '还没有占位（Lua 文件规则没匹配上，请自己选文件）';
      out.push(`- [ ] ${head(x.def, x.obj)} → 行为 \`${bid}\`，${where}`);
      out.push(`  - 卡面：${x.obj[x.def.textField]}`);
      const data = x.def.children.map((ch) => (x.obj[ch.field] || []).length ? `${ch.sheet}：${fmtValue({ child: ch }, x.obj[ch.field], enums)}` : null).filter(Boolean);
      if (data.length) out.push(`  - 已有数据效果（引擎会先执行，Lua 只补剩下的部分）：${data.join('；')}`);
      else out.push('  - 没有数据效果，卡面上的效果全部要在 Lua 里实现（或者让策划补数据效果）');
      out.push('  - 写一条验收测试，按卡面断言结果');
    }
    out.push('');
  }
  if (t.textChanged.length) {
    out.push(`## 2. 卡面改了，核对 / 修改已有 Lua（${t.textChanged.length}）`);
    out.push('');
    for (const x of t.textChanged) {
      out.push(`- [ ] ${head(x.def, x.after)} → \`${x.block.file}:${x.block.line}\`（钩子：${x.block.hooks.map((h) => h.name).join(', ') || '无'}）`);
      out.push(`  - 原卡面：${x.before[x.def.textField]}`);
      out.push(`  - 新卡面：**${x.after[x.def.textField]}**`);
      for (const f of x.fields || []) out.push(`  - 同时改了 ${f.header}：${fmtValue(f, f.from, enums)} → ${fmtValue(f, f.to, enums)}`);
      out.push('  - 改完把 Lua 注释里抄的卡面原文也换成新文字，并更新 / 补充对应测试');
    }
    out.push('');
  }
  if (t.dataChanged.length) {
    out.push(`## 3. 数值或数据效果改了，确认 Lua 不冲突（${t.dataChanged.length}）`);
    out.push('');
    for (const x of t.dataChanged) {
      out.push(`- [ ] ${head(x.def, x.after)} → \`${x.block.file}:${x.block.line}\``);
      for (const f of x.fields) out.push(`  - ${f.header}：${fmtValue(f, f.from, enums)} → ${fmtValue(f, f.to, enums)}`);
      out.push('  - Lua 里如果写死了这些数（或者和数据效果重复结算），要一起改');
    }
    out.push('');
  }
  if (t.reused.length) {
    out.push(`## 4. 复用了已有行为，确认是否适用（${t.reused.length}）`);
    out.push('');
    for (const x of t.reused) {
      const users = [];
      for (const def of profile.collections.filter((d) => d.behaviourField)) {
        for (const it of store.collections[def.key].items) {
          if (it.obj[def.behaviourField] === x.block.id && it.id !== x.obj[x.def.idField]) users.push(it.obj[def.nameField] || it.id);
        }
      }
      out.push(`- [ ] ${head(x.def, x.obj)} 用的是已有行为 \`${x.block.id}\`（\`${x.block.file}:${x.block.line}\`，同时被 ${users.join('、') || '没有别的项'} 使用）`);
      out.push(`  - 卡面：${x.obj[x.def.textField]}`);
    }
    out.push('');
  }
  if (t.removeLua.length) {
    out.push(`## 5. 行为已经没人用了，确认后删除（${t.removeLua.length}）`);
    out.push('');
    for (const x of t.removeLua) out.push(`- [ ] \`${x.block.id}\`（\`${x.block.file}:${x.block.line}\`，原属 ${x.obj[x.def.nameField]}）；对应的测试也一起删`);
    out.push('');
  }
  if (t.dataOnly.length) {
    out.push(`## 附：只靠数据效果的新卡（${t.dataOnly.length}，不需要 Lua，列出来方便核对）`);
    out.push('');
    for (const x of t.dataOnly) out.push(`- ${head(x.def, x.obj)}：${x.obj[x.def.textField]}`);
    out.push('');
  }
  // 其它仍在待实现的占位（之前导入留下的）
  const pending = [...index.stubs.values()].filter((s) => !t.implement.some((x) => x.obj[x.def.behaviourField] === s.id));
  if (pending.length) {
    out.push(`## 附：之前留下、仍待实现的占位（${pending.length}）`);
    out.push('');
    for (const s of pending) out.push(`- [ ] \`${s.id}\`「${s.title || ''}」 → \`${s.file}:${s.startLine}\``);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { applyPlan, planMarkdown, tasksMarkdown, fmtValue };
