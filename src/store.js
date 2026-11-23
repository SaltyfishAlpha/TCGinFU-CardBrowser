'use strict';
// 通用的内容包读写：按 profile 找到每个集合的文件，记住每一项来自哪个文件、第几个，
// 写回时保持原文件的缩进、换行符和结尾换行，让 git diff 只出现真正改动的行。

const fs = require('fs');
const path = require('path');
const { parseLuaFile } = require('./lua');

function detectStyle(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/\n([ \t]+)\S/);
  const indent = m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
  return { eol, indent, finalNewline: /\r?\n$/.test(text), bom: text.charCodeAt(0) === 0xfeff };
}

function serializeJson(data, style) {
  let s = JSON.stringify(data, null, style.indent);
  if (style.eol !== '\n') s = s.replace(/\n/g, style.eol);
  if (style.finalNewline) s += style.eol;
  return (style.bom ? '﻿' : '') + s;
}

function globFiles(contentDir, pattern) {
  // 只支持 dir/*.ext 这种最常见的写法，够用
  const dir = path.posix.dirname(pattern);
  const re = new RegExp('^' + path.posix.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  try {
    return fs.readdirSync(path.join(contentDir, dir)).filter((f) => re.test(f)).map((f) => (dir === '.' ? f : `${dir}/${f}`)).sort();
  } catch { return []; }
}

class ContentStore {
  constructor(contentDir, profile) {
    this.dir = path.resolve(contentDir);
    this.profile = profile;
    this.problems = [];
    this.files = new Map(); // rel → { data, style, dirty }
    this.luaFiles = new Map(); // rel → { text, style, parsed, dirty }
    this.collections = {};
    this.manifest = null;
    this.manifestDirty = false;
  }

  abs(rel) { return path.join(this.dir, rel); }

  readJson(rel) {
    if (this.files.has(rel)) return this.files.get(rel);
    let text;
    try {
      text = fs.readFileSync(this.abs(rel), 'utf8');
    } catch (e) {
      this.problems.push({ severity: 'error', code: 'missing-file', file: rel, message: `清单里列了 ${rel}，但文件不存在` });
      return null;
    }
    try {
      const entry = { data: JSON.parse(text.replace(/^﻿/, '')), style: detectStyle(text), original: text, dirty: false };
      this.files.set(rel, entry);
      return entry;
    } catch (e) {
      this.problems.push({ severity: 'error', code: 'bad-json', file: rel, message: `${rel} 不是合法的 JSON：${e.message}` });
      return null;
    }
  }

  load() {
    const p = this.profile;
    if (p.manifest) {
      const m = this.readJson(p.manifest);
      if (!m) throw new Error(`读不到 ${this.abs(p.manifest)}。检查 contentDir 配置，或用 --content 指定。`);
      this.manifest = m;
    }
    for (const def of p.collections) this.loadCollection(def);
    this.loadLua();
    return this;
  }

  collectionFiles(def) {
    if (def.manifestKey && this.manifest) {
      const list = this.manifest.data[def.manifestKey];
      return Array.isArray(list) ? list.map((f) => f.replace(/\\/g, '/')) : [];
    }
    return (def.files || []).flatMap((g) => (g.includes('*') ? globFiles(this.dir, g) : [g]));
  }

  itemsOfFile(def, data) {
    if (def.arrayKey === null) return null; // 整个文件就是一项
    if (Array.isArray(data)) return data;
    if (def.arrayKey && Array.isArray(data[def.arrayKey])) return data[def.arrayKey];
    return [];
  }

  loadCollection(def) {
    const col = { def, items: [], byId: new Map() };
    for (const rel of this.collectionFiles(def)) {
      const f = this.readJson(rel);
      if (!f) continue;
      const list = this.itemsOfFile(def, f.data);
      const push = (obj, index) => {
        const id = obj[def.idField || 'id'];
        const it = { obj, file: rel, index, id };
        if (id != null && col.byId.has(id)) {
          this.problems.push({ severity: 'error', code: 'duplicate-id', file: rel, message: `${def.label || def.key} id「${id}」重复：${col.byId.get(id).file} 和 ${rel}` });
        } else if (id != null) col.byId.set(id, it);
        col.items.push(it);
      };
      if (list === null) push(f.data, null);
      else list.forEach((o, i) => push(o, i));
    }
    this.collections[def.key] = col;
  }

  luaManifestFiles() {
    const lua = this.profile.lua;
    if (!lua) return [];
    if (lua.manifestKey && this.manifest) return (this.manifest.data[lua.manifestKey] || []).map((f) => f.replace(/\\/g, '/'));
    return (lua.files || []).flatMap((g) => (g.includes('*') ? globFiles(this.dir, g) : [g]));
  }

  loadLua() {
    for (const rel of this.luaManifestFiles()) {
      let text;
      try { text = fs.readFileSync(this.abs(rel), 'utf8'); } catch {
        this.problems.push({ severity: 'error', code: 'missing-file', file: rel, message: `清单里列了 ${rel}，但文件不存在` });
        continue;
      }
      this.luaFiles.set(rel, { text, style: detectStyle(text), parsed: parseLuaFile(rel, text, this.profile.lua), dirty: false });
    }
  }

  /** 所有已实现的行为 id → 块；所有占位 id → 占位 */
  behaviourIndex() {
    const blocks = new Map();
    const stubs = new Map();
    for (const f of this.luaFiles.values()) {
      for (const b of f.parsed.blocks) blocks.set(b.id, b);
      for (const s of f.parsed.stubs) stubs.set(s.id, s);
    }
    return { blocks, stubs };
  }

  // ───────── 写 ─────────

  ensureFile(def, rel) {
    if (this.files.has(rel)) return this.files.get(rel);
    if (fs.existsSync(this.abs(rel))) {
      const f = this.readJson(rel);
      if (f) return f;
    }
    const data = def.arrayKey === null ? null : def.arrayKey ? { [def.arrayKey]: [] } : [];
    const entry = { data, style: { eol: '\n', indent: 2, finalNewline: true, bom: false }, original: null, dirty: true, created: true };
    this.files.set(rel, entry);
    if (def.manifestKey && this.manifest) {
      const list = this.manifest.data[def.manifestKey] || (this.manifest.data[def.manifestKey] = []);
      if (!list.includes(rel)) { list.push(rel); this.manifest.dirty = true; }
    }
    return entry;
  }

  listOf(def, entry) {
    if (Array.isArray(entry.data)) return entry.data;
    return entry.data[def.arrayKey];
  }

  replaceItem(def, it, obj) {
    const f = this.files.get(it.file);
    const list = this.listOf(def, f);
    const idx = list.indexOf(it.obj);
    list[idx] = obj;
    it.obj = obj;
    f.dirty = true;
  }

  removeItem(def, it) {
    const f = this.files.get(it.file);
    const list = this.listOf(def, f);
    list.splice(list.indexOf(it.obj), 1);
    f.dirty = true;
  }

  addItem(def, rel, obj) {
    const f = this.ensureFile(def, rel);
    this.listOf(def, f).push(obj);
    f.dirty = true;
  }

  /** 往 Lua 文件末尾追加一段；文件不存在就建，并登记进清单 */
  appendLua(rel, lines, headerLines) {
    let f = this.luaFiles.get(rel);
    if (!f) {
      let text = '';
      try { text = fs.readFileSync(this.abs(rel), 'utf8'); } catch { /* 新文件 */ }
      f = { text, style: text ? detectStyle(text) : { eol: '\r\n', finalNewline: true }, parsed: { blocks: [], stubs: [] }, dirty: false, created: !text };
      this.luaFiles.set(rel, f);
      const lua = this.profile.lua;
      if (lua.manifestKey && this.manifest) {
        const list = this.manifest.data[lua.manifestKey] || (this.manifest.data[lua.manifestKey] = []);
        if (!list.includes(rel)) { list.push(rel); this.manifest.dirty = true; }
      }
      if (!text && headerLines) f.text = headerLines.join(f.style.eol) + f.style.eol;
    }
    const eol = f.style.eol;
    let t = f.text;
    if (t && !t.endsWith('\n')) t += eol;
    t += eol + lines.join(eol) + eol;
    f.text = t;
    f.dirty = true;
  }

  /** 把某个 id 的占位块整段替换成新行（lines 为 null 表示删除） */
  replaceStub(stub, lines) {
    const f = this.luaFiles.get(stub.file);
    const eol = f.style.eol;
    const all = f.text.split(/\r?\n/);
    // stub.startLine / endLine 是 1 起的闭区间；删除时顺带吃掉前面的一个空行
    let s = stub.startLine - 1;
    const e = stub.endLine;
    if (!lines && s > 0 && all[s - 1].trim() === '') s--;
    all.splice(s, e - s, ...(lines || []));
    f.text = all.join(eol);
    f.dirty = true;
  }

  /** 改过的 Lua 文件重新解析，让占位 / 行号反映最新内容 */
  reparseLua() {
    for (const [rel, f] of this.luaFiles) {
      if (f.dirty) f.parsed = parseLuaFile(rel, f.text, this.profile.lua);
    }
  }

  /** 返回将要写的文件 [{ rel, text, created }]，不落盘 */
  pendingWrites() {
    const out = [];
    for (const [rel, f] of this.files) {
      if (!f.dirty && !(this.manifest === f && this.manifest.dirty)) continue;
      out.push({ rel, text: serializeJson(f.data, f.style), created: !!f.created, before: f.original });
    }
    for (const [rel, f] of this.luaFiles) {
      if (f.dirty) out.push({ rel, text: f.text, created: !!f.created, before: null });
    }
    return out.filter((w) => w.text !== w.before);
  }

  commit() {
    const writes = this.pendingWrites();
    for (const w of writes) {
      fs.mkdirSync(path.dirname(this.abs(w.rel)), { recursive: true });
      fs.writeFileSync(this.abs(w.rel), w.text, 'utf8');
    }
    return writes;
  }
}

module.exports = { ContentStore, serializeJson, detectStyle };
