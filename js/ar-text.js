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

/* ── Word + Calibri: letters the file's own character map gets wrong ──────────────────────────────
   Calibri draws many Arabic letter pairs as ONE shape without dots plus separate zero-width dot glyphs
   ("ني" = a shape + a dot above + two dots below; "لى", "مي", "بر" are one shape each). Word's "save as
   PDF" gives every glyph ONE Unicode value, taken from the first word the glyph appeared in, so the
   text of every such file reads wrong in any program ("على" comes out "عل", "التي" comes out "الت").
   The glyph numbers are the font's own and are the same in every file, so the letters can be rebuilt
   from them: a table's "shapes" says which letters a shape stands for with a given set of dots. CALIBRI_AR holds two
   tables, because Calibri (with its Bold and Italics) and Calibri Light number their glyphs differently. Each table
   was learned from PDFs that Word made from known text (test tooling: claude-tools/calibri-ar) and is
   used only for a font named Calibri whose ordinary letters agree with it. */

/* every glyph a page draws, in the order it is drawn: { f: font id, gid, u: the file's text for it, zero: no advance,
   x, y: left end on the baseline (page units), w: its own width, fs: font size on the page, m: the 2x2 part of its matrix } */
function pageGlyphs(ol) {
  const O = pdfjsLib.OPS;
  const mul = (a, b) => [a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1], a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3], a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5]];
  let g = { ctm: [1, 0, 0, 1, 0, 0], f: '', size: 0, dir: 1, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm;
  const out = [];
  const push = () => { stack.push(Object.assign({}, g)); };
  const pop = () => { if (stack.length) g = stack.pop(); };
  const move = (x, y) => { tlm = mul(tlm, [1, 0, 0, 1, x, y]); tm = tlm; };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === O.save) push();
    else if (fn === O.restore) pop();
    else if (fn === O.transform) g.ctm = mul(g.ctm, a);
    else if (fn === O.paintFormXObjectBegin) { push(); if (Array.isArray(a[0]) && a[0].length === 6) g.ctm = mul(g.ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) pop();
    else if (fn === O.beginText) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm; }
    else if (fn === O.setFont) { g.f = a[0]; g.size = Math.abs(a[1]); g.dir = a[1] < 0 ? -1 : 1; }
    else if (fn === O.setCharSpacing) g.tc = a[0];
    else if (fn === O.setWordSpacing) g.tw = a[0];
    else if (fn === O.setHScale) g.th = a[0] / 100;
    else if (fn === O.setLeading) g.tl = -a[0];
    else if (fn === O.setTextRise) g.rise = a[0];
    else if (fn === O.moveText) move(a[0], a[1]);
    else if (fn === O.setLeadingMoveText) { g.tl = a[1]; move(a[0], a[1]); }
    else if (fn === O.setTextMatrix) { tm = [a[0], a[1], a[2], a[3], a[4], a[5]]; tlm = tm; }
    else if (fn === O.nextLine) move(0, g.tl);
    else if (fn === O.showText) {
      const list = a[0];
      if (!Array.isArray(list)) continue;
      let last = null;
      for (const c of list) {
        if (typeof c === 'number') {
          const step = -c / 1000 * g.size * g.th * g.dir;
          if (last) last.back -= step * last.kx;           /* how far the pen stepped back right after the glyph */
          tm = mul(tm, [1, 0, 0, 1, step, 0]); continue;
        }
        if (!c || typeof c !== 'object') continue;
        const M = mul(g.ctm, tm), kx = Math.hypot(M[0], M[1]), ky = Math.hypot(M[2], M[3]);
        const own = (c.width || 0) / 1000 * g.size * g.th;
        const adv = (own / g.th + g.tc + (c.isSpace ? g.tw : 0)) * g.th * g.dir;
        last = { f: g.f, gid: c.originalCharCode, u: typeof c.unicode === 'string' ? c.unicode : '', zero: !c.width,
          x: M[2] * g.rise + M[4], y: M[3] * g.rise + M[5], w: own * kx, fs: g.size * ky, adv: adv * kx, back: 0, kx: kx,
          m: [M[0] * g.size * g.th, M[1] * g.size * g.th, M[2] * g.size, M[3] * g.size] };
        out.push(last);
        tm = mul(tm, [1, 0, 0, 1, adv, 0]);
      }
    }
  }
  return out;
}

/* a zero-width glyph belongs to the letter it is drawn over */
function glyphOver(mark, base) {
  const tol = base.fs * 0.06;
  return Math.abs(mark.y - base.y) < base.fs * 1.2 && mark.x >= base.x - tol && mark.x <= base.x + base.w + tol;
}

/* the letters and marks of a page's glyphs: [{ g: the glyph with an advance, dots: [...], marks: [...] }]. Word draws
   the dots and harakat of a letter just before the letter itself. */
function glyphUnits(glyphs, isDot) {
  const units = []; let wait = [];
  const give = (m, u) => { (isDot(m) ? u.dots : u.marks).push(m); };
  glyphs.forEach(g => {
    if (g.zero) { wait.push(g); return; }
    const u = { g: g, dots: [], marks: [] }, prev = units[units.length - 1];
    wait.forEach(m => { give(m, glyphOver(m, g) ? u : (prev && prev.g.f === m.f && glyphOver(m, prev.g)) ? prev : u); });
    wait = [];
    units.push(u);
  });
  const last = units[units.length - 1];
  if (last) wait.forEach(m => give(m, last));
  return units;
}

/* A blank glyph is not always a gap between words. Word puts a space glyph in front of a run of letters and then steps
   back over it: the pen goes back right after the space, or (in a file another program rewrote) the space starts where
   a letter starts and lies on top of it. Those are left out. A real space may touch the letter next to it, but it does
   not start where that letter starts. */
function ghostSpace(g) { return g.adv > 0 && g.back >= g.adv * 0.7; }
function dropGhostSpaces(units) {
  const sp = u => u.g.u.trim() === '';
  return units.filter(s => !sp(s) || joinPiece(s.g) || !(ghostSpace(s.g) ||
    units.some(o => !sp(o) && o.g.f === s.g.f && Math.abs(o.g.y - s.g.y) < s.g.fs * 0.3 && Math.abs(o.g.x - s.g.x) < s.g.fs * 0.12 &&
      Math.min(o.g.x + o.g.w, s.g.x + s.g.w) - Math.max(o.g.x, s.g.x) >= s.g.w * 0.5)));
}
/* the hair-thin blank pieces Calibri puts between some joined letters to lengthen the join: part of the word, no text */
function joinPiece(g) { return g.u.trim() === '' && g.w < g.fs * 0.1; }

const CALIBRI_AR = [{"anchors":{"3":" ","4709":"آ","4710":"أ","4711":"إ","4712":"ا","4719":"آ","4720":"أ","4721":"إ","4722":"ا","4729":"ب","4730":"ت","4731":"ث","4750":"ب","4751":"ت","4752":"ث","4771":"ب","4772":"ت","4773":"ث","4792":"ب","4793":"ت","4794":"ث","4813":"ج","4814":"ح","4815":"خ","4831":"ج","4832":"ح","4833":"خ","4849":"ج","4850":"ح","4851":"خ","4867":"ج","4868":"ح","4869":"خ","4885":"د","4886":"ذ","4900":"د","4901":"ذ","4915":"ر","4916":"ز","4933":"ر","4934":"ز","4951":"س","4952":"ش","4962":"س","4963":"ش","4973":"س","4974":"ش","4984":"س","4985":"ش","4995":"ص","4996":"ض","5001":"ص","5002":"ض","5007":"ص","5008":"ض","5013":"ص","5014":"ض","5019":"ط","5020":"ظ","5023":"ط","5024":"ظ","5027":"ط","5028":"ظ","5031":"ط","5032":"ظ","5035":"ع","5036":"غ","5043":"ع","5044":"غ","5051":"ع","5052":"غ","5059":"ع","5060":"غ","5067":"ف","5077":"ف","5087":"ف","5097":"ف","5107":"ق","5112":"ق","5117":"ق","5122":"ق","5127":"ك","5147":"ك","5167":"ك","5187":"ك","5211":"ل","5218":"ل","5225":"ل","5232":"ل","5239":"م","5243":"م","5247":"م","5251":"م","5255":"ن","5264":"ن","5273":"ن","5282":"ن","5291":"ه","5295":"ه","5299":"ه","5303":"ه","5307":"ة","5311":"ه","5312":"ة","5317":"ؤ","5318":"و","5334":"ؤ","5335":"و","5352":"ئ","5356":"ى","5357":"ي","5369":"ئ","5373":"ى","5374":"ي","5386":"ئ","5390":"ى","5391":"ي","5433":"ء","5523":"ؤ","5524":"و","5590":"ب","5611":"ي","5623":"ب","5644":"ي","5656":"ب","5677":"ي","5691":"ت","5692":"ث","5711":"ن","5721":"ئ","5725":"ى","5739":"ب","5740":"ت","5741":"ث","5760":"ن","5770":"ئ","5774":"ى","5775":"ي","5788":"ب","5809":"ي","5821":"ب","5842":"ي","5854":"ب","5875":"ي","5887":"ك","5907":"ك","5927":"ك","5947":"ك","5967":"ك","6043":"إ","6045":"إ"},"dots":{"6247":1,"6248":1,"6251":1,"6261":1,"6269":1,"6292":1,"6293":1,"6301":1},"marks":{"4625":"ً","4626":"ٌ","4627":"ٍ","4628":"َ","4629":"ُ","4630":"ِ","4631":"ّ","4632":"ْ","4695":"ٌّ","4696":"ٍّ","4697":"َّ","4698":"ُّ","4699":"ِّ","4701":"ًّ","6157":"ً","6158":"ٌ","6159":"ٍ","6160":"َ","6161":"ُ","6162":"ِ","6163":"ّ","6164":"ْ","6224":"َّ"},"shapes":{"5458":{"":"لآ"},"5459":{"":"لأ"},"5460":{"":"لإ"},"5461":{"":"لا"},"5462":{"":"لآ"},"5463":{"":"لأ"},"5464":{"":"لإ"},"5465":{"":"لا"},"5466":{"":"الله"},"5467":{"":"لله"},"5469":{"":"لله"},"6330":{"":"لا"},"6331":{"":"لا"},"6334":{"":"لا"},"6335":{"":"لا"},"6338":{"6247":[["نر",[[0.75]],[[0.95]]],["ىز",[[0.4]],[[0.55],[0.6]]]],"6248":"تر","6261":"ثر","6269":"ئر","6292":"بر","6293":"ير","6247,6292":"بز","6247,6248":"تز","6247,6261":"ثز","6247,6247":"نز","6247,6293":"يز","6247,6269":"ئز","":"ىر"},"6339":{"6247":"سز","6251":"شر","":"سر","6247,6251":"شز"},"6340":{"6247":"سز","6251":"شر","":"سر","6247,6251":"شز"},"6341":{"6247":[["صز",[[0.3]],[[0.35]]],["ضر",[[0.7]],[[0.8]]]],"":"صر","6247,6247":"ضز"},"6342":{"6247":[["صز",[[0.25]],[[0.35]]],["ضر",[[0.7]],[[0.75]]]],"":"صر","6247,6247":"ضز"},"6348":{"6247":"ىن","6247,6292":"بن","6247,6248":"تن","6247,6261":"ثن","6247,6247":"نن","6247,6293":"ين","6247,6269":"ئن"},"6349":{"6247":"نى","6248":"تى","6261":"ثى","6269":[["ئى",[[0.7]],[[0.9]]],["ىئ",[[0.2]],[[0.3]]]],"6292":"بى","6301":[["يى",[[0.85]],[[0.75]]],["ىي",[[0.5]],[[0.35]]]],"6269,6292":"بئ","6292,6301":"بي","6248,6269":"تئ","6248,6301":"تي","6261,6269":"ثئ","6261,6301":"ثي","6247,6269":"نئ","6247,6301":"ني","6269,6301":[["يئ",[[0.2,0.85]],[[0.3,0.75]]],["ئي",[[0.7,0.5]],[[0.9,0.35]]]],"6301,6301":"يي","6269,6269":"ئئ","":"ىى"},"6350":{"6247":"نى","6248":"تى","6261":"ثى","6269":[["ئى",[[0.65]],[[0.8]]],["ىئ",[[0.15]],[[0.25]]]],"6292":"بى","6293":"يى","6301":"ىي","6269,6292":"بئ","6292,6301":"بي","6248,6269":"تئ","6248,6301":"تي","6261,6269":"ثئ","6261,6301":"ثي","6247,6269":"نئ","6247,6301":"ني","6269,6293":"يئ","6293,6301":"يي","6269,6269":"ئئ","6269,6301":"ئي","":"ىى"},"6352":{"6247":"خى","6269":"حئ","6292":"جى","6301":"حي","6269,6292":"جئ","6292,6301":"جي","":"حى","6247,6269":"خئ","6247,6301":"خي"},"6353":{"6247":"خى","6269":"حئ","6292":"جى","6301":"حي","6269,6292":"جئ","6292,6301":"جي","":"حى","6247,6269":"خئ","6247,6301":"خي"},"6354":{"6251":"شى","6269":"سئ","6301":"سي","":"سى","6251,6269":"شئ","6251,6301":"شي"},"6355":{"6251":"شى","6269":"سئ","6301":"سي","":"سى","6251,6269":"شئ","6251,6301":"شي"},"6356":{"6247":"ضى","6269":"صئ","6301":"صي","":"صى","6247,6269":"ضئ","6247,6301":"ضي"},"6357":{"6247":"ضى","6269":"صئ","6301":"صي","":"صى","6247,6269":"ضئ","6247,6301":"ضي"},"6358":{"6247":"ظى","6269":"طئ","6301":"طي","":"طى","6247,6269":"ظئ","6247,6301":"ظي"},"6359":{"6247":"ظى","6269":"طئ","6301":"طي","":"طى","6247,6269":"ظئ","6247,6301":"ظي"},"6360":{"6247":"غى","6269":"عئ","6301":"عي","":"عى","6247,6269":"غئ","6247,6301":"غي"},"6361":{"6247":"غى","6269":"عئ","6301":"عي","":"عى","6247,6269":"غئ","6247,6301":"غي"},"6362":{"6247":"فى","6248":"قى","6247,6269":"فئ","6247,6301":"في","6248,6269":"قئ","6248,6301":"قي"},"6363":{"6247":"فى","6248":"قى","6247,6269":"فئ","6247,6301":"في","6248,6269":"قئ","6248,6301":"قي"},"6364":{"6269":"كئ","6301":"كي","":"كى"},"6365":{"6269":"كئ","6301":"كي","":"كى"},"6366":{"6269":"كئ","6301":"كي","":"كى"},"6368":{"6269":"لئ","6301":"لي","":"لى"},"6370":{"6269":"لئ","6301":"لي","":"لى"},"6372":{"6269":"مئ","6301":"مي","":"مى"},"6373":{"6269":"مئ","6301":"مي","":"مى"},"6374":{"6269":"هئ","6301":"هي","":"هى"},"6375":{"6269":"هئ","6301":"هي","":"هى"},"6681":{"":"فلله"},"6682":{"":"فلله"}}},{"anchors":{"3":" ","4814":"آ","4815":"أ","4816":"إ","4817":"ا","4824":"آ","4825":"أ","4826":"إ","4827":"ا","4834":"ب","4835":"ت","4836":"ث","4855":"ب","4856":"ت","4857":"ث","4876":"ب","4877":"ت","4878":"ث","4897":"ب","4898":"ت","4899":"ث","4918":"ج","4919":"ح","4920":"خ","4936":"ج","4937":"ح","4938":"خ","4954":"ج","4955":"ح","4956":"خ","4972":"ج","4973":"ح","4974":"خ","4990":"د","4991":"ذ","5005":"د","5006":"ذ","5020":"ر","5021":"ز","5038":"ر","5039":"ز","5056":"س","5057":"ش","5067":"س","5068":"ش","5078":"س","5079":"ش","5089":"س","5090":"ش","5100":"ص","5101":"ض","5106":"ص","5107":"ض","5112":"ص","5113":"ض","5118":"ص","5119":"ض","5124":"ط","5125":"ظ","5128":"ط","5129":"ظ","5132":"ط","5133":"ظ","5136":"ط","5137":"ظ","5140":"ع","5141":"غ","5148":"ع","5149":"غ","5156":"ع","5157":"غ","5164":"ع","5165":"غ","5172":"ف","5182":"ف","5192":"ف","5202":"ف","5212":"ق","5217":"ق","5222":"ق","5227":"ق","5232":"ك","5252":"ك","5272":"ك","5292":"ك","5316":"ل","5323":"ل","5330":"ل","5337":"ل","5344":"م","5348":"م","5352":"م","5356":"م","5360":"ن","5369":"ن","5378":"ن","5387":"ن","5396":"ه","5400":"ه","5404":"ه","5408":"ه","5412":"ة","5416":"ه","5417":"ة","5422":"ؤ","5423":"و","5439":"ؤ","5440":"و","5457":"ئ","5461":"ى","5462":"ي","5474":"ئ","5478":"ى","5479":"ي","5491":"ئ","5495":"ى","5496":"ي","5538":"ء","5628":"ؤ","5629":"و","5695":"ب","5716":"ي","5728":"ب","5749":"ي","5761":"ب","5782":"ي","5796":"ت","5797":"ث","5816":"ن","5826":"ئ","5830":"ى","5844":"ب","5845":"ت","5846":"ث","5865":"ن","5875":"ئ","5879":"ى","5880":"ي","5893":"ب","5914":"ي","5926":"ب","5947":"ي","5959":"ب","5980":"ي","5992":"ك","6012":"ك","6032":"ك","6052":"ك","6072":"ك","6148":"إ","6150":"إ"},"dots":{"6352":1,"6353":1,"6356":1,"6366":1,"6374":1,"6397":1,"6398":1,"6406":1},"marks":{"4730":"ً","4731":"ٌ","4732":"ٍ","4733":"َ","4734":"ُ","4735":"ِ","4736":"ّ","4737":"ْ","4800":"ٌّ","4801":"ٍّ","4802":"َّ","4803":"ُّ","4804":"ِّ","4806":"ًّ","6262":"ً","6263":"ٌ","6264":"ٍ","6265":"َ","6266":"ُ","6267":"ِ","6268":"ّ","6269":"ْ","6329":"َّ"},"shapes":{"5563":{"":"لآ"},"5564":{"":"لأ"},"5565":{"":"لإ"},"5566":{"":"لا"},"5567":{"":"لآ"},"5568":{"":"لأ"},"5569":{"":"لإ"},"5570":{"":"لا"},"5571":{"":"الله"},"5572":{"":"لله"},"5574":{"":"لله"},"6435":{"":"لا"},"6436":{"":"لا"},"6439":{"":"لا"},"6440":{"":"لا"},"6443":{"6352":[["نر",[[0.75]],[[1]]],["ىز",[[0.4],[0.45]],[[0.55],[0.6]]]],"6353":"تر","6366":"ثر","6374":"ئر","6397":"بر","6398":"ير","6352,6397":"بز","6352,6353":"تز","6352,6366":"ثز","6352,6352":"نز","6352,6398":"يز","6352,6374":"ئز","":"ىر"},"6444":{"6352":"سز","6356":"شر","":"سر","6352,6356":"شز"},"6445":{"6352":"سز","6356":"شر","":"سر","6352,6356":"شز"},"6446":{"6352":[["صز",[[0.3]],[[0.35]]],["ضر",[[0.7]],[[0.8]]]],"":"صر","6352,6352":"ضز"},"6447":{"6352":[["صز",[[0.3]],[[0.35]]],["ضر",[[0.7]],[[0.8]]]],"":"صر","6352,6352":"ضز"},"6453":{"6352":"ىن","6352,6397":"بن","6352,6353":"تن","6352,6366":"ثن","6352,6352":"نن","6352,6398":"ين","6352,6374":"ئن"},"6454":{"6352":"نى","6353":"تى","6366":"ثى","6374":[["ئى",[[0.7]],[[0.9]]],["ىئ",[[0.2]],[[0.3]]]],"6397":"بى","6406":[["يى",[[0.85]],[[0.75]]],["ىي",[[0.5]],[[0.35]]]],"6374,6397":"بئ","6397,6406":"بي","6353,6374":"تئ","6353,6406":"تي","6366,6374":"ثئ","6366,6406":"ثي","6352,6374":"نئ","6352,6406":"ني","6374,6406":[["يئ",[[0.2,0.85]],[[0.3,0.75]]],["ئي",[[0.7,0.5]],[[0.9,0.35]]]],"6406,6406":"يي","6374,6374":"ئئ","":"ىى"},"6455":{"6352":"نى","6353":"تى","6366":"ثى","6374":[["ئى",[[0.65]],[[0.8]]],["ىئ",[[0.2]],[[0.25]]]],"6397":"بى","6398":"يى","6406":"ىي","6374,6397":"بئ","6397,6406":"بي","6353,6374":"تئ","6353,6406":"تي","6366,6374":"ثئ","6366,6406":"ثي","6352,6374":"نئ","6352,6406":"ني","6374,6398":"يئ","6398,6406":"يي","6374,6374":"ئئ","6374,6406":"ئي","":"ىى"},"6457":{"6352":"خى","6374":"حئ","6397":"جى","6406":"حي","6374,6397":"جئ","6397,6406":"جي","":"حى","6352,6374":"خئ","6352,6406":"خي"},"6458":{"6352":"خى","6374":"حئ","6397":"جى","6406":"حي","6374,6397":"جئ","6397,6406":"جي","":"حى","6352,6374":"خئ","6352,6406":"خي"},"6459":{"6356":"شى","6374":"سئ","6406":"سي","":"سى","6356,6374":"شئ","6356,6406":"شي"},"6460":{"6356":"شى","6374":"سئ","6406":"سي","":"سى","6356,6374":"شئ","6356,6406":"شي"},"6461":{"6352":"ضى","6374":"صئ","6406":"صي","":"صى","6352,6374":"ضئ","6352,6406":"ضي"},"6462":{"6352":"ضى","6374":"صئ","6406":"صي","":"صى","6352,6374":"ضئ","6352,6406":"ضي"},"6463":{"6352":"ظى","6374":"طئ","6406":"طي","":"طى","6352,6374":"ظئ","6352,6406":"ظي"},"6464":{"6352":"ظى","6374":"طئ","6406":"طي","":"طى","6352,6374":"ظئ","6352,6406":"ظي"},"6465":{"6352":"غى","6374":"عئ","6406":"عي","":"عى","6352,6374":"غئ","6352,6406":"غي"},"6466":{"6352":"غى","6374":"عئ","6406":"عي","":"عى","6352,6374":"غئ","6352,6406":"غي"},"6467":{"6352":"فى","6353":"قى","6352,6374":"فئ","6352,6406":"في","6353,6374":"قئ","6353,6406":"قي"},"6468":{"6352":"فى","6353":"قى","6352,6374":"فئ","6352,6406":"في","6353,6374":"قئ","6353,6406":"قي"},"6469":{"6374":"كئ","6406":"كي","":"كى"},"6470":{"6374":"كئ","6406":"كي","":"كى"},"6471":{"6374":"كئ","6406":"كي","":"كى"},"6473":{"6374":"لئ","6406":"لي","":"لى"},"6475":{"6374":"لئ","6406":"لي","":"لى"},"6477":{"6374":"مئ","6406":"مي","":"مى"},"6478":{"6374":"مئ","6406":"مي","":"مى"},"6479":{"6374":"هئ","6406":"هي","":"هى"},"6480":{"6374":"هئ","6406":"هي","":"هى"},"6786":{"":"فلله"},"6787":{"":"فلله"}}}];

/* Asked before paying for a page's operator list (it can double the time a page takes): does the page use a font that may
   be such a Calibri? pdf.js gives every Calibri the same pair of heights (0.75 above the line, 0.25 below - measured on
   Regular, Bold and Light, from Word 365, Word 2019 and two files other programs had rewritten); Arial, Times and the
   rest have other pairs. A font with that pair that turns out to be something else is remembered and not asked about again. */
function arabicIn(t) {
  for (const ch of t) { const c = ch.codePointAt(0); if ((c >= 0x600 && c <= 0x6FF) || (c >= 0xFB50 && c <= 0xFEFF)) return true; }
  return false;
}
function mayNeedCalibriRepair(content) {
  const other = repairCalibriText.other || {}, latin = repairCalibriText.latin || {}, seen = repairCalibriText.seen || {}, styles = content.styles || {};
  return content.items.some(it => {
    if (!it.fontName || other[it.fontName]) return false;
    const file = seen[it.fontName.split('_f')[0]];
    if (file && !file.calibri && file.without >= 3) return false;      /* three pages asked, no Calibri: this file has none */
    /* a Calibri that was seen writing only Latin, digits or spaces (a book set in another font uses it for its page
       numbers) is asked about again only where it writes Arabic */
    if (latin[it.fontName] && !arabicIn(it.str || '')) return false;
    const s = styles[it.fontName];
    return !s || (Math.abs(s.ascent - 0.75) < 0.006 && Math.abs(s.descent + 0.25) < 0.006);
  });
}

/* Rebuilds the text of a page's Calibri runs from the glyphs themselves. Returns how many glyphs it read differently
   from the file (0 = the file's text was right and nothing was touched). The page's other fonts keep the items pdf.js made.
   repairCalibriText.last = { read: shapes read, missed: shapes with a set of dots the table does not know, changed }. */
async function repairCalibriText(ol, content, page) {
  const nf = t => (t && t.normalize) ? t.normalize('NFKC') : (t || '');
  const all = pageGlyphs(ol);
  const byFont = {};
  all.forEach(g => { (byFont[g.f] = byFont[g.f] || []).push(g); });
  /* A Calibri font is trusted - its glyph numbers are those of one of the tables - when its ordinary glyphs agree with it: every
     one of them when few are seen, four in five otherwise (in a file with harakat Word gets a few ordinary glyphs wrong
     as well, even the space). Trust, once given, holds for the rest of the file. A page is rebuilt only when a trusted
     font's text is wrong on it, and then all the page's Calibri fonts are rebuilt together, because Word draws some
     spaces and the Latin words of an Arabic line with a second Calibri font; that font's file text is used as it is. */
  const trusted = repairCalibriText.trusted || (repairCalibriText.trusted = {});
  const other = repairCalibriText.other || (repairCalibriText.other = {});      /* fonts known not to be this Calibri */
  const names = repairCalibriText.names || (repairCalibriText.names = {});
  const wrong = (g, T) => { T = T || trusted[g.f]; return !!T && T.anchors[g.gid] != null && nf(g.u) !== T.anchors[g.gid]; };
  const family = {};                                                             /* this page's Calibri fonts: id -> style */
  let need = false;
  /* pdf.js may still be loading a font when the operator list is ready: wait for it (three seconds at most) */
  const fontOf = id => new Promise(done => {
    const t = setTimeout(() => done(null), 3000), got = f => { clearTimeout(t); done(f); };
    try { if (page.commonObjs.has(id)) got(page.commonObjs.get(id)); else page.commonObjs.get(id, got); } catch (e) { got(null); }
  });
  for (const id of Object.keys(byFont)) {
    if (other[id]) continue;
    if (names[id] == null) {
      const font = await fontOf(id);
      if (!font) continue;
      names[id] = String(font.name || '');
    }
    if (!/calibri/i.test(names[id])) { other[id] = true; continue; }
    const gl = byFont[id];
    if (!trusted[id]) {
      /* Calibri and Calibri Light number their glyphs differently: the table whose ordinary glyphs agree is the font's */
      let best = 0, seen = 0;
      CALIBRI_AR.forEach(T => {
        const ok = {}, no = {};
        gl.forEach(g => { if (T.anchors[g.gid] != null) (wrong(g, T) ? no : ok)[g.gid] = 1; });
        const a = Object.keys(ok).length, b = Object.keys(no).length;
        seen = Math.max(seen, a + b);
        if (((a >= 3 && b === 0) || (a >= 5 && a >= (a + b) * 0.8)) && a > best) { best = a; trusted[id] = T; }
      });
      if (!trusted[id] && seen >= 20) { other[id] = true; continue; }              /* a Calibri with other glyph numbers */
    }
    family[id] = names[id].replace(/^[A-Z]{6}\+/, '');
    if (!trusted[id] && !gl.some(g => arabicIn(g.u))) (repairCalibriText.latin || (repairCalibriText.latin = {}))[id] = true;      /* see mayNeedCalibriRepair */
    const T = trusted[id];
    if (T && gl.some(g => T.shapes[g.gid] || T.dots[g.gid] || T.marks[g.gid] || wrong(g, T))) need = true;
  }
  /* a file whose first pages were asked about and had no Calibri at all is not asked again (see mayNeedCalibriRepair):
     some files give every page fonts of its own, and each question costs that page's operator list */
  const seen = repairCalibriText.seen || (repairCalibriText.seen = {});
  const file = (Object.keys(byFont)[0] || '').split('_f')[0];        /* font ids are g_d<file>_f<font> */
  if (file) { const e = seen[file] || (seen[file] = { calibri: false, without: 0 }); if (Object.keys(family).length) e.calibri = true; else e.without++; }
  /* a font that wrote text on the page but drew no glyph cannot be repaired either */
  content.items.forEach(it => { if (it.fontName && !byFont[it.fontName]) other[it.fontName] = true; });
  if (!need) return 0;

  const level = g => Math.abs(g.m[1]) < Math.abs(g.m[0]) * 0.02;      /* text that is not turned */
  const isHaraka = t => { for (const ch of t) { const c = ch.charCodeAt(0); if (!((c >= 0x64B && c <= 0x655) || c === 0x670)) return false; } return t !== ''; };
  const st = repairCalibriText.last = { read: 0, missed: 0, changed: 0 };
  const mine = all.filter(g => family[g.f] && level(g));
  mine.forEach(g => { if (wrong(g)) { g.u = trusted[g.f].anchors[g.gid]; st.changed++; } });      /* the table knows these glyphs better than the file */
  const units = dropGhostSpaces(glyphUnits(mine, m => !!(trusted[m.f] && trusted[m.f].dots[m.gid])));
  units.forEach(u => {
    const sh = trusted[u.g.f] ? trusted[u.g.f].shapes[u.g.gid] : null;
    let s = joinPiece(u.g) ? '' : u.g.u;
    if (sh) {
      /* the dots in a fixed order (glyph number, then left to right) and where each sits along the shape */
      const ds = u.dots.map(d => ({ gid: d.gid, dx: (d.x - u.g.x) / u.g.w })).sort((p, q) => (p.gid - q.gid) || (p.dx - q.dx));
      let hit = sh[ds.map(d => d.gid).join(',')];
      if (Array.isArray(hit)) {               /* the same dots can mean different letters: the place of each dot decides */
        /* the slant of the italics moves the dots to the right. Word also makes an italic of its own by leaning the
           upright font (the font is then named plain Calibri), so the lean of the glyph counts as well as the name. */
        const places = (/italic|oblique/i.test(names[u.g.f] || '') || Math.abs(u.g.m[2]) > Math.abs(u.g.m[3]) * 0.15) ? 2 : 1;
        /* a reading lists every place its dots were seen in: the nearest one counts */
        const far = alt => Math.min.apply(null, (alt[places] || alt[1]).map(seen => seen.reduce((sum, dx, i) => sum + Math.abs(dx - ds[i].dx), 0)));
        hit = hit.slice().sort((p, q) => far(p) - far(q))[0][0];
      }
      /* a glyph of several letters counts as wrong even when the file names the right letters: pdf.js hands them over in
         reverse ("الله" comes out "هللا"). Lam-alef is left to the older fix (fixRtlLigatures), as before. */
      if (hit != null) { if (hit !== s || ds.length || ([...hit].length > 1 && !/^ل[اأإآ]$/.test(hit))) st.changed++; s = hit; st.read++; } else st.missed++;
    } else if (u.dots.length) st.changed++;
    /* harakat: each goes after the letter it sits over (a shape of several letters is read right to left along its width) */
    const letters = [...s], after = letters.map(() => '');
    u.marks.forEach(m => {
      const t = (trusted[m.f] && trusted[m.f].marks[m.gid]) || (isHaraka(m.u) ? m.u : '');
      if (t !== m.u) st.changed++;
      if (!t || !letters.length) return;
      const dx = Math.min(0.999, Math.max(0, (m.x - u.g.x) / (u.g.w || 1)));
      after[Math.floor((1 - dx) * letters.length)] += t;
    });
    u.t = letters.map((ch, i) => ch + after[i]).join('');
  });
  if (!st.changed) return 0;        /* the file's own text is right on this page: it stays exactly as pdf.js gave it */

  /* R = Arabic or Hebrew letters, L = Latin letters and digits of either kind (numbers always run left to right), N = the rest */
  const cls = t => { let r = false, l = false;
    for (const ch of t) { const c = ch.codePointAt(0);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x660 && c <= 0x669) || (c >= 0x6F0 && c <= 0x6F9)) l = true;
      else if (c >= 0x590 && c <= 0x8FF && c !== 0x60C && c !== 0x61B && c !== 0x61F && !(c >= 0x64B && c <= 0x655)) r = true; }
    return r ? 'R' : l ? 'L' : 'N'; };
  /* lines: the same size on the same baseline */
  const rows = [];
  units.slice().sort((p, q) => (q.g.y - p.g.y) || (p.g.x - q.g.x)).forEach(u => {
    const row = rows.find(r => Math.abs(r.fs - u.g.fs) < 0.05 && Math.abs(r.y - u.g.y) < r.fs * 0.3);
    if (row) row.units.push(u); else rows.push({ fs: u.g.fs, y: u.g.y, units: [u] });
  });
  const items = [];
  rows.forEach(row => {
    const us = row.units.sort((p, q) => p.g.x - q.g.x);
    const c = us.map(u => cls(u.t));
    const base = c.filter(k => k === 'R').length >= c.filter(k => k === 'L').length ? 'R' : 'L';
    for (let i = 0; i < c.length; i++) {
      if (c[i] !== 'N') continue;
      let p = i - 1; while (p >= 0 && c[p] === 'N') p--;
      let n = i + 1; while (n < c.length && c[n] === 'N') n++;
      const before = p >= 0 ? c[p] : base, after = n < c.length ? c[n] : base;
      for (let k = i; k < n; k++) c[k] = before === after ? before : base;
      i = n - 1;
    }
    /* the style of a blank is the style of the letter before it, so a space does not cut a bold run in two */
    const style = us.map(u => family[u.g.f]);
    us.forEach((u, i) => { if (u.t.trim() === '' && i > 0) style[i] = style[i - 1]; });
    /* one item per stretch of the same direction and style; a gap inside it is a space, a wide gap starts a new item */
    const gapAfter = k => us[k + 1].g.x - (us[k].g.x + us[k].g.w);
    let from = 0;
    for (let i = 1; i <= us.length; i++) {
      const gap = i < us.length ? gapAfter(i - 1) : 0;
      if (i < us.length && c[i] === c[from] && style[i] === style[from] && gap < row.fs * 1.5 && gap > -row.fs * 0.5) continue;
      const seg = us.slice(from, i), a = seg[0].g, z = seg[seg.length - 1].g;
      const parts = [];
      seg.forEach((u, k) => {
        parts.push(u.t);
        if (k < seg.length - 1 && gapAfter(from + k) > row.fs * 0.1 && u.t.trim() !== '' && seg[k + 1].t.trim() !== '') parts.push(' ');
      });
      const str = (c[from] === 'R' ? parts.reverse() : parts).join('');
      const lead = seg.find(u => u.t.trim() !== '') || seg[0];
      items.push({ str: str, dir: c[from] === 'R' ? 'rtl' : 'ltr', width: z.x + z.w - a.x, height: row.fs,
        transform: [a.m[0], a.m[1], a.m[2], a.m[3], a.x, row.y], fontName: lead.g.f, hasEOL: false });
      from = i;
    }
  });
  const turned = it => it.transform && Math.abs(it.transform[1]) >= Math.abs(it.transform[0]) * 0.02;
  content.items = content.items.filter(it => !family[it.fontName] || turned(it)).concat(items);
  return st.changed;
}
