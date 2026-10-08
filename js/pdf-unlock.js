/* Doctor PDF — open an owner-locked PDF for editing.
   Shared by the tools that rewrite a file with pdf-lib.

   Many official PDFs (site plans, permits, government forms) are encrypted with an
   owner password: anyone can open and read them, but the file is still encrypted
   inside. pdf-lib cannot decrypt. Loading such a file with ignoreEncryption and
   saving it again gives a file that asks for a password, and copying its pages into
   a new file gives blank pages. So we decrypt it first with qpdf (the engine of the
   Unlock tool), entirely in the browser.

   No password is guessed. A file that needs a password to OPEN cannot be shown by
   the tool in the first place; if qpdf cannot decrypt, load() throws an error whose
   code is 'locked' and the tool tells the visitor. */
(function () {
  var QPDF_JS     = 'https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.js';
  var QPDF_JS_SRI = 'sha384-viHHfnvZlwDzjAQCrTUX3UR1zDr3OW9ItyLOqwH2wTHYHXWK8NdKi5LFp++BT8NL';
  var QPDF_WASM   = 'https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm';
  var script = null;

  function loadScript() {
    if (script) return script;
    script = new Promise(function (res, rej) {
      if (typeof Module === 'function') { res(); return; }
      var sc = document.createElement('script');
      sc.src = QPDF_JS; sc.integrity = QPDF_JS_SRI; sc.crossOrigin = 'anonymous';
      sc.onload  = function () { typeof Module === 'function' ? res() : rej(new Error('qpdf')); };
      sc.onerror = function () { script = null; rej(new Error('qpdf')); };
      document.head.appendChild(sc);
    });
    return script;
  }

  function toBytes(b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }

  /* does the file mention an /Encrypt entry at all? (a cheap first look; pdf-lib's isEncrypted is the real answer) */
  function mentionsEncrypt(b) {
    var u = toBytes(b), k = [47, 69, 110, 99, 114, 121, 112, 116];   /* "/Encrypt" */
    for (var i = 0, n = u.length - k.length; i <= n; i++) {
      if (u[i] !== 47) continue;
      var j = 1;
      while (j < k.length && u[i + j] === k[j]) j++;
      if (j === k.length) return true;
    }
    return false;
  }

  function locked() { var e = new Error(document.documentElement.lang === 'ar' ? 'هذا الملف مقفل ولم نتمكن من فتحه للتعديل. افتح قفله أولاً بأداة «فك قفل PDF».' : 'This PDF is locked and could not be opened for editing. Unlock it first with the Unlock PDF tool.'); e.code = 'locked'; return e; }

  /* the same file, decrypted. Throws (code 'locked') when qpdf cannot do it. */
  async function decrypt(bytes) {
    var out = null;
    try {
      await loadScript();
      var q = await Module({ locateFile: function () { return QPDF_WASM; } });   /* a fresh instance per run */
      q.FS.writeFile('/in.pdf', toBytes(bytes));
      try { q.callMain(['--decrypt', '--', '/in.pdf', '/out.pdf']); } catch (e) {}
      try { out = q.FS.readFile('/out.pdf'); } catch (e) { out = null; }
    } catch (e) { out = null; }
    if (!out || !out.length) throw locked();
    return out;
  }

  /* PDFLib.PDFDocument.load, but an encrypted file is decrypted first.
     Returns the document; doc.dpdfDecrypted is true when a decrypted copy was used. */
  async function load(bytes, opts) {
    opts = opts || {};
    var probe = {}, k;
    for (k in opts) probe[k] = opts[k];
    probe.ignoreEncryption = true;
    var doc = null, err = null;
    try { doc = await PDFLib.PDFDocument.load(bytes, probe); } catch (e) { err = e; }
    if (doc && !doc.isEncrypted) return doc;
    if (!doc && !mentionsEncrypt(bytes)) throw err;      /* broken for another reason */
    var plain = await PDFLib.PDFDocument.load(await decrypt(bytes), opts);
    plain.dpdfDecrypted = true;
    return plain;
  }

  window.DpdfUnlock = { load: load, decrypt: decrypt, mentionsEncrypt: mentionsEncrypt };
})();
