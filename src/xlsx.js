'use strict';
// 零依赖的 xlsx 读写。只覆盖本工具需要的子集：
//   写：多张表、表头样式、只读列底色、自动换行、冻结首行首列、筛选、下拉框（数据验证）、隐藏表
//   读：Excel / WPS / LibreOffice 存出来的 xlsx（共享字符串、内联字符串、数字、布尔、富文本）
// 压缩用 Node 自带的 zlib，所以不需要装任何包。

const zlib = require('zlib');

// ───────────────────────── zip ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // 时间 / 日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）。是不是存成了 .xls 或 .csv？');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 的 zip 目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ───────────────────────── XML 小工具 ─────────────────────────

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 不允许的控制字符直接丢掉
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function xmlUnesc(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // Excel 用 _x000D_ 这种写法转义控制字符
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    o[m[1]] = xmlUnesc(m[2]);
    // 关系 id 的命名空间前缀不一定叫 r:，统一再存一份不带前缀的
    const local = m[1].replace(/^\w+:/, '');
    if (!(local in o)) o[local] = o[m[1]];
  }
  return o;
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ───────────────────────── 写 ─────────────────────────

// 样式下标（对应 styles.xml 里 cellXfs 的顺序）
const STYLE = { normal: 0, header: 1, wrap: 2, readonly: 3, headerReadonly: 4, headerKey: 5 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font>
<font><sz val="11"/><color rgb="FF6B665D"/><name val="Microsoft YaHei"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCE4FF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF0EEE9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFE9B3"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB8B2A7"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

/**
 * sheet: {
 *   name, hidden?,
 *   columns: [{ header, width?, readonly?, key?, wrap?, list?: { sheet, range } }],
 *   rows: [[value...]],
 *   freezeCols?: 1, autoFilter?: true
 * }
 */
function sheetXml(sheet) {
  const cols = sheet.columns;
  const lastCol = colName(Math.max(cols.length - 1, 0));
  const nRows = sheet.rows.length + 1;
  const freezeCols = sheet.freezeCols || 0;
  const pane = freezeCols
    ? `<pane xSplit="${freezeCols}" ySplit="1" topLeftCell="${colName(freezeCols)}2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${colName(freezeCols)}2" sqref="${colName(freezeCols)}2"/>`
    : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  const colsXml = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"${c.readonly ? ` style="${STYLE.readonly}"` : ''}/>`).join('');
  const rows = [];
  rows.push(`<row r="1" ht="30" customHeight="1">${cols.map((c, i) => cellXml(`${colName(i)}1`, c.header, c.readonly ? STYLE.headerReadonly : c.key ? STYLE.headerKey : STYLE.header)).join('')}</row>`);
  sheet.rows.forEach((r, ri) => {
    const rn = ri + 2;
    const cells = cols.map((c, ci) => cellXml(`${colName(ci)}${rn}`, r[ci], c.readonly ? STYLE.readonly : c.wrap ? STYLE.wrap : 0)).join('');
    rows.push(`<row r="${rn}">${cells}</row>`);
  });
  // 下拉框：覆盖到 2000 行，方便策划往下加新行
  const dv = cols.map((c, i) => (c.list ? { i, c } : null)).filter(Boolean);
  const dvXml = dv.length
    ? `<dataValidations count="${dv.length}">${dv.map(({ i, c }) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" errorTitle="不在列表里" error="这一列只能从下拉列表里选；确实要填别的值请先在「枚举」表里确认" sqref="${colName(i)}2:${colName(i)}2000"><formula1>${xmlEsc(c.list)}</formula1></dataValidation>`).join('')}</dataValidations>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${nRows}"/>
<sheetViews><sheetView workbookViewId="0"${sheet.tabSelected ? ' tabSelected="1"' : ''}>${sheet.freeze === false ? '' : pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16.5"/>
<cols>${colsXml}</cols>
<sheetData>${rows.join('')}</sheetData>
${sheet.autoFilter ? `<autoFilter ref="A1:${lastCol}${nRows}"/>` : ''}
${dvXml}
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function writeXlsx(sheets) {
  const files = [];
  const ct = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  files.push(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${ct}
</Types>`]);
  files.push(['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`]);
  const filterNames = sheets.map((s, i) => (s.autoFilter
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>`
    : '')).join('');
  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="${Math.max(0, sheets.findIndex((s) => s.tabSelected))}"/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>
${filterNames ? `<definedNames>${filterNames}</definedNames>` : ''}
</workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`]);
  files.push(['xl/styles.xml', STYLES_XML]);
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
  return zip(files);
}

// ───────────────────────── 读 ─────────────────────────

function textOf(fragment) {
  // <si> / <is> 里可能是 <t> 也可能是多段 <r><t>；<rPh> 是注音，不要
  const noPh = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of noPh.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += m[1] ? xmlUnesc(m[1]) : '';
  return s;
}

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ['xl'];
  for (const p of target.split('/')) {
    if (p === '..') parts.pop(); else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

/** 返回 [{ name, hidden, rows: [[value...]] }]，rows 里第一行是表头 */
function readXlsx(buf) {
  const files = unzip(buf);
  const get = (n) => {
    const b = files.get(n);
    return b ? b.toString('utf8') : null;
  };
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('xlsx 里没有 workbook.xml');
  const rels = {};
  for (const m of (get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    rels[a.Id] = a.Target;
  }
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = a['r:id'] || a.id;
    const path = rels[rid] ? resolveTarget(rels[rid]) : null;
    const xml = path ? get(path) : null;
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(rm[1]);
      const rIdx = ra.r ? Number(ra.r) - 1 : rows.length;
      const row = [];
      let nextCol = 0;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        const ci = ca.r ? colIndex(ca.r.replace(/\d+/g, '')) : nextCol;
        nextCol = ci + 1;
        const inner = cm[2] || '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        switch (ca.t) {
          case 's': val = v != null ? shared[Number(v)] ?? '' : ''; break;
          case 'inlineStr': val = textOf((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || ''); break;
          case 'b': val = v === '1'; break;
          case 'str': case 'e': val = v != null ? xmlUnesc(v) : ''; break;
          default: val = v != null && v !== '' ? Number(v) : null;
        }
        row[ci] = val;
      }
      rows[rIdx] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name: a.name, hidden: a.state === 'hidden' || a.state === 'veryHidden', rows });
  }
  return sheets;
}

module.exports = { writeXlsx, readXlsx, colName, colIndex, zip, unzip };
