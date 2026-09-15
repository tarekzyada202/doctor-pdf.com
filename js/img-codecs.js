/* Doctor PDF — image codecs shared by convert-image, image-to-pdf and pdf-to-image.
   Everything runs in the browser. Heavy codecs load on demand from /js/codecs/ (self-hosted):
   AVIF + JPEG XL + WebP (jSquash / Squoosh, Apache-2.0), TIFF decode (UTIF.js MIT + pako MIT/Zlib),
   BMP, ICO and TIFF (multi-page, LZW) writers are implemented here; GIF + animated images live in
   /js/img-anim.js (also our own code).
   API (window.DpdfImg):
     INPUT_ACCEPT                      <input accept> string for every readable format
     isImageFile(file)                 true if we can probably read it
     decode(file|blob, {allPages})     -> [{ canvas, width, height, animated? }]  (TIFF: every page; animated = gif|apng|webp)
     encode(canvas, fmt, {quality})    -> Blob   fmt: jpg png webp avif jxl bmp gif ico tiff
     encodeTiff([canvas...])           -> Blob   multi-page TIFF
     createTiffWriter()                -> { addPage(canvas), pageCount(), finish() -> Blob }
     OUTPUTS                           { fmt: { ext, mime, label } } */
(function () {
  'use strict';
  var BASE = '/js/codecs/';
  var OUTPUTS = {
    jpg:  { ext: 'jpg',  mime: 'image/jpeg', label: 'JPG' },
    png:  { ext: 'png',  mime: 'image/png',  label: 'PNG' },
    webp: { ext: 'webp', mime: 'image/webp', label: 'WebP' },
    avif: { ext: 'avif', mime: 'image/avif', label: 'AVIF' },
    jxl:  { ext: 'jxl',  mime: 'image/jxl',  label: 'JPEG XL' },
    bmp:  { ext: 'bmp',  mime: 'image/bmp',  label: 'BMP' },
    gif:  { ext: 'gif',  mime: 'image/gif',  label: 'GIF' },
    ico:  { ext: 'ico',  mime: 'image/x-icon', label: 'ICO' },
    tiff: { ext: 'tiff', mime: 'image/tiff', label: 'TIFF' }
  };
  var IN_EXT = ['jpg', 'jpeg', 'jfif', 'pjpeg', 'png', 'apng', 'webp', 'gif', 'bmp', 'dib', 'ico', 'cur',
    'svg', 'avif', 'tif', 'tiff', 'jxl'];
  var INPUT_ACCEPT = 'image/*,' + IN_EXT.map(function (e) { return '.' + e; }).join(',');

  /* ── lazy loaders ── */
  var cache = {};
  function once(key, fn) { if (!cache[key]) cache[key] = fn().catch(function (e) { delete cache[key]; throw e; }); return cache[key]; }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function wasmModule(path) {
    return once(path, function () {
      return import(BASE + path).then(function (m) { return m.default({ noInitialRun: true }); });
    });
  }
  function utif() {
    return once('utif', function () {
      return (window.pako ? Promise.resolve() : loadScript(BASE + 'utif/pako_inflate.umd.min.js'))
        .then(function () { return window.UTIF ? null : loadScript(BASE + 'utif/UTIF.js'); })
        .then(function () { return window.UTIF; });
    });
  }
  /* animated images + GIF writer: our own code in /js/img-anim.js */
  function anim() {
    return once('anim', function () {
      return (window.DpdfAnim ? Promise.resolve() : loadScript('/js/img-anim.js')).then(function () { return window.DpdfAnim; });
    });
  }

  /* ── helpers ── */
  function canvasOf(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function fromImageData(id) { var c = canvasOf(id.width, id.height); c.getContext('2d').putImageData(id, 0, 0); return c; }
  function fromBitmap(bm) { var c = canvasOf(bm.width, bm.height); c.getContext('2d').drawImage(bm, 0, 0); if (bm.close) bm.close(); return c; }
  function rgbaOf(canvas) { return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height); }
  function toBlob(canvas, mime, q) { return new Promise(function (res) { canvas.toBlob(res, mime, q); }); }
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

  function sniff(bytes, name, type) {
    var b = bytes;
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0) return 'tiff';
    if (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && b[3] === 0x2A) return 'tiff';
    if (b[0] === 0xFF && b[1] === 0x0A) return 'jxl';
    if (b[4] === 0x4A && b[5] === 0x58 && b[6] === 0x4C && b[7] === 0x20) return 'jxl';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      var brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (/avi[fs]/.test(brand)) return 'avif';
      if (/hei[cmsx]|hev[cx]|mif1|msf1/.test(brand)) return 'heic';
    }
    var head = '';
    for (var i = 0; i < Math.min(b.length, 256); i++) head += String.fromCharCode(b[i]);
    if (/<svg|<\?xml/i.test(head) || type === 'image/svg+xml' || extOf(name) === 'svg') return 'svg';
    return 'native';
  }

  function isImageFile(f) {
    return !!f && ((f.type && f.type.indexOf('image/') === 0) || IN_EXT.indexOf(extOf(f.name)) >= 0);
  }

  /* ── decode ── */
  function decodeNative(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).then(fromBitmap)
        .catch(function () { return decodeViaImg(blob); });
    }
    return decodeViaImg(blob);
  }
  function decodeViaImg(blob, svg) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (svg) { /* SVG without intrinsic size: 1024 on the long side */
          if (!w || !h) { w = 1024; h = 1024; }
          var s = Math.max(1, 1024 / Math.max(w, h)); if (Math.max(w, h) < 1024) { w = Math.round(w * s); h = Math.round(h * s); }
        }
        var c = canvasOf(w, h); c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Unsupported or damaged image')); };
      img.src = url;
    });
  }

  function decode(file, opts) {
    opts = opts || {};
    return file.arrayBuffer().then(function (buf) {
      var kind = sniff(new Uint8Array(buf, 0, Math.min(buf.byteLength, 256)), file.name, file.type);
      var one = function (p) { return p.then(function (c) { return [{ canvas: c, width: c.width, height: c.height }]; }); };
      if (kind === 'heic') return Promise.reject(new Error('HEIC_UNSUPPORTED'));
      if (kind === 'tiff') {
        return utif().then(function (UTIF) {
          var ifds = UTIF.decode(buf).filter(function (d) { return d.t256 && d.t257; });
          if (!ifds.length) throw new Error('Unsupported or damaged image');
          if (!opts.allPages) ifds = ifds.slice(0, 1);
          return ifds.map(function (ifd) {
            UTIF.decodeImage(buf, ifd);
            var rgba = UTIF.toRGBA8(ifd), w = ifd.width, h = ifd.height;
            var c = fromImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h));
            return { canvas: c, width: w, height: h };
          });
        });
      }
      var blob = new Blob([buf], { type: file.type || '' });
      /* GIF / PNG / WebP may be animated: report it (frames are decoded later, only if needed) */
      var head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 64));
      var maybeAnim = (head[0] === 0x47 && head[1] === 0x49) || (head[0] === 0x89 && head[1] === 0x50) ||
        (head[8] === 0x57 && head[9] === 0x45 && head[12] === 0x56 && head[15] === 0x58);
      if (kind === 'native' && maybeAnim) {
        return anim().then(function (A) {
          var ak = A.detect(new Uint8Array(buf));
          return decodeNative(blob).then(function (c) { return [{ canvas: c, width: c.width, height: c.height, animated: ak }]; });
        });
      }
      if (kind === 'svg') return one(decodeViaImg(new Blob([buf], { type: 'image/svg+xml' }), true));
      if (kind === 'jxl' || kind === 'avif') {
        /* native first (Safari/Chrome AVIF, Safari JXL), wasm decoder as fallback */
        var path = kind === 'jxl' ? 'jxl/jxl_dec.js' : 'avif/avif_dec.js';
        return one(decodeNative(new Blob([buf], { type: 'image/' + kind })).catch(function () {
          return wasmModule(path).then(function (m) {
            var id = m.decode(buf);
            if (!id) throw new Error('Unsupported or damaged image');
            return fromImageData(id);
          });
        }));
      }
      return one(decodeNative(blob));
    });
  }

  /* ── encoders ── */
  function withBackground(canvas, color) {
    var c = canvasOf(canvas.width, canvas.height), x = c.getContext('2d');
    x.fillStyle = color || '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
    return c;
  }

  function encodeBMP(canvas) {
    var id = rgbaOf(canvas), w = id.width, h = id.height, d = id.data, alpha = false;
    for (var i = 3; i < d.length; i += 4) { if (d[i] !== 255) { alpha = true; break; } }
    var bpp = alpha ? 32 : 24, row = Math.floor((bpp * w + 31) / 32) * 4, hdr = alpha ? 108 : 40;
    var size = 14 + hdr + row * h, buf = new ArrayBuffer(size), v = new DataView(buf), p = 0;
    v.setUint8(0, 0x42); v.setUint8(1, 0x4D); v.setUint32(2, size, true); v.setUint32(10, 14 + hdr, true);
    v.setUint32(14, hdr, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
    v.setUint16(26, 1, true); v.setUint16(28, bpp, true); v.setUint32(30, alpha ? 3 : 0, true);
    v.setUint32(34, row * h, true); v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
    if (alpha) { /* BITMAPV4HEADER masks + sRGB */
      v.setUint32(54, 0x00FF0000, true); v.setUint32(58, 0x0000FF00, true); v.setUint32(62, 0x000000FF, true);
      v.setUint32(66, 0xFF000000, true); v.setUint32(70, 0x73524742, true);
    }
    var u = new Uint8Array(buf);
    for (var y = 0; y < h; y++) {
      p = 14 + hdr + (h - 1 - y) * row;
      for (var x = 0; x < w; x++) {
        var s = (y * w + x) * 4;
        u[p++] = d[s + 2]; u[p++] = d[s + 1]; u[p++] = d[s];
        if (alpha) u[p++] = d[s + 3];
      }
    }
    return new Blob([buf], { type: 'image/bmp' });
  }

  function encodeICO(canvas) {
    var sizes = [16, 24, 32, 48, 64, 128, 256].filter(function (s) { return s <= Math.max(16, Math.max(canvas.width, canvas.height)); });
    return Promise.all(sizes.map(function (s) {
      var c = canvasOf(s, s), x = c.getContext('2d'), k = Math.min(s / canvas.width, s / canvas.height);
      var w = canvas.width * k, h = canvas.height * k;
      x.imageSmoothingQuality = 'high';
      x.drawImage(canvas, (s - w) / 2, (s - h) / 2, w, h);
      return toBlob(c, 'image/png').then(function (b) { return b.arrayBuffer(); });
    })).then(function (pngs) {
      var n = pngs.length, off = 6 + 16 * n, total = off + pngs.reduce(function (a, b) { return a + b.byteLength; }, 0);
      var buf = new ArrayBuffer(total), v = new DataView(buf), u = new Uint8Array(buf);
      v.setUint16(2, 1, true); v.setUint16(4, n, true);
      pngs.forEach(function (png, i) {
        var s = sizes[i], e = 6 + 16 * i;
        v.setUint8(e, s >= 256 ? 0 : s); v.setUint8(e + 1, s >= 256 ? 0 : s);
        v.setUint16(e + 4, 1, true); v.setUint16(e + 6, 32, true);
        v.setUint32(e + 8, png.byteLength, true); v.setUint32(e + 12, off, true);
        u.set(new Uint8Array(png), off); off += png.byteLength;
      });
      return new Blob([buf], { type: 'image/x-icon' });
    });
  }

  function encodeGIF(canvas) {
    return anim().then(function (A) { return A.encodeGIF([{ canvas: canvas, delay: 0 }], {}); });
  }

  /* TIFF LZW (with early change), one strip per page */
  function lzw(data) {
    var out = [], acc = 0, nbits = 0;
    function put(code, width) { acc = (acc << width) | code; nbits += width; while (nbits >= 8) { out.push((acc >>> (nbits - 8)) & 0xFF); nbits -= 8; } acc &= (1 << nbits) - 1; }
    var dict = new Map(), next = 258, width = 9;
    put(256, width);
    var prefix = -1;
    for (var i = 0; i < data.length; i++) {
      var c = data[i];
      if (prefix < 0) { prefix = c; continue; }
      var key = prefix * 256 + c, hit = dict.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      put(prefix, width);
      dict.set(key, next++);
      if (next + 1 > (1 << width) && width < 12) width++;          /* early change */
      if (next >= 4094) { put(256, width); dict.clear(); next = 258; width = 9; }
      prefix = c;
    }
    if (prefix >= 0) {
      put(prefix, width); next++;
      if (next + 1 > (1 << width) && width < 12) width++;
    }
    put(257, width);
    if (nbits > 0) out.push((acc << (8 - nbits)) & 0xFF);
    return new Uint8Array(out);
  }

  function tiffPage(cv) {
    var id = rgbaOf(cv), d = id.data, alpha = false;
    for (var i = 3; i < d.length; i += 4) { if (d[i] !== 255) { alpha = true; break; } }
    var spp = alpha ? 4 : 3, px = new Uint8Array(id.width * id.height * spp);
    for (var s = 0, t = 0; s < d.length; s += 4) { px[t++] = d[s]; px[t++] = d[s + 1]; px[t++] = d[s + 2]; if (alpha) px[t++] = d[s + 3]; }
    return { w: id.width, h: id.height, spp: spp, data: lzw(px) };
  }
  /* incremental writer: pages are compressed as they're added, so big PDFs don't keep every canvas alive */
  function createTiffWriter() {
    var pages = [];
    return { addPage: function (cv) { pages.push(tiffPage(cv)); }, pageCount: function () { return pages.length; },
      finish: function () { return tiffFromPages(pages); } };
  }
  function encodeTiff(canvases) { return tiffFromPages(canvases.map(tiffPage)); }

  function tiffFromPages(pages) {
    /* layout: header | per page: [strip][bits][ifd] */
    var parts = [], offset = 8;
    var header = new Uint8Array(8); header.set([0x49, 0x49, 0x2A, 0]);
    parts.push(header);
    var ifdOffsets = [], fixups = [];
    pages.forEach(function (pg, n) {
      var stripOff = offset;
      parts.push(pg.data); offset += pg.data.length; if (offset & 1) { parts.push(new Uint8Array(1)); offset++; }
      var bitsOff = offset, bits = new Uint8Array(pg.spp * 2);
      for (var k = 0; k < pg.spp; k++) bits[k * 2] = 8;
      parts.push(bits); offset += bits.length;
      var resOff = offset, res = new Uint8Array(16), rv = new DataView(res.buffer);
      rv.setUint32(0, 72, true); rv.setUint32(4, 1, true); rv.setUint32(8, 72, true); rv.setUint32(12, 1, true);
      parts.push(res); offset += 16;
      var tags = [
        [256, 4, 1, pg.w], [257, 4, 1, pg.h], [258, 3, pg.spp, bitsOff], [259, 3, 1, 5], [262, 3, 1, 2],
        [273, 4, 1, stripOff], [277, 3, 1, pg.spp], [278, 4, 1, pg.h], [279, 4, 1, pg.data.length],
        [282, 5, 1, resOff], [283, 5, 1, resOff + 8], [284, 3, 1, 1], [296, 3, 1, 2]
      ];
      if (pg.spp === 4) tags.push([338, 3, 1, 2]);
      if (pages.length > 1) tags.push([297, 3, 2, 0]);
      tags.sort(function (a, b) { return a[0] - b[0]; });
      var ifd = new Uint8Array(2 + tags.length * 12 + 4), v = new DataView(ifd.buffer);
      v.setUint16(0, tags.length, true);
      tags.forEach(function (tg, i) {
        var e = 2 + i * 12;
        v.setUint16(e, tg[0], true); v.setUint16(e + 2, tg[1], true); v.setUint32(e + 4, tg[2], true);
        if (tg[0] === 297) { v.setUint16(e + 8, n, true); v.setUint16(e + 10, pages.length, true); }
        else if (tg[1] === 3 && tg[2] === 1) v.setUint16(e + 8, tg[3], true);
        else v.setUint32(e + 8, tg[3], true);
      });
      ifdOffsets.push(offset); fixups.push({ view: v, at: 2 + tags.length * 12 });
      parts.push(ifd); offset += ifd.length; if (offset & 1) { parts.push(new Uint8Array(1)); offset++; }
    });
    new DataView(header.buffer).setUint32(4, ifdOffsets[0], true);
    fixups.forEach(function (f, i) { f.view.setUint32(f.at, i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0, true); });
    return new Blob(parts, { type: 'image/tiff' });
  }

  function encode(canvas, fmt, opts) {
    opts = opts || {};
    var q = opts.quality == null ? 0.9 : opts.quality;          /* 0..1 */
    switch (fmt) {
      case 'jpg': case 'jpeg':
        return toBlob(withBackground(canvas, opts.background), 'image/jpeg', q);
      case 'png':
        return toBlob(canvas, 'image/png');
      case 'webp':
        return toBlob(canvas, 'image/webp', q).then(function (b) {
          if (b && b.type === 'image/webp') return b;
          /* Safari can't encode WebP from a canvas: use libwebp */
          return wasmModule('webp/webp_enc.js').then(function (m) {
            var id = rgbaOf(canvas);
            var o = { quality: Math.round(q * 100), target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60,
              filter_sharpness: 0, filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0,
              autofilter: 0, partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 0,
              exact: 0, image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0, near_lossless: 100,
              use_delta_palette: 0, use_sharp_yuv: 0 };
            return new Blob([m.encode(id.data, id.width, id.height, o)], { type: 'image/webp' });
          });
        });
      case 'avif':
        return wasmModule('avif/avif_enc.js').then(function (m) {
          var id = rgbaOf(canvas);
          var o = { quality: Math.round(q * 100), qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 6,
            subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false };
          var out = m.encode(new Uint8Array(id.data.buffer), id.width, id.height, o);
          if (!out) throw new Error('AVIF encoding failed');
          return new Blob([out], { type: 'image/avif' });
        });
      case 'jxl':
        return wasmModule('jxl/jxl_enc.js').then(function (m) {
          var id = rgbaOf(canvas);
          var o = { effort: 7, quality: Math.round(q * 100), progressive: false, epf: -1, lossyPalette: false, decodingSpeedTier: 0,
            photonNoiseIso: 0, lossyModular: false, lossless: false };
          var out = m.encode(id.data, id.width, id.height, o);
          if (!out) throw new Error('JPEG XL encoding failed');
          return new Blob([out], { type: 'image/jxl' });
        });
      case 'bmp': return Promise.resolve(encodeBMP(canvas));
      case 'gif': return encodeGIF(canvas);
      case 'ico': return encodeICO(canvas);
      case 'tif': case 'tiff': return Promise.resolve(encodeTiff([canvas]));
    }
    return Promise.reject(new Error('Unknown format ' + fmt));
  }

  window.DpdfImg = { INPUT_ACCEPT: INPUT_ACCEPT, OUTPUTS: OUTPUTS, isImageFile: isImageFile,
    decode: decode, encode: encode, encodeTiff: encodeTiff, createTiffWriter: createTiffWriter, loadAnim: anim };
})();
