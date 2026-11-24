/* TCGinFU 卡牌浏览器 —— 页面逻辑。数据由 build.js 内嵌在 #data 里，页面本身只读不写。 */
(function () {
  'use strict';

  const D = JSON.parse(document.getElementById('data').textContent);
  const L = D.labels;

  // ───────────── 小工具 ─────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lab = (map, v) => (v == null || v === '' ? '' : (map && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : String(v)));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tcgcards.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tcgcards.' + k, JSON.stringify(v)); } catch { /* 隐私模式之类，忽略 */ } },
  };
  const $ = (sel) => document.querySelector(sel);

  const cardById = new Map(D.cards.map((c) => [c.id, c]));
  const behaviourById = new Map(D.behaviours.map((b) => [b.id, b]));
  const statusById = new Map(D.statuses.map((s) => [s.id, s]));
  const statusByName = new Map(D.statuses.map((s) => [s.name, s]));
  const charById = new Map(D.characters.map((c) => [c.id, c]));
  const intentById = new Map();
  for (const e of D.enemies) for (const i of e.intents || []) intentById.set(i.id, { ...i, enemy: e });
  const issueByN = new Map(D.issues.map((x) => [x.n, x]));
  const issuesOf = (type, id) => (D.issueIndex[`${type}:${id}`] || []).map((n) => issueByN.get(n));
  const ownerName = (id) => charById.get(id)?.name || id || '（无）';

  // 状态被谁用到：Lua 里 apply_status 之类 + 卡面上写了【状态名】
  const statusUsers = new Map();
  const addStatusUser = (sid, u) => {
    if (!statusUsers.has(sid)) statusUsers.set(sid, new Map());
    statusUsers.get(sid).set(`${u.type}:${u.id}`, u);
  };
  for (const b of D.behaviours) {
    for (const r of b.statusRefs) {
      for (const u of b.users) addStatusUser(r.id, { ...u, via: r.fn });
      if (!b.users.length) addStatusUser(r.id, { type: 'behaviour', id: b.id, name: b.id, via: r.fn });
    }
  }
  for (const c of D.cards) {
    for (const m of c.rulesText.matchAll(/【([^】]+)】/g)) {
      const s = statusByName.get(m[1]);
      if (s) addStatusUser(s.id, { type: 'card', id: c.id, name: c.name, via: '卡面' });
    }
  }

  const COLOR_VAR = { Might: '--c-might', Dexterity: '--c-dexterity', Insight: '--c-insight', Willpower: '--c-willpower' };
  const colorVar = (c) => `var(${COLOR_VAR[c] || '--c-none'})`;

  // ───────────── 文本渲染 ─────────────
  function highlight(htmlStr, q) {
    if (!q) return htmlStr;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return htmlStr.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, (m) => `<mark>${m}</mark>`))).join('');
  }

  function rulesHtml(text, q) {
    let h = esc(text).replace(/【([^】]+)】/g, (all, name) => {
      const s = statusByName.get(name);
      return s
        ? `<span class="kw status" title="${esc(`状态 · ${s.rulesText}`)}">【${name}】</span>`
        : `<span class="kw">【${name}】</span>`;
    });
    h = h.replace(/\bB_(atk|def)\b/g, (m) => `<span class="kw" title="${m === 'B_atk' ? '形态基础攻击' : '形态基础防御'}">${m}</span>`);
    return highlight(h, q);
  }

  const LUA_RE = /(--.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(local|function|end|if|then|else|elseif|for|in|do|while|return|and|or|not|nil|true|false|repeat|until|break)\b|\b(\d+(?:\.\d+)?)\b/g;
  function luaHtml(code, firstLine) {
    return code.split('\n').map((line, i) => {
      let out = '';
      let last = 0;
      line.replace(LUA_RE, (m, c, s, k, n, idx) => {
        out += esc(line.slice(last, idx));
        const cls = c ? 'tok-c' : s ? 'tok-s' : k ? 'tok-k' : 'tok-n';
        out += `<span class="${cls}">${esc(m)}</span>`;
        last = idx + m.length;
        return m;
      });
      out += esc(line.slice(last));
      return `<span class="ln">${firstLine + i}</span>${out}`;
    }).join('\n');
  }

  function stripe(colors) {
    const list = colors.length ? colors : [''];
    return `<span class="stripe">${list.map((c) => `<i style="background:${colorVar(c)}"></i>`).join('')}</span>`;
  }

  function issueTags(list) {
    const e = list.filter((x) => x.severity === 'error').length;
    const w = list.filter((x) => x.severity === 'warn').length;
    return (e ? `<span class="tag err">✕ ${e}</span>` : '') + (w ? `<span class="tag warn">! ${w}</span>` : '');
  }

  function kindText(c) {
    const parts = [];
    if (c.role && c.role !== 'Normal') parts.push(lab(L.role, c.role));
    if (c.play) parts.push(lab(L.play, c.play));
    if (c.hero) parts.push('英雄技能');
    return parts.join(' · ');
  }

  const entityLink = (type, id, text) => `<button class="entity-link" data-open="${esc(type)}:${esc(id)}">${esc(text || id)}</button>`;

  // ───────────── 状态 ─────────────
  const S = {
    tab: 'cards',
    q: '',
    view: store.get('view', 'grid'),
    groupBy: store.get('groupBy', 'owner'),
    filters: { owner: new Set(), category: new Set(), role: new Set(), play: new Set(), classId: new Set(), color: new Set(), ap: new Set(), problem: new Set() },
    sort: { key: null, asc: true },
    drawer: null, // "card:id"
  };

  const FILTER_DEFS = [
    { key: 'owner', label: '角色', get: (c) => [c.owner], name: ownerName },
    { key: 'classId', label: '职业', get: (c) => [c.classId], name: (v) => v || '（无）' },
    { key: 'category', label: '类别', get: (c) => [c.category], name: (v) => lab(L.category, v) },
    { key: 'role', label: '标记', get: (c) => [c.role], name: (v) => lab(L.role, v) },
    { key: 'play', label: '打法', get: (c) => [c.play || ''], name: (v) => (v ? lab(L.play, v) : '无（升变牌）') },
    { key: 'color', label: '颜色', get: (c) => (c.colors.length ? c.colors : ['']), name: (v) => (v ? lab(L.color, v) : '无色') },
    { key: 'ap', label: 'AP', get: (c) => [String(c.ap)], name: (v) => `${v} AP` },
    {
      key: 'problem', label: '状况', name: (v) => ({ error: '有错误', warn: '有警告', pending: 'Lua 待实现', nolua: '没有 Lua 行为', lua: '有 Lua 行为', crit: '带暴击' }[v]),
      get: (c) => {
        const iss = issuesOf('card', c.id).concat(c.behaviourId ? issuesOf('behaviour', c.behaviourId) : []);
        const out = [];
        if (iss.some((x) => x.severity === 'error')) out.push('error');
        if (iss.some((x) => x.severity === 'warn')) out.push('warn');
        out.push(c.hooks.length ? 'lua' : c.luaPending ? 'pending' : 'nolua');
        if (c.hasCrit) out.push('crit');
        return out;
      },
    },
  ];

  function cardIssues(c) {
    return issuesOf('card', c.id).concat(c.behaviourId ? issuesOf('behaviour', c.behaviourId) : []);
  }

  function matchesQuery(c, q) {
    if (!q) return true;
    const hay = [c.name, c.id, c.rulesText, c.classId, ownerName(c.owner), kindText(c), lab(L.category, c.category), ...c.effectTexts, ...c.hooks].join('\n').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function filteredCards(skipKey) {
    return D.cards.filter((c) => {
      if (!matchesQuery(c, S.q)) return false;
      for (const f of FILTER_DEFS) {
        if (f.key === skipKey) continue;
        const sel = S.filters[f.key];
        if (sel.size && !f.get(c).some((v) => sel.has(v))) return false;
      }
      return true;
    });
  }

  // ───────────── 卡牌页 ─────────────
  function renderFilters() {
    const rows = FILTER_DEFS.map((f) => {
      const base = filteredCards(f.key);
      const counts = new Map();
      for (const c of D.cards) for (const v of f.get(c)) if (!counts.has(v)) counts.set(v, 0);
      for (const c of base) for (const v of f.get(c)) counts.set(v, (counts.get(v) || 0) + 1);
      const order = f.key === 'ap' ? [...counts.keys()].sort((a, b) => a - b) : [...counts.keys()];
      const chips = order.map((v) => {
        const on = S.filters[f.key].has(v);
        return `<button class="chip${on ? ' on' : ''}" data-filter="${f.key}" data-value="${esc(v)}">${esc(f.name(v))}<span class="n">${counts.get(v)}</span></button>`;
      }).join('');
      return `<div class="frow"><span class="flabel">${f.label}</span>${chips}</div>`;
    }).join('');
    return `<div class="filters">${rows}</div>`;
  }

  function tileHtml(c) {
    const iss = cardIssues(c);
    const costs = [`<span class="ap">${c.ap} AP</span>`];
    if (c.mp) costs.push(`<span>${c.mp} MP</span>`);
    if (c.charge) costs.push(`<span>充能 ${c.charge}</span>`);
    const meta = [ownerName(c.owner), c.classId, lab(L.category, c.category), kindText(c)].filter(Boolean);
    return `<button class="tile" data-open="card:${esc(c.id)}">
      ${stripe(c.colors)}
      <div class="tile-head"><div class="tile-name">${highlight(esc(c.name), S.q)}</div><div class="cost">${costs.join('')}</div></div>
      <div class="meta">${meta.map(esc).join('<span>·</span>')}</div>
      <div class="tile-text">${rulesHtml(c.rulesText, S.q)}</div>
      <div class="tile-foot">
        ${c.hasCrit ? '<span class="tag crit">暴击</span>' : ''}
        ${c.hooks.length ? `<span class="tag lua" title="${esc(c.hooks.join(', '))}">Lua · ${c.hooks.length} 个钩子</span>` : c.luaPending ? '<span class="tag warn">Lua 待实现</span>' : '<span class="tag nolua">无 Lua</span>'}
        ${c.decks.length ? `<span class="tag">卡组 ×${c.decks.reduce((a, d) => a + d.count, 0)}</span>` : ''}
        ${issueTags(iss)}
      </div>
    </button>`;
  }

  const GROUPS = {
    none: { label: '不分组', key: () => '', name: () => '' },
    owner: { label: '按角色', key: (c) => c.owner || '', name: ownerName },
    classId: { label: '按职业', key: (c) => c.classId || '', name: (v) => v || '（无职业）' },
    category: { label: '按类别', key: (c) => c.category || '', name: (v) => lab(L.category, v) },
    role: { label: '按标记', key: (c) => c.role || 'Normal', name: (v) => lab(L.role, v) },
    play: { label: '按打法', key: (c) => c.play || '', name: (v) => (v ? lab(L.play, v) : '无打法（升变牌）') },
  };

  const COLUMNS = [
    { key: 'name', label: '名称', val: (c) => c.name, html: (c) => `<b>${highlight(esc(c.name), S.q)}</b><div class="mono" style="color:var(--muted)">${esc(c.id)}</div>` },
    { key: 'owner', label: '角色', val: (c) => ownerName(c.owner), cls: 'nowrap' },
    { key: 'classId', label: '职业', val: (c) => c.classId, cls: 'nowrap' },
    { key: 'category', label: '类别', val: (c) => lab(L.category, c.category), cls: 'nowrap' },
    { key: 'role', label: '标记', val: (c) => (c.role === 'Normal' ? '' : lab(L.role, c.role)), cls: 'nowrap' },
    { key: 'play', label: '打法', val: (c) => lab(L.play, c.play), cls: 'nowrap' },
    { key: 'colors', label: '颜色', val: (c) => c.colors.map((x) => lab(L.color, x)).join('+'), cls: 'nowrap' },
    { key: 'ap', label: 'AP', val: (c) => c.ap, cls: 'num' },
    { key: 'mp', label: 'MP', val: (c) => c.mp, cls: 'num' },
    { key: 'crit', label: '暴击', val: (c) => (c.hasCrit ? '是' : ''), cls: 'nowrap' },
    { key: 'text', label: '卡面文字', val: (c) => c.rulesText, html: (c) => rulesHtml(c.rulesText, S.q), cls: 'text' },
    { key: 'effects', label: '数据效果', val: (c) => c.effectTexts.join('；'), html: (c) => c.effectTexts.map(esc).join('<br>') },
    { key: 'hooks', label: 'Lua 钩子', val: (c) => c.hooks.join(', '), html: (c) => c.hooks.map((h) => `<code>${esc(h)}</code>`).join('<br>') },
    { key: 'deck', label: '卡组张数', val: (c) => c.decks.reduce((a, d) => a + d.count, 0), cls: 'num' },
    { key: 'issues', label: '问题', val: (c) => cardIssues(c).filter((x) => x.severity !== 'info').length, html: (c) => issueTags(cardIssues(c)) },
  ];

  function renderCards() {
    const list = filteredCards();
    const anyFilter = S.q || FILTER_DEFS.some((f) => S.filters[f.key].size);
    let body;
    if (!list.length) body = '<div class="empty">没有符合条件的卡。</div>';
    else if (S.view === 'table') {
      let rows = list.slice();
      if (S.sort.key) {
        const col = COLUMNS.find((x) => x.key === S.sort.key);
        rows.sort((a, b) => {
          const x = col.val(a); const y = col.val(b);
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh');
          return S.sort.asc ? r : -r;
        });
      }
      body = `<div class="table-wrap"><table class="data"><thead><tr>${COLUMNS.map((col) => `<th data-sort="${col.key}" class="${S.sort.key === col.key ? 'sorted' + (S.sort.asc ? ' asc' : '') : ''}">${col.label}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((c) => `<tr class="click" data-open="card:${esc(c.id)}">${COLUMNS.map((col) => `<td class="${col.cls || ''}">${col.html ? col.html(c) : esc(col.val(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else {
      const g = GROUPS[S.groupBy] || GROUPS.none;
      const groups = new Map();
      for (const c of list) {
        const k = g.key(c);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      body = [...groups].map(([k, cs]) => `${S.groupBy !== 'none' ? `<div class="group-title">${esc(g.name(k))}<span class="n">${cs.length} 张</span></div>` : ''}<div class="grid">${cs.map(tileHtml).join('')}</div>`).join('');
    }
    return `
      <div class="toolbar">
        <input class="search" id="q" type="search" placeholder="搜索卡名 / id / 卡面文字 / 钩子…" value="${esc(S.q)}">
        <div class="seg"><button data-view="grid" class="${S.view === 'grid' ? 'on' : ''}">卡片</button><button data-view="table" class="${S.view === 'table' ? 'on' : ''}">表格</button></div>
        ${S.view === 'grid' ? `<select class="plain" id="groupBy">${Object.entries(GROUPS).map(([k, v]) => `<option value="${k}" ${S.groupBy === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>` : ''}
      </div>
      ${renderFilters()}
      <div class="result-line"><span>显示 ${list.length} / ${D.cards.length} 张</span>${anyFilter ? '<button class="linkbtn" data-action="clear">清空筛选</button>' : ''}</div>
      ${body}`;
  }

  // ───────────── 卡组 / 角色页 ─────────────
  function renderDecks() {
    const out = D.characters.map((ch) => {
      const decks = D.decks.filter((d) => d.characterId === ch.id);
      const dice = Object.entries(ch.dice || {}).map(([k, v]) => `${lab(L.color, k)} ${v}`).join(' · ');
      const head = `<h2>${esc(ch.name)} <small style="color:var(--muted);font-weight:400;font-size:13px">${esc(ch.subtitle || '')}</small></h2>
        <div class="kv" style="margin:8px 0 4px">
          <div><dt>职业等级</dt><dd>${(ch.classes || []).map((c) => `${esc(c.classId)} Lv${c.level}`).join(' / ')}</dd></div>
          <div><dt>属性骰</dt><dd>${esc(dice)}</dd></div>
          <div><dt>HP / MP 修正</dt><dd>${ch.hpBonus >= 0 ? '+' : ''}${ch.hpBonus ?? 0} / ${ch.mpBonus >= 0 ? '+' : ''}${ch.mpBonus ?? 0}</dd></div>
          <div><dt>初始站位</dt><dd>${lab(L.row, ch.startingRow)}</dd></div>
          <div><dt>充能上限</dt><dd>${ch.chargeCapacity ?? ''}</dd></div>
          <div><dt>武器 / 防具</dt><dd>${ch.weaponCardId ? entityLink('card', ch.weaponCardId, cardById.get(ch.weaponCardId)?.name) : '—'} / ${ch.armorCardId ? entityLink('card', ch.armorCardId, cardById.get(ch.armorCardId)?.name) : '—'}</dd></div>
        </div>`;
      const deckHtml = decks.map((d) => d.sections.map((s) => {
        const total = s.cards.reduce((a, x) => a + x.count, 0);
        const byColor = {};
        for (const x of s.cards) {
          const c = cardById.get(x.card);
          const key = c && c.colors.length ? c.colors[0] : '';
          byColor[key] = (byColor[key] || 0) + x.count;
        }
        const bar = Object.entries(byColor).map(([k, n]) => `<i style="flex:${n};background:${colorVar(k)}" title="${esc((k ? lab(L.color, k) : '无色') + ' ' + n)}"></i>`).join('');
        const rows = s.cards.map((x) => {
          const c = cardById.get(x.card);
          if (!c) return `<div class="deck-row"><span class="cnt">×${x.count}</span><span class="nm" style="color:var(--err)">找不到「${esc(x.card)}」</span></div>`;
          return `<div class="deck-row" data-open="card:${esc(c.id)}"><span class="cnt">×${x.count}</span><span class="dot" style="background:${colorVar(c.colors[0])}"></span><span class="nm">${esc(c.name)}</span><span class="k">${esc(kindText(c))} · ${c.ap} AP${c.mp ? ` · ${c.mp} MP` : ''}</span>${issueTags(cardIssues(c))}</div>`;
        }).join('');
        return `<h3>${esc(s.title)}<span class="n">${total} 张 · ${s.cards.length} 种</span></h3><div class="bar">${bar}</div>${rows}`;
      }).join('')).join('');
      return `<div class="panel">${head}${deckHtml || '<div class="empty">没有起始卡组</div>'}</div>`;
    }).join('');
    const legend = Object.keys(COLOR_VAR).map((k) => `<span><i style="background:${colorVar(k)}"></i>${lab(L.color, k)}</span>`).join('') + `<span><i style="background:${colorVar('')}"></i>无色</span>`;
    return `<div class="legend" style="margin-bottom:10px">颜色条按每张卡的第一种颜色统计：${legend}</div><div class="cols">${out}</div>`;
  }

  // ───────────── 状态页 ─────────────
  function renderStatuses() {
    const rows = D.statuses.map((s) => {
      const users = [...(statusUsers.get(s.id)?.values() || [])];
      const flags = [];
      if (s.negative) flags.push('负面');
      if (s.consumedOnTrigger) flags.push('触发后消耗');
      for (const [k, v] of Object.entries(s)) {
        if (/Bonus$|Resist|Multiplier/.test(k)) flags.push(`${k}=${v}`);
      }
      return `<tr class="click" data-open="status:${esc(s.id)}">
        <td class="nowrap"><b>${esc(s.name)}</b><div class="mono" style="color:var(--muted)">${esc(s.id)}</div></td>
        <td class="text">${rulesHtml(s.rulesText || '', S.q)}</td>
        <td>${flags.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ')}</td>
        <td>${s.behaviourId ? `<code>${esc(s.behaviourId)}</code>` : '<span style="color:var(--muted)">纯数据</span>'}</td>
        <td>${users.map((u) => esc(u.name)).join('、') || '<span style="color:var(--muted)">没有引用</span>'}</td>
        <td>${issueTags(issuesOf('status', s.id).concat(s.behaviourId ? issuesOf('behaviour', s.behaviourId) : []))}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="data"><thead><tr><th>状态</th><th>效果</th><th>数据字段</th><th>Lua 行为</th><th>谁会施加 / 提到它</th><th>问题</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ───────────── 敌人页 ─────────────
  function renderEnemies() {
    return D.enemies.map((e) => {
      const aff = Object.entries(e.affinities || {}).map(([k, v]) => `<span class="tag">${esc(lab(L.element, k))} ${esc(lab(L.affinity, v))}</span>`).join(' ');
      const pools = Object.entries(e.intentPools || {}).map(([k, ids]) => `<div><dt>${esc(k)}</dt><dd style="font-weight:400">${ids.map((id) => esc(intentById.get(id)?.name || id)).join('、')}</dd></div>`).join('');
      const rows = (e.intents || []).map((i) => `<tr class="click" data-open="intent:${esc(i.id)}">
        <td class="nowrap"><b>${esc(i.name)}</b><div class="mono" style="color:var(--muted)">${esc(i.id)}</div></td>
        <td class="nowrap">${esc(i.category || '')}</td>
        <td class="num">${i.damage ?? ''}${i.hits > 1 ? ` ×${i.hits}` : ''}</td>
        <td class="nowrap">${esc(lab(L.element, i.element))}</td>
        <td class="nowrap">${esc(lab(L.targeting, i.targeting))}${i.designatedRow ? ` · ${esc(lab(L.row, i.designatedRow))}` : ''}</td>
        <td class="text">${rulesHtml(i.text || '', S.q)}</td>
        <td>${behaviourById.get(i.behaviourId || i.id) ? behaviourById.get(i.behaviourId || i.id).hooks.map((h) => `<code>${esc(h.name)}</code>`).join('<br>') : ''}</td>
        <td>${issueTags(issuesOf('intent', i.id).concat(issuesOf('behaviour', i.behaviourId || i.id)))}</td></tr>`).join('');
      return `<div class="panel" style="margin-bottom:16px">
        <h2>${esc(e.name)} <small style="color:var(--muted);font-weight:400;font-size:13px">${esc(e.subtitle || '')}</small></h2>
        <div class="kv" style="margin:8px 0">
          <div><dt>等级</dt><dd>${esc(lab(L.rank, e.rank))}</dd></div>
          <div><dt>HP</dt><dd>${e.hp ?? ''}</dd></div>
          ${e.mp != null ? `<div><dt>MP</dt><dd>${e.mp}</dd></div>` : ''}
          <div><dt>暴击抵抗</dt><dd>${e.critResist ?? ''}</dd></div>
          <div><dt>站位</dt><dd>${esc(lab(L.row, e.row))}</dd></div>
        </div>
        <div style="margin:4px 0 8px">${aff}</div>
        ${pools ? `<div class="kv" style="margin-bottom:10px">${pools}</div>` : ''}
        <div class="table-wrap"><table class="data"><thead><tr><th>意图</th><th>分类</th><th>伤害</th><th>属性</th><th>目标</th><th>说明</th><th>Lua</th><th>问题</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    }).join('') || '<div class="empty">内容包里没有敌人。</div>';
  }

  // ───────────── Lua 页 ─────────────
  function renderLua() {
    return D.scripts.map((f) => {
      const bs = D.behaviours.filter((b) => b.file === f.file);
      const rows = bs.map((b) => `<tr class="click" data-open="behaviour:${esc(b.id)}">
        <td class="nowrap"><b>${esc(b.title || b.id)}</b><div class="mono" style="color:var(--muted)">${esc(b.id)}</div></td>
        <td class="num">${b.line}</td>
        <td>${b.hooks.map((h) => `<code>${esc(h.name)}</code>`).join(' ')}</td>
        <td>${b.users.map((u) => esc(u.name)).join('、') || '<span style="color:var(--err)">没有引用</span>'}</td>
        <td>${issueTags(issuesOf('behaviour', b.id))}</td></tr>`).join('');
      return `<div class="panel" style="margin-bottom:16px">
        <h2 class="mono" style="font-size:16px">${esc(f.file)} <small style="color:var(--muted);font-weight:400">${f.count} 个行为</small></h2>
        ${f.header ? `<div class="comment">${esc(f.header)}</div>` : ''}
        <div class="table-wrap"><table class="data"><thead><tr><th>行为</th><th>行号</th><th>钩子</th><th>被谁使用</th><th>问题</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    }).join('');
  }

  // ───────────── 检查报告 ─────────────
  const CODE_INFO = {
    'missing-file': ['文件缺失', 'pack.json 列出的文件不存在，引擎加载内容包时会出错。'],
    'bad-json': ['JSON 写坏了', '文件无法解析，里面的所有内容都不会加载。'],
    'unlisted-file': ['没登记进 pack.json 的文件', '文件在目录里，但 pack.json 没列，引擎不会读它。'],
    'lua-parse': ['Lua 解析失败', '本工具没能切出这个文件里的行为块，后面的内容可能没显示出来。'],
    'duplicate-id': ['重复的卡牌 id', '同一个 id 出现两次，后加载的会覆盖前面的。'],
    'duplicate-behaviour': ['重复的 Lua 行为', '同一个行为 id 定义了两次，后加载的会覆盖前面的。'],
    'behaviour-missing': ['行为没有实现', '卡 / 状态 / 意图指向的 Lua 行为不存在：卡面上数据效果以外的部分不会生效。'],
    'behaviour-unlinked': ['疑似漏写 behaviourId', 'Lua 里有同名行为，但数据没有指向它。'],
    'behaviour-unused': ['没人引用的 Lua 行为', '写了但不会被调用。可能是 id 拼错，也可能是废弃代码。'],
    'status-missing': ['Lua 用了不存在的状态', 'apply_status 等调用里的状态 id 在 statuses.json 里找不到。'],
    'unknown-hook': ['引擎不认识的钩子', '钩子名不在引擎的列表里，写了也不会被调用。'],
    'text-drift': ['Lua 注释和卡面不同步', '脚本作者在注释里抄了当时的卡面原文；现在卡面变了，要确认脚本是否还按新文字实现。'],
    'crit-flag': ['暴击标记和卡面不一致', 'hasCrit 字段和卡面上的【暴击】对不上。'],
    'number-mismatch': ['数据数值和卡面对不上', '数据效果里的数字在卡面文字里找不到。'],
    'character-missing-card': ['角色引用了不存在的卡', ''],
    'character-missing-deck': ['角色引用了不存在的卡组', ''],
    'deck-missing-card': ['卡组引用了不存在的卡', ''],
    'intent-missing': ['意图池引用了不存在的意图', ''],
    'rule': ['不符合内容包规则', '引擎加载时会报错或忽略的写法（规则来自 profile.json 的 rules，与 ContentLoader 一致）。'],
    'form-in-main': ['形态牌放进了主卡组', '形态牌只能出现在升变牌的形态卡组里（规则书 §3.1）。'],
    'no-behaviour-id': ['没有 behaviourId', '只有数据效果的卡。通常没问题，列出来供核对。'],
    'behaviour-pending': ['Lua 待实现', '卡牌表导入时生成了占位，等 agent 按卡面实现。任务单在 dist/agent-tasks.md。'],
    'not-in-deck': ['不在任何卡组里', '可能是备选卡，也可能是漏放了。'],
  };
  const SEV_LABEL = { error: '错误', warn: '警告', info: '提示' };

  function entityLabel(ent) {
    switch (ent.type) {
      case 'card': return `卡 · ${cardById.get(ent.id)?.name || ent.id}`;
      case 'behaviour': return `Lua · ${ent.id}`;
      case 'status': return `状态 · ${statusById.get(ent.id)?.name || ent.id}`;
      case 'intent': return `意图 · ${intentById.get(ent.id)?.name || ent.id}`;
      case 'enemy': return `敌人 · ${ent.id}`;
      case 'deck': return `卡组 · ${ent.id}`;
      case 'character': return `角色 · ${charById.get(ent.id)?.name || ent.id}`;
      default: return `文件 · ${ent.id}${ent.line ? ':' + ent.line : ''}`;
    }
  }

  function diffHtml(d) {
    if (!d || !d.diff) return '';
    const side = (keep, tag) => d.diff.filter((x) => x.t === 'same' || x.t === keep)
      .map((x) => (x.t === 'same' ? esc(x.s) : `<${tag}>${esc(x.s)}</${tag}>`)).join('');
    return `<div class="diff">
      <span class="lbl">Lua 注释</span><span>${side('del', 'del')}</span>
      <span class="lbl">当前文字</span><span>${side('ins', 'ins')}</span>
    </div>`;
  }

  function issueHtml(x, showWhere = true) {
    const openable = ['card', 'behaviour', 'status', 'intent'].includes(x.entity.type);
    const where = showWhere ? `<div class="where">${openable ? entityLink(x.entity.type, x.entity.id, entityLabel(x.entity)) : esc(entityLabel(x.entity))}</div>` : '';
    return `<div class="issue ${x.severity}"><span class="sev">${SEV_LABEL[x.severity]}</span><div class="body">${esc(x.message)}${diffHtml(x.detail)}${where}</div></div>`;
  }

  function renderReport() {
    const count = (s) => D.issues.filter((x) => x.severity === s).length;
    const groups = new Map();
    for (const x of D.issues) {
      if (!groups.has(x.code)) groups.set(x.code, []);
      groups.get(x.code).push(x);
    }
    const gh = [...groups].map(([code, list]) => {
      const [title, why] = CODE_INFO[code] || [code, ''];
      return `<div class="report-group panel"><h3>${esc(title)} <span style="color:var(--muted);font-weight:400;font-size:12px">${list.length} 条 · ${code}</span></h3>${why ? `<div class="why">${esc(why)}</div>` : ''}${list.map((x) => issueHtml(x)).join('')}</div>`;
    }).join('');
    const um = D.unmappedSummary.map((u) => `<tr><td class="mono">${esc(u.key)}</td><td class="num">${u.cards.length}</td><td>${Object.entries(u.values).slice(0, 6).map(([v, n]) => `<code>${esc(v.length > 40 ? v.slice(0, 40) + '…' : v)}</code> ×${n}`).join('　')}</td></tr>`).join('');
    const hooksNote = D.engineHooks
      ? `钩子列表按引擎源码（${esc(D.engineHooks.source)}）核对，共 ${D.engineHooks.hooks.length} 个。`
      : '没找到引擎源码，钩子列表按本工具内置的表核对。';
    return `
      <div class="summary-cards">
        <div class="stat error"><div class="v">${count('error')}</div><div class="l">错误：会直接导致效果不生效</div></div>
        <div class="stat warn"><div class="v">${count('warn')}</div><div class="l">警告：需要人确认</div></div>
        <div class="stat info"><div class="v">${count('info')}</div><div class="l">提示：供核对</div></div>
        <div class="stat"><div class="v">${D.cards.length}</div><div class="l">张卡 · ${D.behaviours.length} 个 Lua 行为</div></div>
      </div>
      ${gh || '<div class="empty">没有发现问题。</div>'}
      <div class="panel" style="margin-top:18px"><h3>迁移遗留字段（unmapped）</h3><div class="why" style="color:var(--muted);font-size:12.5px;margin-bottom:6px">从旧版迁移时没能对应到新结构的字段，引擎不读它们。卡面效果如果依赖这些字段，需要在数据或 Lua 里补上。</div>
        <div class="table-wrap"><table class="data"><thead><tr><th>字段</th><th>卡数</th><th>取值</th></tr></thead><tbody>${um}</tbody></table></div></div>
      <div class="foot">${hooksNote}</div>`;
  }

  // ───────────── 详情抽屉 ─────────────
  function hookList(b) {
    return b.hooks.map((h) => `<div class="hook"><code>${esc(h.name)}(${esc(h.params)})</code><span class="desc">${esc(lab(L.hook, h.name) === h.name ? '（未知钩子）' : lab(L.hook, h.name))}</span></div>`).join('');
  }

  function behaviourSection(b, opts = {}) {
    if (!b) return '';
    const quoteNote = b.quoteState === 'drift' ? '<span class="tag warn">注释里的卡面原文与当前不一致</span>'
      : b.quoteState === 'ok' ? '<span class="tag">注释原文与卡面一致</span>' : '';
    return `<section class="box"><h3>Lua 行为 · <span class="mono">${esc(b.file)}:${b.line}</span> ${quoteNote}</h3>
      ${hookList(b) || '<div style="color:var(--muted)">没有钩子</div>'}
      ${b.comment ? `<div class="comment">${esc(b.comment).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div>` : ''}
      <details ${opts.openCode ? 'open' : ''}><summary>查看代码（${b.endLine - b.line + 1} 行）</summary><pre class="code">${luaHtml(b.code, b.line)}</pre></details>
    </section>`;
  }

  function issuesSection(list) {
    if (!list.length) return '';
    return `<section class="box"><h3>检查发现</h3>${list.map((x) => issueHtml(x, false)).join('')}</section>`;
  }

  function drawerCard(c) {
    const b = c.behaviourId ? behaviourById.get(c.behaviourId) : null;
    const kv = [
      ['角色', ownerName(c.owner)], ['职业', c.classId], ['类别', lab(L.category, c.category)], ['标记', lab(L.role, c.role)], ['打法', c.play ? lab(L.play, c.play) : '无（升变牌不按打法结算）'],
      ['颜色', c.colors.map((x) => lab(L.color, x)).join(' + ') || '无色'], ['AP', c.ap], ['MP', c.mp], ['充能', c.charge],
      ['暴击', c.hasCrit ? '是' : '否'],
    ];
    if (c.hero) kv.push(['英雄技能', '是']);
    if (c.targeting) kv.push(['指定目标', lab(L.cardTargeting, c.targeting)]);
    if (c.chargeOptions) kv.push(['可选充能', c.chargeOptions.join(' / ')]);
    if (c.ranged) kv.push(['远程', '是']);
    if (c.requiresBackRow) kv.push(['需在后排', '是']);
    if (c.armorBaseShield != null) kv.push(['基础护盾', `${c.armorBaseShield}${c.shieldKind ? ' ' + lab(L.shieldKind, c.shieldKind) : ''}`]);
    if (c.weaponBaseDamage != null) kv.push(['基础伤害', c.weaponBaseDamage]);
    if (c.twoHanded != null) kv.push(['双手', c.twoHanded ? '是' : '否']);
    const unm = Object.entries(c.unmapped || {});
    const decks = c.decks.map((d) => `<li>${esc(d.deckName)} · ${esc(d.section)} ×${d.count}</li>`).join('');
    return {
      title: c.name,
      sub: `<span class="mono">${esc(c.id)}</span> · ${esc(c.file)}${c.behaviourId && c.behaviourId !== c.id ? ` · 行为 <span class="mono">${esc(c.behaviourId)}</span>` : ''}`,
      body: `
        <section class="box"><h3>卡面文字</h3><div class="rules">${rulesHtml(c.rulesText)}</div></section>
        <section class="box"><h3>数值</h3><dl class="kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
        <section class="box"><h3>数据效果（引擎直接执行）</h3>${c.effectTexts.length ? `<ul class="plain">${c.effectTexts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<div style="color:var(--muted)">没有数据效果，全部靠 Lua 行为</div>'}</section>
        ${b ? behaviourSection(b) : `<section class="box"><h3>Lua 行为</h3><div style="color:var(--muted)">${c.luaPending ? `待实现：占位在 <span class="mono">${esc(c.luaPending.file)}:${c.luaPending.line}</span>` : c.behaviourId ? `指向「${esc(c.behaviourId)}」，但 Lua 里没有这个行为` : '这张卡没有 Lua 行为'}</div></section>`}
        ${issuesSection(cardIssues(c))}
        ${c.formDeck ? `<section class="box"><h3>形态卡组（${c.formDeck.reduce((a, f) => a + f.count, 0)} 张）</h3><ul class="plain">${c.formDeck.map((f) => `<li>${cardById.has(f.card) ? entityLink('card', f.card, cardById.get(f.card).name) : `<span style="color:var(--err)">找不到「${esc(f.card)}」</span>`} ×${f.count}</li>`).join('')}</ul></section>` : ''}
        <section class="box"><h3>所在卡组</h3>${decks ? `<ul class="plain">${decks}</ul>` : '<div style="color:var(--muted)">不在任何卡组里</div>'}</section>
        ${unm.length ? `<section class="box"><h3>迁移遗留字段（引擎不读）</h3><dl class="kv">${unm.map(([k, v]) => `<div><dt class="mono">${esc(k)}</dt><dd class="mono" style="font-weight:400">${esc(JSON.stringify(v))}</dd></div>`).join('')}</dl></section>` : ''}`,
    };
  }

  function drawerBehaviour(b) {
    const users = b.users.map((u) => `<li>${['card', 'status', 'intent'].includes(u.type) ? entityLink(u.type, u.id, u.name) : esc(u.name)}</li>`).join('');
    return {
      title: b.title || b.id,
      sub: `Lua 行为 <span class="mono">${esc(b.id)}</span> · ${esc(b.file)}:${b.line}`,
      body: `<section class="box"><h3>被谁使用</h3>${users ? `<ul class="plain">${users}</ul>` : '<div style="color:var(--err)">没有任何卡、状态或意图引用它</div>'}</section>
        ${issuesSection(issuesOf('behaviour', b.id))}
        ${behaviourSection(b, { openCode: true })}`,
    };
  }

  function drawerStatus(s) {
    const b = s.behaviourId ? behaviourById.get(s.behaviourId) : null;
    const users = [...(statusUsers.get(s.id)?.values() || [])].map((u) => `<li>${['card', 'status', 'intent'].includes(u.type) ? entityLink(u.type, u.id, u.name) : esc(u.name)} <span style="color:var(--muted)">（${esc(u.via)}）</span></li>`).join('');
    const fields = Object.entries(s).filter(([k]) => !['id', 'name', 'rulesText', 'behaviourId', 'file'].includes(k));
    return {
      title: s.name,
      sub: `状态 <span class="mono">${esc(s.id)}</span> · ${esc(s.file || '')}`,
      body: `<section class="box"><h3>效果</h3><div class="rules">${rulesHtml(s.rulesText || '')}</div></section>
        ${fields.length ? `<section class="box"><h3>数据字段</h3><dl class="kv">${fields.map(([k, v]) => `<div><dt class="mono">${esc(k)}</dt><dd>${esc(JSON.stringify(v))}</dd></div>`).join('')}</dl></section>` : ''}
        <section class="box"><h3>谁会施加 / 提到它</h3>${users ? `<ul class="plain">${users}</ul>` : '<div style="color:var(--muted)">没有找到引用</div>'}</section>
        ${issuesSection(issuesOf('status', s.id).concat(s.behaviourId ? issuesOf('behaviour', s.behaviourId) : []))}
        ${b ? behaviourSection(b) : s.behaviourId ? `<section class="box"><h3>Lua 行为</h3><div style="color:var(--err)">指向「${esc(s.behaviourId)}」，但 Lua 里没有这个行为</div></section>` : ''}`,
    };
  }

  function drawerIntent(i) {
    const b = behaviourById.get(i.behaviourId || i.id);
    const kv = [['敌人', i.enemy.name], ['分类', i.category], ['伤害', i.damage], ['段数', i.hits], ['属性', lab(L.element, i.element)],
      ['目标', lab(L.targeting, i.targeting)], ['指定排', lab(L.row, i.designatedRow)]].filter(([, v]) => v !== undefined && v !== '' && v !== null);
    const unm = Object.entries(i.unmapped || {});
    return {
      title: i.name,
      sub: `敌人意图 <span class="mono">${esc(i.id)}</span>`,
      body: `<section class="box"><h3>说明</h3><div class="rules">${rulesHtml(i.text || '')}</div></section>
        <section class="box"><h3>数值</h3><dl class="kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
        ${issuesSection(issuesOf('intent', i.id).concat(b ? issuesOf('behaviour', b.id) : []))}
        ${b ? behaviourSection(b) : '<section class="box"><h3>Lua 行为</h3><div style="color:var(--muted)">没有 Lua 行为，只按数据结算</div></section>'}
        ${unm.length ? `<section class="box"><h3>迁移遗留字段（引擎不读）</h3><dl class="kv">${unm.map(([k, v]) => `<div><dt class="mono">${esc(k)}</dt><dd class="mono" style="font-weight:400">${esc(JSON.stringify(v))}</dd></div>`).join('')}</dl></section>` : ''}`,
    };
  }

  function renderDrawer() {
    const host = $('#drawer');
    if (!S.drawer) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
    const i = S.drawer.indexOf(':');
    const type = S.drawer.slice(0, i);
    const id = S.drawer.slice(i + 1);
    let d = null;
    if (type === 'card' && cardById.has(id)) d = drawerCard(cardById.get(id));
    else if (type === 'behaviour' && behaviourById.has(id)) d = drawerBehaviour(behaviourById.get(id));
    else if (type === 'status' && statusById.has(id)) d = drawerStatus(statusById.get(id));
    else if (type === 'intent' && intentById.has(id)) d = drawerIntent(intentById.get(id));
    if (!d) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="scrim" data-action="close"></div>
      <aside class="drawer" role="dialog" aria-label="${esc(d.title)}">
        <div class="drawer-head"><div><h2>${esc(d.title)}</h2><div class="sub">${d.sub}</div></div><button class="close" data-action="close" title="关闭（Esc）">关闭</button></div>
        <div class="drawer-body">${d.body}</div>
      </aside>`;
    document.body.style.overflow = 'hidden';
    host.querySelector('.drawer').scrollTop = 0;
  }

  // ───────────── 路由与总渲染 ─────────────
  const TABS = [
    ['cards', () => `卡牌<span class="pill" style="background:var(--panel-2)">${D.cards.length}</span>`],
    ['decks', () => '角色与卡组'],
    ['statuses', () => '状态'],
    ['enemies', () => '敌人'],
    ['lua', () => 'Lua 行为'],
    ['report', () => {
      const e = D.issues.filter((x) => x.severity === 'error').length;
      const w = D.issues.filter((x) => x.severity === 'warn').length;
      return `检查报告${e ? `<span class="pill err">${e}</span>` : ''}${w ? `<span class="pill warn">${w}</span>` : ''}`;
    }],
  ];

  function readHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    const [tab, open] = h.split('/');
    S.tab = TABS.some(([k]) => k === tab) ? tab : 'cards';
    S.drawer = open || null;
  }

  function writeHash() {
    const h = `#${S.tab}${S.drawer ? '/' + S.drawer : ''}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  function render(keepFocus) {
    $('#tabs').innerHTML = TABS.map(([k, f]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${f()}</button>`).join('');
    const view = { cards: renderCards, decks: renderDecks, statuses: renderStatuses, enemies: renderEnemies, lua: renderLua, report: renderReport }[S.tab];
    const active = document.activeElement && document.activeElement.id;
    const caret = active === 'q' ? document.activeElement.selectionStart : null;
    $('#main').innerHTML = view();
    if (keepFocus && active === 'q') {
      const q = $('#q');
      if (q) { q.focus(); q.setSelectionRange(caret, caret); }
    }
    renderDrawer();
    writeHash();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-open],[data-tab],[data-filter],[data-view],[data-sort],[data-action]');
    if (!t) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.drawer = null; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.open) { S.drawer = t.dataset.open; renderDrawer(); writeHash(); return; }
    if (t.dataset.filter) {
      const set = S.filters[t.dataset.filter];
      const v = t.dataset.value;
      if (set.has(v)) set.delete(v); else set.add(v);
      render();
      return;
    }
    if (t.dataset.view) { S.view = t.dataset.view; store.set('view', S.view); render(); return; }
    if (t.dataset.sort) {
      if (S.sort.key === t.dataset.sort) S.sort.asc = !S.sort.asc; else { S.sort.key = t.dataset.sort; S.sort.asc = true; }
      render();
      return;
    }
    if (t.dataset.action === 'close') { S.drawer = null; renderDrawer(); writeHash(); return; }
    if (t.dataset.action === 'clear') { S.q = ''; for (const k in S.filters) S.filters[k].clear(); render(); return; }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'q') { S.q = ev.target.value.trim(); render(true); }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'groupBy') { S.groupBy = ev.target.value; store.set('groupBy', S.groupBy); render(); }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.drawer) { S.drawer = null; renderDrawer(); writeHash(); }
    if (ev.key === '/' && document.activeElement?.tagName !== 'INPUT' && S.tab === 'cards') { ev.preventDefault(); $('#q')?.focus(); }
  });
  window.addEventListener('hashchange', () => { readHash(); render(); });

  // 主题
  const themeBtn = $('#theme');
  const applyTheme = (t) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    themeBtn.textContent = t === 'dark' ? '深色' : t === 'light' ? '浅色' : '跟随系统';
  };
  let theme = store.get('theme', null);
  applyTheme(theme);
  themeBtn.addEventListener('click', () => {
    theme = theme === null ? 'light' : theme === 'light' ? 'dark' : null;
    store.set('theme', theme);
    applyTheme(theme);
  });

  $('#packinfo').textContent = `${D.pack.name || D.pack.id || ''} ${D.pack.version ? 'v' + D.pack.version : ''} · 生成于 ${new Date(D.generatedAt).toLocaleString('zh-CN')}`;
  readHash();
  render();

  // 用 --serve 打开时，内容包一改就自动刷新（保留当前页签和打开的卡）
  if (location.protocol.startsWith('http') && 'EventSource' in window) {
    try {
      const es = new EventSource('/__events');
      es.onmessage = () => location.reload();
    } catch { /* 静态文件模式下没有这个通道 */ }
  }
})();
