'use strict';
// 从 Lua 脚本里切出每个 behaviour("<id>", { ... }) 块。
//
// 不是完整的 Lua 解析器：只认顶层的 behaviour(...) 调用，靠一个够用的词法扫描
// （跳过字符串、长字符串、注释）去找配对的大括号。内容包里的脚本都是这个写法，
// 认不出的写法会作为「解析失败」出现在检查报告里，而不是悄悄丢掉。

const START_RE = /^[ \t]*behaviour\(\s*(["'])([^"']+)\1\s*,\s*\{/gm;
const HOOK_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)/;
const STATUS_CALL_RE = /\b(apply_status|has_status|remove_status|status_stacks|clear_status)\s*\(\s*[^,()]+,\s*(["'])([^"']+)\2/g;

function longBracketLevel(src, i) {
  // src[i] === '['；返回 [=*[ 的等号个数，不是长括号则返回 -1
  let j = i + 1;
  let level = 0;
  while (src[j] === '=') { level++; j++; }
  return src[j] === '[' ? level : -1;
}

function skipLongBracket(src, i, level) {
  const close = ']' + '='.repeat(level) + ']';
  const end = src.indexOf(close, i);
  return end < 0 ? src.length : end + close.length;
}

/**
 * 从 openIdx（指向 '{'）开始扫，返回配对 '}' 的下标，以及块内每行行首的括号深度。
 */
function scanTable(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const lineDepth = []; // 块内每一行开头时的深度
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { lineDepth.push(depth); i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[') {
        const lv = longBracketLevel(src, i + 2);
        if (lv >= 0) {
          const end = skipLongBracket(src, i + 2, lv);
          for (let k = i; k < end; k++) if (src[k] === '\n') lineDepth.push(depth);
          i = end;
          continue;
        }
      }
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const lv = longBracketLevel(src, i);
      if (lv >= 0) {
        const end = skipLongBracket(src, i, lv);
        for (let k = i; k < end; k++) if (src[k] === '\n') lineDepth.push(depth);
        i = end;
        continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { close: i, lineDepth };
    }
    i++;
  }
  return { close: -1, lineDepth };
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** behaviour 行上方紧挨着的连续注释行 → { title, lines } */
function leadingComment(lines, startLine) {
  const out = [];
  for (let i = startLine - 2; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('--')) break;
    out.unshift(l.replace(/^--+\s?/, ''));
  }
  let title = '';
  const body = [];
  for (const l of out) {
    const m = l.match(/^─+\s*(.+?)\s*─+$/);
    if (m && !title) title = m[1];
    else body.push(l);
  }
  while (body.length && !body[0].trim()) body.shift();
  return { title, lines: body };
}

/** 注释里第一段「……」——按约定那是脚本作者照抄的卡面原文 */
function quotedRulesText(commentLines) {
  const joined = commentLines.map((l) => l.trim()).join('');
  const re = /「([^」]+)」/g;
  let m;
  while ((m = re.exec(joined))) {
    if (m[1].replace(/\s/g, '').length >= 6) return m[1];
  }
  return null;
}

function parseLuaFile(file, src) {
  src = src.replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks = [];
  const errors = [];
  START_RE.lastIndex = 0;
  let m;
  while ((m = START_RE.exec(src))) {
    const id = m[2];
    const openIdx = m.index + m[0].length - 1;
    const startLine = lineOf(src, m.index);
    const { close, lineDepth } = scanTable(src, openIdx);
    if (close < 0) {
      errors.push({ file, line: startLine, id, message: `behaviour("${id}") 的大括号没有配对，后面的块没法解析` });
      break;
    }
    // 吃掉收尾的 ")"
    let end = close + 1;
    while (end < src.length && /[ \t]/.test(src[end])) end++;
    if (src[end] === ')') end++;
    const endLine = lineOf(src, end);
    const code = lines.slice(startLine - 1, endLine).join('\n');

    const hooks = [];
    // lineDepth[k] 是块内第 k+1 行（startLine + k + 1）开头的深度
    for (let k = 0; k < lineDepth.length; k++) {
      if (lineDepth[k] !== 1) continue;
      const ln = startLine + k + 1;
      const hm = (lines[ln - 1] || '').match(HOOK_RE);
      if (hm) hooks.push({ name: hm[1], params: hm[2].trim(), line: ln });
    }

    const statusRefs = [];
    STATUS_CALL_RE.lastIndex = 0;
    let sm;
    while ((sm = STATUS_CALL_RE.exec(code))) statusRefs.push({ fn: sm[1], id: sm[3] });

    const comment = leadingComment(lines, startLine);
    blocks.push({
      id, file, line: startLine, endLine, hooks, code,
      title: comment.title,
      comment: comment.lines.join('\n'),
      quote: quotedRulesText(comment.lines),
      statusRefs,
    });
    START_RE.lastIndex = end;
  }
  return { blocks, errors, header: fileHeader(lines) };
}

/** 文件开头的注释（写法约定之类），给浏览器里的「脚本文件」视图用 */
function fileHeader(lines) {
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith('--')) { if (out.length) break; else continue; }
    out.push(l.replace(/^--+\s?/, ''));
  }
  return out.join('\n');
}

module.exports = { parseLuaFile, quotedRulesText };
