'use strict';
// 把模型输出成三种东西：
//   index.html  —— 单文件网页，数据内嵌，双击就能开，也能直接发给别人
//   cards.md    —— 卡牌目录，能贴进 Assets/docs/ 或任何文档工具
//   cards.csv   —— 用 Excel 打开的总表（带 BOM，中文不乱码）
//   report.md   —— 检查报告

const fs = require('fs');
const path = require('path');
const L = require('./labels');

const WEB = path.join(__dirname, 'web');

function safeJson(obj) {
  // 内嵌在 <script> 里：不能出现 </script>，也要处理 JS 里的行分隔符
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

function renderHtml(model) {
  const labels = {
    category: L.category, kind: L.kind, color: L.color, element: L.element, shieldKind: L.shieldKind,
    target: L.target, row: L.row, rank: L.rank, affinity: L.affinity, targeting: L.targeting, hook: L.hook,
  };
  const tpl = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');
  const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  // 用函数做替换，避免 $& 之类被当成替换模式
  return tpl
    .replace('/*__CSS__*/', () => css)
    .replace('/*__DATA__*/', () => safeJson({ ...model, labels }))
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
}

function charName(model, id) {
  return (model.characters.find((c) => c.id === id) || {}).name || id || '（无）';
}

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const SEV = { error: '错误', warn: '警告', info: '提示' };

function cardIssues(model, c) {
  const ns = [...(model.issueIndex[`card:${c.id}`] || []), ...(c.behaviourId ? model.issueIndex[`behaviour:${c.behaviourId}`] || [] : [])];
  return ns.map((n) => model.issues[n - 1]);
}

function renderMarkdown(model) {
  const out = [];
  out.push(`# 卡牌目录 · ${model.pack.name || model.pack.id}`);
  out.push('');
  out.push(`> 由 tcginfu-card-browser 从内容包自动生成，**不要手改**——改卡请改 json / lua，然后重新生成。`);
  out.push(`> 生成时间：${new Date(model.generatedAt).toLocaleString('zh-CN')}　共 ${model.cards.length} 张卡`);
  out.push('');

  const owners = [...new Set(model.cards.map((c) => c.owner))];
  out.push('## 目录');
  for (const o of owners) out.push(`- [${charName(model, o)}](#${encodeURIComponent(charName(model, o))})`);
  out.push('');

  for (const o of owners) {
    out.push(`## ${charName(model, o)}`);
    out.push('');
    const cs = model.cards.filter((c) => c.owner === o);
    const classes = [...new Set(cs.map((c) => c.classId || '（无职业）'))];
    for (const cl of classes) {
      out.push(`### ${cl}`);
      out.push('');
      out.push('| 卡名 | 类别 | 种类 | 颜色 | AP | MP | 暴击 | 卡面文字 |');
      out.push('|---|---|---|---|--:|--:|:-:|---|');
      for (const c of cs.filter((x) => (x.classId || '（无职业）') === cl)) {
        out.push(`| **${mdEscape(c.name)}** | ${L.t(L.category, c.category)} | ${L.t(L.kind, c.kind)} | ${c.colors.map((x) => L.t(L.color, x)).join('+') || '无色'} | ${c.ap} | ${c.mp} | ${c.hasCrit ? '✓' : ''} | ${mdEscape(c.rulesText)} |`);
      }
      out.push('');
      for (const c of cs.filter((x) => (x.classId || '（无职业）') === cl)) {
        out.push(`#### ${c.name} \`${c.id}\``);
        out.push('');
        out.push(c.rulesText);
        out.push('');
        const lines = [];
        if (c.effectTexts.length) lines.push(`- 数据效果：${c.effectTexts.join('；')}`);
        if (c.hooks.length) lines.push(`- Lua 钩子：${c.hooks.map((h) => `\`${h}\`（${L.t(L.hook, h)}）`).join('、')}`);
        else if (c.behaviourId) lines.push(`- Lua 行为：**缺失**（指向 \`${c.behaviourId}\`）`);
        if (c.decks.length) lines.push(`- 卡组：${c.decks.map((d) => `${d.deckName} · ${d.section} ×${d.count}`).join('；')}`);
        for (const x of cardIssues(model, c)) if (x.severity !== 'info') lines.push(`- ⚠ ${SEV[x.severity]}：${x.message}`);
        if (lines.length) { out.push(...lines); out.push(''); }
      }
    }
  }
  return out.join('\n');
}

function renderReportMd(model) {
  const out = [];
  const n = (s) => model.issues.filter((x) => x.severity === s).length;
  out.push(`# 内容包检查报告 · ${model.pack.name || model.pack.id}`);
  out.push('');
  out.push(`生成时间：${new Date(model.generatedAt).toLocaleString('zh-CN')}　错误 ${n('error')} · 警告 ${n('warn')} · 提示 ${n('info')}`);
  out.push('');
  for (const sev of ['error', 'warn', 'info']) {
    const list = model.issues.filter((x) => x.severity === sev);
    if (!list.length) continue;
    out.push(`## ${SEV[sev]}（${list.length}）`);
    out.push('');
    for (const x of list) {
      out.push(`- \`${x.code}\` ${x.message}`);
      if (x.detail && x.detail.quote) {
        out.push(`  - Lua 注释：${x.detail.quote}`);
        out.push(`  - 当前文字：${x.detail.current}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCsv(model) {
  const head = ['id', '卡名', '角色', '职业', '类别', '种类', '颜色', 'AP', 'MP', '充能', '暴击', '卡面文字', '数据效果', 'Lua钩子', '卡组张数', '问题数', '文件'];
  const rows = model.cards.map((c) => [
    c.id, c.name, charName(model, c.owner), c.classId, L.t(L.category, c.category), L.t(L.kind, c.kind),
    c.colors.map((x) => L.t(L.color, x)).join('+'), c.ap, c.mp, c.charge, c.hasCrit ? '是' : '',
    c.rulesText, c.effectTexts.join('；'), c.hooks.join(' '),
    c.decks.reduce((a, d) => a + d.count, 0),
    cardIssues(model, c).filter((x) => x.severity !== 'info').length, c.file,
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { renderHtml, renderMarkdown, renderReportMd, renderCsv };
