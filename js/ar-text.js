/* Doctor PDF — fixes for Arabic text as pdf.js hands it over. One copy, loaded by pdf-to-word, pdf-to-excel
   (before pdf-layout.js), extract-text and edit-pdf. Bump the ?v= in those four pages when this file changes.
   Until 2026-10-09 the same two functions were pasted in three places. */
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
