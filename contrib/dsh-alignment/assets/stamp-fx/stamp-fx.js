/*!
 * stamp-fx v3 — rubber-stamp feedback effect. Zero dependencies, plain script.
 *
 * A stamp head drops onto the target, presses, and lifts away to reveal wet ink
 * that dries smoothly; several stamps in a row are one hand working down the list,
 * and an item stamped in two places (a "twin") is struck in both at the same instant.
 * The rng and the original "thump" synthesis are re-implemented from
 * IP, PLEASE (https://github.com/ip-please/ip-please.github.io),
 * MIT License, Copyright (c) 2026 ctnyanya. See NOTICE.md in this folder.
 *
 * Usage:  StampFx.stamp(element, { text: '已发送', color: '#2f62d6' })
 *         StampFx.sequence([{ target: a, twins: [{ target: a2 }] }, { target: b }], { text: '已发送' })
 */
(function (root) {
  'use strict';

  // ---- timing (ms) ----
  const TIMING = Object.freeze({
    approach: 90,   // head comes down, accelerating (ease-in), lands at "contact"
    dwell: 60,      // rubber stays pressed on the paper; ink is laid under it
    lift: 150,      // head lifts away (ease-out), revealing the ink
    gaps: [190, 170, 155, 145, 140], // sequence: contact-to-contact, the hand speeds up
    span: 1200,     // sequence: aim for first contact to last lift within this (gaps shrink; 6 stamps ≈ 1010 ms, unsqueezed)
    minGap: 80,     // ...but gaps never go below this, so very long runs can exceed span
    dip: 150,       // paper gives a whole pixel on contact, holds, and comes back as the head clears the ink
    dry: 1800,      // wet ink dries (starts when the head begins to lift); every pixel interpolated every frame
    press: 220,     // button sink (pressOn)
    fade: 160,      // reduced motion: ink fade-in
    rmDelay: 50,    // reduced motion: delay before the fade
    rmStep: 80,     // reduced motion: stagger between strikes in a sequence
    slam: 600,      // big transient mark
  });
  const COLORS = Object.freeze({
    green: 'rgb(42, 110, 53)',
    red: 'rgb(191, 44, 44)',
    blue: 'rgb(47, 98, 214)',
    amber: 'rgb(163, 95, 0)',
    ink: 'rgb(68, 73, 81)',
    greenLight: 'rgb(122, 178, 98)',
    redLight: 'rgb(222, 92, 76)',
  });
  // Chinese: a heavy Song (serif) face, the classic seal / official-stamp look. Latin and digits: a condensed
  // DIN-style grotesque, the look of punched date stamps.
  // - "StampFx Serif" is embedded below: Noto Serif SC (© 2017-2023 Adobe, SIL Open Font License 1.1 — full text in
  //   OFL.txt next to this file and in the font's name table; no Reserved Font Name), instanced at weight 900 and subset
  //   to the fixed stamp words 已发送回复确认待修改暂缓放弃恢复 (4.5 KB woff2). It is used only when every CJK character of
  //   a line is in the subset; any other line (option names) uses the system chain as a whole — Noto Serif SC / Source
  //   Han Serif SC when installed (not part of a default Windows install), else Songti / SimSun — so one stamp never
  //   mixes weights.
  // - Bahnschrift is a Windows system font (Windows 10+), used only by name, never bundled; elsewhere DIN / Arial Narrow.
  const SERIF_WOFF2 = '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';
  if (typeof FontFace === 'function' && typeof document !== 'undefined' && document.fonts) {
    const bin = atob(SERIF_WOFF2), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    // an ArrayBuffer source is parsed synchronously, so canvas can use it on the very first stamp
    document.fonts.add(new FontFace('StampFx Serif', buf.buffer, { weight: '900' }));
  }
  const SERIF_CHARS = '已发送回复确认待修改暂缓放弃恢复';
  const FONTS = Object.freeze({
    cjk: '"StampFx Serif", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", SimSun, serif',
    latin: 'Bahnschrift, "DIN Alternate", "DIN Condensed", "Arial Narrow", "Roboto Condensed", sans-serif',
  });
  const DEFAULTS = Object.freeze({
    text: '',
    sub: '',            // optional second line (dates and codes read best: Latin / digits font)
    color: COLORS.green,
    size: 18,           // main line height in CSS px (sub line = 0.42 × size, min 9)
    maxWidth: 200,      // CSS px; longer text shrinks to 0.72 × size, then is cut with an ellipsis (full text stays in aria-label)
    font: FONTS.cjk,    // used for CJK characters
    latin: FONTS.latin, // used for Latin letters, digits and punctuation
    grain: 1,           // ink texture cell in CSS px; 1 = fine rubber grain
    speckle: 0.08,      // how much ink misses (more where pressure is low)
    pressure: 0.35,     // 0..1, how uneven the pressure across the mark is
    seed: null,         // texture / tilt / offset seed; null = new random look every time
    at: null,           // { x, y } as 0..1 of target box; null = centre
    align: 'center',    // 'center': at is the mark's centre; 'right': at is the middle of its right edge
    nudge: null,        // { x, y } extra CSS px offset of the mark centre
    inset: 10,          // spill: false only — min px between the (rotated) mark and the target edge
    spill: false,       // true: the mark may overhang the target and print over the text around it
    blend: 'multiply',  // mix-blend-mode of the ink layer, so text printed over stays readable
    rotate: 0,          // degrees, fixed part of the tilt
    jitter: 2,          // max random tilt in degrees; offset up to 0.75 px per degree
    hand: true,         // show the stamp head
    dip: 1,             // whole px the paper (shakeOn) gives under the hit; 0 disables
    shakeOn: null,      // element that gives under the hit; null = target
    pressOn: null,      // element that sinks while the stamp is down (e.g. the clicked button)
    pressDepth: 3,      // px
    sound: false,       // false | true | 'approve' | 'deny'
    volume: 0.5,
    replace: true,      // remove earlier marks on this target first
    instant: false,     // place the mark with no animation and no sound (dry, or still drying: dryLeft)
    dryLeft: 0,         // instant only: ms of drying still to go (a re-render mid-dry keeps drying in step)
    reducedMotion: null // null = follow prefers-reduced-motion; true/false to force
  });

  // ---- deterministic rng (mulberry32 variant from the original sfx.js) ----
  function rng(seed) {
    let a = (seed * 2654435761) >>> 0 || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function prefersReduced() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  const clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  const smooth = function (v) { v = clamp01(v); return v * v * (3 - 2 * v); };

  function rgbOf(color) {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillStyle = color; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  // value noise on a grid of 'cell' px (in canvas pixels), 0..1
  function valueNoise(r, W, H, cell) {
    const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2, grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    return function (x, y) {
      const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1], c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  }

  // split text into runs of CJK and non-CJK characters
  const CJK = /[\u2E80-\u303F\u3040-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
  function runs(text) {
    const out = [];
    for (const ch of text) {
      const cjk = CJK.test(ch), last = out[out.length - 1];
      if (last && last.cjk === cjk) last.s += ch; else out.push({ s: ch, cjk: cjk });
    }
    return out;
  }
  function setFont(g, run, px, o) {
    if (run.cjk) { g.font = '900 ' + px + 'px ' + o.font; g.fontStretch = 'normal'; g.letterSpacing = (px * 0.06).toFixed(2) + 'px'; }
    else { g.font = '700 ' + (px * 1.14).toFixed(2) + 'px ' + o.latin; g.fontStretch = 'condensed'; g.letterSpacing = (px * 0.05).toFixed(2) + 'px'; }
  }
  function measure(g, text, px, o) {
    let w = 0;
    for (const r of runs(text)) { setFont(g, r, px, o); w += g.measureText(r.s).width; }
    return w;
  }
  function draw(g, text, cx, cy, px, o) {
    let x = cx - measure(g, text, px, o) / 2;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    for (const r of runs(text)) { setFont(g, r, px, o); g.fillText(r.s, x, cy + (r.cjk ? px * 0.04 : 0)); x += g.measureText(r.s).width; }
  }

  // ---- ink: double frame + 1-2 lines; uneven pressure, rough edges, missing ink, bleed; wet -> dry ----
  // The per-pixel fields of a stamp (same text, sub, colour, size, seed) are cached: re-renders and repeats are cheap.
  const inkCache = new Map(), layoutCache = new Map();
  let probe = null;
  // cheap part: fitted text, font sizes and the mark's box (so the mark can be placed and sized right away)
  function layoutOf(o) {
    const key = [o.text, o.sub, o.size, o.maxWidth, o.font, o.latin].join('\u0001');
    const hit = layoutCache.get(key);
    if (hit) return hit;
    probe = probe || document.createElement('canvas').getContext('2d');
    // the embedded subset only covers the fixed stamp words: otherwise drop it so the whole line uses one face
    const covered = [...(o.text + (o.sub || ''))].every(function (ch) { return !CJK.test(ch) || SERIF_CHARS.indexOf(ch) >= 0; });
    if (!covered && o.font.indexOf('"StampFx Serif"') >= 0) o = Object.assign({}, o, { font: o.font.replace(/"StampFx Serif",\s*/, '') });
    // a long text shrinks (down to 0.72 of size), then is cut with an ellipsis, so the mark never grows past maxWidth
    const frameW = function (px) { return 2 * (Math.max(1.6, px * 0.1) + Math.max(1.4, px * 0.09) + Math.max(0.8, px * 0.045) + px * 0.5 + 2); };
    let px = o.size, text = o.text;
    const fits = function () { return measure(probe, text, px, o) + frameW(px) <= o.maxWidth; };
    while (!fits() && px > o.size * 0.72) px -= 0.5;
    if (!fits()) { const ch = [...text]; while (ch.length > 1 && !fits()) { ch.pop(); text = ch.join('') + '…'; } }
    const spx = Math.max(9, Math.round(o.size * 0.42));
    const tw = Math.max(measure(probe, text, px, o), o.sub ? measure(probe, o.sub, spx, o) : 0);
    const bw = Math.max(1.6, px * 0.1), gap = Math.max(1.4, px * 0.09), lw = Math.max(0.8, px * 0.045);
    const padX = px * 0.5, padY = px * 0.26, m = 2;                           // CSS px
    const innerH = px * 1.08 + (o.sub ? spx * 1.25 + px * 0.12 : 0);
    const cw = Math.ceil(tw + 2 * (bw + gap + lw + padX) + 2 * m), ch = Math.ceil(innerH + 2 * (bw + gap + lw + padY) + 2 * m);
    const L = { px: px, spx: spx, text: text, font: o.font, bw: bw, gap: gap, lw: lw, padY: padY, m: m, cw: cw, ch: ch };
    layoutCache.set(key, L);
    if (layoutCache.size > 128) layoutCache.delete(layoutCache.keys().next().value);
    return L;
  }
  // expensive part: per-pixel ink fields (built a frame or more before the stamp lands, see run())
  function inkFields(o, seed, L) {
    const key = [o.text, o.sub, o.color, o.size, o.maxWidth, o.grain, o.speckle, o.pressure, seed, o.font, o.latin].join('\u0001');
    const hit = inkCache.get(key);
    if (hit) return hit;
    const r = rng(seed ^ 0x9e3779b9);
    const S = Math.max(2, Math.ceil(root.devicePixelRatio || 1)); // canvas px per CSS px
    const px = L.px, spx = L.spx, text = L.text, bw = L.bw, gap = L.gap, lw = L.lw, padY = L.padY, m = L.m, cw = L.cw, ch = L.ch;
    o = Object.assign({}, o, { font: L.font }); // draw with the face the layout measured
    const W = cw * S, H = ch * S, n = W * H;

    // coverage of frame and of text in one canvas: frame in red, text in green, blurred union in blue
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.scale(S, S);
    const x0 = m + bw / 2, y0 = m + bw / 2, x1 = cw - m - bw / 2, y1 = ch - m - bw / 2, rad = Math.max(1.5, px * 0.12);
    const frame = function () {
      g.lineWidth = bw; g.beginPath(); g.roundRect(x0, y0, x1 - x0, y1 - y0, rad); g.stroke();
      const k = bw / 2 + gap + lw / 2;
      g.lineWidth = lw; g.beginPath(); g.roundRect(x0 + k, y0 + k, x1 - x0 - 2 * k, y1 - y0 - 2 * k, Math.max(0.5, rad - k * 0.6)); g.stroke();
    };
    const top = m + bw + gap + lw + padY;
    const words = function () {
      draw(g, text, cw / 2, top + px * 0.54, px, o);
      if (o.sub) draw(g, o.sub, cw / 2, top + px * 1.08 + px * 0.12 + spx * 0.62, spx, o);
    };
    // blue: union with a soft halo (where wet ink bleeds); then frame added into red, text into green
    g.shadowColor = 'rgb(0,0,255)'; g.shadowBlur = Math.max(0.6, px * 0.035) * S;
    g.strokeStyle = g.fillStyle = 'rgb(0,0,255)'; frame(); words();
    g.shadowBlur = 0; g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgb(255,0,0)'; frame();
    g.fillStyle = 'rgb(0,255,0)'; words();
    const cov = g.getImageData(0, 0, W, H).data;

    // fields (cells in canvas px); small stamps get finer, lighter missing ink so a column of them stays clean
    const cell = Math.max(1, o.grain) * S, sp = o.speckle * (px < 20 ? 0.5 : 1);
    const ang = r() * Math.PI * 2, tx = Math.cos(ang), ty = Math.sin(ang);
    const nPress = valueNoise(r, W, H, cell * 7), nHole = valueNoise(r, W, H, cell * 1.3), nEdge = valueNoise(r, W, H, cell * 0.8), nLag = valueNoise(r, W, H, cell * 9);
    const rgb = rgbOf(o.color);
    const wetA = new Uint8ClampedArray(n), dryA = new Uint8ClampedArray(n), lag = new Float32Array(n);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, k = i * 4;
      const fC = cov[k] / 255, tC = cov[k + 1] / 255, bl = cov[k + 2] / 255;
      if (fC + tC + bl === 0) continue;
      const plane = ((x / W - 0.5) * tx + (y / H - 0.5) * ty) * 2;
      const pr = clamp01(0.62 + o.pressure * (0.55 * plane + 0.9 * (nPress(x, y) - 0.5)));
      const isText = tC > fC, cv = Math.max(tC, fC);
      // rough rubber edge: push antialiased coverage around with fine noise
      const rough = cv > 0 && cv < 1 ? clamp01((cv - 0.5) * 1.6 + 0.5 + (nEdge(x, y) - 0.5) * 0.7) : cv;
      const thr = 0.1 + sp * 1.4 * (1.45 - pr);
      const hole = clamp01((thr - nHole(x, y)) / 0.07);
      dryA[i] = Math.round(255 * rough * (0.8 + 0.2 * pr) * (1 - hole * (isText ? 0.42 : 0.9)));
      wetA[i] = Math.round(255 * clamp01(Math.max(rough, bl * 0.42) * (1 - hole * 0.18)));
      lag[i] = clamp01((nLag(x, y) - 0.2) / 0.6) * 0.35 + (1 - pr) * 0.15; // patches dry at different moments (0..0.5)
    }
    const f = { W: W, H: H, n: n, cw: cw, ch: ch, text: text, rgb: rgb, wet: [rgb[0] * 0.7, rgb[1] * 0.7, rgb[2] * 0.78], wetA: wetA, dryA: dryA, lag: lag };
    inkCache.set(key, f);
    if (inkCache.size > 64) inkCache.delete(inkCache.keys().next().value);
    return f;
  }

  // lazy: the mark is sized and placed now; its ink is built on the first paint or prepare()
  function renderMark(opts, lazy) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (!o.text) throw new TypeError('StampFx: opts.text is required');
    const seed = o.seed == null ? (Math.random() * 4294967296) >>> 0 : o.seed >>> 0;
    const L = layoutOf(o);
    const cv = document.createElement('canvas');
    cv.className = 'stampfx-ink';
    Object.assign(cv.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    let f = null, g, img, d, n, rgb, wet, wetA, dryA, lag;
    function prepare() {
      if (f) return;
      f = inkFields(o, seed, L); n = f.n; rgb = f.rgb; wet = f.wet; wetA = f.wetA; dryA = f.dryA; lag = f.lag;
      cv.width = f.W; cv.height = f.H;
      g = cv.getContext('2d'); img = g.createImageData(f.W, f.H); d = img.data;
    }
    let last = -1, mark = null;
    // dryness p 0..1: every pixel blends from wet to dry on its own slightly delayed smooth curve
    function paint(p) {
      prepare();
      p = clamp01(p);
      if (Math.abs(p - last) < 0.0015 && p !== 1 && p !== 0) return;
      last = p;
      if (mark) mark._stampfx.dryness = p;
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        if (!wetA[i] && !dryA[i]) continue;
        const u = smooth((p - lag[i]) / 0.5);
        const a = wetA[i] + (dryA[i] - wetA[i]) * u;
        if (a < 0.5) { d[k + 3] = 0; continue; }
        d[k] = wet[0] + (rgb[0] - wet[0]) * u; d[k + 1] = wet[1] + (rgb[1] - wet[1]) * u; d[k + 2] = wet[2] + (rgb[2] - wet[2]) * u; d[k + 3] = a;
      }
      g.putImageData(img, 0, 0);
    }
    if (!lazy) paint(1);
    mark = document.createElement('div');
    mark.className = 'stampfx-mark';
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', o.sub ? o.text + ' ' + o.sub : o.text);
    Object.assign(mark.style, { position: 'absolute', width: L.cw + 'px', height: L.ch + 'px' });
    mark.appendChild(cv);
    mark._stampfx = { seed: seed, paint: paint, prepare: prepare, ready: function () { return !!f; }, dryness: 1 }; // dryness: 0 wet .. 1 dry, as last painted
    return mark;
  }

  function layerFor(target, spill, blend) {
    let layer = target.querySelector(':scope > .stampfx-layer');
    if (!layer) {
      if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
      layer = document.createElement('div');
      layer.className = 'stampfx-layer';
      Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', borderRadius: 'inherit', zIndex: '1' });
      target.appendChild(layer);
    }
    layer.style.overflow = spill ? 'visible' : 'hidden';
    layer.style.mixBlendMode = blend || 'normal';
    return layer;
  }

  // place a fresh mark in the target; returns { mark, tilt }
  function placeMark(target, o, lazy) {
    const layer = layerFor(target, o.spill, o.blend);
    if (o.replace) clear(target);
    const mark = renderMark(o, lazy);
    const jr = rng(mark._stampfx.seed ^ 0x51ed27);
    const tilt = o.rotate + (o.jitter ? (jr() * 2 - 1) * o.jitter : 0);
    const off = o.jitter * 0.75;
    const dx = (off ? (jr() * 2 - 1) * off : 0) + (o.nudge ? o.nudge.x || 0 : 0), dy = (off ? (jr() * 2 - 1) * off : 0) + (o.nudge ? o.nudge.y || 0 : 0);
    const at = o.at || { x: 0.5, y: 0.5 };
    const W = layer.clientWidth, H = layer.clientHeight;
    const w0 = parseFloat(mark.style.width), h0 = parseFloat(mark.style.height);
    let cx = at.x * W + dx - (o.align === 'right' ? w0 / 2 : 0), cy = at.y * H + dy;
    if (!o.spill) {
      const rad = tilt * Math.PI / 180, cs = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
      const mw = w0 * cs + h0 * sn + 2 * o.inset, mh = w0 * sn + h0 * cs + 2 * o.inset;
      const fit = function (v, size, box) { return size >= box ? box / 2 : Math.min(box - size / 2, Math.max(size / 2, v)); };
      cx = fit(cx, mw, W); cy = fit(cy, mh, H);
    }
    Object.assign(mark.style, {
      left: Math.round(cx - w0 / 2) + 'px', top: Math.round(cy - h0 / 2) + 'px',
      transform: tilt ? 'rotate(' + tilt.toFixed(2) + 'deg)' : 'none', opacity: '0',
    });
    layer.appendChild(mark);
    // a shortened mark keeps the full text for screen readers (aria-label); for hover, the host carries it
    if (layoutOf(o).text !== o.text && !target.title) { target.title = o.sub ? o.text + ' ' + o.sub : o.text; target.dataset.stampfxTitle = '1'; }
    return { mark: mark, tilt: tilt };
  }

  // ---- drying: one rAF loop repaints every drying mark from its own clock animation ----
  // The clock is a Web Animation (opacity 1 -> 1, no visual effect) so that finish(), pause and seeking
  // all drive the ink too; the loop only reads its currentTime.
  const drying = new Set();
  let loop = 0;
  function tick() {
    loop = 0;
    drying.forEach(function (it) {
      const ct = it.clock.currentTime;
      if (ct == null) return;
      const t = (ct - it.delay) / TIMING.dry;
      if (!it.mark._stampfx.ready()) return; // the prepare queue builds it (one per frame, due ones first)
      if (t <= 0) { it.paint(0); return; }
      it.paint(1 - Math.pow(1 - clamp01(t), 1.7)); // ease-out: the wet sheen goes first, the last of it lingers
      if (t >= 1 || !it.mark.isConnected) drying.delete(it);
    });
    if (drying.size) loop = requestAnimationFrame(tick);
  }
  function dryAnim(mark, delay, from) {
    const st = mark._stampfx;
    const clock = mark.firstChild.animate([{ opacity: 1 }, { opacity: 1 }], { duration: delay + TIMING.dry });
    if (from) clock.currentTime = from;
    drying.add({ mark: mark, paint: st.paint, clock: clock, delay: delay });
    if (!loop) loop = requestAnimationFrame(tick);
    // at the end (or when a run is settled early) show it dry; a mark whose ink is not built yet is painted dry by the
    // prepare queue on a later frame instead of stalling this one
    const end = function () { if (st.ready()) st.paint(1); else st.dryWhenReady = true; };
    clock.finished.then(end, end);
    return clock;
  }

  // ---- stamp head (the visible rubber stamp, seen from above) ----
  let styled = false;
  function injectStyle() {
    if (styled) return;
    styled = true;
    const s = document.createElement('style');
    s.textContent =
      '.stampfx-hand{position:fixed;inset:0;pointer-events:none;z-index:35;contain:strict}' +
      '.stampfx-head,.stampfx-shadow{position:absolute;left:0;top:0;border-radius:6px;will-change:transform,opacity;opacity:0}' +
      '.stampfx-shadow{background:rgba(16,18,22,.24);filter:blur(3px)}' +
      // rubber face (inked, a ring of it shows around the mount) + light mount plate + handle seen from above
      '.stampfx-head{background:var(--stampfx-ink);box-shadow:0 0 0 1px rgba(16,18,22,.2)}' +
      '.stampfx-head::before{content:"";position:absolute;inset:2px 2px 3px;border-radius:4px;background:linear-gradient(#fbfbfc,#dcdfe5);box-shadow:inset 0 1px 0 #fff,inset 0 -1px 0 rgba(16,18,22,.12)}' +
      '.stampfx-head::after{content:"";position:absolute;left:50%;top:44%;width:calc(var(--stampfx-knob) * 1.5);height:var(--stampfx-knob);margin:calc(var(--stampfx-knob) / -2) 0 0 calc(var(--stampfx-knob) * -.75);border-radius:999px;' +
      'background:radial-gradient(ellipse at 40% 30%,#f6f7f9,#c9ced6 62%,#a6adb8);box-shadow:1px 2px 3px rgba(16,18,22,.34),0 0 0 1px rgba(16,18,22,.12)}';
    document.head.appendChild(s);
  }
  function makeHand(w, h, color) {
    injectStyle();
    const wrap = document.createElement('div');
    wrap.className = 'stampfx-hand';
    wrap.setAttribute('aria-hidden', 'true');
    const sh = document.createElement('div'), hd = document.createElement('div');
    sh.className = 'stampfx-shadow'; hd.className = 'stampfx-head';
    for (const el of [sh, hd]) { el.style.width = w + 'px'; el.style.height = h + 'px'; }
    hd.style.setProperty('--stampfx-ink', color);
    hd.style.setProperty('--stampfx-knob', Math.round(Math.min(h * 0.5, w * 0.3, 18)) + 'px');
    wrap.appendChild(sh); wrap.appendChild(hd);
    document.body.appendChild(wrap);
    return { wrap: wrap, head: hd, shadow: sh, w: w, h: h };
  }

  // visible part of el's box, intersected with every clipping ancestor and the viewport
  function visibleRect(el) {
    const b = el.getBoundingClientRect();
    let l = b.left, t = b.top, r = b.right, bt = b.bottom;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ov = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(ov.overflow + ov.overflowX + ov.overflowY)) {
        const q = p.getBoundingClientRect();
        l = Math.max(l, q.left); t = Math.max(t, q.top); r = Math.min(r, q.right); bt = Math.min(bt, q.bottom);
      }
    }
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, innerWidth); bt = Math.min(bt, innerHeight);
    return r > l && bt > t ? { l: l, t: t, r: r, b: bt } : null;
  }

  function pressAnim(el, depth) {
    const d = depth + 'px', T = TIMING.press;
    return el.animate([
      { translate: '0px 0px', easing: 'cubic-bezier(.2,.8,.3,1)' },
      { translate: '0px ' + d, offset: 40 / T },
      { translate: '0px ' + d, offset: 130 / T, easing: 'cubic-bezier(.2,.7,.3,1)' },
      { translate: '0px 0px' },
    ], { duration: T });
  }

  function dipAnim(el, px, delay) {
    // gives way on the contact frame, holds while pressed, snaps back as the head clears the ink (TIMING.dip).
    // Whole pixels only, so the text in the row never renders at a fractional offset.
    const d = Math.max(1, Math.round(px)) + 'px';
    return el.animate([
      { translate: '0px 0px', easing: 'step-end' },
      { translate: '0px ' + d, offset: 0.001, easing: 'step-end' },
      { translate: '0px 0px' },
    ], { duration: TIMING.dip, delay: delay });
  }

  let current = null; // settle() of the animated run in progress
  // Build ink off the click frame: one mark per animation frame in landing order, and any mark due within 50 ms at
  // once, so every mark is ready before it touches the paper. dry: paint it dry (reduced motion), else paint it wet.
  function prepareAhead(marks, due, dry) {
    const order = marks.map(function (m, i) { return i; }).sort(function (a, b) { return due[a] - due[b]; });
    const t0 = performance.now();
    function step() {
      const el = performance.now() - t0;
      let did = 0;
      while (order.length) {
        const m = marks[order[0]];
        if (!m._stampfx.ready() && did && due[order[0]] - 50 > el) break;
        order.shift();
        if (!m._stampfx.ready()) { m._stampfx.paint(dry || m._stampfx.dryWhenReady ? 1 : 0); did++; }
      }
      if (order.length) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  // ---- the core: strike a list of items with one hand; each item may also print its twins at the same instant ----
  function run(items, shared) {
    if (!Array.isArray(items) || !items.length) throw new TypeError('StampFx.sequence: items must be a non-empty array');
    // flatten: every mark knows its strike (time slot) and lane (0 = the item itself, k = its k-th twin)
    const jobs = [];
    items.forEach(function (it, strike) {
      if (!it || !(it.target instanceof Element)) throw new TypeError('StampFx: every item needs a target Element');
      jobs.push({ target: it.target, o: Object.assign({}, DEFAULTS, shared, it.opts), strike: strike, lane: 0 });
      (it.twins || []).forEach(function (tw, k) {
        if (!tw || !(tw.target instanceof Element)) throw new TypeError('StampFx: every twin needs a target Element');
        jobs.push({ target: tw.target, o: Object.assign({}, DEFAULTS, shared, it.opts, tw.opts), strike: strike, lane: k + 1 });
      });
    });
    const first = jobs[0].o;
    const reduce = first.reducedMotion == null ? prefersReduced() : first.reducedMotion;
    const placed = jobs.map(function (j) { return placeMark(j.target, j.o, !j.o.instant); });
    const marks = placed.map(function (p) { return p.mark; });

    if (first.instant) {
      marks.forEach(function (m, i) {
        m.style.opacity = '1';
        const left = Math.min(TIMING.dry, jobs[i].o.dryLeft || 0);
        if (left > 0 && !reduce) dryAnim(m, 0, TIMING.dry - left);
      });
      return { mark: marks[0], marks: marks, contacts: marks.map(function () { return 0; }), finished: Promise.resolve(marks) };
    }

    const anims = [], extras = [], voices = [], hands = [];
    // a new animated run settles the previous one first: its heads go, its ink lands dry, its queued sounds stop
    if (current) current();
    const settle = function () {
      anims.concat(extras).forEach(function (a) { a.finish(); });
      voices.forEach(function (v) { try { v.stop(); } catch (e) { /* already ended */ } });
      hands.forEach(function (h) { h.wrap.remove(); });
      if (current === settle) current = null;
    };
    current = settle;
    const soundKind = first.sound === true ? 'approve' : first.sound;
    const strikes = items.length;
    if (first.pressOn && !reduce) anims.push(pressAnim(first.pressOn, first.pressDepth));

    if (reduce) {
      // no head, no movement; ink fades in already dry; one sound per strike
      prepareAhead(marks, jobs.map(function (j) { return TIMING.rmDelay + j.strike * TIMING.rmStep; }), true);
      marks.forEach(function (m, i) {
        const delay = TIMING.rmDelay + jobs[i].strike * TIMING.rmStep;
        anims.push(m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TIMING.fade, delay: delay, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' }));
        m.style.opacity = '1';
      });
      if (soundKind) for (let s = 0; s < strikes; s++) voices.push(playThump(soundKind, first.volume, TIMING.rmDelay + s * TIMING.rmStep, s));
      return finish(anims, marks, jobs.map(function (j) { return TIMING.rmDelay + j.strike * TIMING.rmStep; }));
    }

    // contact time per strike: the hand speeds up; a long run is squeezed so the whole thing stays within TIMING.span
    const gaps = [];
    for (let i = 0; i < strikes - 1; i++) gaps.push(TIMING.gaps[Math.min(i, TIMING.gaps.length - 1)]);
    const room = TIMING.span - TIMING.dwell - TIMING.lift, sum = gaps.reduce(function (a, b) { return a + b; }, 0);
    const k = sum > room ? Math.max(TIMING.minGap / Math.min.apply(null, gaps), room / sum) : 1;
    const contacts = [TIMING.approach];
    gaps.forEach(function (g) { contacts.push(contacts[contacts.length - 1] + Math.max(TIMING.minGap, g * k)); });

    // where each mark sits on screen (centre), and whether it is visible
    const spots = placed.map(function (p, i) {
      // visibility is judged on the mark itself (anchors may be zero-size; a spilled mark is bigger than its target)
      const b = p.mark.getBoundingClientRect(), v = visibleRect(p.mark);
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      const seen = !!v && cx >= v.l && cx <= v.r && cy >= v.t && cy <= v.b;
      return { x: cx, y: cy, tilt: p.tilt, seen: seen, o: jobs[i].o, c: contacts[jobs[i].strike], lane: jobs[i].lane, mark: p.mark };
    });

    prepareAhead(marks, spots.map(function (s) { return s.c; }));
    // ink and paper per mark (twins share their strike's contact, so they land, lift and dry together)
    spots.forEach(function (s, i) {
      const m = marks[i], c = s.c;
      anims.push(m.animate([{ opacity: 0 }, { opacity: 0, offset: c / (c + 1) }, { opacity: 1 }], { duration: c + 1, easing: 'step-end' }));
      m.style.opacity = '1';
      extras.push(dryAnim(m, c + TIMING.dwell));
      if (s.seen && s.o.dip > 0) anims.push(dipAnim(s.o.shakeOn || jobs[i].target, s.o.dip, c));
    });
    // one sound per strike, never two at once
    if (soundKind) for (let s = 0; s < strikes; s++) voices.push(playThump(soundKind, first.volume, contacts[s], s));

    // one head per lane, travelling through that lane's visible spots
    const lanes = {};
    spots.forEach(function (s) { if (s.seen) (lanes[s.lane] = lanes[s.lane] || []).push(s); });
    if (first.hand) Object.keys(lanes).forEach(function (key) {
      const seen = lanes[key];
      const pad = Math.max(4, Math.round(seen[0].o.size * 0.22));
      const hw = parseFloat(seen[0].mark.style.width) + 2 * pad, hh = parseFloat(seen[0].mark.style.height) + 2 * pad;
      const hand = makeHand(hw, hh, seen[0].o.color);
      const end = seen[seen.length - 1].c + TIMING.dwell + TIMING.lift;
      const hk = [], sk = [];
      // pose: lift 0..1 (0 = on the paper)
      function pose(at, x, y, tilt, lift, op, squash, easing) {
        const s = (1 + 0.22 * lift) * (squash || 1);
        const ox = x - hw / 2, oy = y - hh / 2;
        hk.push({ offset: at / end, opacity: op, easing: easing || 'linear',
          transform: 'translate(' + ox.toFixed(1) + 'px,' + oy.toFixed(1) + 'px) rotate(' + tilt.toFixed(2) + 'deg) scale(' + s.toFixed(3) + ')' });
        sk.push({ offset: at / end, opacity: op * (0.85 - 0.6 * lift), easing: easing || 'linear',
          transform: 'translate(' + (ox + 1 + 9 * lift).toFixed(1) + 'px,' + (oy + 1.5 + 13 * lift).toFixed(1) + 'px) rotate(' + tilt.toFixed(2) + 'deg) scale(' + (1 + 0.2 * lift).toFixed(3) + ')' });
      }
      const IN = 'cubic-bezier(.55,0,.85,.35)';   // falling: speeds up into the paper
      const OUT = 'cubic-bezier(.15,.65,.3,1)';   // lifting: quick off the paper, then floats
      seen.forEach(function (s, k) {
        const c = s.c;
        if (k === 0) {
          pose(0, s.x + 18, s.y - 22, s.tilt + 5, 1, 0, 1, IN);
          pose(c * 0.2, s.x + 14, s.y - 17, s.tilt + 4, 0.8, 1, 1, IN);
        }
        pose(c, s.x, s.y, s.tilt, 0, 1, 1.035, 'ease-out');        // contact: rubber spreads
        pose(c + 24, s.x, s.y, s.tilt, 0, 1, 0.985, 'linear');       // settles under the weight
        pose(c + TIMING.dwell, s.x, s.y, s.tilt, 0, 1, 1, OUT);
        const next = seen[k + 1];
        if (next) {
          const mid = c + TIMING.dwell + (next.c - c - TIMING.dwell) * 0.45;
          // swing out to the right first so the ink just laid is uncovered, then drop onto the next one
          pose(mid, Math.max(s.x, next.x) + hw * 0.6, (s.y + next.y) / 2 - 10, (s.tilt + next.tilt) / 2 + 2, 0.55, 1, 1, IN);
        } else {
          // pulled back toward the hand (upper right): fully off the ink while still opaque, then it fades
          pose(c + TIMING.dwell + TIMING.lift * 0.6, s.x + hw * 1.05, s.y - hh * 0.7, s.tilt + 3, 0.6, 1, 1, 'ease-out');
          pose(end, s.x + hw * 1.45, s.y - hh * 1, s.tilt + 5, 0.8, 0, 1);
        }
      });
      const opt = { duration: end, fill: 'both' };
      const ha = hand.head.animate(hk, opt), sa = hand.shadow.animate(sk, opt);
      anims.push(ha, sa);
      hands.push(hand);
      Promise.all([ha.finished, sa.finished]).then(function () { hand.wrap.remove(); }, function () { hand.wrap.remove(); });
    });
    if (hands.length) {
      // the heads are placed in viewport coordinates once; if a scroll container holding a mark scrolls (or the window
      // scrolls / resizes) mid-run, jump every strike to its end state instead of stamping thin air
      const boxes = new Set([root]);
      marks.forEach(function (m) { for (let el = m.parentElement; el; el = el.parentElement) if (/(auto|scroll)/.test(getComputedStyle(el).overflowY + getComputedStyle(el).overflowX)) boxes.add(el); });
      boxes.forEach(function (b) { b.addEventListener('scroll', settle, { passive: true }); });
      addEventListener('resize', settle);
      const done = function () { boxes.forEach(function (b) { b.removeEventListener('scroll', settle); }); removeEventListener('resize', settle); };
      Promise.all(anims.map(function (a) { return a.finished; })).then(done, done);
    }
    Promise.all(anims.concat(extras).map(function (a) { return a.finished; })).then(function () { if (current === settle) current = null; }, function () {});
    return finish(anims, marks, jobs.map(function (j) { return contacts[j.strike]; }));
  }

  // contacts[i]: ms from now until marks[i] hits the paper (its ink starts drying TIMING.dwell later)
  function finish(anims, marks, contacts) {
    const finished = Promise.all(anims.map(function (a) { return a.finished; })).then(function () { return marks; });
    return { mark: marks[0], marks: marks, contacts: contacts, finished: finished };
  }

  function stamp(target, opts) {
    if (!(target instanceof Element)) throw new TypeError('StampFx.stamp: target must be an Element');
    return run([{ target: target, opts: opts }], {});
  }

  // Run-level settings come from the first item: hand, sound, volume, reducedMotion, instant, pressOn, pressDepth.
  // Each lane's head takes its size and ink colour from that lane's first visible mark. Text, colour, size, dip and
  // shakeOn are per item; twins inherit their item's opts and may override them.
  function sequence(items, shared) {
    return run(items, shared || {});
  }

  // Big transient mark slammed over a whole area.
  function slam(container, opts) {
    if (!(container instanceof Element)) throw new TypeError('StampFx.slam: container must be an Element');
    const o = Object.assign({}, DEFAULTS, { size: DEFAULTS.size * 2, replace: false, jitter: 0 }, opts);
    const r = run([{ target: container, opts: o }], {});
    const finished = r.finished.then(function () {
      return r.mark.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: TIMING.slam }).finished;
    }).then(function () { r.mark.remove(); });
    return { mark: r.mark, finished: finished };
  }

  function clear(target) {
    if (target.dataset && target.dataset.stampfxTitle) { target.removeAttribute('title'); delete target.dataset.stampfxTitle; }
    const layer = target.querySelector(':scope > .stampfx-layer');
    if (layer) layer.querySelectorAll('.stampfx-mark').forEach(function (m) { m.remove(); });
  }

  // ---- sound: rubber on paper on a desk. Each hit is a little different; only one plays at a time. ----
  let ac = null, lastGain = null;
  const buffers = {};
  function noise(n, seed) {
    const r = rng(seed + 7), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (r() + r() + r() + r() - 2) * 1.7;
    return x;
  }
  function biquad(x, type, f, sr, q) {
    f = Math.min(f, sr * 0.45);
    const w0 = 2 * Math.PI * f / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * (q || Math.SQRT1_2));
    let b0, b1, b2;
    if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; } // bandpass (constant 0 dB peak)
    const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al, y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i], yi = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
    }
    return y;
  }
  // A short mechanism "tick" leads the thump by LEAD seconds (Papers, Please has a click ~125 ms before its thud),
  // and a soft "peel" follows when the rubber leaves the paper.
  const LEAD = 0.07;
  // variant v: 0..3, different noise and pitch so a run of stamps does not sound like a loop
  function thumpBuffer(kind, v) {
    const sr = ac.sampleRate, n = Math.floor((0.32 + LEAD) * sr), pitch = [1, 0.94, 1.05, 0.98][v];
    const tick = biquad(noise(n, 44 + v * 13), 'highpass', 3200, sr);
    const f0 = (kind === 'deny' ? 100 : 118) * pitch, f1 = (kind === 'deny' ? 44 : 52) * pitch;
    const knock = biquad(noise(n, 41 + v * 13), 'bandpass', 640 * pitch, sr, 1.1);
    const slap = biquad(biquad(noise(n, 42 + v * 13), 'highpass', 2200, sr), 'lowpass', 7000, sr);
    const peel = biquad(noise(n, 43 + v * 13), 'bandpass', 2600, sr, 0.9);
    const peelAt = (TIMING.dwell + 20) / 1000;
    const x = new Float32Array(n);
    let ph = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const t0 = i / sr, t = t0 - LEAD;
      const tk = tick[i] * Math.exp(-t0 / 0.003) * 0.3;
      if (t < 0) { x[i] = Math.tanh(tk * 1.4); peak = Math.max(peak, Math.abs(x[i])); continue; }
      ph += 2 * Math.PI * (f0 + (f1 - f0) * Math.min(1, t / 0.12)) / sr;
      const pt = t - peelAt, pe = pt > 0 ? (1 - Math.exp(-pt / 0.012)) * Math.exp(-pt / 0.03) : 0;
      const atk = Math.min(1, t / 0.0015);
      const val = atk * (Math.sin(ph) * Math.exp(-t / 0.075) + knock[i] * Math.exp(-t / 0.02) * 1.3 + slap[i] * Math.exp(-t / 0.005) * 0.45) + peel[i] * pe * 0.5;
      x[i] = Math.tanh(val * 1.4);
      peak = Math.max(peak, Math.abs(x[i]));
    }
    const buf = ac.createBuffer(1, n, sr), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = x[i] * 0.85 / peak;
    return buf;
  }
  function playThump(kind, volume, delayMs, index) {
    if (kind === true) kind = 'approve';
    if (kind !== 'approve' && kind !== 'deny') throw new TypeError('StampFx: sound must be false, true, "approve" or "deny"');
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) throw new Error('StampFx: Web Audio is not available');
    if (!ac) ac = new AC();
    if (ac.state === 'suspended') ac.resume();
    const v = index == null ? (Math.random() * 4) | 0 : (index * 3 + 1) % 4;
    const key = kind + v;
    const buf = buffers[key] || (buffers[key] = thumpBuffer(kind, v));
    const src = ac.createBufferSource(), gain = ac.createGain();
    src.buffer = buf;
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const vol = (volume == null ? DEFAULTS.volume : volume) * (0.86 + Math.random() * 0.14);
    src.connect(gain).connect(ac.destination);
    // land the thump on the contact frame: start earlier by the tick lead and the device output latency
    const lat = (ac.baseLatency || 0) + (ac.outputLatency || 0);
    const at = ac.currentTime + Math.max(0, (delayMs || 0) / 1000 - LEAD - lat);
    // one voice: the previous thump's tail is faded out (6 ms) the moment this one starts
    gain.gain.setValueAtTime(0, 0); gain.gain.setValueAtTime(vol, at);
    if (lastGain) { lastGain.gain.setTargetAtTime(0, at, 0.006); }
    lastGain = gain;
    src.start(at);
    return src;
  }

  root.StampFx = { stamp: stamp, sequence: sequence, slam: slam, clear: clear, renderMark: renderMark, playThump: playThump, hash: hash, TIMING: TIMING, COLORS: COLORS, FONTS: FONTS, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
