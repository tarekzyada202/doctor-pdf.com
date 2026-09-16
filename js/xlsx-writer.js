/* Doctor PDF — minimal XLSX writer, written from scratch (Office Open XML SpreadsheetML + ZIP).
   API (window.DpdfXlsx):
     parseNumber(text)  -> { value, fmt: 'int'|'dec'|'thou'|'pct'|'pct2'|'cur', code? } or null   (conservative: phones, IDs, dates stay text;
                           'cur' = amount with a currency before/after it, code = Excel number format showing that currency)
     build(sheets)      -> Promise<Blob>
       sheets: [{ name, rtl, rows: [[cell, ...], ...], merges: ['A1:C1'], widths: [chars...] }]
       cell:   null | string | number | { v, style }   style: 'head' | 'cell' | 'text' | 'title'
               strings in 'head'/'cell' that look numeric are written as real numbers (unless keepText) */
(function () {
  'use strict';

  /* ── numbers ── */
  var AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  function westernDigits(s) {
    return s.replace(/[٠-٩۰-۹]/g, function (d) { var i = AR_DIGITS.indexOf(d); return String(i >= 0 ? i : FA_DIGITS.indexOf(d)); })
      .replace(/٫/g, '.').replace(/٬/g, ',');
  }
  /* currency written before or after an amount: "AED 25,428.57", "150,000.00 د.إ", "$1,200" */
  var CUR = '(?:AED|SAR|QAR|KWD|BHD|OMR|JOD|EGP|USD|EUR|GBP|Dhs?|US\\$|\\$|€|£|د\\.?\\s?إ|درهم|ر\\.?\\s?س|ريال|ج\\.?\\s?م|جنيه|د\\.?\\s?ك|ر\\.?\\s?ق|د\\.?\\s?ب|ر\\.?\\s?ع|د\\.?\\s?أ|دينار|دولار|يورو)\\.?';
  var CUR_PRE = new RegExp('^(' + CUR + ')(\\s*)(.+)$', 'i'), CUR_POST = new RegExp('^(.+?)(\\s*)(' + CUR + ')$', 'i');
  function fmtQuote(t) { return '"' + t.replace(/"/g, '') + '"'; }
  function parseNumber(text) {
    if (typeof text !== 'string') return null;
    var s = westernDigits(text.trim());
    if (!s || s.length > 32) return null;
    var neg = false, pct = false, cur = null, m;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    if (/^[-−]/.test(s) && CUR_PRE.test(s.slice(1).trim())) { neg = !neg; s = s.slice(1).trim(); }
    if ((m = CUR_PRE.exec(s)) && /\d/.test(m[3]) && !/\d/.test(m[1])) { cur = { sym: m[1], sp: m[2] ? ' ' : '', pre: true }; s = m[3].trim(); }
    else if ((m = CUR_POST.exec(s)) && /\d$/.test(m[1])) { cur = { sym: m[3], sp: m[2] ? ' ' : '', pre: false }; s = m[1].trim(); }
    if (s.length > 24) return null;
    if (/%$/.test(s)) { pct = true; s = s.slice(0, -1).trim(); }
    else if (/^%/.test(s)) { pct = true; s = s.slice(1).trim(); }
    if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
    var digits = s.replace(/[,.]/g, '');
    if (digits.length > 15) return null;                               /* IDs / card numbers */
    if (/^0\d/.test(s) && s.indexOf('.') < 0) return null;             /* phones, codes with leading zero */
    var v = parseFloat(s.replace(/,/g, ''));
    if (!isFinite(v)) return null;
    if (neg) v = -v;
    var dec = s.indexOf('.') >= 0;
    if (pct) return cur ? null : { value: v / 100, fmt: dec ? 'pct2' : 'pct' };
    if (cur) {
      /* the amount stays a real number; the currency is shown by the cell's number format */
      var body = dec ? '#,##0.' + new Array(Math.min(s.split('.')[1].length, 4) + 1).join('0') : '#,##0';
      var code = cur.pre ? fmtQuote(cur.sym + cur.sp) + body : body + fmtQuote(cur.sp + cur.sym);
      return { value: v, fmt: 'cur', code: code };
    }
    return { value: v, fmt: dec ? 'dec' : (s.indexOf(',') >= 0 ? 'thou' : 'int') };
  }

  /* ── XML ── */
  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  /* style ids in styles.xml (cellXfs order) */
  var XF = { text: 0, head: 1, cell: 2, dec: 3, int: 4, pct: 5, pct2: 6, thou: 7, title: 8 };
  /* currency formats are added per workbook: numFmtId 167+, cellXfs index 9+ */
  function stylesXml(curCodes) {
    /* joined, not String.replace: a "$" currency in the format would be read as a replacement pattern */
    return STYLES_HEAD.split('{NUMFMTS}').join('<numFmts count="' + (3 + curCodes.length) + '"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="#,##0"/>' +
        curCodes.map(function (c, i) { return '<numFmt numFmtId="' + (167 + i) + '" formatCode="' + esc(c) + '"/>'; }).join('') + '</numFmts>') +
      '<cellXfs count="' + (9 + curCodes.length) + '">' + XFS +
      curCodes.map(function (c, i) { return '<xf numFmtId="' + (167 + i) + '" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>'; }).join('') +
      STYLES_TAIL;
  }
  var STYLES_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '{NUMFMTS}' +
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFB4B4C0"/></left><right style="thin"><color rgb="FFB4B4C0"/></right>' +
    '<top style="thin"><color rgb="FFB4B4C0"/></top><bottom style="thin"><color rgb="FFB4B4C0"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
  var XFS =
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>';
  var STYLES_TAIL = '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function sheetXml(sh, curCodes) {
    var rows = sh.rows || [], maxCols = 0, widths = [];
    rows.forEach(function (r) { if (r && r.length > maxCols) maxCols = r.length; });
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheetViews><sheetView workbookViewId="0"' + (sh.rtl ? ' rightToLeft="1"' : '') + '/></sheetViews>',
      '<sheetFormatPr defaultRowHeight="15"/>');
    var body = [];
    rows.forEach(function (r, ri) {
      if (!r || !r.length) { return; }
      var cells = [];
      r.forEach(function (cell, ci) {
        if (cell == null || cell === '') return;
        var v = cell, style = 'cell', keepText = false;
        if (typeof cell === 'object') { v = cell.v; style = cell.style || 'cell'; keepText = !!cell.keepText; }
        if (v == null || v === '') return;
        var ref = colName(ci) + (ri + 1), xf = XF[style] != null ? XF[style] : XF.cell, len;
        var num = typeof v === 'number' ? { value: v, fmt: Number.isInteger(v) ? 'int' : 'dec' } :
          (!keepText && (style === 'cell') ? parseNumber(v) : null);
        if (num) {
          var s = XF[num.fmt];
          if (num.fmt === 'cur') { var ci2 = curCodes.indexOf(num.code); if (ci2 < 0) { ci2 = curCodes.length; curCodes.push(num.code); } s = 9 + ci2; }
          cells.push('<c r="' + ref + '" s="' + s + '"><v>' + num.value + '</v></c>');
          len = String(typeof v === 'number' ? v : v).length + 1;
        } else {
          var t = String(v); if (t.length > 32767) t = t.slice(0, 32767);
          cells.push('<c r="' + ref + '" s="' + xf + '" t="inlineStr"><is><t xml:space="preserve">' + esc(t) + '</t></is></c>');
          len = t.split('\n').reduce(function (m, line) { return Math.max(m, line.length); }, 0);
        }
        if (style !== 'text' && style !== 'title') widths[ci] = Math.max(widths[ci] || 0, len);
      });
      if (cells.length) body.push('<row r="' + (ri + 1) + '">' + cells.join('') + '</row>');
    });
    var w = sh.widths || widths;
    if (maxCols) {
      out.push('<cols>');
      for (var c = 0; c < maxCols; c++) {
        var cw = Math.max(8, Math.min(60, Math.round((w[c] || 8) * 1.1 + 2)));
        out.push('<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + cw + '" customWidth="1"/>');
      }
      out.push('</cols>');
    }
    out.push('<sheetData>' + body.join('') + '</sheetData>');
    if (sh.merges && sh.merges.length) {
      out.push('<mergeCells count="' + sh.merges.length + '">' + sh.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>');
    }
    out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
    return out.join('');
  }

  function sheetNames(sheets) {
    var used = {};
    return sheets.map(function (sh, i) {
      var n = String(sh.name || ('Sheet' + (i + 1))).replace(/[\[\]:*?\/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || ('Sheet' + (i + 1));
      n = n.slice(0, 31);
      var base = n, k = 2;
      while (used[n.toLowerCase()]) { var suf = ' (' + k++ + ')'; n = base.slice(0, 31 - suf.length) + suf; }
      used[n.toLowerCase()] = true;
      return n;
    });
  }

  /* ── ZIP (deflate via CompressionStream, store fallback) ── */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }
  async function zip(entries) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var name = enc.encode(entries[i].name), data = typeof entries[i].data === 'string' ? enc.encode(entries[i].data) : entries[i].data;
      var crc = crc32(data), comp = await deflateRaw(data), method = 8;
      if (!comp || comp.length >= data.length) { comp = data; method = 0; }
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034B50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, comp.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, comp);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014B50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + comp.length;
    }
    var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054B50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  async function build(sheets) {
    if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
    var names = sheetNames(sheets), files = [];
    files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>' });
    files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>' });
    files.push({ name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Doctor PDF</Application></Properties>' });
    files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView/></bookViews><sheets>' +
      names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>' });
    var curCodes = [], sheetFiles = sheets.map(function (s, i) { return { name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s, curCodes) }; });
    files.push({ name: 'xl/styles.xml', data: stylesXml(curCodes) });
    sheetFiles.forEach(function (f) { files.push(f); });
    return zip(files);
  }

  window.DpdfXlsx = { parseNumber: parseNumber, build: build, colName: colName, sheetNames: sheetNames };
})();
