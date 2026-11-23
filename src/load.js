'use strict';
// 按 pack.json 的清单读整个内容包。文件缺失或 JSON 写坏不会让整个工具崩掉，
// 而是记成「加载问题」交给检查报告——策划正是在这种时候最需要看到它。

const fs = require('fs');
const path = require('path');
const { parseLuaFile } = require('./lua');

function readJson(abs, problems, rel) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    problems.push({
      severity: 'error', code: e.code === 'ENOENT' ? 'missing-file' : 'bad-json',
      file: rel,
      message: e.code === 'ENOENT' ? `pack.json 里列了 ${rel}，但文件不存在` : `${rel} 不是合法的 JSON：${e.message}`,
    });
    return null;
  }
}

function list(pack, key) {
  return Array.isArray(pack[key]) ? pack[key] : [];
}

function loadContent(contentDir) {
  const problems = [];
  const abs = (rel) => path.join(contentDir, rel);
  const pack = readJson(abs('pack.json'), problems, 'pack.json');
  if (!pack) {
    throw new Error(`读不到 ${abs('pack.json')}。检查 cardbrowser.config.json 里的 contentDir，或用 --content 指定。`);
  }

  const cards = [];
  for (const rel of list(pack, 'cards')) {
    const d = readJson(abs(rel), problems, rel);
    if (!d) continue;
    (d.cards || []).forEach((c, index) => cards.push({ ...c, _file: rel, _index: index }));
  }

  const statuses = [];
  for (const rel of list(pack, 'statuses')) {
    const d = readJson(abs(rel), problems, rel);
    if (d) (d.statuses || []).forEach((s) => statuses.push({ ...s, _file: rel }));
  }

  const characters = [];
  for (const rel of list(pack, 'characters')) {
    const d = readJson(abs(rel), problems, rel);
    if (d) (d.characters || []).forEach((c) => characters.push({ ...c, _file: rel }));
  }

  const enemies = [];
  for (const rel of list(pack, 'enemies')) {
    const d = readJson(abs(rel), problems, rel);
    if (d) (d.enemies || []).forEach((e) => enemies.push({ ...e, _file: rel }));
  }

  const decks = [];
  for (const rel of list(pack, 'decks')) {
    const d = readJson(abs(rel), problems, rel);
    if (d) decks.push({ ...d, _file: rel });
  }

  const scripts = [];
  const behaviours = [];
  for (const rel of list(pack, 'scripts')) {
    let src;
    try {
      src = fs.readFileSync(abs(rel), 'utf8').replace(/^﻿/, '');
    } catch (e) {
      problems.push({
        severity: 'error', code: 'missing-file', file: rel,
        message: `pack.json 里列了 ${rel}，但文件不存在——引擎加载内容包时这里就会出问题`,
      });
      continue;
    }
    const parsed = parseLuaFile(rel, src);
    scripts.push({ file: rel, header: parsed.header, count: parsed.blocks.length });
    behaviours.push(...parsed.blocks);
    for (const err of parsed.errors) {
      problems.push({ severity: 'error', code: 'lua-parse', file: rel, line: err.line, message: err.message });
    }
  }

  // 目录里有、pack.json 却没列的文件：引擎不会加载它们
  for (const [dir, key, ext] of [['cards', 'cards', '.json'], ['scripts', 'scripts', '.lua'],
    ['decks', 'decks', '.json'], ['enemies', 'enemies', '.json'], ['characters', 'characters', '.json']]) {
    let files = [];
    try { files = fs.readdirSync(abs(dir)).filter((f) => f.endsWith(ext)); } catch { /* 目录不存在就算了 */ }
    const listed = new Set(list(pack, key).map((p) => p.replace(/\\/g, '/')));
    for (const f of files) {
      const rel = `${dir}/${f}`;
      if (!listed.has(rel)) {
        problems.push({
          severity: 'warn', code: 'unlisted-file', file: rel,
          message: `${rel} 在目录里，但 pack.json 没有列它，引擎不会加载`,
        });
      }
    }
  }

  return {
    contentDir: path.resolve(contentDir),
    pack: { id: pack.id, name: pack.name, version: pack.version, source: pack.source },
    cards, statuses, characters, enemies, decks, scripts, behaviours, problems,
  };
}

module.exports = { loadContent };
