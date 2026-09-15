/* Doctor PDF — animated images, written from scratch (no third-party code).
   Reads animated GIF, APNG and animated WebP into full composited frames; writes animated GIF
   (median-cut palette, optional Floyd–Steinberg dither, changed-rectangle frames), APNG (own PNG
   encoder over the browser's CompressionStream) and animated WebP (frames encoded by the browser,
   container written here). Also a tiny store-only ZIP writer.
   API (window.DpdfAnim):
     detect(bytes)                          -> 'gif' | 'apng' | 'webp' | null   (animated only)
     decodeFrames(blob, {own})              -> { kind, width, height, loop, frames:[{canvas, delay}] }
     encodeGIF(frames, {loop, dither})      -> Blob       frames: [{canvas, delay(ms)}]
     encodeAPNG(frames, {loop})             -> Promise<Blob>
     encodeWebP(frames, {loop, quality})    -> Promise<Blob>
     zip([{name, blob}])                    -> Promise<Blob>
   loop: 0 = forever, n = play n times. */
(function () {
  'use strict';

  /* ── byte helpers ── */
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crcUpdate(c, bytes) { for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return c; }
  function crc32(bytes) { return (crcUpdate(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0; }
  function str4(b, p) { return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); }
  function u16le(b, p) { return b[p] | (b[p + 1] << 8); }
  function u24le(b, p) { return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); }
  function u32le(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function u16be(b, p) { return (b[p] << 8) | b[p + 1]; }
  function u32be(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
  function ascii(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function concat(parts) {
    var n = 0, i; for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0; for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function Bytes() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  Bytes.prototype.need = function (n) {
    if (this.len + n <= this.buf.length) return;
    var c = this.buf.length; while (c < this.len + n) c *= 2;
    var nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  };
  Bytes.prototype.u8 = function (v) { this.need(1); this.buf[this.len++] = v & 0xFF; };
  Bytes.prototype.u16le = function (v) { this.u8(v); this.u8(v >> 8); };
  Bytes.prototype.u24le = function (v) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); };
  Bytes.prototype.u32le = function (v) { this.u8(v); this.u8(v >> 8); this.u8(v >> 16); this.u8(v >>> 24); };
  Bytes.prototype.u32be = function (v) { this.u8(v >>> 24); this.u8(v >> 16); this.u8(v >> 8); this.u8(v); };
  Bytes.prototype.bytes = function (a) { this.need(a.length); this.buf.set(a, this.len); this.len += a.length; };
  Bytes.prototype.str = function (s) { this.bytes(ascii(s)); };
  Bytes.prototype.result = function () { return this.buf.slice(0, this.len); };

  function canvasOf(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function snapshot(ctx, w, h) { var c = canvasOf(w, h); c.getContext('2d').drawImage(ctx.canvas, 0, 0); return c; }
  function normDelay(ms) { return ms > 10 ? ms : 100; }   /* like browsers: 0–10 ms plays at 100 ms */

  /* ── detection (animated only) ── */
  function gifImageCount(b, stopAt) {
    if (b.length < 13) return 0;
    var p = 13, f = b[10], n = 0;
    if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
    while (p < b.length) {
      var t = b[p++];
      if (t === 0x3B) break;
      if (t === 0x21) { p++; while (p < b.length) { var s = b[p++]; if (!s) break; p += s; } }
      else if (t === 0x2C) {
        var fl = b[p + 8]; p += 9; if (fl & 0x80) p += 3 * (1 << ((fl & 7) + 1));
        p++; while (p < b.length) { var z = b[p++]; if (!z) break; p += z; }
        if (++n >= stopAt) break;
      } else break;
    }
    return n;
  }
  function detect(b) {
    if (!b || b.length < 16) return null;
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return gifImageCount(b, 2) > 1 ? 'gif' : null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      for (var p = 8; p + 8 <= b.length;) {
        var len = u32be(b, p), type = str4(b, p + 4);
        if (type === 'acTL') return u32be(b, p + 8) > 1 ? 'apng' : null;
        if (type === 'IDAT') return null;
        p += 12 + len;
      }
      return null;
    }
    if (str4(b, 0) === 'RIFF' && str4(b, 8) === 'WEBP' && str4(b, 12) === 'VP8X') return (b[20] & 0x02) ? 'webp' : null;
    return null;
  }

  /* ── GIF decoder ── */
  function parseGIF(b) {
    var w = u16le(b, 6), h = u16le(b, 8), f = b[10], p = 13, gct = null;
    if (f & 0x80) { var n = 3 * (1 << ((f & 7) + 1)); gct = b.subarray(p, p + n); p += n; }
    var g = { w: w, h: h, loop: 1, frames: [] }, gce = null;
    function sub() {
      var parts = [];
      while (p < b.length) { var s = b[p++]; if (!s) break; parts.push(b.subarray(p, p + s)); p += s; }
      return concat(parts);
    }
    while (p < b.length) {
      var t = b[p++];
      if (t === 0x3B) break;
      if (t === 0x21) {
        var label = b[p++];
        if (label === 0xF9 && b[p] >= 4) {
          var pk = b[p + 1];
          gce = { disposal: (pk >> 2) & 7, trans: (pk & 1) ? b[p + 4] : -1, delay: u16le(b, p + 2) * 10 };
          sub();
        } else if (label === 0xFF && b[p] === 11) {
          var app = String.fromCharCode.apply(null, b.subarray(p + 1, p + 12));
          p += 12;
          var data = sub();
          /* Netscape count = extra repeats (0 = forever) -> total plays */
          if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && data.length >= 3 && data[0] === 1) { var rep = u16le(data, 1); g.loop = rep === 0 ? 0 : rep + 1; }
        } else sub();
      } else if (t === 0x2C) {
        var fx = u16le(b, p), fy = u16le(b, p + 2), fw = u16le(b, p + 4), fh = u16le(b, p + 6), fl = b[p + 8];
        p += 9;
        var lct = null;
        if (fl & 0x80) { var m = 3 * (1 << ((fl & 7) + 1)); lct = b.subarray(p, p + m); p += m; }
        var min = b[p++];
        g.frames.push({ x: fx, y: fy, w: fw, h: fh, pal: lct || gct, interlace: !!(fl & 0x40), min: min, data: sub(),
          delay: gce ? gce.delay : 0, disposal: gce ? gce.disposal : 0, trans: gce ? gce.trans : -1 });
        gce = null;
      } else break;
    }
    return g;
  }

  function lzwDecode(min, data, count) {
    var out = new Uint8Array(count);
    if (min < 2 || min > 11) return out;
    var clear = 1 << min, eoi = clear + 1, size = min + 1, mask = (1 << size) - 1, next = eoi + 1, prev = -1, first = 0;
    var prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (var i = 0; i < clear; i++) suffix[i] = i;
    var acc = 0, bits = 0, dp = 0, op = 0;
    while (op < count) {
      while (bits < size) { if (dp >= data.length) return out; acc |= data[dp++] << bits; bits += 8; }
      var code = acc & mask; acc >>>= size; bits -= size;
      if (code === clear) { size = min + 1; mask = (1 << size) - 1; next = eoi + 1; prev = -1; continue; }
      if (code === eoi) break;
      if (prev === -1) { out[op++] = suffix[code]; prev = code; first = code; continue; }
      var sp = 0, c = code;
      if (code >= next) { stack[sp++] = first; c = prev; }
      while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
      stack[sp++] = c; first = c;
      while (sp > 0 && op < count) out[op++] = stack[--sp];
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first; next++;
        if (next === mask + 1 && size < 12) { size++; mask = (1 << size) - 1; }
      }
      prev = code;
    }
    return out;
  }

  function deinterlace(src, w, h) {
    var out = new Uint8Array(src.length), row = 0;
    [[0, 8], [4, 8], [2, 4], [1, 2]].forEach(function (pass) {
      for (var y = pass[0]; y < h; y += pass[1]) { out.set(src.subarray(row * w, (row + 1) * w), y * w); row++; }
    });
    return out;
  }

  function gifFrames(b) {
    var g = parseGIF(b), W = g.w, H = g.h;
    if (!g.frames.length) throw new Error('Unsupported or damaged image');
    if (!W || !H) { g.frames.forEach(function (f) { W = Math.max(W, f.x + f.w); H = Math.max(H, f.y + f.h); }); }
    var buf = new Uint8ClampedArray(W * H * 4), saved = null, prev = null, frames = [];
    var gray = new Uint8Array(768); for (var i = 0; i < 256; i++) gray[i * 3] = gray[i * 3 + 1] = gray[i * 3 + 2] = i;
    g.frames.forEach(function (fr) {
      if (prev) {
        if (prev.disposal === 2) {
          for (var yy = prev.y; yy < Math.min(H, prev.y + prev.h); yy++)
            for (var xx = prev.x; xx < Math.min(W, prev.x + prev.w); xx++) { var q = (yy * W + xx) * 4; buf[q] = buf[q + 1] = buf[q + 2] = buf[q + 3] = 0; }
        } else if (prev.disposal === 3 && saved) buf.set(saved);
      }
      saved = fr.disposal === 3 ? buf.slice() : null;
      var idx = lzwDecode(fr.min, fr.data, fr.w * fr.h);
      if (fr.interlace) idx = deinterlace(idx, fr.w, fr.h);
      var pal = fr.pal || gray;
      for (var y = 0; y < fr.h; y++) {
        var ty = fr.y + y; if (ty >= H) break;
        for (var x = 0; x < fr.w; x++) {
          var tx = fr.x + x; if (tx >= W) continue;
          var k = idx[y * fr.w + x]; if (k === fr.trans) continue;
          var pi = k * 3; if (pi + 2 >= pal.length) continue;
          var o = (ty * W + tx) * 4;
          buf[o] = pal[pi]; buf[o + 1] = pal[pi + 1]; buf[o + 2] = pal[pi + 2]; buf[o + 3] = 255;
        }
      }
      var c = canvasOf(W, H); c.getContext('2d').putImageData(new ImageData(buf.slice(), W, H), 0, 0);
      frames.push({ canvas: c, delay: normDelay(fr.delay) });
      prev = fr;
    });
    return { kind: 'gif', width: W, height: H, loop: g.loop, frames: frames };
  }

  /* ── APNG decoder ── */
  function pngChunk(type, data) {
    var out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length); out.set(ascii(type), 4); out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }
  var PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  async function apngFrames(b) {
    var p = 8, ihdr = null, pre = [], frames = [], plays = 0, sawIDAT = false;
    while (p + 12 <= b.length) {
      var len = u32be(b, p), type = str4(b, p + 4), d = b.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') ihdr = d;
      else if (type === 'acTL') plays = u32be(d, 4);
      else if (type === 'fcTL') frames.push({ w: u32be(d, 4), h: u32be(d, 8), x: u32be(d, 12), y: u32be(d, 16),
        dn: u16be(d, 20), dd: u16be(d, 22), dispose: d[24], blend: d[25], parts: [] });
      else if (type === 'IDAT') { sawIDAT = true; if (frames.length === 1) frames[0].parts.push(d); }
      else if (type === 'fdAT') { if (frames.length) frames[frames.length - 1].parts.push(d.subarray(4)); }
      else if (type === 'IEND') break;
      else if (!sawIDAT) pre.push(b.subarray(p, p + 12 + len));
      p += 12 + len;
    }
    if (!ihdr || !frames.length) throw new Error('Unsupported or damaged image');
    var W = u32be(ihdr, 0), H = u32be(ihdr, 4);
    var ctx = canvasOf(W, H).getContext('2d'), out = [];
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i];
      if (!fr.parts.length) continue;
      var hdr = ihdr.slice(); new DataView(hdr.buffer).setUint32(0, fr.w); new DataView(hdr.buffer).setUint32(4, fr.h);
      var png = concat([PNG_SIG, pngChunk('IHDR', hdr)].concat(pre, [pngChunk('IDAT', concat(fr.parts)), pngChunk('IEND', new Uint8Array(0))]));
      var bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      var keep = fr.dispose === 2 && i > 0 ? ctx.getImageData(fr.x, fr.y, fr.w, fr.h) : null;
      if (fr.blend === 0) ctx.clearRect(fr.x, fr.y, fr.w, fr.h);
      ctx.drawImage(bmp, fr.x, fr.y);
      if (bmp.close) bmp.close();
      var ms = fr.dd === 0 ? fr.dn * 10 : Math.round(fr.dn * 1000 / fr.dd);
      out.push({ canvas: snapshot(ctx, W, H), delay: normDelay(ms) });
      if (fr.dispose === 1 || (fr.dispose === 2 && i === 0)) ctx.clearRect(fr.x, fr.y, fr.w, fr.h);
      else if (keep) ctx.putImageData(keep, fr.x, fr.y);
    }
    return { kind: 'apng', width: W, height: H, loop: plays, frames: out };
  }

  /* ── animated WebP decoder ── */
  function riffChunk(type, data) {
    var pad = data.length & 1, out = new Uint8Array(8 + data.length + pad);
    out.set(ascii(type), 0); new DataView(out.buffer).setUint32(4, data.length, true); out.set(data, 8);
    return out;
  }
  function riffWebP(chunks) {
    var body = concat(chunks), out = new Uint8Array(12 + body.length);
    out.set(ascii('RIFF'), 0); new DataView(out.buffer).setUint32(4, 4 + body.length, true); out.set(ascii('WEBP'), 8); out.set(body, 12);
    return out;
  }
  function listChunks(b, p, end) {
    var list = [];
    while (p + 8 <= end) {
      var type = str4(b, p), len = u32le(b, p + 4);
      list.push({ type: type, data: b.subarray(p + 8, p + 8 + len) });
      p += 8 + len + (len & 1);
    }
    return list;
  }

  async function webpFrames(b) {
    var W = 0, H = 0, loop = 0, frames = [];
    listChunks(b, 12, b.length).forEach(function (c) {
      var d = c.data;
      if (c.type === 'VP8X') { W = 1 + u24le(d, 4); H = 1 + u24le(d, 7); }
      else if (c.type === 'ANIM') loop = u16le(d, 4);
      else if (c.type === 'ANMF') frames.push({ x: 2 * u24le(d, 0), y: 2 * u24le(d, 3), w: 1 + u24le(d, 6), h: 1 + u24le(d, 9),
        delay: u24le(d, 12), noBlend: !!(d[15] & 2), dispose: !!(d[15] & 1), chunks: listChunks(d, 16, d.length) });
    });
    if (!W || !frames.length) throw new Error('Unsupported or damaged image');
    var ctx = canvasOf(W, H).getContext('2d'), out = [];
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i], alph = null, vp8 = null, vp8l = null;
      fr.chunks.forEach(function (c) { if (c.type === 'ALPH') alph = c.data; else if (c.type === 'VP8 ') vp8 = c.data; else if (c.type === 'VP8L') vp8l = c.data; });
      var file;
      if (vp8l) file = riffWebP([riffChunk('VP8L', vp8l)]);
      else if (vp8 && alph) {
        var x = new Uint8Array(10); x[0] = 0x10; x[4] = (fr.w - 1) & 255; x[5] = ((fr.w - 1) >> 8) & 255; x[6] = ((fr.w - 1) >> 16) & 255;
        x[7] = (fr.h - 1) & 255; x[8] = ((fr.h - 1) >> 8) & 255; x[9] = ((fr.h - 1) >> 16) & 255;
        file = riffWebP([riffChunk('VP8X', x), riffChunk('ALPH', alph), riffChunk('VP8 ', vp8)]);
      } else if (vp8) file = riffWebP([riffChunk('VP8 ', vp8)]);
      else continue;
      var bmp = await createImageBitmap(new Blob([file], { type: 'image/webp' }));
      if (fr.noBlend) ctx.clearRect(fr.x, fr.y, fr.w, fr.h);
      ctx.drawImage(bmp, fr.x, fr.y);
      if (bmp.close) bmp.close();
      out.push({ canvas: snapshot(ctx, W, H), delay: normDelay(fr.delay) });
      if (fr.dispose) ctx.clearRect(fr.x, fr.y, fr.w, fr.h);
    }
    return { kind: 'webp', width: W, height: H, loop: loop, frames: out };
  }

  /* ── native decoder (WebCodecs ImageDecoder) when the browser has one ── */
  async function nativeFrames(buf, kind) {
    if (typeof ImageDecoder === 'undefined') return null;
    var type = kind === 'gif' ? 'image/gif' : kind === 'apng' ? 'image/png' : 'image/webp';
    try {
      if (!(await ImageDecoder.isTypeSupported(type))) return null;
      var dec = new ImageDecoder({ data: buf, type: type });
      await dec.tracks.ready;
      var tr = dec.tracks.selectedTrack, n = tr.frameCount;
      if (!tr.animated || n < 2) { dec.close(); return null; }
      var frames = [], W = 0, H = 0;
      for (var i = 0; i < n; i++) {
        var r = await dec.decode({ frameIndex: i });
        var vf = r.image; W = vf.displayWidth; H = vf.displayHeight;
        var c = canvasOf(W, H); c.getContext('2d').drawImage(vf, 0, 0);
        frames.push({ canvas: c, delay: normDelay(vf.duration ? Math.round(vf.duration / 1000) : 0) });
        vf.close();
      }
      var rep = tr.repetitionCount;
      dec.close();
      return { kind: kind, width: W, height: H, loop: rep === Infinity ? 0 : rep + 1, frames: frames, native: true };
    } catch (e) { return null; }
  }

  async function decodeFrames(blob, opts) {
    opts = opts || {};
    var buf = await blob.arrayBuffer(), b = new Uint8Array(buf), kind = detect(b);
    if (!kind) return null;
    if (!opts.own) { var nat = await nativeFrames(buf.slice(0), kind); if (nat) return nat; }
    if (kind === 'gif') return gifFrames(b);
    if (kind === 'apng') return apngFrames(b);
    return webpFrames(b);
  }

  /* ── colour quantisation: median cut on a 15-bit histogram ── */
  function buildPalette(frames, maxColors) {
    var hist = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    var budget = 2e6, total = 0;
    frames.forEach(function (d) { total += d.length / 4; });
    var step = Math.max(1, Math.floor(total / budget));
    frames.forEach(function (d) {
      for (var i = 0; i < d.length; i += 4 * step) {
        if (d[i + 3] < 128) continue;
        var k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        hist[k]++; sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
      }
    });
    var ids = []; for (var k = 0; k < 32768; k++) if (hist[k]) ids.push(k);
    if (!ids.length) return [[0, 0, 0]];
    function box(list) {
      var b = { ids: list, count: 0, rmin: 31, rmax: 0, gmin: 31, gmax: 0, bmin: 31, bmax: 0 };
      list.forEach(function (id) {
        var r = id >> 10, g = (id >> 5) & 31, bl = id & 31;
        b.count += hist[id];
        if (r < b.rmin) b.rmin = r; if (r > b.rmax) b.rmax = r;
        if (g < b.gmin) b.gmin = g; if (g > b.gmax) b.gmax = g;
        if (bl < b.bmin) b.bmin = bl; if (bl > b.bmax) b.bmax = bl;
      });
      return b;
    }
    var boxes = [box(ids)];
    while (boxes.length < maxColors) {
      var best = -1, score = 0;
      boxes.forEach(function (bx, i) {
        if (bx.ids.length < 2) return;
        var range = Math.max(bx.rmax - bx.rmin, bx.gmax - bx.gmin, bx.bmax - bx.bmin);
        var s = range * Math.sqrt(bx.count);
        if (s > score) { score = s; best = i; }
      });
      if (best < 0) break;
      var bx = boxes[best], rr = bx.rmax - bx.rmin, gr = bx.gmax - bx.gmin, br = bx.bmax - bx.bmin;
      var ch = rr >= gr && rr >= br ? function (id) { return id >> 10; } : gr >= br ? function (id) { return (id >> 5) & 31; } : function (id) { return id & 31; };
      bx.ids.sort(function (a, c) { return ch(a) - ch(c); });
      var half = bx.count / 2, acc = 0, cut = 0;
      for (var j = 0; j < bx.ids.length - 1; j++) { acc += hist[bx.ids[j]]; cut = j + 1; if (acc >= half) break; }
      boxes.splice(best, 1, box(bx.ids.slice(0, cut)), box(bx.ids.slice(cut)));
    }
    return boxes.map(function (bx) {
      var n = 0, r = 0, g = 0, bl = 0;
      bx.ids.forEach(function (id) { n += hist[id]; r += sr[id]; g += sg[id]; bl += sb[id]; });
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });
  }

  function Mapper(palette) {
    var lut = new Int16Array(32768).fill(-1);
    return function (r, g, b) {
      var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3), v = lut[k];
      if (v >= 0) return v;
      var best = 0, bd = 1e9;
      for (var i = 0; i < palette.length; i++) {
        var p = palette[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
        var d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < bd) { bd = d; best = i; }
      }
      lut[k] = best;
      return best;
    };
  }

  /* PSNR (dB) of mapping a frame straight to the palette, on a sample of pixels */
  function paletteError(d, map) {
    var step = Math.max(1, Math.floor(d.length / 4 / 200000)) * 4, se = 0, n = 0;
    for (var i = 0; i < d.length; i += step) {
      if (d[i + 3] < 128) continue;
      var c = map.palette[map(d[i], d[i + 1], d[i + 2])], dr = d[i] - c[0], dg = d[i + 1] - c[1], db = d[i + 2] - c[2];
      se += dr * dr + dg * dg + db * db; n += 3;
    }
    return n ? 10 * Math.log10(65025 / Math.max(se / n, 1e-6)) : 99;
  }

  function indexFrame(d, w, h, map, transIndex, dither) {
    var idx = new Uint8Array(w * h);
    if (!dither) {
      for (var i = 0, p = 0; p < idx.length; i += 4, p++) idx[p] = d[i + 3] < 128 ? transIndex : map(d[i], d[i + 1], d[i + 2]);
      return idx;
    }
    /* Floyd–Steinberg on a working copy */
    var er = new Float32Array(w * 3), nr = new Float32Array(w * 3);
    var pal = map.palette;
    for (var y = 0; y < h; y++) {
      nr.fill(0);
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4, q = x * 3;
        if (d[o + 3] < 128) { idx[y * w + x] = transIndex; continue; }
        var r = Math.max(0, Math.min(255, d[o] + er[q])), g = Math.max(0, Math.min(255, d[o + 1] + er[q + 1])), b = Math.max(0, Math.min(255, d[o + 2] + er[q + 2]));
        var k = map(r | 0, g | 0, b | 0), c = pal[k];
        idx[y * w + x] = k;
        var e0 = r - c[0], e1 = g - c[1], e2 = b - c[2];
        if (x + 1 < w) { er[q + 3] += e0 * 7 / 16; er[q + 4] += e1 * 7 / 16; er[q + 5] += e2 * 7 / 16; }
        if (x > 0) { nr[q - 3] += e0 * 3 / 16; nr[q - 2] += e1 * 3 / 16; nr[q - 1] += e2 * 3 / 16; }
        nr[q] += e0 * 5 / 16; nr[q + 1] += e1 * 5 / 16; nr[q + 2] += e2 * 5 / 16;
        if (x + 1 < w) { nr[q + 3] += e0 / 16; nr[q + 4] += e1 / 16; nr[q + 5] += e2 / 16; }
      }
      var t = er; er = nr; nr = t;
    }
    return idx;
  }

  /* ── GIF encoder ── */
  function lzwEncode(out, idx, min) {
    var clear = 1 << min, eoi = clear + 1, size = min + 1, next = eoi + 1;
    var table = new Map(), acc = 0, bits = 0, block = new Uint8Array(255), bl = 0;
    function byte(v) { block[bl++] = v; if (bl === 255) { out.u8(255); out.bytes(block); bl = 0; } }
    function emit(code) { acc |= code << bits; bits += size; while (bits >= 8) { byte(acc & 255); acc >>>= 8; bits -= 8; } }
    out.u8(min);
    emit(clear);
    var cur = idx[0];
    for (var i = 1; i < idx.length; i++) {
      var k = idx[i], key = cur * 256 + k, hit = table.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur);
      if (next === 4096) { emit(clear); next = eoi + 1; size = min + 1; table.clear(); }
      else { if (next >= (1 << size)) size++; table.set(key, next++); }
      cur = k;
    }
    emit(cur);
    emit(eoi);
    if (bits > 0) byte(acc & 255);
    if (bl) { out.u8(bl); out.bytes(block.subarray(0, bl)); }
    out.u8(0);
  }

  function encodeGIF(frames, opts) {
    opts = opts || {};
    var W = frames[0].canvas.width, H = frames[0].canvas.height;
    var datas = frames.map(function (f) {
      var c = f.canvas;
      if (c.width !== W || c.height !== H) { var n = canvasOf(W, H); n.getContext('2d').drawImage(c, 0, 0, W, H); c = n; }
      return c.getContext('2d').getImageData(0, 0, W, H).data;
    });
    var hasAlpha = datas.some(function (d) { for (var i = 3; i < d.length; i += 4) if (d[i] < 128) return true; return false; });
    var animated = datas.length > 1;
    var reserve = hasAlpha || animated;                       /* index 255 = transparent */
    var palette = buildPalette(datas, reserve ? 255 : 256);
    var map = Mapper(palette); map.palette = palette;
    var T = reserve ? 255 : -1;
    /* dither only still images that would visibly band (flat graphics stay crisp and small) */
    var dither = opts.dither == null ? (!animated && paletteError(datas[0], map) < 38) : !!opts.dither;

    var out = new Bytes();
    out.str('GIF89a'); out.u16le(W); out.u16le(H); out.u8(0xF7); out.u8(0); out.u8(0);
    for (var i = 0; i < 256; i++) { var c = palette[i] || [0, 0, 0]; out.u8(c[0]); out.u8(c[1]); out.u8(c[2]); }
    var loop = opts.loop == null ? 0 : opts.loop;             /* total plays, 0 = forever */
    if (animated && loop !== 1) {                               /* no Netscape block = play once */
      out.u8(0x21); out.u8(0xFF); out.u8(11); out.str('NETSCAPE2.0'); out.u8(3); out.u8(1);
      out.u16le(loop === 0 ? 0 : Math.min(65535, loop - 1)); out.u8(0);
    }

    var prev = null, pending = null;
    function flush(f) {
      out.u8(0x21); out.u8(0xF9); out.u8(4);
      out.u8((f.disposal << 2) | (f.trans >= 0 ? 1 : 0));
      out.u16le(Math.max(2, Math.round(f.delay / 10))); out.u8(f.trans >= 0 ? f.trans : 0); out.u8(0);
      out.u8(0x2C); out.u16le(f.x); out.u16le(f.y); out.u16le(f.w); out.u16le(f.h); out.u8(0);
      lzwEncode(out, f.idx, 8);
    }
    for (var n = 0; n < datas.length; n++) {
      var full = indexFrame(datas[n], W, H, map, T < 0 ? 0 : T, dither);
      var delay = frames[n].delay || 100;
      if (!prev || hasAlpha) {
        /* first frame, or transparency: full frame, restore-to-background before the next */
        if (pending) flush(pending);
        pending = { x: 0, y: 0, w: W, h: H, idx: full, delay: delay, disposal: animated && hasAlpha ? 2 : (animated ? 1 : 0), trans: T };
      } else {
        var x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
          var q = y * W + x; if (full[q] !== prev[q]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (x1 < 0) { pending.delay += delay; continue; }         /* identical frame: extend the previous one */
        flush(pending);
        var fw = x1 - x0 + 1, fh = y1 - y0 + 1, sub = new Uint8Array(fw * fh);
        for (var yy = 0; yy < fh; yy++) for (var xx = 0; xx < fw; xx++) {
          var s = (y0 + yy) * W + x0 + xx;
          sub[yy * fw + xx] = full[s] === prev[s] ? T : full[s];   /* unchanged pixel -> transparent (keeps the old one) */
        }
        pending = { x: x0, y: y0, w: fw, h: fh, idx: sub, delay: delay, disposal: 1, trans: T };
      }
      prev = full;
    }
    if (pending) flush(pending);
    out.u8(0x3B);
    return new Blob([out.result()], { type: 'image/gif' });
  }

  /* ── PNG / APNG encoder ── */
  async function deflate(bytes) {
    var cs = new CompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function filterRows(d, w, h, bpp) {
    var stride = w * bpp, out = new Uint8Array(h * (stride + 1)), prior = new Uint8Array(stride), row = new Uint8Array(stride);
    var cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
    for (var y = 0; y < h; y++) {
      for (var x = 0, s = y * w * 4; x < w; x++, s += 4) {
        var t = x * bpp; row[t] = d[s]; row[t + 1] = d[s + 1]; row[t + 2] = d[s + 2]; if (bpp === 4) row[t + 3] = d[s + 3];
      }
      var bestF = 0, bestSum = Infinity;
      for (var f = 0; f < 5; f++) {
        var c = cand[f], sum = 0;
        for (var i = 0; i < stride; i++) {
          var a = i >= bpp ? row[i - bpp] : 0, b = prior[i], cc = i >= bpp ? prior[i - bpp] : 0, v;
          if (f === 0) v = row[i];
          else if (f === 1) v = row[i] - a;
          else if (f === 2) v = row[i] - b;
          else if (f === 3) v = row[i] - ((a + b) >> 1);
          else { var pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v = row[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
          v &= 255; c[i] = v; sum += v < 128 ? v : 256 - v;
          if (sum >= bestSum) break;
        }
        if (sum < bestSum) { bestSum = sum; bestF = f; }
      }
      var o = y * (stride + 1); out[o] = bestF; out.set(cand[bestF], o + 1);
      var tmp = prior; prior = row; row = tmp;
    }
    return out;
  }

  async function encodeAPNG(frames, opts) {
    opts = opts || {};
    var W = frames[0].canvas.width, H = frames[0].canvas.height;
    var datas = frames.map(function (f) {
      var c = f.canvas;
      if (c.width !== W || c.height !== H) { var n = canvasOf(W, H); n.getContext('2d').drawImage(c, 0, 0, W, H); c = n; }
      return c.getContext('2d').getImageData(0, 0, W, H).data;
    });
    var alpha = datas.some(function (d) { for (var i = 3; i < d.length; i += 4) if (d[i] !== 255) return true; return false; });
    var bpp = alpha ? 4 : 3;
    var ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
    v.setUint32(0, W); v.setUint32(4, H); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
    var parts = [PNG_SIG, pngChunk('IHDR', ihdr)], seq = 0;
    var animated = datas.length > 1;
    if (animated) {
      var ac = new Uint8Array(8); new DataView(ac.buffer).setUint32(0, datas.length); new DataView(ac.buffer).setUint32(4, opts.loop || 0);
      parts.push(pngChunk('acTL', ac));
    }
    for (var n = 0; n < datas.length; n++) {
      var z = await deflate(filterRows(datas[n], W, H, bpp));
      if (animated) {
        var fc = new Uint8Array(26), fv = new DataView(fc.buffer);
        fv.setUint32(0, seq++); fv.setUint32(4, W); fv.setUint32(8, H); fv.setUint32(12, 0); fv.setUint32(16, 0);
        fv.setUint16(20, Math.min(65535, Math.max(1, Math.round(frames[n].delay || 100)))); fv.setUint16(22, 1000);
        fc[24] = 0; fc[25] = 0;
        parts.push(pngChunk('fcTL', fc));
      }
      if (n === 0) parts.push(pngChunk('IDAT', z));
      else { var fd = new Uint8Array(4 + z.length); new DataView(fd.buffer).setUint32(0, seq++); fd.set(z, 4); parts.push(pngChunk('fdAT', fd)); }
    }
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob([concat(parts)], { type: 'image/png' });
  }

  /* ── animated WebP writer (frame bitstreams from the browser / libwebp) ── */
  async function encodeWebP(frames, opts) {
    opts = opts || {};
    var W = frames[0].canvas.width, H = frames[0].canvas.height, q = opts.quality == null ? 0.9 : opts.quality;
    var anmf = [], anyAlpha = false;
    for (var n = 0; n < frames.length; n++) {
      var c = frames[n].canvas;
      if (c.width !== W || c.height !== H) { var s = canvasOf(W, H); s.getContext('2d').drawImage(c, 0, 0, W, H); c = s; }
      var blob = window.DpdfImg ? await window.DpdfImg.encode(c, 'webp', { quality: q }) : await new Promise(function (r) { c.toBlob(r, 'image/webp', q); });
      var b = new Uint8Array(await blob.arrayBuffer());
      if (str4(b, 0) !== 'RIFF' || str4(b, 8) !== 'WEBP') throw new Error('WebP encoding is not available in this browser');
      var keep = listChunks(b, 12, b.length).filter(function (ch) { return ch.type === 'ALPH' || ch.type === 'VP8 ' || ch.type === 'VP8L'; });
      if (keep.some(function (ch) { return ch.type === 'ALPH' || (ch.type === 'VP8L' && (ch.data[4] & 0x10)); })) anyAlpha = true;
      var hdr = new Uint8Array(16), dv = new DataView(hdr.buffer);
      hdr[6] = (W - 1) & 255; hdr[7] = ((W - 1) >> 8) & 255; hdr[8] = ((W - 1) >> 16) & 255;
      hdr[9] = (H - 1) & 255; hdr[10] = ((H - 1) >> 8) & 255; hdr[11] = ((H - 1) >> 16) & 255;
      var ms = Math.min(0xFFFFFF, Math.max(10, Math.round(frames[n].delay || 100)));
      hdr[12] = ms & 255; hdr[13] = (ms >> 8) & 255; hdr[14] = (ms >> 16) & 255; hdr[15] = 0x02;   /* no blend, no dispose */
      anmf.push(riffChunk('ANMF', concat([hdr].concat(keep.map(function (ch) { return riffChunk(ch.type, ch.data); })))));
    }
    var x = new Uint8Array(10);
    x[0] = 0x02 | (anyAlpha ? 0x10 : 0);
    x[4] = (W - 1) & 255; x[5] = ((W - 1) >> 8) & 255; x[6] = ((W - 1) >> 16) & 255;
    x[7] = (H - 1) & 255; x[8] = ((H - 1) >> 8) & 255; x[9] = ((H - 1) >> 16) & 255;
    var anim = new Uint8Array(6); new DataView(anim.buffer).setUint16(4, opts.loop || 0, true);
    return new Blob([riffWebP([riffChunk('VP8X', x), riffChunk('ANIM', anim)].concat(anmf))], { type: 'image/webp' });
  }

  /* ── store-only ZIP ── */
  async function zip(files) {
    var out = new Bytes(), central = new Bytes(), count = 0;
    var now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (var i = 0; i < files.length; i++) {
      var data = new Uint8Array(await files[i].blob.arrayBuffer()), name = new TextEncoder().encode(files[i].name);
      var crc = crc32(data), off = out.len;
      out.u32le(0x04034B50); out.u16le(20); out.u16le(0x0800); out.u16le(0); out.u16le(dosTime); out.u16le(dosDate);
      out.u32le(crc); out.u32le(data.length); out.u32le(data.length); out.u16le(name.length); out.u16le(0);
      out.bytes(name); out.bytes(data);
      central.u32le(0x02014B50); central.u16le(20); central.u16le(20); central.u16le(0x0800); central.u16le(0);
      central.u16le(dosTime); central.u16le(dosDate); central.u32le(crc); central.u32le(data.length); central.u32le(data.length);
      central.u16le(name.length); central.u16le(0); central.u16le(0); central.u16le(0); central.u16le(0); central.u32le(0); central.u32le(off);
      central.bytes(name); count++;
    }
    var cdOff = out.len, cd = central.result();
    out.bytes(cd);
    out.u32le(0x06054B50); out.u16le(0); out.u16le(0); out.u16le(count); out.u16le(count);
    out.u32le(cd.length); out.u32le(cdOff); out.u16le(0);
    return new Blob([out.result()], { type: 'application/zip' });
  }

  window.DpdfAnim = { detect: detect, decodeFrames: decodeFrames, encodeGIF: encodeGIF, encodeAPNG: encodeAPNG,
    encodeWebP: encodeWebP, zip: zip, _crc32: crc32 };
})();
