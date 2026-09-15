/* Doctor PDF — PDF page layout engine (shared by PDF→Word and PDF→Excel).
   Turns pdf.js text + operator lists into lines, paragraphs, real tables (LTR + Arabic/RTL),
   label/value info grids, separator lines and images. Extracted verbatim from pdf-to-word.html.
   Expects the page to define (as top-level let): pagesLines, pagesHLines, pagesImages — buildBlocks() reads them.
   Needs pdf.js (pdfjsLib) loaded first. ⚠️ Contains a control-character regex: edit with a Node script. */
function hx2(n){ n=Math.max(0,Math.min(255,Math.round(n))); return ('0'+n.toString(16)).slice(-2); }
function rgbHex(r,g,b){ return hx2(r)+hx2(g)+hx2(b); }
function nearBlack(hex){ if(!hex) return true; const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16); return r<45&&g<45&&b<45; }
/* walk the page operator list; record the active fill colour at each text-show op */
function extractTextColors(ol){
  const OPS = pdfjsLib.OPS; let cur='000000'; const cols=[];
  const nb = v => v<=1 ? v*255 : v;
  for(let i=0;i<ol.fnArray.length;i++){
    const fn=ol.fnArray[i], a=ol.argsArray[i];
    if(fn===OPS.setFillRGBColor){ cur=rgbHex(nb(a[0]),nb(a[1]),nb(a[2])); }
    else if(fn===OPS.setFillGray){ const v=nb(a[0]); cur=rgbHex(v,v,v); }
    else if(fn===OPS.setFillCMYKColor){ const c=a[0]>1?a[0]/255:a[0],m=a[1]>1?a[1]/255:a[1],y=a[2]>1?a[2]/255:a[2],k=a[3]>1?a[3]/255:a[3]; cur=rgbHex(255*(1-c)*(1-k),255*(1-m)*(1-k),255*(1-y)*(1-k)); }
    else if(fn===OPS.setFillColorN || fn===OPS.setFillColor){ if(a&&a.length>=3&&typeof a[0]==='number'&&typeof a[1]==='number'&&typeof a[2]==='number') cur=rgbHex(nb(a[0]),nb(a[1]),nb(a[2])); }
    else if(fn===OPS.showText || fn===OPS.showSpacedText){ cols.push(cur); }
  }
  return cols;
}

function cleanFontName(raw) {
  if (!raw) return '';
  /* legacy symbol fonts render Unicode (e.g. U+2022 bullet) as tofu boxes in Word -> use default font */
  if (/(symbol|wingdings|webdings|zapfdingbats|dingbats|marlett)/i.test(raw)) return '';
  let n = raw.replace(/^[A-Z]{6}\+/, '');           /* strip subset prefix ABCDEF+ */
  n = n.replace(/[-_,].*$/, '');                     /* drop -Bold / ,Italic etc */
  n = n.replace(/(PSMT|PS|MT|Std|Pro)$/i, '');       /* drop foundry suffixes */
  n = n.replace(/(Bold|Italic|Oblique|Regular|Light|Medium|SemiBold|Black|Heavy)$/i, '');
  n = n.trim();
  const map = {
    arial:'Arial', helvetica:'Arial', arialnova:'Arial', liberationsans:'Arial',
    times:'Times New Roman', timesnewroman:'Times New Roman', liberationserif:'Times New Roman',
    calibri:'Calibri', cambria:'Cambria', verdana:'Verdana', tahoma:'Tahoma',
    georgia:'Georgia', courier:'Courier New', couriernew:'Courier New',
    segoeui:'Segoe UI', cairo:'Cairo', tajawal:'Tajawal', amiri:'Amiri',
    simplifiedarabic:'Simplified Arabic', traditionalarabic:'Traditional Arabic',
    dubai:'Dubai', notonaskharabic:'Noto Naskh Arabic'
  };
  const key = n.toLowerCase().replace(/\s+/g, '');
  return map[key] || n;
}

function extractHLines(ol, pageW){
  const OPS = pdfjsLib.OPS; const out = [];
  for (let i = 0; i < ol.fnArray.length; i++){
    if (ol.fnArray[i] !== OPS.constructPath) continue;
    const ops = ol.argsArray[i][0], args = ol.argsArray[i][1];
    let xs = [], ys = [], k = 0;
    for (const op of ops){
      if (op === OPS.moveTo || op === OPS.lineTo){ xs.push(args[k]); ys.push(args[k+1]); k += 2; }
      else if (op === OPS.rectangle){ const x=args[k],y=args[k+1],w=args[k+2],h=args[k+3]; xs.push(x,x+w); ys.push(y,y+h); k += 4; }
      else if (op === OPS.curveTo){ k += 6; }
    }
    if (!xs.length) continue;
    const minX=Math.min.apply(null,xs), maxX=Math.max.apply(null,xs), minY=Math.min.apply(null,ys), maxY=Math.max.apply(null,ys);
    if ((maxX-minX) > (pageW||595)*0.55 && (maxY-minY) < 4) out.push({ y:(minY+maxY)/2, x0:minX, x1:maxX });
  }
  return out;
}

/* cell text from fragments: rebuild spaces from x-gaps; visual-order Arabic -> logical (reverse, re-flip Latin runs) */
function bidiCellText(frs) {
  const chs = frs.slice().sort((a,b)=>a.x-b.x);
  const t = chs.map(c => c.str).join('');
  const ar = (t.match(/[؀-ۿ]/g)||[]).length;
  const cvis = chs.length>1 && chs[chs.length-1].x > chs[0].x;
  let toks = [];
  for (let k = 0; k < chs.length; k++) {
    if (k>0){ const g = chs[k].x - chs[k-1].x1; if (g > (chs[k].fs||10)*0.18) toks.push(' '); }
    toks.push(chs[k].str);
  }
  if (ar > 0 && cvis) {
    toks.reverse();
    const hA = z => /[؀-ۿ]/.test(z), hL = z => /[A-Za-z0-9]/.test(z);
    let p = 0;
    while (p < toks.length) {
      if (hL(toks[p]) && !hA(toks[p])) {
        let q = p+1; while (q < toks.length && !hA(toks[q])) q++;
        let e = q; while (e > p+1 && toks[e-1].trim() === '') e--;   /* trailing spaces stay between the Latin run and the Arabic */
        const rev = toks.slice(p,e).reverse(); for (let z2=0; z2<rev.length; z2++) toks[p+z2]=rev[z2]; p = q;
      } else p++;
    }
  }
  return toks.join('').replace(/\s+/g, ' ').trim();
}

/* some fonts/producers (Chrome, many Arabic PDFs) map Arabic yeh/heh glyphs to the Persian code points
   ی (U+06CC) / ھ (U+06BE): looks identical but breaks search in Word. Fold them to ي / ه when the page
   is Arabic (has ة) and has no Persian/Urdu-only letters (پ چ ژ گ ڈ ٹ ں ے). */
function foldPersianForms(content) {
  const nf = t => (t && t.normalize) ? t.normalize('NFKC') : (t || '');
  const all = content.items.map(it => nf(it.str)).join('');
  if (!/[\u06CC\u06BE]/.test(all) || !/\u0629/.test(all) || /[\u067E\u0686\u0698\u06AF\u0688\u0679\u06BA\u06D2]/.test(all)) return;
  content.items.forEach(it => { if (typeof it.str === 'string') it.str = nf(it.str).replace(/\u06CC/g, '\u064A').replace(/\u06BE/g, '\u0647'); });
}

/* pdf.js reverses RTL text CHARACTER by character, so a ligature glyph whose ToUnicode is two
   characters (Word's lam-alef "لأ") comes out swapped ("األعمال", "كابالت"). The operator list has
   the glyphs in visual order with each ligature as ONE unit, so we know where every ligature sits
   and which letters surround it, and swap only those occurrences ("ألف", "إلى" stay untouched). */
function fixRtlLigatures(ol, content) {
  const OPS = pdfjsLib.OPS, arRe = /[؀-ۿ]/;
  const units = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    if (fn !== OPS.showText && fn !== OPS.showSpacedText) continue;
    const gl = ol.argsArray[i] && ol.argsArray[i][0];
    if (!Array.isArray(gl)) continue;
    gl.forEach(g => { if (g && typeof g === 'object' && typeof g.unicode === 'string' && g.unicode !== '') units.push(g.unicode); });
  }
  const rev = t => [...t].reverse().join('');
  const isAr = ch => !!ch && arRe.test(ch) && !/\s/.test(ch);
  const fixes = [];
  units.forEach((u, i) => {
    if ([...u].length < 2 || !arRe.test(u)) return;
    /* up to 2 Arabic neighbour glyphs each side; 'edge' = the word ends there */
    const side = dir => { const out = []; let k = i + dir;
      for (; k >= 0 && k < units.length && out.length < 2; k += dir) { if (!isAr(units[k])) break; out.push(units[k]); }
      return { g: out, edge: out.length < 2 }; };
    const L = side(-1), R = side(1);            /* visual left / right */
    /* pdf.js output = reverse(L2 L1 lig R1 R2) = rev(R2) rev(R1) rev(lig) rev(L1) rev(L2) */
    /* a neighbouring ligature may already be fixed (or not yet): accept both spellings of the context */
    const variants = [];
    [true, false].forEach(revNb => {
      const nb = g => ([...g].length > 1 && !revNb) ? g : rev(g);
      const before = R.g.map(nb).reverse().join(''), after = L.g.map(nb).join('');
      const v = { bad: before + rev(u) + after, good: before + u + after };
      if (!variants.some(x => x.bad === v.bad)) variants.push(v);
    });
    fixes.push({ variants, needStart: R.edge, needEnd: L.edge });
  });
  if (!fixes.length) return;
  const items = content.items.filter(it => typeof it.str === 'string' && arRe.test(it.str));
  fixes.forEach(f => {
    for (const v of f.variants) {
      if (v.bad === v.good) return;
      for (const it of items) {
        let from = 0, at;
        while ((at = it.str.indexOf(v.bad, from)) >= 0) {
          const okS = !f.needStart || !isAr(it.str[at - 1]);
          const okE = !f.needEnd || !isAr(it.str[at + v.bad.length]);
          if (okS && okE) { it.str = it.str.slice(0, at) + v.good + it.str.slice(at + v.bad.length); return; }
          from = at + 1;
        }
      }
    }
  });
}

function pageToLines(page, content, pageW, colors) {
  /* 1) collect non-rotated chunks with position + width + style */
  const raw = [];
  const shownCount = content.items.filter(it => it.str !== undefined && it.str !== '').length;
  const useColor = !!(colors && colors.length === shownCount);
  let colorIdx = 0;
  for (const it of content.items) {
    if (it.str === undefined) continue;
    let color = '000000';
    if (it.str !== '') { color = useColor ? (colors[colorIdx] || '000000') : '000000'; colorIdx++; }
    const t = it.transform;
    /* skip rotated watermarks, but KEEP italic/sheared text (italic = c-skew without b-rotation) */
    const sx0 = Math.hypot(t[0], t[1]) || 1;
    const rotAmt = Math.abs(t[1]) / sx0;                        /* rotation: sin(theta), 0..1 */
    const shearAmt = Math.abs(t[2]) / (Math.abs(t[3]) || sx0);  /* italic shear: tan(slant) */
    if (rotAmt > 0.15 || shearAmt > 0.6) continue;
    const skewItal = shearAmt > 0.15;                           /* faux-italic via matrix skew */
    const str = (it.str.normalize ? it.str.normalize('NFKC') : it.str)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (str === '') continue; /* spacing is rebuilt from x-gaps below */
    const fs = Math.abs(t[3]) || Math.abs(t[0]) || it.height || 12;
    let fname = '';
    try { const f = page.commonObjs.get(it.fontName); fname = (f && f.name) || ''; } catch(e) {}
    raw.push({
      str: str, x: t[4], y: t[5], w: it.width || 0, fs: fs,
      fam: cleanFontName(fname), color: color,
      bold: /bold|black|heavy|semib|demib/i.test(fname),
      ital: /italic|oblique/i.test(fname) || skewItal
    });
  }
  /* 2) group chunks into lines by y proximity */
  raw.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let cur = null;
  for (const r of raw) {
    if (!cur || Math.abs(r.y - cur.y) > Math.max(2, r.fs * 0.5)) {
      cur = { chunks: [], y: r.y, fs: r.fs };
      lines.push(cur);
    }
    cur.chunks.push(r);
    if (r.fs > cur.fs) cur.fs = r.fs;
  }
  /* 3) per line: order L->R, rebuild missing spaces from x-gaps, record extents */
  const out = [];
  for (const ln of lines) {
    ln.chunks.sort((a, b) => a.x - b.x);
    const runs = [];
    for (let i = 0; i < ln.chunks.length; i++) {
      const c = ln.chunks[i];
      if (i > 0) {
        const pc = ln.chunks[i - 1];
        const gap = c.x - (pc.x + pc.w);
        const last = runs[runs.length - 1];
        if (gap > c.fs * 4 && last && !/[؀-ۿ]/.test(pc.str) && !/[؀-ۿ]/.test(c.str)) last.str = last.str.replace(/ +$/, '') + ' '.repeat(Math.max(2, Math.min(6, Math.round(gap / (c.fs * 2)))));
        if (gap > c.fs * 0.18 && last && !/\s$/.test(last.str) && !/^\s/.test(c.str)) last.str += ' ';
      }
      var _str = c.str;
      if (_str.length > 0 && _str.trim() === "" && c.w > c.fs * 1.4) {
        var _n = Math.round(c.w / (c.fs * 0.9));
        _str = " ".repeat(Math.max(2, Math.min(6, _n)));
      }
      runs.push({ str: _str, bold: c.bold, ital: c.ital, fs: c.fs, fam: c.fam, color: c.color, x: c.x });
    }
    ln.runs = runs;
    ln.x0 = ln.chunks[0].x;
    ln.x1 = Math.max.apply(null, ln.chunks.map(c => c.x + c.w));
    ln.pageW = pageW || 0;
    /* split the line into CELLS at large (column) gaps for table detection */
    const cells = [];
    let cell = null;
    for (let k = 0; k < ln.chunks.length; k++) {
      const c = ln.chunks[k];
      if (cell && (c.x - cell.x1) > Math.max(c.fs * 2.0, 16)) { cells.push(cell); cell = null; }
      if (!cell) { cell = { x0: c.x, x1: c.x + c.w, chunks: [c] }; }
      else { cell.chunks.push(c); cell.x1 = c.x + c.w; }
    }
    if (cell) cells.push(cell);
    cells.forEach(cl => {
      cl.frags = cl.chunks.map(c => ({ str: c.str, x: c.x, x1: c.x + (c.w||0), fs: c.fs }));
      cl.str = bidiCellText(cl.frags);
      delete cl.chunks;
    });
    ln.cells = cells;
    ln.frags = ln.chunks.map(c => ({ str: c.str, x: c.x, x1: c.x + (c.w||0), fs: c.fs }));
    delete ln.chunks;
    if (ln.runs.some(r => r.str.trim() !== '')) out.push(ln);
  }
  out.forEach(l => { fixVisualArabic(l); mergeRuns(l); });
  return out;
}

/* merge adjacent same-style chunks into single runs */
function mergeRuns(line) {
  const merged = [];
  line.runs.forEach(r => {
    const prev = merged[merged.length-1];
    if (prev && prev.bold === r.bold && prev.ital === r.ital && prev.fam === r.fam && prev.color === r.color && Math.abs(prev.fs - r.fs) < 0.6) {
      prev.str += r.str;
    } else {
      merged.push(r);
    }
  });
  line.runs = merged;
}

/* Legacy Arabic PDFs store glyph chunks in VISUAL (left-to-right) order.
   For Arabic-dominant lines whose chunks advance left→right (x increasing),
   reverse the chunk order to restore logical reading order. Modern PDFs emit
   Arabic logically (x decreasing) and are left untouched. */
function fixVisualArabic(line) {
  if (line.runs.length < 2) return;
  const text = line.runs.map(r=>r.str).join('');
  const arab = (text.match(/[؀-ۿ]/g)||[]).length;
  if (arab === 0) return;
  const xs = line.runs.map(r=>r.x).filter(v=>typeof v === 'number');
  /* only legacy VISUAL-order lines (chunks advance left->right) need reordering */
  if (!(xs.length > 1 && xs[xs.length-1] > xs[0])) return;
  /* reverse to logical base-RTL order (rightmost chunk reads first) */
  const r = line.runs.slice().sort((a,b)=>(typeof b.x==='number'?b.x:-Infinity)-(typeof a.x==='number'?a.x:-Infinity));
  /* bidi: re-flip maximal runs of Latin/number chunks so they read left->right */
  const hasArab = z => /[؀-ۿ]/.test(z);
  const hasLatin = z => /[A-Za-z0-9]/.test(z);
  let i = 0;
  while (i < r.length) {
    if (hasLatin(r[i].str) && !hasArab(r[i].str)) {
      let j = i + 1;
      while (j < r.length && !hasArab(r[j].str)) j++;
      let e = j; while (e > i + 1 && r[e - 1].str.trim() === '') e--;   /* keep trailing space runs in place */
      const seg = r.slice(i, e).reverse();
      for (let k = 0; k < seg.length; k++) r[i + k] = seg[k];
      i = j;
    } else i++;
  }
  line.runs = r;
}

// ══════════════════════════════════════════
// PARAGRAPH BUILDING
// ══════════════════════════════════════════
function lineText(ln){ return ln.runs.map(r=>r.str).join(''); }

function buildParas() {
  const _th = document.getElementById('toggleHeadings'); const detectHeads = _th ? _th.checked : true;
  const sizes = [];
  pagesLines.forEach(pls => pls.forEach(l => sizes.push(l.fs)));
  sizes.sort((a,b)=>a-b);
  const body = sizes.length ? sizes[Math.floor(sizes.length/2)] : 12;

  const out = [];
  pagesLines.forEach((pls, pi) => {
    const rightMax = pls.length ? Math.max.apply(null, pls.map(l=>l.x1)) : 0;
    const leftMin  = pls.length ? Math.min.apply(null, pls.map(l=>l.x0)) : 0;
    const span = Math.max(rightMax - leftMin, 1);
    let cur = null, prev = null, prevEnded = false;
    pls.forEach(ln => {
      const txt = lineText(ln).trim();
      if (!txt) return;
      /* drop tiny fine-print / hidden watermark lines */
      if (ln.fs < body*0.66 && txt.length < 60) return;

      const rtl = /[؀-ۿ]/.test(txt);
      const bigFont = ln.fs >= body*1.22;
      const allBold = ln.runs.length > 0 && ln.runs.every(r => r.bold || r.str.trim()==='');
      const boldHead = allBold && txt.length < 48 && !/[.:؛،]$/.test(txt);
      const isHead = detectHeads && txt.length < 120 && (bigFont || boldHead);
      const level = isHead ? ((ln.fs >= body*1.6) ? 1 : 2) : 0;

      /* alignment from indentation symmetry within the page's own text block */
      const indentL = ln.x0 - leftMin, indentR = rightMax - ln.x1;
      let align = 'left';
      if (indentL > span*0.08 && indentR > span*0.08 && Math.abs(indentL - indentR) < span*0.12) align = 'center';
      else if (rtl) align = 'right';
      else if (indentR < span*0.04 && indentL > span*0.15) align = 'right';

      const gap = prev ? (prev.y - ln.y) : 0;
      const lineH = Math.max(prev ? prev.fs : ln.fs, ln.fs);
      const indent = !!(cur && !rtl && (ln.x0 - cur.x0 > lineH*1.5));
      const split = !cur || isHead || (cur.head !== isHead) || (cur.align !== align)
                    || gap > lineH*1.6 || gap < -2 || prevEnded || indent;

      if (split) {
        cur = { runs: [], head: isHead, level: level, align: align, x0: ln.x0,
                page: pi, firstOfPage: !out.some(pp => pp.page === pi) };
        out.push(cur);
      } else {
        const last = cur.runs[cur.runs.length-1];
        if (last && !/\s$/.test(last.str)) last.str += ' ';
      }
      ln.runs.forEach(r => {
        const last = cur.runs[cur.runs.length-1];
        if (last && last.bold === r.bold && last.ital === r.ital && last.fam === r.fam && last.color === r.color) last.str += r.str;
        else cur.runs.push({ str: r.str, bold: r.bold, ital: r.ital, fs: r.fs, fam: r.fam, color: r.color });
      });
      if (isHead && ln.fs >= body*1.6) cur.level = 1;

      /* a line that stops well before the right margin ends its paragraph */
      prevEnded = isHead || (rightMax > 0 && ln.x1 < rightMax - lineH*2.5);
      prev = ln;
    });
  });
  out.forEach(pp => {
    pp.text = pp.runs.map(r=>r.str).join('');
    pp.rtl = /[؀-ۿ]/.test(pp.text);
  });
  return out.filter(pp => pp.text.trim() !== '');
}

/* 1-D clustering of values within a tolerance -> array of cluster centers */
function cluster1D(vals, tol) {
  const s = vals.slice().sort((a,b)=>a-b);
  const groups = []; let g = null;
  for (const v of s) {
    if (g && (v - g.last) <= tol) { g.sum += v; g.n++; g.last = v; }
    else { g = { sum: v, n: 1, last: v }; groups.push(g); }
  }
  return groups.map(g => g.sum / g.n);
}

/* detect a 2-column label|value info grid (quote header: Client | شركة...) -> {startIdx,endIdx,rows} */
function detectInfoGrid(lines){
  const raw = [];
  for (let i = 0; i < lines.length; i++){
    const cs = lines[i].cells || [];
    if (cs.length === 2 && (cs[1].x0 - cs[0].x0) > 60 && cs[0].str.trim() && cs[1].str.trim()) raw.push(i);
  }
  if (raw.length < 3) return null;
  const med = arr => { const a = arr.slice().sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
  const labelColX = med(raw.map(i => lines[i].cells[0].x0));
  const valColX   = med(raw.map(i => lines[i].cells[1].x0));
  if (valColX - labelColX < 60) return null;
  const inLabel = x => Math.abs(x - labelColX) <= 40;
  const isVal = i => { const cs = lines[i].cells || []; return cs.length>=1 && cs.length<=2 && lineText(lines[i]).trim() && cs.every(c => c.x0 >= labelColX + 45); };
  /* seed at the first label-column 2-cell row (excludes stray right-aligned 2-cell lines like a total) */
  const cand = raw.filter(i => inLabel(lines[i].cells[0].x0));
  if (cand.length < 3) return null;
  let s = cand[0], e = cand[0];
  /* extend forward only, contiguously; STOP at any >=3-cell line (a real material table) */
  while (e + 1 < lines.length) {
    const ni = e + 1, cs = lines[ni].cells || [];
    if (cs.length > 2 || !lineText(lines[ni]).trim()) break;
    if (cand.indexOf(ni) >= 0 || isVal(ni) || inLabel(cs[0].x0)) e = ni; else break;
  }
  const labels = [], vals = [];
  for (let i = s; i <= e; i++){
    const cs = lines[i].cells || [];
    if (cs.length > 2) continue;
    if (inLabel(cs[0].x0)){
      labels.push({ y: lines[i].y, label: cs[0].str.trim(), val: [] });
      for (let k = 1; k < cs.length; k++) if (cs[k].str.trim()) vals.push({ y: lines[i].y, str: cs[k].str.trim() });
    } else if (cs.every(c => c.x0 >= labelColX + 45)) {
      for (const c of cs) if (c.str.trim()) vals.push({ y: lines[i].y, str: c.str.trim() });
    }
  }
  /* an info grid is SMALL with SHORT field-name labels — reject data tables / 2-col page layouts */
  if (labels.length < 3 || labels.length > 8) return null;
  /* a real info grid is DENSE (mostly label/value rows); reject sparse false-positives (e.g. an Arabic certificate body) */
  if ((e - s + 1) > labels.length * 2) return null;
  const medLabelLen = med(labels.map(L => L.label.length));
  if (medLabelLen > 16 || labels.some(L => L.label.length > 34)) return null;
  labels.sort((a,b) => b.y - a.y);
  vals.forEach(v => { let best=null, bd=1e9; labels.forEach(L => { const d=Math.abs(L.y-v.y); if (d<bd){ bd=d; best=L; } }); if (best && bd <= 24) best.val.push(v); });
  const rows = labels.map(L => { L.val.sort((a,b)=>b.y-a.y); return [L.label, L.val.map(v=>v.str).join(' ')]; });
  return { startIdx: s, endIdx: e, rows };
}

/* build an ordered list of paragraph + table blocks for the whole document */
async function extractImages(ol, page, vp){
  const OPS = pdfjsLib.OPS;
  const mul = (m,t)=>[m[0]*t[0]+m[2]*t[1], m[1]*t[0]+m[3]*t[1], m[0]*t[2]+m[2]*t[3], m[1]*t[2]+m[3]*t[3], m[0]*t[4]+m[2]*t[5]+m[4], m[1]*t[4]+m[3]*t[5]+m[5]];
  const getObj = (id)=>{ try{ if(page.objs.has(id)) return page.objs.get(id); }catch(e){} return null; }; /* sync: skip images not immediately ready — never hang on a callback */
  const contentW = 600;
  const out = [];
  let ctm = [1,0,0,1,0,0]; const stack = [];
  for (let k=0;k<ol.fnArray.length;k++){
    const fn = ol.fnArray[k], a = ol.argsArray[k];
    if (fn===OPS.save) stack.push(ctm.slice());
    else if (fn===OPS.restore) ctm = stack.pop() || [1,0,0,1,0,0];
    else if (fn===OPS.transform) ctm = mul(ctm, a);
    else if (fn===OPS.paintImageXObject || fn===OPS.paintJpegXObject){
      try{
        const o = getObj(a[0]); if(!o || !o.bitmap) continue;
        const pw = Math.hypot(ctm[0],ctm[1]), ph = Math.hypot(ctm[2],ctm[3]);
        if (pw < 24 || ph < 24) continue;                 /* skip tiny icons/spacers/rules */
        const top = ctm[5] + ph;                          /* pdf-space top (bottom-up) */
        const bm = o.bitmap;
        const scale = 2;                                   /* ~144dpi for crisp Word output */
        const cw = Math.max(1, Math.round(pw*scale)), chh = Math.max(1, Math.round(ph*scale));
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = chh;
        cv.getContext('2d').drawImage(bm, 0, 0, cw, chh);
        const blob = await new Promise(r=>cv.toBlob(r,'image/png'));
        if (!blob) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const dataUrl = await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); });
        let dispW = Math.round(pw*96/72); if (dispW>contentW) dispW = contentW;
        const dispH = Math.max(1, Math.round(dispW*ph/pw));
        out.push({ bytes, dataUrl, top, bottom: ctm[5], x: ctm[4], dispW, dispH });
      }catch(e){}
    }
  }
  return out;
}

/* ── geometric multi-column table reconstructor ──
   groups fragments into a real grid (columns by x-cluster, rows by y-band),
   so reflowed/wrapped multi-column tables rebuild correctly. */
function fragGroups(l){
  const fr=(l.frags||[]).filter(f=>f.str.trim()!=="").sort((a,b)=>a.x-b.x);
  const g=[]; let cur=null;
  fr.forEach(f=>{ if(cur && f.x-cur.x1 > l.fs*2){ g.push(cur); cur=null; } if(!cur) cur={x:f.x,x1:f.x1}; else cur.x1=f.x1; });
  if(cur) g.push(cur); return g;
}
/* Arabic / bidi table region -> grid built from line CELLS (their text is already bidi-fixed).
   rows = y-bands (wrapped lines merge), columns = overlapping x-ranges, RTL-aware order */
function tableFromCells(reg){
  const fsz=reg[0].fs||11;
  const bands=[]; let cur=null, lastY=null;
  reg.forEach(l=>{ if(!cur || lastY-l.y > fsz*1.5){ cur={lines:[]}; bands.push(cur); } cur.lines.push(l); lastY=l.y; });
  if(bands.length<3) return null;
  /* per band: merge cells of wrapped lines that overlap horizontally */
  const mergeBands=(cellsOf)=>bands.forEach(b=>{
    const cs=[];
    b.lines.forEach(l=>cellsOf(l).forEach(c=>{ if(!c.str.trim()) return;
      const m=cs.find(k=>c.x0<=k.x1 && c.x1>=k.x0);
      if(m){ m.x0=Math.min(m.x0,c.x0); m.x1=Math.max(m.x1,c.x1); m.parts.push({y:l.y,x1:c.x1,str:c.str}); }
      else cs.push({x0:c.x0,x1:c.x1,parts:[{y:l.y,x1:c.x1,str:c.str}]});
    }));
    b.cells=cs;
  });
  mergeBands(l=>l.cells||[]);
  const pad=Math.max(fsz*0.6,4);
  let cols=tableColumns(bands.filter(b=>b.cells.length>=2),pad);
  /* a line cell covering 2+ columns (numbers jammed together) is split by its fragments' columns */
  const splitCells=l=>{ const outC=[]; (l.cells||[]).forEach(c=>{
    const over=cols.filter(k=>Math.min(c.x1,k.x1)-Math.max(c.x0,k.x0)>2);
    if(over.length<2 || !c.frags || c.frags.length<2){ outC.push(c); return; }
    /* split only at real gaps (> 1 em), never inside a word */
    const runs=[]; c.frags.filter(f=>f.str.trim()).sort((a,b)=>a.x-b.x).forEach(f=>{ const r=runs[runs.length-1]; if(r && f.x-r.x1<=(f.fs||fsz)){ r.fr.push(f); r.x1=Math.max(r.x1,f.x1); } else runs.push({x0:f.x,x1:f.x1,fr:[f]}); });
    const g=new Map(); runs.forEach(r=>{ const i=nearestColByEdge(cols,r.x0,r.x1); if(!g.has(i)) g.set(i,[]); r.fr.forEach(f=>g.get(i).push(f)); });
    if(g.size<2){ outC.push(c); return; }
    g.forEach(fr=>outC.push({ x0:Math.min.apply(null,fr.map(f=>f.x)), x1:Math.max.apply(null,fr.map(f=>f.x1)), str:bidiCellText(fr), frags:fr }));
  }); return outC; };
  mergeBands(splitCells);
  /* keep columns that actually receive cells in at least half the rows; re-assign until stable */
  const minRows=Math.max(2,Math.ceil(bands.length*0.5));
  for(let it=0; it<4 && cols.length; it++){
    const use=cols.map(()=>new Set());
    bands.forEach((b,ri)=>b.cells.forEach(c=>use[colIndexFor(cols,c,pad,false)].add(ri)));
    const kept=cols.filter((k,i)=>use[i].size>=minRows);
    if(kept.length===cols.length) break;
    cols=kept;
  }
  if(cols.length<3) return null;
  const grid=bands.map(()=>cols.map(()=>[]));
  const colCells=cols.map(()=>[]);
  bands.forEach((b,ri)=>b.cells.forEach(c=>{ const k=colIndexFor(cols,c,pad,false); c.parts.forEach(p=>grid[ri][k].push(p)); colCells[k].push({x0:c.x0,x1:c.x1,head:ri===0}); }));
  let rows=grid.map(r=>r.map(ps=>ps.sort((a,b)=>(b.y-a.y)||(b.x1-a.x1)).map(p=>p.str).join(' ').replace(/\s+/g,' ').trim()));
  const filled=rows.reduce((n,r)=>n+r.filter(c=>c!=='').length,0);
  const ratio=filled/(rows.length*cols.length);
  const fullRowFrac=rows.filter(r=>r.every(c=>c!=='')).length/rows.length;
  if(!(ratio>=0.7 && fullRowFrac>=0.7 && rows[0].every(c=>c!==''))) return null;
  let al=colCells.map(cc=>colAlignment(cc,fsz));
  const arRe=/[؀-ۿ]/;
  const arRows=rows.filter(r=>r.some(c=>arRe.test(c))).length;
  const rtl=arRows>rows.length/2 || (rows[0].some(c=>arRe.test(c)) && al.filter(a=>a==='right').length>al.filter(a=>a==='left').length);
  al=al.map(a=>a||(rtl?'right':'left'));
  if(rtl){ rows.forEach(r=>r.reverse()); al.reverse(); }
  return { rows:rows, rtl:rtl, aligns:al, colX:cols.map(k=>({x0:k.x0,x1:k.x1})) };
}
/* whole region first; if it isn't one table, split at standalone single-cell lines (titles between tables) */
function cellTables(reg,s){
  const t=tableFromCells(reg);
  if(t){ t.start=s; t.end=s+reg.length-1; return [t]; }
  const out=[]; let a=0;
  const fsz=reg[0].fs||11;
  const isBreak=i=>{ const l=reg[i]; if((l.cells||[]).length>1) return false;
    const up=i>0?reg[i-1].y-l.y:1e9, dn=i<reg.length-1?l.y-reg[i+1].y:1e9; return up>fsz*1.5 && dn>fsz*1.5; };
  for(let i=0;i<=reg.length;i++){
    if(i===reg.length || isBreak(i)){
      if(i>a && i-a<reg.length){ const p=tableFromCells(reg.slice(a,i)); if(p){ p.start=s+a; p.end=s+i-1; out.push(p); } }
      a=i+1;
    }
  }
  return out;
}
function findTables(lines){
  const anchors=lines.map((l,i)=>({i,n:fragGroups(l).length})).filter(a=>a.n>=2);
  const out=[]; let ci=0;
  while(ci<anchors.length){
    let s=anchors[ci].i, e=anchors[ci].i, cj=ci;
    while(cj+1<anchors.length && anchors[cj+1].i-anchors[cj].i<=4){ cj++; e=anchors[cj].i; }
    const reg=lines.slice(s,e+1);
    if(reg.some(l=>/[؀-ۿ]/.test(lineText(l)))){ cellTables(reg,s).forEach(t=>out.push(t)); ci=cj+1; continue; }
    const frags=[]; reg.forEach(l=>(l.frags||[]).forEach(f=>{ if(f.str.trim()!=="") frags.push({x:f.x,y:l.y,str:f.str}); }));
    const fsz=reg[0].fs||11;
    if(frags.length){
      const ys=[...new Set(frags.map(f=>f.y))].sort((a,b)=>b-a);
      const rows=[]; let cur=[ys[0]];
      for(let k=1;k<ys.length;k++){ if(cur[cur.length-1]-ys[k] > fsz*1.5){ rows.push(cur); cur=[ys[k]]; } else cur.push(ys[k]); }
      rows.push(cur);
      const rowOf=y=>rows.findIndex(r=>r.indexOf(y)>=0);
      const xs=frags.map(f=>f.x).sort((a,b)=>a-b);
      let cl=[]; xs.forEach(x=>{ const c=cl.find(c=>Math.abs(c.c-x)<=25); if(c){ c.xs.push(x); c.c=c.xs.reduce((a,b)=>a+b,0)/c.xs.length; } else cl.push({c:x,xs:[x]}); });
      let cols=cl.map(c=>c.c).filter(cx=>{ const rs=new Set(frags.filter(f=>Math.abs(f.x-cx)<=25).map(f=>rowOf(f.y))); return rs.size>=Math.max(2,Math.ceil(rows.length*0.5)); }).sort((a,b)=>a-b);
      if(cols.length>=3 && rows.length>=3){
        const grid=rows.map(()=>cols.map(()=>[]));
        frags.forEach(f=>{ const ri=rowOf(f.y); let cix=0; for(let k=0;k<cols.length;k++) if(f.x>=cols[k]-15) cix=k; grid[ri][cix].push(f); });
        const tbl=grid.map(r=>r.map(c=>c.sort((a,b)=>(b.y-a.y)||(a.x-b.x)).map(f=>f.str).join(" ").replace(/\s+/g," ").trim()));
        const filled=tbl.reduce((n,r)=>n+r.filter(c=>c!=="").length,0);
        const ratio=filled/(rows.length*cols.length);
        const fullRowFrac=tbl.filter(r=>r.every(c=>c!=="")).length/rows.length;
        if(ratio>=0.7 && fullRowFrac>=0.7 && tbl[0].every(c=>c!=="")){
          const rtl=frags.filter(f=>/[؀-ۿ]/.test(f.str)).length > frags.length/2;
          out.push({ start:s, end:e, rows:tbl, rtl:rtl, colX:cols.map((cx,k)=>({x0:cx-15,x1:k+1<cols.length?cols[k+1]-16:cx+400})) });
        }
      }
    }
    ci=cj+1;
  }
  return out;
}

function buildBlocks() {
  const sizes = [];
  pagesLines.forEach(pls => pls.forEach(l => sizes.push(l.fs)));
  sizes.sort((a,b)=>a-b);
  const body = sizes.length ? sizes[Math.floor(sizes.length/2)] : 12;

  /* doc-wide bold frequency: bold only signals a heading when bold is uncommon */
  let boldN = 0, totN = 0;
  pagesLines.forEach(pls => pls.forEach(l => {
    const t = lineText(l).trim(); if (!t) return; totN++;
    if (l.runs.length && l.runs.every(r => r.bold || r.str.trim()==="")) boldN++;
  }));
  const boldFrac = totN ? boldN / totN : 0;

  const blk = [];
  pagesLines.forEach((pls, pi) => {
    const rightMax = pls.length ? Math.max.apply(null, pls.map(l=>l.x1)) : 0;
    const leftMin  = pls.length ? Math.min.apply(null, pls.map(l=>l.x0)) : 0;
    const geo = { rightMax, leftMin, boldFrac };
    /* drop fine-print / watermark lines up front */
    const lines = pls.filter(ln => {
      const t = lineText(ln).trim();
      return t && !(ln.fs < body*0.66 && t.length < 60);
    });

    const processRange = (a, b) => {
      let i = a;
      while (i < b) {
        const multi = lines[i].cells && lines[i].cells.length >= 2;
        let j = i;
        while (j < b && (!!(lines[j].cells && lines[j].cells.length >= 2)) === multi) j++;
        const seg = lines.slice(i, j);
        if (multi && !emitTable(seg, pi, blk, body, geo)) paragraphsFromLines(seg, pi, blk, body, geo);
        else if (!multi) paragraphsFromLines(seg, pi, blk, body, geo);
        i = j;
      }
    };
    const handleSegment = (a, b) => {
      if (b <= a) return;
      const sub = lines.slice(a, b);
      const grid = detectInfoGrid(sub);
      if (grid) {
        processRange(a, a + grid.startIdx);
        blk.push({ type:'table', rows: grid.rows, ncols: 2, rtl: false, infoGrid: true,
                   page: pi, firstOfPage: !blk.some(b2 => b2.page === pi) });
        processRange(a + grid.endIdx + 1, b);
      } else {
        processRange(a, b);
      }
    };
    /* first pass: geometric multi-column tables (LTR from fragments, Arabic from cells) consume their lines */
    let fTables = [];
    try { fTables = findTables(lines).sort((a, b) => a.start - b.start); } catch (e) { fTables = []; }
    let cursor = 0;
    fTables.forEach(t => {
      handleSegment(cursor, t.start);
      blk.push({ type:'table', rows: t.rows, ncols: t.rows[0].length, rtl: !!t.rtl, aligns: t.aligns,
                 colX: t.colX, yTop: lines[t.start].y, yBot: lines[t.end].y,
                 page: pi, firstOfPage: !blk.some(b2 => b2.page === pi) });
      cursor = t.end + 1;
    });
    handleSegment(cursor, lines.length);
  });
  /* attach section-separator horizontal lines as a bottom border on the paragraph just above each */
  pagesLines.forEach((pls, pi) => {
    (pagesHLines[pi] || []).forEach(hl => {
      let best=null, bestD=1e9;
      blk.forEach(b => { if (b.page!==pi || b.type!=='para' || b.yBot==null) return;
        const d = b.yBot - hl.y; if (d>=4 && d<=22 && d<bestD){ bestD=d; best=b; } });
      if (best) best.brBottom = true;
    });
  });
  /* interleave extracted images per page by vertical position */
  const withImg = [];
  for (let _pi = 0; _pi < pagesLines.length; _pi++){
    const pageBlocks = blk.filter(b => b.page === _pi);
    /* group images into rows of side-by-side figures (overlapping vertical extent) */
    const rawImgs = (pagesImages[_pi] || []).slice().sort((a,b)=>b.top-a.top);
    const rows = [];
    rawImgs.forEach(im => {
      const hh = im.top - im.bottom;
      const row = rows.find(r => { const ov = Math.min(r.top, im.top) - Math.max(r.bottom, im.bottom); return ov > Math.min(hh, r.top - r.bottom) * 0.4; });
      if (row){ row.items.push(im); row.top = Math.max(row.top, im.top); row.bottom = Math.min(row.bottom, im.bottom); }
      else rows.push({ top: im.top, bottom: im.bottom, items: [im] });
    });
    const imgBlocks = rows.map(r => { r.items.sort((a,b)=>a.x-b.x); return { type:'image', page:_pi, top:r.top, items: r.items.map(im=>({ bytes:im.bytes, dataUrl:im.dataUrl, dispW:im.dispW, dispH:im.dispH })) }; });
    const res = pageBlocks.slice();
    imgBlocks.forEach(im => {
      let idx = res.findIndex(b => { const by = (b.yTop!=null?b.yTop:b.yBot); return b.type==='para' && by!=null && by < im.top; });
      if (idx < 0) idx = res.length;
      res.splice(idx, 0, im);
    });
    for (const b of res) withImg.push(b);
  }
  return withImg;
}

/* table columns from cell x-ranges: cells whose ranges overlap share a column; two clusters are
   never merged if one row has a cell in each (they are distinct columns in that row) */
function tableColumns(lines, pad) {
  const cl = [];
  const order = lines.map((l, ri) => ({ l, ri })).sort((a, b) => b.l.cells.length - a.l.cells.length);
  order.forEach(({ l, ri }) => {
    l.cells.forEach(c => {
      const hits = cl.filter(k => c.x0 - pad <= k.x1 && c.x1 + pad >= k.x0);
      if (!hits.length) { cl.push({ x0: c.x0, x1: c.x1, rows: new Set([ri]) }); return; }
      let tgt = hits[0];
      for (let h = 1; h < hits.length; h++) {
        const o = hits[h];
        const clash = [...o.rows].some(r => tgt.rows.has(r));
        if (!clash) { tgt.x0 = Math.min(tgt.x0, o.x0); tgt.x1 = Math.max(tgt.x1, o.x1); o.rows.forEach(r => tgt.rows.add(r)); cl.splice(cl.indexOf(o), 1); }
      }
      if (hits.some(h => h !== tgt && cl.indexOf(h) >= 0)) return; /* spans distinct columns */
      if (tgt.rows.has(ri)) {
        /* this row already has a cell here: keep it a separate column */
        const ov = k => Math.min(c.x1, k.x1) - Math.max(c.x0, k.x0);
        const alt = hits.filter(k => cl.indexOf(k) >= 0 && !k.rows.has(ri)).sort((a, b) => ov(b) - ov(a))[0];
        if (alt) tgt = alt; else { cl.push({ x0: c.x0, x1: c.x1, rows: new Set([ri]) }); return; }
      }
      tgt.x0 = Math.min(tgt.x0, c.x0); tgt.x1 = Math.max(tgt.x1, c.x1); tgt.rows.add(ri);
    });
  });
  return cl.sort((a, b) => a.x0 - b.x0).map(k => ({ x0: k.x0, x1: k.x1 }));
}
/* column whose x-range is closest to [x0,x1] (0 when overlapping; ties -> larger overlap) */
function nearestColByEdge(cols, x0, x1) {
  let bi = 0, bd = 1e9;
  cols.forEach((k, i) => { const d = Math.max(k.x0 - x1, x0 - k.x1); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
/* column for a cell: largest overlap, else (unless strict) the nearest column centre */
function colIndexFor(cols, c, pad, strict) {
  let bi = -1, bo = 0;
  cols.forEach((k, i) => { const o = Math.min(c.x1 + pad, k.x1) - Math.max(c.x0 - pad, k.x0); if (o > bo) { bo = o; bi = i; } });
  if (bi >= 0 || strict) return bi;
  const cc = (c.x0 + c.x1) / 2; let bd = 1e9;
  cols.forEach((k, i) => { const d = Math.abs((k.x0 + k.x1) / 2 - cc); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
/* left / right / center: the edge most cells line up on (inliers around the median, so one
   total/footer row can't skew it). '' = no clear signal (e.g. all cells the same width) */
function colAlignment(cells, body) {
  let cs = cells.filter(c => !c.head);
  if (cs.length < 2) cs = cells;
  if (cs.length < 2) return '';
  const ws = cs.map(c => c.x1 - c.x0).sort((p, q) => p - q);
  const tol = Math.max(1.5, Math.min(body * 0.5, ws[Math.floor(ws.length / 2)] * 0.2));
  const inl = f => { const v = cs.map(f).sort((p, q) => p - q); const med = v[Math.floor(v.length / 2)]; return v.filter(x => Math.abs(x - med) <= tol).length; };
  const nl = inl(c => c.x0), nr = inl(c => c.x1), nc = inl(c => (c.x0 + c.x1) / 2);
  const best = Math.max(nl, nr, nc);
  if (best < cs.length * 0.6) return '';
  if (nl === best && nr === best) return '';
  if (nc === best && nl < best && nr < best) return 'center';
  return nl === best ? 'left' : (nr === best ? 'right' : '');
}

/* try to turn a run of multi-cell lines into a table block; returns true if it did */
function emitTable(seg, pi, blk, body, geo) {
  if (seg.length < 3) return false;
  const counts = {};
  seg.forEach(l => counts[l.cells.length] = (counts[l.cells.length]||0) + 1);
  let modeN = 0, modeF = 0;
  Object.keys(counts).forEach(k => { if (counts[k] > modeF) { modeF = counts[k]; modeN = +k; } });
  if (modeN < 2 || modeF < 3) return false;

  /* define columns from the dominant rows by horizontal OVERLAP (alignment-agnostic:
     right-aligned Arabic columns have ragged left edges, centred columns ragged both) */
  const pad = Math.max(body * 0.6, 4);
  const cols = tableColumns(seg.filter(l => l.cells.length === modeN), pad);
  if (cols.length < 2) return false;

  /* a line belongs to the table if >=2 of its cells land in distinct columns */
  const aligns = l => {
    if (l.cells.length !== modeN) return false;
    const hit = new Set();
    l.cells.forEach(c => { const k = colIndexFor(cols, c, pad, true); if (k >= 0) hit.add(k); });
    return hit.size >= Math.min(2, modeN);
  };
  /* longest contiguous run of aligned lines */
  let bestS = 0, bestL = 0, s = -1;
  for (let k = 0; k <= seg.length; k++) {
    if (k < seg.length && aligns(seg[k])) { if (s < 0) s = k; }
    else { if (s >= 0 && (k - s) > bestL) { bestL = k - s; bestS = s; } s = -1; }
  }
  if (bestL < 3) return false;

  const before = seg.slice(0, bestS);
  const rowsLines = seg.slice(bestS, bestS + bestL);
  const after = seg.slice(bestS + bestL);
  if (before.length) paragraphsFromLines(before, pi, blk, body, geo);

  let rows = rowsLines.map(() => new Array(cols.length).fill(''));
  const colCells = cols.map(() => []);
  rowsLines.forEach((l, ri) => {
    l.cells.forEach(c => {
      const k = colIndexFor(cols, c, pad, false);
      rows[ri][k] = rows[ri][k] ? (rows[ri][k] + ' ' + c.str) : c.str;
      colCells[k].push({ x0: c.x0, x1: c.x1, head: ri === 0 });
    });
  });
  /* drop columns that are empty in every row */
  let keep = [];
  for (let c = 0; c < cols.length; c++) { if (rows.some(r => (r[c]||'').trim() !== '')) keep.push(c); }
  if (keep.length < 2) return false;
  rows = rows.map(r => keep.map(c => r[c]));
  const kCells = keep.map(c => colCells[c]);

  /* direction: Arabic-majority rows, OR an Arabic header over right-aligned columns */
  const arRe = /[؀-ۿ]/;
  const rtlCount = rowsLines.filter(l => arRe.test(lineText(l))).length;
  let colAlign = kCells.map(cc => colAlignment(cc, body));
  const rightCols = colAlign.filter(a => a === 'right').length, leftCols = colAlign.filter(a => a === 'left').length;
  const rtl = rtlCount > rowsLines.length / 2 || (rows[0].some(c => arRe.test(c)) && rightCols > leftCols);
  colAlign = colAlign.map(a => a || (rtl ? 'right' : 'left'));
  if (rtl) { rows.forEach(r => r.reverse()); colAlign.reverse(); }
  blk.push({ type:'table', rows: rows, ncols: keep.length, rtl: rtl, aligns: colAlign, page: pi,
             colX: keep.map(c => ({ x0: cols[c].x0, x1: cols[c].x1 })), yTop: rowsLines[0].y, yBot: rowsLines[rowsLines.length - 1].y,
             firstOfPage: !blk.some(b => b.page === pi) });

  if (after.length) paragraphsFromLines(after, pi, blk, body, geo);
  return true;
}

/* paragraph builder for a set of (non-table) lines -> pushes 'para' blocks */
function paragraphsFromLines(lines, pi, blk, body, geo) {
  const rightMax = geo.rightMax, leftMin = geo.leftMin;
  const span = Math.max(rightMax - leftMin, 1);
  const _th = document.getElementById('toggleHeadings'); const detectHeads = _th ? _th.checked : true;
  let cur = null, prev = null, prevEnded = false, prevHead = false;
  lines.forEach(ln => {
    const txt = lineText(ln).trim();
    if (!txt) return;
    const rtl = /[؀-ۿ]/.test(txt);
    const bigFont = ln.fs >= body*1.22;
    const allBold = ln.runs.length > 0 && ln.runs.every(r => r.bold || r.str.trim()==='');
    /* "Label : value" field lines (letterheads) are never headings */
    const looksLikeField = /^[^:：]{1,30}[:：] ./.test(txt);
    /* bold alone signals a heading only when bold is uncommon across the doc */
    const boldUseful = (geo.boldFrac || 0) < 0.4;
    const boldHead = boldUseful && allBold && txt.length < 48 && !looksLikeField && ln.fs > body*1.05 && !/[.:؛،]$/.test(txt);
    const isHead = detectHeads && txt.length < 120 && !looksLikeField && (bigFont || boldHead);
    const level = isHead ? ((ln.fs >= body*1.6) ? 1 : 2) : 0;

    const indentL = ln.x0 - leftMin, indentR = rightMax - ln.x1;
    let align = 'left';
    if (indentL > span*0.08 && indentR > span*0.08 && Math.abs(indentL - indentR) < span*0.12) align = 'center';
    else if (rtl) align = 'right';
    else if (indentR < span*0.04 && indentL > span*0.15) align = 'right';

    const gap = prev ? (prev.y - ln.y) : 0;
    const lineH = Math.max(prev ? prev.fs : ln.fs, ln.fs);
    const indent = !!(cur && !rtl && (ln.x0 - cur.x0 > lineH*1.5));
    /* hanging-indent wrap continuation: slightly indented, not a new bullet/field/heading */
    const isBullet = /^[•‣⁃▪◦●○·*]/.test(txt) || /^[-–] /.test(txt);
    const hangIndent = !!(cur && !rtl && (ln.x0 - cur.x0) > 2 && (ln.x0 - cur.x0) <= lineH*1.5);
    const isContinuation = !isHead && !looksLikeField && !isBullet && hangIndent;
    const split = !cur || isHead || (cur.head !== isHead) || (cur.align !== align)
                  || gap > lineH*1.6 || gap < -2 || (prevEnded && !(isContinuation && !prevHead)) || indent;

    if (split) {
      cur = { type:'para', runs: [], lines: [], head: isHead, level: level, align: align, x0: ln.x0,
              page: pi, firstOfPage: !blk.some(b => b.page === pi), rtl: rtl, yTop: ln.y, yBot: ln.y };
      blk.push(cur);
    } else {
      const last = cur.runs[cur.runs.length-1];
      if (last && !/\s$/.test(last.str)) last.str += ' ';
    }
    ln.runs.forEach(r => {
      const last = cur.runs[cur.runs.length-1];
      if (last && last.bold === r.bold && last.ital === r.ital && last.fam === r.fam && last.color === r.color) last.str += r.str;
      else cur.runs.push({ str: r.str, bold: r.bold, ital: r.ital, fs: r.fs, fam: r.fam, color: r.color });
    });
    cur.lines.push(ln);
    if (isHead && ln.fs >= body*1.6) cur.level = 1;
    if (cur) { cur.yBot = Math.min(cur.yBot, ln.y); cur.yTop = Math.max(cur.yTop, ln.y); }
    prevHead = isHead;
    prevEnded = isHead || (rightMax > 0 && ln.x1 < rightMax - lineH*2.5);
    prev = ln;
  });
  /* finalize text + rtl on the paragraphs we just added */
  blk.forEach(b => { if (b.type==='para' && b.page===pi && b.text===undefined) {
    b.text = b.runs.map(r=>r.str).join('');
    b.rtl = /[؀-ۿ]/.test(b.text);
  }});
}

