/* Ambient Music v3 - Music Mixer page (data-driven kit, patterns, per-layer FX).
   Everything is built from api/kit: any number of layers, variants per layer and patterns (A/B/Fill) per variant.

   Playback model (sample-locked): one global timeline t0 + k*Lc, Lc = loop length.
   Each layer plays one-shot "segments" (a pattern buffer from an offset) scheduled exactly on that grid, about
   2.5 s ahead. Consecutive segments butt-join on the same sample frame, so loops stay seamless and layers never
   drift. A variant change cuts at the next bar (12 ms crossfade, new buffer starts at the bar's offset); a pattern
   setting change applies at the next loop boundary. Pattern choice per loop k is R.patternFor(): A, A/B alternating,
   and a fill on every Nth loop (full-length fill replaces the loop; a shorter fill replaces the loop's tail).
   Layer chain: segments -> HP -> LP -> drive -> pan -> fader -> bus (+ post-fader reverb / delay sends).
   Gain = (v/100)^2. Intensity = 3 s linear ramp in fader space (volume and low-pass), like Set RTPC Value 3000 ms. */
(function () {
  'use strict';
  var R = window.MixRecipe;
  var LEVELS = ['CALM', 'MEDIUM', 'INTENSE'], LVL_CLASS = ['calm', 'medium', 'intense'], LVL_SHORT = ['CALM', 'MED', 'INT'];
  var RAMP_S = 3.0, XF = 0.012, LOOKAHEAD = 2.5, CACHE_MAX = 36;   // decoded loops kept (~8 MB each)
  var AUTO_STEPS = [[0, 14], [1, 14], [2, 20], [1, 10], [0, 12]];
  var DEFAULT_ON_VOL = [40, 55, 70];
  var DLY_LABEL = { '4': '1/4', '8d': '1/8 dotted' }, DLY_BEATS = { '4': 1, '8d': 0.75 };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowS() { return performance.now() / 1000; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Audiokinetic's table "Associating Low-pass and High-pass Filter Values with their Corresponding Cutoff Frequencies"
  // (Wwise 2021.1.14 Help): LPF value 0..100 -> cutoff Hz; HPF value v uses the same table at 100 - v.
  var WW_CUT = [20000, 19567, 19133, 18700, 18267, 17833, 17400, 16967, 16533, 16100, 15667, 15233, 14800, 14367, 13933,
    13500, 13067, 12633, 12200, 11767, 11333, 10900, 10467, 10033, 9600, 9167, 8733, 8300, 7867, 7433, 7000, 6422, 5892,
    5405, 4959, 4550, 4174, 3829, 3513, 3223, 2957, 2713, 2489, 2283, 2095, 1922, 1763, 1618, 1484, 1361, 1249, 1146,
    1051, 964, 885, 812, 745, 683, 627, 575, 528, 484, 444, 407, 374, 343, 315, 289, 265, 243, 223, 204, 188, 172, 158,
    145, 133, 122, 112, 103, 94, 86, 79, 73, 67, 61, 56, 51, 47, 43, 40, 36, 33, 31, 28, 26, 24, 22, 20, 18, 17];
  function wwCut(u) {                       // fractional units (RTPC ramps) interpolate in log-frequency
    u = Math.max(0, Math.min(100, u)); var i = Math.floor(u), f = u - i;
    return i >= 100 || f === 0 ? WW_CUT[i] : Math.exp(Math.log(WW_CUT[i]) * (1 - f) + Math.log(WW_CUT[i + 1]) * f);
  }
  function lpHz(v) { return wwCut(v); }          // LPF units -> Hz (0 = 20 kHz = no filter)
  function hpHz(v) { return wwCut(100 - v); }    // HPF units -> Hz (0 = no filter)
  // one-pole power responses (same coefficients as js/onepole-worklet.js), fs = 48 kHz
  var FS = 48000;
  function lpPow(f, hz) { if (!hz || hz >= 20000) return 1; var b = Math.exp(-2 * Math.PI * hz / FS), c = Math.cos(2 * Math.PI * f / FS); return (1 - b) * (1 - b) / (1 - 2 * b * c + b * b); }
  function hpPow(f, hz) { if (!hz) return 1; var b = Math.exp(-2 * Math.PI * hz / FS), a = (1 + b) / 2, c = Math.cos(2 * Math.PI * f / FS); return a * a * (2 - 2 * c) / (1 - 2 * b * c + b * b); }
  function bqPow(f, b, a) {                // |H(e^jw)|^2 of a biquad
    var w = 2 * Math.PI * f / FS, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    var nr = b[0] + b[1] * c1 + b[2] * c2, ni = -(b[1] * s1 + b[2] * s2), dr = a[0] + a[1] * c1 + a[2] * c2, di = -(a[1] * s1 + a[2] * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  function kPow(f) {                         // ITU-R BS.1770 K-weighting at 48 kHz
    return bqPow(f, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]) *
           bqPow(f, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  }
  // dB that a Wwise LPF/HPF setting takes off a loop's loudness, from its measured spectrum (null if unknown)
  function filterLossDb(spec, lpU, hpU) {
    if (!spec || !kit.specBands || (!lpU && !hpU)) return 0;
    var lh = lpU ? lpHz(lpU) : 0, hh = hpU ? hpHz(hpU) : 0, num = 0, den = 0;
    kit.specBands.forEach(function (f, i) {
      var p = Math.pow(10, spec[i] / 10) * kPow(f); den += p; num += p * lpPow(f, lh) * hpPow(f, hh);
    });
    return den > 0 ? 10 * Math.log10(Math.max(num, 1e-30) / den) : 0;
  }
  function fmtHz(h) { return h >= 1000 ? (h / 1000).toFixed(h >= 10000 ? 0 : 1) + ' kHz' : Math.round(h) + ' Hz'; }
  function fmtPan(p) { return p === 0 ? 'C' : (p < 0 ? 'L' : 'R') + Math.abs(p); }

  var kit = null, LAYERS = [], VAR = {}, VIDS = {};
  var doc = null, savedJson = '', curId = null;
  var strips = {}, mute = {}, solo = {}, meterLevel = {}, lastLive = -1;
  var lvl = { target: 0, t: -1e9, from: {}, fromI: 0 };
  var auto = { on: false, step: 0, timer: null };
  var A = { ctx: null, G: null, ready: false, playing: false, t0: 0, Lc: 0, barC: 0, rate: 1,
            raw: {}, cache: {}, useTick: 0, st: {}, buf: null };

  // ------------------------------------------------------------------ status / errors
  function status(msg, kind) { var s = $('status'); s.textContent = msg; s.className = 'status' + (kind ? ' ' + kind : ''); }
  window.addEventListener('error', function (e) { status('JS ERROR: ' + e.message, 'err'); selftestLog('JS ERROR ' + e.message + ' @' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { var m = e.reason && e.reason.message || e.reason; status('ERROR: ' + m, 'err'); selftestLog('REJECTION ' + m); });

  // Storage: the Python server (api/*) or, when it isn't there (e.g. the Windows no-Python launcher), BROWSER MODE:
  // kit from data/kit.json, presets in this browser's localStorage, starting from data/default_mixes.json.
  var LOCAL = false, LS_KEY = 'am_mixer_doc_v3';
  function loadKit() { return api('GET', 'api/kit').catch(function () { LOCAL = true; return api('GET', 'data/kit.json'); }); }
  function loadDoc() {
    if (!LOCAL) return api('GET', 'api/mixes');
    var d = null;
    try { d = JSON.parse(window.localStorage.getItem(LS_KEY) || 'null'); } catch (e) { d = null; }
    return d && Array.isArray(d.mixes) ? Promise.resolve(d) : api('GET', 'data/default_mixes.json');
  }
  function saveDoc(d) {
    if (!LOCAL) return api('PUT', 'api/mixes', d);
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (e) { return Promise.reject(new Error('browser storage is blocked: ' + e.message)); }
    return Promise.resolve(clone(d));
  }
  function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { /* text */ }
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j === null ? t : j;
      });
    });
  }

  // ------------------------------------------------------------------ model helpers
  function curMix() { for (var i = 0; i < doc.mixes.length; i++) if (doc.mixes[i].id === curId) return doc.mixes[i]; return null; }
  function normDoc(d) {
    d.mixes = (d.mixes || []).map(function (m) { return R.normMix(m, LAYERS); }); d.mode = d.mode || 'Mix';
    var sv = R.sensOf(d); R.SENS.forEach(function (s) { d[s.id] = sv[s.id]; });   // v3.1 music sensitivity
    return d;
  }
  function isDirty() { return JSON.stringify(doc) !== savedJson; }
  // variant playing for layer L at intensity level lv (default: the current target level)
  function vidAt(L, m, lv) { var l = (m || curMix()).layers[L]; return l ? R.levelVariants(l.variant)[lv == null ? lvl.target : lv] : 'Off'; }
  function variantOf(L, m, lv) { var id = vidAt(L, m, lv); return id !== 'Off' ? VAR[L][id] || null : null; }
  function suitsTag(v) { return (v.suits || []).map(function (x) { return x[0].toUpperCase(); }).join(' '); }
  function optLabel(L, v) { var t = suitsTag(VAR[L][v]); return v + ' \u00b7 ' + VAR[L][v].label + (t ? '  \u00b7 ' + t : ''); }
  function avail(v) { return { A: !!v.patterns.A, B: !!v.patterns.B, Fill: !!v.patterns.Fill }; }
  function fxDefault(l) { return !(l.lp[0] || l.lp[1] || l.lp[2] || l.hp || l.pan || l.rev || l.dly || l.drv); }
  function usesPreview(m) {
    return !!(Object.keys(m.layers).some(function (L) { var l = m.layers[L]; return l.variant !== 'Off' && (l.rev || l.dly || l.drv); }));
  }
  function uniqueName(base, exceptId) {
    base = R.sanitizeName(base);
    var taken = {}; doc.mixes.forEach(function (m) { if (m.id !== exceptId) taken[m.name.toLowerCase()] = 1; });
    if (!taken[base.toLowerCase()]) return base;
    for (var n = 2; ; n++) { var suf = ' ' + n, b = base.slice(0, R.NAME_MAX - suf.length).trim() + suf; if (!taken[b.toLowerCase()]) return b; }
  }
  function newId() { return 'm_' + Math.random().toString(16).slice(2, 10); }
  function blankLayers() { var o = {}; LAYERS.forEach(function (L) { o[L] = R.defaultLayer(); }); return o; }


  function changed() {
    var d = isDirty();
    $('btnSave').disabled = !d; $('btnRevert').disabled = !d;
    $('dirty').textContent = d ? 'UNSAVED CHANGES' : '';
    renderExport();
  }

  // ------------------------------------------------------------------ UI build (from the kit)
  function range(min, max, step) { var i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step || 1; return i; }

  function buildStrips() {
    var host = $('strips'); host.innerHTML = '';
    LAYERS.forEach(function (L) {
      var s = el('div', 'strip'), head = el('div', 'strip-head');
      var bfx = el('button', 'btn fx-btn', 'FX'); bfx.title = 'Effects'; bfx.setAttribute('aria-expanded', 'false');
      var blv = el('button', 'btn fx-btn', 'LVL'); blv.title = 'Different variant per intensity (calm / medium / intense), switched on the next bar';
      blv.setAttribute('aria-pressed', 'false');
      var bm = el('button', 'btn ms m', 'M'), bs = el('button', 'btn ms s', 'S');
      bm.title = 'Mute (preview only, not saved)'; bs.title = 'Solo (preview only, not saved)';
      bm.setAttribute('aria-pressed', 'false'); bs.setAttribute('aria-pressed', 'false');
      head.appendChild(el('div', 'strip-name', L.toUpperCase())); head.appendChild(blv); head.appendChild(bfx); head.appendChild(bm); head.appendChild(bs);
      var meter = el('div', 'meter'), fill = el('div', 'meter-fill'); meter.appendChild(fill);
      var sel = el('select'); sel.setAttribute('aria-label', L + ' variant');
      sel.appendChild(new Option('OFF', 'Off'));
      VIDS[L].forEach(function (v) { sel.appendChild(new Option(optLabel(L, v), v)); });
      var optPer = new Option('PER LEVEL (see below)', '*'); optPer.disabled = true; sel.appendChild(optPer);
      // per-level variant pickers
      var lvRow = el('div', 'lvl-row'), lvSel = [];
      lvRow.hidden = true;
      LVL_SHORT.forEach(function (lv, i) {
        var w = el('label', LVL_CLASS[i]); w.appendChild(el('span', 'pl', lv));
        var ss = el('select'); ss.setAttribute('aria-label', L + ' variant at ' + LEVELS[i]);
        ss.appendChild(new Option('OFF', 'Off'));
        VIDS[L].forEach(function (v) { ss.appendChild(new Option(optLabel(L, v), v)); });
        w.appendChild(ss); lvRow.appendChild(w); lvSel.push(ss);
        ss.addEventListener('change', function () {
          var l = curMix().layers[L], vv = R.levelVariants(l.variant);
          vv[i] = ss.value;
          if (l.variant === 'Off' && l.vol.every(function (x) { return x === 0; })) l.vol = DEFAULT_ON_VOL.slice();
          l.variant = R.normVariant(vv.join('/')); onLayerChanged(L, 'bar'); renderStrip(L); changed();
        });
      });
      var desc = el('div', 'vdesc');
      // pattern row
      var pr = el('div', 'pat-row'), pw1 = el('label'), pw2 = el('label');
      pw1.appendChild(el('span', 'pl', 'VARIATION')); pw2.appendChild(el('span', 'pl', 'FILL'));
      var spat = el('select'); spat.appendChild(new Option('Steady (A)', 'A')); spat.appendChild(new Option('Varied (A/B)', 'AB'));
      var sfill = el('select'); sfill.appendChild(new Option('Off', '0')); sfill.appendChild(new Option('Every 2 loops', '2')); sfill.appendChild(new Option('Every 4 loops', '4'));
      pw1.appendChild(spat); pw2.appendChild(sfill); pr.appendChild(pw1); pr.appendChild(pw2);
      var plamp = el('div', 'pat-lamp');
      // volume faders
      var fw = el('div', 'fader-wrap'), faders = [], outs = [], rows = [];
      LEVELS.forEach(function (lv, i) {
        var row = el('div', 'fader ' + LVL_CLASS[i]), id = 'f_' + L + '_' + i;
        var lab = el('label', null, lv); lab.htmlFor = id;
        var inp = range(0, 100); inp.id = id;
        var out = el('output', null, '0');
        row.appendChild(lab); row.appendChild(inp); row.appendChild(out); fw.appendChild(row);
        faders.push(inp); outs.push(out); rows.push(row);
        inp.addEventListener('input', function () { var m = curMix(); m.layers[L].vol[i] = R.clampVol(inp.value); out.textContent = inp.value; changed(); });
      });
      // FX panel
      var fx = el('div', 'fx-panel'); fx.hidden = true;
      var fxr = {};
      function fxRow(key, label, min, max, cls, badge) {
        var row = el('div', 'fxr' + (cls ? ' ' + cls : '')), id = 'x_' + L + '_' + key;
        var lab = el('label', null, label); lab.htmlFor = id;
        if (badge) { var b = el('span', 'badge', 'PREVIEW'); b.title = badge; lab.appendChild(b); }
        var inp = range(min, max); inp.id = id; var out = el('output');
        row.appendChild(lab); row.appendChild(inp); row.appendChild(out); fx.appendChild(row);
        fxr[key] = { row: row, inp: inp, out: out };
        return fxr[key];
      }
      fx.appendChild(el('div', 'fx-sub', 'LOW-PASS PER INTENSITY'));
      LVL_SHORT.forEach(function (lv, i) { fxRow('lp' + i, lv, 0, 100, 'lp ' + LVL_CLASS[i]); });
      fx.appendChild(el('div', 'fx-sub', 'TONE / SPACE'));
      fxRow('hp', 'HI-PASS', 0, 100);
      fxRow('pan', 'PAN', -100, 100);
      fxRow('rev', 'REVERB', 0, 100);
      fxRow('dly', 'DELAY', 0, 100);
      var tRow = el('div', 'fxr'), tl = el('label', null, 'TIME'), tsel = el('select');
      R.DLY_TIMES.forEach(function (t) { tsel.appendChild(new Option(DLY_LABEL[t], t)); });
      tRow.appendChild(tl); tRow.appendChild(tsel); tRow.appendChild(el('span')); fx.appendChild(tRow);
      fxRow('drv', 'DRIVE', 0, 100);
      fx.appendChild(el('div', 'fx-note', 'In game: Drive \u2192 Delay \u2192 Reverb on this layer, then filters. Reverb tail level and drive gain are not yet ear-checked against the game.'));
      var foot = el('div', 'fx-foot'), brst = el('button', 'btn', 'RESET FX'); foot.appendChild(brst); fx.appendChild(foot);

      s.appendChild(head); s.appendChild(meter); s.appendChild(sel); s.appendChild(lvRow); s.appendChild(desc); s.appendChild(pr); s.appendChild(plamp);
      s.appendChild(fw); s.appendChild(fx);
      host.appendChild(s);
      strips[L] = { root: s, sel: sel, blv: blv, lvRow: lvRow, lvSel: lvSel, perOpen: false, desc: desc, spat: spat, sfill: sfill, plamp: plamp, faders: faders, outs: outs, rows: rows,
                    fill: fill, bm: bm, bs: bs, bfx: bfx, fx: fx, fxr: fxr, tsel: tsel };
      meterLevel[L] = 0;

      sel.addEventListener('change', function () {
        var l = curMix().layers[L], v = sel.value;
        if (l.variant === 'Off' && v !== 'Off' && l.vol.every(function (x) { return x === 0; })) l.vol = DEFAULT_ON_VOL.slice();
        l.variant = v; onLayerChanged(L, 'bar'); renderStrip(L); changed();
      });
      blv.addEventListener('click', function () {
        var st = strips[L], l = curMix().layers[L];
        if (l.variant.indexOf('/') >= 0) {      // turning off: keep the variant of the current level for all levels
          if (!window.confirm('Use one variant for all levels (' + vidAt(L) + ')?')) return;
          l.variant = vidAt(L); st.perOpen = false; onLayerChanged(L, 'bar'); changed();
        } else st.perOpen = !st.perOpen;
        renderStrip(L);
      });
      spat.addEventListener('change', function () { curMix().layers[L].pat = spat.value; onLayerChanged(L, 'loop'); renderPatLamp(L); changed(); });
      sfill.addEventListener('change', function () { curMix().layers[L].fill = +sfill.value; onLayerChanged(L, 'loop'); renderPatLamp(L); changed(); });
      bm.addEventListener('click', function () { mute[L] = !mute[L]; bm.setAttribute('aria-pressed', String(!!mute[L])); renderMuteSolo(); });
      bs.addEventListener('click', function () { solo[L] = !solo[L]; bs.setAttribute('aria-pressed', String(!!solo[L])); renderMuteSolo(); });
      bfx.addEventListener('click', function () { fx.hidden = !fx.hidden; bfx.setAttribute('aria-expanded', String(!fx.hidden)); });
      function bindFx(key, apply) {
        fxr[key].inp.addEventListener('input', function () { apply(curMix().layers[L], +fxr[key].inp.value); renderFxValues(L); applyStatic(L); changed(); });
      }
      [0, 1, 2].forEach(function (i) { bindFx('lp' + i, function (l, v) { l.lp[i] = v; }); });
      bindFx('hp', function (l, v) { l.hp = v; });
      bindFx('pan', function (l, v) { l.pan = v; });
      bindFx('rev', function (l, v) { l.rev = v; });
      bindFx('dly', function (l, v) { l.dly = v; });
      bindFx('drv', function (l, v) { l.drv = v; });
      tsel.addEventListener('change', function () { curMix().layers[L].dlyT = tsel.value; applyStatic(L); changed(); });
      brst.addEventListener('click', function () {
        var l = curMix().layers, d = R.defaultLayer();
        ['lp', 'hp', 'pan', 'rev', 'dly', 'dlyT', 'drv'].forEach(function (k) { l[L][k] = clone(d[k]); });
        renderStrip(L); applyStatic(L); changed();
      });
    });
    var bars = $('bars'); bars.innerHTML = '';
    for (var b = 0; b < kit.bars; b++) bars.appendChild(el('span'));
  }

  function renderMuteSolo() {
    var anySolo = LAYERS.some(function (L) { return solo[L]; });
    LAYERS.forEach(function (L) { strips[L].root.classList.toggle('muted', !!mute[L]); strips[L].root.classList.toggle('dimmed', anySolo && !solo[L]); });
  }

  function renderFxValues(L) {
    var l = curMix().layers[L], x = strips[L].fxr;
    [0, 1, 2].forEach(function (i) { x['lp' + i].inp.value = l.lp[i]; x['lp' + i].out.textContent = l.lp[i] ? fmtHz(lpHz(l.lp[i])) : 'open'; });
    x.hp.inp.value = l.hp; x.hp.out.textContent = l.hp ? fmtHz(hpHz(l.hp)) : 'off';
    x.pan.inp.value = l.pan; x.pan.out.textContent = fmtPan(l.pan);
    x.rev.inp.value = l.rev; x.rev.out.textContent = l.rev;
    x.dly.inp.value = l.dly; x.dly.out.textContent = l.dly;
    x.drv.inp.value = l.drv; x.drv.out.textContent = l.drv;
    strips[L].tsel.value = l.dlyT;
    strips[L].bfx.classList.toggle('has', !fxDefault(l));
  }

  function renderStrip(L) {
    var m = curMix(), st = strips[L], l = m.layers[L], vv = R.levelVariants(l.variant), per = l.variant.indexOf('/') >= 0;
    var known = vv.every(function (v) { return v === 'Off' || !!VAR[L][v]; });
    function ensureOpt(sel, v) { if (v !== 'Off' && !VAR[L][v] && !sel.querySelector('option[value="' + v + '"]')) sel.appendChild(new Option(v + ' (not in kit)', v)); }
    if (per) st.sel.value = '*'; else { ensureOpt(st.sel, l.variant); st.sel.value = l.variant; }
    st.sel.disabled = per;
    st.lvRow.hidden = !(per || st.perOpen);
    st.blv.setAttribute('aria-pressed', String(per || st.perOpen)); st.blv.classList.toggle('has', per);
    vv.forEach(function (v, i) { ensureOpt(st.lvSel[i], v); st.lvSel[i].value = v; });
    st.root.classList.toggle('off', l.variant === 'Off' || !known);
    for (var i = 0; i < 3; i++) { st.faders[i].value = l.vol[i]; st.outs[i].textContent = l.vol[i]; }
    st.spat.value = l.pat; st.sfill.value = String(l.fill);
    renderFxValues(L); renderDesc(L); renderPatLamp(L);
  }
  function renderDesc(L) {
    var l = curMix().layers[L], st = strips[L], v = variantOf(L), id = vidAt(L);
    var per = l.variant.indexOf('/') >= 0, pre = per ? LEVELS[lvl.target] + ' \u25b8 ' : '';
    st.desc.textContent = l.variant === 'Off' ? 'Layer off.' : v ? pre + v.desc : id === 'Off' ? pre + 'off at this level.' : '';
    var miss = R.levelVariants(l.variant).filter(function (x) { return x !== 'Off' && !VAR[L][x]; });
    if (miss.length) st.desc.appendChild(el('span', 'missing', ' ' + miss.join(', ') + ' not in the current kit (kept in the preset, silent here).'));
    var p = A.st[L] && A.st[L].pendingAt;
    if (p && A.playing) st.desc.appendChild(el('span', 'pend', '  ▸ switching on next bar'));
  }
  function renderPatLamp(L, k) {
    var l = curMix().layers[L], v = variantOf(L), st = strips[L];
    st.plamp.textContent = '';
    if (!v) return;
    var a = avail(v), notes = [];
    if (l.pat === 'AB' && !a.B) notes.push('no B pattern in this variant: plays A');
    if (l.fill && !a.Fill) notes.push('no fill in this variant');
    if (A.playing && k != null) {
      var pf = R.patternFor(l, a, k);
      st.plamp.appendChild(document.createTextNode('LOOP ' + (k + 1) + ': '));
      st.plamp.appendChild(el('b', null, pf.base + (pf.fill ? ' + FILL' : '')));
      if (notes.length) st.plamp.appendChild(document.createTextNode('  · ' + notes.join(', ')));
    } else st.plamp.textContent = notes.length ? notes.join(', ') : 'Patterns: ' + Object.keys(v.patterns).join(' / ');
  }

  function renderGlobals() {
    var m = curMix();
    $('tempoKey').textContent = kit.bpm + ' BPM \u00b7 ' + kit.key + ' \u00b7 ' + kit.bars + '-bar loops';
  }

  function renderPresets() {
    var ul = $('presetList'); ul.innerHTML = '';
    doc.mixes.forEach(function (m) {
      var li = el('li'); if (m.id === curId) li.className = 'sel';
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!m.rotation; cb.title = 'In server rotation';
      cb.setAttribute('aria-label', 'In rotation: ' + m.name);
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { m.rotation = cb.checked; changed(); });
      var on = LAYERS.filter(function (L) { return m.layers[L] && m.layers[L].variant !== 'Off'; }).length;
      li.appendChild(cb); li.appendChild(el('span', 'pname', m.name)); li.appendChild(el('span', 'ptag', on + '/' + LAYERS.length));
      li.addEventListener('click', function () { selectMix(m.id); });
      ul.appendChild(li);
    });
  }

  function selectMix(id) {
    var prev = curMix();
    curId = id;
    var m = curMix(); if (!m) return;
    $('mixName').value = m.name;
    LAYERS.forEach(function (L) { renderStrip(L); applyStatic(L); });
    renderGlobals(); renderPresets(); renderExtraLayers(); if (doc) renderLoudness();
    if (A.playing) {
      LAYERS.forEach(function (L) { onLayerChanged(L, 'bar'); });
    }
  }

  function renderExtraLayers() {
    var m = curMix(), extra = Object.keys(m.layers).filter(function (L) { return LAYERS.indexOf(L) < 0 && m.layers[L].variant !== 'Off'; });
    $('extraWarn').textContent = extra.length ? 'This preset also uses layers that are not in the current kit (kept and exported, silent here): ' + extra.join(', ') : '';
  }

  // Loudness estimate: loops are -20 LUFS (kit_report), gains power-summed (uncorrelated), master included.
  // Ignores filters/drive/sends; good to a few dB. Reference: v2.2 tracks played calm -28, combat -18 LUFS.
  var REF = [-28, -18, -18], CALM_WARN_DB = 6;
  // FX loudness (power): drive from the measured table; each delay adds w^2/(1-fb^2) of echoes; reverb adds w^2 (unit IR)
  function fxGainDb(l) {
    var db = 0;
    if (l.drv) { var i = Math.min(9, Math.floor(l.drv / 10)), f = l.drv / 10 - i; db += DRV_LOUD_DB[i] * (1 - f) + DRV_LOUD_DB[i + 1] * f; }
    var dw = wetGain(l.dly), rw = wetGain(l.rev);
    db += 10 * Math.log10(1 + dw * dw / (1 - DLY_FB * DLY_FB)) + 10 * Math.log10(1 + rw * rw);
    return db;
  }
  function loudAt(m, lv, lossOut) {
    var p = 0, mg = R.gainOf(R.mixVolumeOf(doc));
    LAYERS.forEach(function (L) {
      var l = m.layers[L], v = l && variantOf(L, m, lv); if (!v) return;
      var lu = v.patterns.A.lufs != null ? v.patterns.A.lufs : -20, g = R.gainOf(l.vol[lv]) * mg;
      var fl = filterLossDb(v.patterns.A.spec, l.lp[lv], l.hp) + fxGainDb(l);
      if (lossOut && fl < -6 && l.vol[lv] > 0) lossOut.push(L + ' ' + LVL_SHORT[lv] + ' ' + Math.round(fl) + ' dB');
      p += Math.pow(10, (lu + fl) / 10) * g * g;
    });
    return p > 0 ? 10 * Math.log10(p) : -Infinity;
  }
  function renderLoudness() {
    var m = curMix(); if (!m) return;
    var host = $('loudRows'); host.innerHTML = '';
    var loss = [], vals = [0, 1, 2].map(function (lv) { return loudAt(m, lv, loss); });
    vals.forEach(function (x, lv) {
      var row = el('div', 'loud-row ' + LVL_CLASS[lv]);
      row.appendChild(el('span', 'll', LVL_SHORT[lv]));
      var bar = el('div', 'loud-bar'), fill = el('div', 'loud-fill'), ref = el('div', 'loud-ref');
      var pos = function (db) { return Math.max(0, Math.min(100, (db + 60) / 50 * 100)); };   // -60..-10 LUFS
      fill.style.width = (isFinite(x) ? pos(x) : 0) + '%'; ref.style.left = pos(REF[lv]) + '%';
      ref.title = 'v2.2 ' + (lv ? 'combat' : 'calm') + ' ' + REF[lv] + ' LUFS';
      bar.appendChild(fill); bar.appendChild(ref); row.appendChild(bar);
      var d = isFinite(x) ? x - REF[lv] : null;
      row.appendChild(el('span', 'lv', isFinite(x) ? x.toFixed(1) + (d != null ? '  (' + (d >= 0 ? '+' : '') + d.toFixed(0) + ')' : '') : 'silent'));
      host.appendChild(row);
    });
    var c = vals[0];
    $('loudWarn').textContent = !isFinite(c) || c < REF[0] - CALM_WARN_DB
      ? 'Calm is ' + (isFinite(c) ? Math.round(REF[0] - c) + ' dB' : 'far') + ' below the v2.2 calm level (' + REF[0] + ' LUFS): it may be hard to hear in game. Raise the CALM faders (pads 45-65) or MASTER.'
      : '';
    if (loss.length) $('loudWarn').textContent += (c < REF[0] - CALM_WARN_DB ? ' ' : '') + 'Filters remove a lot: ' + loss.join(', ') + ' (Wwise LPF/HPF units; see FX).';
  }

  function renderExport() {
    if (!doc) return;
    renderLoudness();
    $('mode').value = doc.mode;
    $('ini').textContent = R.iniSection(doc, LAYERS);
    var rot = doc.mixes.filter(function (m) { return m.rotation; }), w = [];
    if (doc.mode !== 'Classic' && !rot.length) w.push('No mix is ticked for the rotation.');
    else if (doc.mode === 'Classic') w.push('Classic mode ignores the mixes.');
    else w.push(rot.length + ' mix' + (rot.length === 1 ? '' : 'es') + ' in rotation (one picked at random per map).');
    var pv = rot.filter(usesPreview).map(function (m) { return m.name; });
    void pv;
    $('exportWarn').textContent = w.join(' ');
    var n = rot.length;   // the mutator: Random = RandomIntegerInRange(0, N), N = Classic -> every option 1 in N+1
    $('modeHint').textContent = doc.mode === 'Random'
      ? 'Random: each map picks one of the ' + n + ' ticked mix' + (n === 1 ? '' : 'es') + ' or Classic, all equally likely (Classic 1 in ' + (n + 1) + '). Tick more mixes to hear Classic less often.'
      : doc.mode === 'Mix' ? 'Mix: each map picks one of the ticked mixes at random (equal odds). Classic is never played.'
      : 'Classic: the v2.2 tracks on every map; the mixes are ignored.';
    renderSens();
  }

  // ------------------------------------------------------------------ v3.1 music sensitivity (whole server, all modes)
  function renderSens() {
    var sv = R.sensOf(doc);
    R.SENS.forEach(function (s) {
      var key = s.key, inp = $('sens' + key), v = sv[s.id];
      if (+inp.value !== v) inp.value = v;
      var out = $('sens' + key + 'Val'); out.innerHTML = '';
      var b = el('b'); b.textContent = s.id === 'calmDownTime' ? v + ' s' : 'heat ' + v; out.appendChild(b);
      out.appendChild(document.createTextNode(s.id === 'calmDownTime'
        ? R.sensLabel(s.id, v) + ': MEDIUM holds at least ' + v + ' s, INTENSE ' + (v * 3 / 5) + ' s, after the fighting dies down'
        : R.sensLabel(s.id, v)));
      if (v === s.def) out.appendChild(document.createTextNode(' (default)'));
    });
    var def = R.sensLines(doc).length === 0;
    $('sensReset').disabled = def;
    $('sensNote').textContent = (def ? 'Defaults: nothing extra is written to Game.ini. ' : '') +
      'Heat: +1 per shot within 60 m, +2 more if it passes within 8 m, +4 every half second while suppressed, at least 6 when hit; halves every 5 s.' +
      ' Getting hit on its own (heat 6): ' + (sv.intenseAt <= 6 ? 'INTENSE.' : sv.mediumAt <= 6 ? 'MEDIUM, not INTENSE (Intense starts above 6).'
        : 'not even MEDIUM (Medium starts above 6).') +
      ' The v3.0 feel was Medium 2, Intense 5, calm-down 20 s.' +
      ' Needs Ambient Music v3.1 or later on the server (older versions ignore these keys).';
  }
  function sensInput() {
    var id = this.getAttribute('data-sens'), v = +this.value;
    doc[id] = v;   // keep MediumAt < IntenseAt by pushing the other slider
    if (id === 'mediumAt' && doc.intenseAt <= v) doc.intenseAt = Math.min(30, v + 0.5);
    if (id === 'intenseAt' && doc.mediumAt >= v) doc.mediumAt = Math.max(0.5, v - 0.5);
    var sv = R.sensOf(doc); R.SENS.forEach(function (s) { doc[s.id] = sv[s.id]; });
    changed();
  }
  function sensReset() { R.SENS.forEach(function (s) { doc[s.id] = s.def; }); changed(); }

  // ------------------------------------------------------------------ buffers (lazy fetch + decode, LRU)
  function fetchRaw(f) {
    if (!A.raw[f]) A.raw[f] = fetch(f).then(function (r) { if (!r.ok) throw new Error(f + ': HTTP ' + r.status); return r.arrayBuffer(); });
    return A.raw[f];
  }
  function decodeOn(ctx, ab) {
    return new Promise(function (res, rej) { var p = ctx.decodeAudioData(ab.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
  }
  function bufReady(f) { var c = A.cache[f]; if (c && c.buf) { c.used = ++A.useTick; return c.buf; } return null; }
  function ensure(files) {
    return Promise.all(files.filter(Boolean).map(function (f) {
      var c = A.cache[f];
      if (c) { c.used = ++A.useTick; return c.p; }
      c = A.cache[f] = { used: ++A.useTick, buf: null };
      c.p = fetchRaw(f).then(function (ab) { return decodeOn(A.ctx, ab); }).then(function (b) { c.buf = b; evict(); return b; },
        function (e) { delete A.cache[f]; throw e; });
      return c.p;
    }));
  }
  function filesFor(m) {
    var out = [];
    LAYERS.forEach(function (L) {
      var l = m.layers[L], v = variantOf(L, m);
      if (v) {
        out.push(v.patterns.A.file);
        if (l.pat === 'AB' && v.patterns.B) out.push(v.patterns.B.file);
        if (l.fill && v.patterns.Fill) out.push(v.patterns.Fill.file);
      }
      [0, 1, 2].forEach(function (lv) {        // other levels' variants: pre-decode their A so a level change lands on time
        var o = variantOf(L, m, lv); if (o && o !== v && out.indexOf(o.patterns.A.file) < 0) out.push(o.patterns.A.file);
      });
    });
    return out;
  }
  function evict() {
    var keys = Object.keys(A.cache).filter(function (f) { return A.cache[f].buf; });
    if (keys.length <= CACHE_MAX) return;
    var keep = {}; filesFor(curMix()).forEach(function (f) { keep[f] = 1; });
    LAYERS.forEach(function (L) { (A.st[L] ? A.st[L].segs : []).forEach(function (s) { keep[s.file] = 1; }); });
    keys.filter(function (f) { return !keep[f]; }).sort(function (a, b) { return A.cache[a].used - A.cache[b].used; })
      .slice(0, keys.length - CACHE_MAX).forEach(function (f) { delete A.cache[f]; });
  }

  // ------------------------------------------------------------------ audio graph (built for any context: live or offline test)
  function makeIR(ctx, secs) {
    var n = Math.floor(ctx.sampleRate * secs), ir = ctx.createBuffer(2, n, ctx.sampleRate), pre = Math.floor(ctx.sampleRate * 0.018);
    for (var c = 0; c < 2; c++) {
      var d = ir.getChannelData(c), lp = 0;
      for (var i = pre; i < n; i++) {
        var t = (i - pre) / ctx.sampleRate, a = 0.35 + 0.6 * (t / secs);            // darker as it decays
        lp += (Math.random() * 2 - 1 - lp) * (1 - a * 0.9);
        d[i] = lp * Math.exp(-6.9 * t / secs) * 0.6;
      }
    }
    for (c = 0; c < 2; c++) {                     // unit energy, so the send level means the same as a fader
      var e = 0, dd = ir.getChannelData(c); for (i = 0; i < n; i++) e += dd[i] * dd[i];
      var k = 1 / Math.sqrt(e || 1); for (i = 0; i < n; i++) dd[i] *= k;
    }
    return ir;
  }
  // ---- FX = the game's per-track inserts (NOTES.md "v3 FX in game"): Drive -> Delay 1/4 -> Delay dotted 1/8 -> Reverb,
  // then the voice LPF/HPF, pan and fader. Wet levels: 40*log10(v/100) - 3.1 dB = (v/100)^2 * 0.7; each bypassed at 0.
  var WET_RET = Math.pow(10, -3.1 / 20), DLY_FB = Math.pow(10, -8.4 / 20), DLY_FB_LP = 3800;
  var DRV_IN_DB = 24, DRV_TRIM_DB = -9;   // drive: input gain 0..+24 dB into tanh, output trimmed linearly 0..-9 dB
  var DRV_LOUD_DB = [0, 1.4, 2.8, 4.2, 5.5, 6.7, 7.7, 8.6, 9.2, 9.7, 9.8];   // measured on 24 kit loops (v = 0,10..100)
  function wetGain(v) { return v > 0 ? R.gainOf(v) * WET_RET : 0; }
  function driveCurve() {
    var n = 4096, c = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = (i / (n - 1) * 2 - 1) * 4; c[i] = Math.tanh(x); }   // input range +-4 (pre-scaled)
    return c;
  }
  function makeInsert(ctx) {               // dry path + wet path summed (DryLevel 0 dB)
    var ins = { in: ctx.createGain(), out: ctx.createGain(), wet: ctx.createGain() };
    ins.wet.gain.value = 0; ins.in.connect(ins.out); ins.wet.connect(ins.out);
    return ins;
  }
  function makeDelay(ctx, secs) {          // Stereo Delay: no crossfeed, feedback -8.4 dB through a 3.8 kHz low-pass
    var ins = makeInsert(ctx), d = ctx.createDelay(2.0), fl = ctx.createBiquadFilter(), fb = ctx.createGain();
    d.delayTime.value = secs; fl.type = 'lowpass'; fl.frequency.value = DLY_FB_LP; fl.Q.value = 0.5; fb.gain.value = DLY_FB;
    ins.in.connect(d); d.connect(ins.wet); d.connect(fl); fl.connect(fb); fb.connect(d);
    ins.node = d;
    return ins;
  }
  function makeReverb(ctx, ir) {           // RoomVerb stand-in: 2.6 s decay, 18 ms pre-delay, no early reflections
    var ins = makeInsert(ctx); ins.conv = ctx.createConvolver(); ins.conv.normalize = false; ins.conv.buffer = ir;
    ins.conv.connect(ins.wet); ins.on = false;
    return ins;
  }
  function buildGraph(ctx, onepole) {
    var G = { ctx: ctx, layers: {}, onepole: !!onepole };
    G.master = ctx.createGain(); G.master.connect(ctx.destination);
    G.an = ctx.createAnalyser(); G.an.fftSize = 1024; G.master.connect(G.an);
    G.bus = ctx.createGain(); G.bus.connect(G.master);
    G.ir = makeIR(ctx, 2.6); G.curve = driveCurve();
    var beat = 60 / kit.bpm;
    LAYERS.forEach(function (L) {
      var x = {};
      x.in = ctx.createGain();
      x.pre = ctx.createGain(); x.shaper = ctx.createWaveShaper(); x.shaper.oversample = '2x'; x.post = ctx.createGain();
      x.d4 = makeDelay(ctx, beat * DLY_BEATS['4']); x.d8 = makeDelay(ctx, beat * DLY_BEATS['8d']); x.rv = makeReverb(ctx, G.ir);
      if (G.onepole) { x.flt = new AudioWorkletNode(ctx, 'am-onepole', { outputChannelCount: [2] }); x.fin = x.fout = x.flt; }
      else {   // fallback without AudioWorklet: gentlest biquads (12 dB/oct, steeper than Wwise)
        x.hp = ctx.createBiquadFilter(); x.hp.type = 'highpass'; x.hp.frequency.value = 10; x.hp.Q.value = 0.5;
        x.lp = ctx.createBiquadFilter(); x.lp.type = 'lowpass'; x.lp.frequency.value = 20000; x.lp.Q.value = 0.5;
        x.hp.connect(x.lp); x.fin = x.hp; x.fout = x.lp;
      }
      x.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      x.fader = ctx.createGain(); x.fader.gain.value = 0; x.drv = -1;
      x.an = ctx.createAnalyser(); x.an.fftSize = 1024;
      x.in.connect(x.pre); x.pre.connect(x.shaper); x.shaper.connect(x.post);
      x.post.connect(x.d4.in); x.d4.out.connect(x.d8.in); x.d8.out.connect(x.rv.in); x.rv.out.connect(x.fin);
      x.fout.connect(x.pan); x.pan.connect(x.fader); x.fader.connect(G.bus); x.fader.connect(x.an);
      G.layers[L] = x;
    });
    return G;
  }
  function setDelayTimes() { /* fixed at 90 BPM: 1/4 = 0.667 s, dotted 1/8 = 0.5 s (built in buildGraph) */ }
  // static (non-intensity) layer parameters
  function applyStaticTo(G, L, l) {
    var x = G.layers[L], t = G.ctx.currentTime;
    setHP(x, l.hp, t);
    if (x.pan.pan) x.pan.pan.setTargetAtTime(l.pan / 100, t, 0.02);
    var dw = wetGain(l.dly), d8 = l.dlyT !== '4';
    x.d4.wet.gain.setTargetAtTime(d8 ? 0 : dw, t, 0.02);
    x.d8.wet.gain.setTargetAtTime(d8 ? dw : 0, t, 0.02);
    var rw = wetGain(l.rev);
    x.rv.wet.gain.setTargetAtTime(rw, t, 0.02);
    if (rw > 0 && !x.rv.on) { x.rv.in.connect(x.rv.conv); x.rv.on = true; }        // bypassed at 0: no convolution CPU
    else if (rw === 0 && x.rv.on) { x.rv.in.disconnect(x.rv.conv); x.rv.on = false; }
    if (x.drv !== l.drv) {
      x.drv = l.drv;
      if (!l.drv) { x.shaper.curve = null; x.pre.gain.value = 1; x.post.gain.value = 1; }
      else {
        x.shaper.curve = G.curve;
        x.pre.gain.value = Math.pow(10, DRV_IN_DB * l.drv / 100 / 20) / 4;           // curve input spans +-4
        x.post.gain.value = Math.pow(10, DRV_TRIM_DB * l.drv / 100 / 20);
      }
    }
  }
  function setHP(x, u, t) {
    if (x.flt) x.flt.parameters.get('hp').setTargetAtTime(u ? hpHz(u) : 0, t, 0.02);
    else x.hp.frequency.setTargetAtTime(u ? hpHz(u) : 10, t, 0.02);
  }
  function setLP(x, u, t, immediate) {
    var prm = x.flt ? x.flt.parameters.get('lp') : x.lp.frequency, hz = u > 0 ? lpHz(u) : x.flt ? 0 : 20000;
    if (immediate) prm.setValueAtTime(hz, t); else prm.setTargetAtTime(hz, t, 0.03);
  }
  function lpNowHz(x) { return x.flt ? x.flt.parameters.get('lp').value : x.lp.frequency.value; }
  function applyStatic(L) { if (A.ready) applyStaticTo(A.G, L, curMix().layers[L]); }



  // ------------------------------------------------------------------ engine
  function makeContext() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio');
    try { return new AC({ sampleRate: kit.sampleRate, latencyHint: 'playback' }); } catch (e) { return new AC(); }
  }
  function initAudio() {
    if (A.ready) return Promise.resolve();
    A.ctx = makeContext();
    A.buf = new Float32Array(1024);
    var aw = A.ctx.audioWorklet, onepole = false;
    var wk = aw ? aw.addModule('js/onepole-worklet.js').then(function () { onepole = true; }, function () { onepole = false; })
                : Promise.resolve();
    return wk.then(function () {
      A.G = buildGraph(A.ctx, onepole); A.onepole = onepole;
      if (!onepole) status('NOTE: no AudioWorklet, filter preview uses steeper biquads', 'err');
      A.ready = true;
      LAYERS.forEach(function (L) { A.st[L] = { segs: [], planEnd: 0, needFade: false, pendingAt: 0 }; applyStatic(L); });
      setMaster();
    });
  }

  function loopIndex(t) { return Math.floor((t - A.t0) / A.Lc + 1e-7); }
  function nextBar(t) { return A.t0 + Math.ceil((t - A.t0) / A.barC - 1e-7) * A.barC; }
  function nextLoop(t) { return A.t0 + Math.ceil((t - A.t0) / A.Lc - 1e-7) * A.Lc; }

  function addSeg(L, file, buf, start, end, offC, fade) {
    var ctx = A.ctx, st = A.st[L];
    var src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; src.playbackRate.value = A.rate;
    if (fade) { g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(1, start + XF); }
    src.connect(g); g.connect(A.G.layers[L].in);
    src.start(start, Math.max(0, offC * A.rate));
    src.stop(end);
    st.segs.push({ src: src, g: g, start: start, end: end, file: file });
  }

  // Plan this layer's audio from st.planEnd up to (now + ahead), one loop iteration at a time.
  function schedLayer(L, ahead) {
    var st = A.st[L], now = A.ctx.currentTime, m = curMix(), guard = 0;
    st.segs = st.segs.filter(function (s) { if (s.end < now - 0.25) { s.g.disconnect(); return false; } return true; });
    while (st.planEnd < now + ahead && guard++ < 64) {
      var T = st.planEnd, k = loopIndex(T), kStart = A.t0 + k * A.Lc, kEnd = kStart + A.Lc;
      var l = m.layers[L], v = variantOf(L, m);
      if (!v) { st.planEnd = kEnd; st.needFade = true; continue; }
      var pf = R.patternFor(l, avail(v), k);
      var bf = v.patterns[pf.base].file, ff = pf.fill ? v.patterns.Fill.file : null;
      var bb = bufReady(bf), fb = ff ? bufReady(ff) : null;
      if (!bb || (ff && !fb)) {             // not decoded yet: fetch, and rejoin on a bar line when ready
        ensure([bf, ff]).catch(function (e) { status('STEM FAILED: ' + e.message, 'err'); });
        if (T < now + 0.08) { st.planEnd = nextBar(now + 0.08); st.needFade = true; }
        break;
      }
      var fade = st.needFade || T > kStart + 1e-6; st.needFade = false;
      if (fb) {
        var fd = fb.duration / A.rate;
        if (fd >= A.Lc - 0.005) addSeg(L, ff, fb, T, kEnd, T - kStart, fade);           // full-length fill loop
        else {
          var fs = kEnd - fd;                                                              // short fill = loop tail
          if (T < fs - 1e-6) { addSeg(L, bf, bb, T, fs, T - kStart, fade); addSeg(L, ff, fb, fs, kEnd, 0, false); }
          else addSeg(L, ff, fb, T, kEnd, T - fs, fade);
        }
      } else addSeg(L, bf, bb, T, kEnd, T - kStart, fade);
      st.planEnd = kEnd;
    }
  }

  // Drop everything planned at/after T; crossfade out whatever is sounding across T.
  function cutLayer(L, T, xfade) {
    var st = A.st[L];
    st.segs = st.segs.filter(function (s) {
      if (s.start >= T - 1e-6) { try { s.src.stop(); } catch (e) { /* not started */ } s.g.disconnect(); return false; }
      if (s.end > T + 1e-6) {
        s.g.gain.setValueAtTime(1, T); s.g.gain.linearRampToValueAtTime(0, T + XF);
        try { s.src.stop(T + XF); } catch (e) { /* ok */ }
        s.end = T + XF;
      }
      return true;
    });
    if (st.planEnd > T) { st.planEnd = T; st.needFade = !!xfade; }
  }

  function onLayerChanged(L, when) {
    renderDesc(L);
    if (!A.playing) return;
    var m = curMix();
    ensure(filesFor(m)).catch(function () { /* reported by the scheduler */ });
    var now = A.ctx.currentTime, T = when === 'loop' ? nextLoop(now + 0.05) : nextBar(now + 0.05);
    cutLayer(L, T, when !== 'loop');
    A.st[L].pendingAt = when === 'loop' ? 0 : T;
    schedLayer(L, LOOKAHEAD);
    renderDesc(L);
  }

  function play() {
    return initAudio().then(function () { return A.ctx.resume(); }).then(function () {
      if (A.playing) return;
      var m = curMix();
      status('LOADING STEMS…');
      return ensure(filesFor(m)).then(function () {
        A.rate = 1;
        A.Lc = kit.loopSamples / kit.sampleRate / A.rate; A.barC = A.Lc / kit.bars;
        setDelayTimes(A.G, A.rate);
        A.t0 = A.ctx.currentTime + 0.15; A.playing = true;
        LAYERS.forEach(function (L) { var st = A.st[L]; st.segs = []; st.planEnd = A.t0; st.needFade = false; st.pendingAt = 0; schedLayer(L, LOOKAHEAD); });
        applyGains(true);
        var b = $('btnPlay'); b.classList.add('playing'); b.querySelector('.lbl').textContent = 'STOP';
        status('PLAYING  ·  ' + m.name, 'ok');
      });
    });
  }
  function stopAudio() {
    if (!A.playing) return;
    LAYERS.forEach(function (L) { A.st[L].segs.forEach(function (s) { try { s.src.stop(); } catch (e) { /* ok */ } s.g.disconnect(); }); A.st[L].segs = []; A.st[L].pendingAt = 0; });
    A.playing = false;
  }
  function stop() {
    if (!A.playing) return;
    stopAudio();
    LAYERS.forEach(renderDesc);
    var b = $('btnPlay'); b.classList.remove('playing'); b.querySelector('.lbl').textContent = 'PLAY';
    status('STOPPED'); setAuto(false);
  }
  function restartTransport() { if (!A.playing) return Promise.resolve(); stopAudio(); return play(); }

  function setMaster(fromInput) {
    if (fromInput === true && doc) { doc.mixVolume = R.clampVol($('master').value); changed(); }
    var v = doc ? R.mixVolumeOf(doc) : +$('master').value;
    $('master').value = v; $('masterOut').textContent = v;
    if (A.ready) A.G.master.gain.setTargetAtTime(R.gainOf(v), A.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------------ intensity (3 s ramp in fader space: volume + low-pass)
  function rampP() { return clamp01((nowS() - lvl.t) / RAMP_S); }
  function heatNow() { return lerp(lvl.fromI, lvl.target, rampP()); }
  function curParam(L, m, key) {
    var tgt = m.layers[L][key][lvl.target], p = rampP(), f = lvl.from[L];
    return p >= 1 || !f || f[key] == null ? tgt : lerp(f[key], tgt, p);
  }
  function setLevel(n, fromAuto) {
    if (!fromAuto) setAuto(false);
    var m = curMix();
    if (m) LAYERS.forEach(function (L) { lvl.from[L] = { vol: curParam(L, m, 'vol'), lp: curParam(L, m, 'lp') }; });
    var before = m ? LAYERS.map(function (L) { return vidAt(L, m); }) : [];
    lvl.fromI = heatNow(); lvl.target = n; lvl.t = nowS();
    if (m) LAYERS.forEach(function (L, i) { if (vidAt(L, m) !== before[i]) onLayerChanged(L, 'bar'); else renderDesc(L); });
    var btns = document.querySelectorAll('#segIntensity .seg-btn');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-checked', String(+btns[i].getAttribute('data-lvl') === n));
  }
  function setAuto(on) {
    auto.on = on; clearTimeout(auto.timer);
    $('btnAuto').setAttribute('aria-pressed', String(on));
    $('btnAuto').textContent = on ? 'AUTO COMBAT: ON' : 'AUTO COMBAT';
    if (on) { auto.step = 0; autoStep(); }
  }
  function autoStep() {
    if (!auto.on) return;
    var s = AUTO_STEPS[auto.step % AUTO_STEPS.length];
    setLevel(s[0], true); auto.step++;
    auto.timer = setTimeout(autoStep, s[1] * 1000);
  }

  function applyGains(immediate) {
    var m = curMix(); if (!A.ready || !m) return;
    var anySolo = LAYERS.some(function (L) { return solo[L]; }), t = A.ctx.currentTime;
    LAYERS.forEach(function (L) {
      var x = A.G.layers[L], on = !mute[L] && (!anySolo || solo[L]);
      var g = on ? R.gainOf(curParam(L, m, 'vol')) : 0, u = curParam(L, m, 'lp');
      if (immediate) { x.fader.gain.cancelScheduledValues(t); x.fader.gain.setValueAtTime(g, t); } else x.fader.gain.setTargetAtTime(g, t, 0.03);
      setLP(x, u, t, immediate);
    });
  }

  function rms(an) {
    an.getFloatTimeDomainData(A.buf);
    var s = 0; for (var i = 0; i < A.buf.length; i++) s += A.buf[i] * A.buf[i];
    return clamp01((10 * Math.log10(s / A.buf.length + 1e-12) + 54) / 54);
  }

  var lastK = -1;
  function tick() {
    var h = heatNow();
    $('heatFill').style.width = (h / 2 * 100) + '%';
    $('heatTxt').textContent = rampP() < 1 ? (LEVELS[lvl.target] + ' …') : LEVELS[lvl.target];
    var live = Math.round(h);
    if (live !== lastLive) {
      LAYERS.forEach(function (L) {
        strips[L].rows.forEach(function (r, i) { r.classList.toggle('live', i === live); });
        [0, 1, 2].forEach(function (i) { strips[L].fxr['lp' + i].row.classList.toggle('live', i === live); });
      });
      lastLive = live;
    }
    if (!A.ready) return;
    applyGains(false);
    var t = A.ctx.currentTime;
    if (A.playing) LAYERS.forEach(function (L) {
      schedLayer(L, LOOKAHEAD);
      var st = A.st[L]; if (st.pendingAt && t >= st.pendingAt) { st.pendingAt = 0; renderDesc(L); }
    });
    LAYERS.forEach(function (L) {
      var v = A.playing ? rms(A.G.layers[L].an) : 0;
      meterLevel[L] = Math.max(v, meterLevel[L] - 0.04);
      strips[L].fill.style.width = (meterLevel[L] * 100) + '%';
    });
    var mv = A.playing ? rms(A.G.an) : 0;
    meterLevel._m = Math.max(mv, (meterLevel._m || 0) - 0.04);
    $('masterMeter').style.width = (meterLevel._m * 100) + '%';
    var lamps = $('bars').children, bar = -1, k = -1;
    if (A.playing && t >= A.t0) { k = loopIndex(t); bar = Math.floor((t - A.t0 - k * A.Lc) / A.barC); }
    for (var i = 0; i < lamps.length; i++) lamps[i].className = i === bar ? 'on' : '';
    if (k !== lastK) { lastK = k; LAYERS.forEach(function (L) { renderPatLamp(L, k >= 0 ? k : null); }); }
  }

  // ------------------------------------------------------------------ presets
  function rnd(a, b) { return Math.round(a + Math.random() * (b - a)); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function chance(p) { return Math.random() < p; }
  var W1 = ['Ghost', 'Iron', 'Night', 'Viper', 'Ash', 'Shadow', 'Steel', 'Delta', 'Echo', 'Raven', 'Dust', 'Cold', 'Storm', 'Silent', 'Black', 'Red'];
  var W2 = ['Ridge', 'Line', 'Watch', 'Run', 'Fall', 'Strike', 'Sector', 'Point', 'Signal', 'Front', 'Hollow', 'Grid', 'Dawn', 'Wire'];
  function role(L) {
    var n = L.toLowerCase();
    if (/drum|perc|beat|kit/.test(n)) return 'drums';
    if (/orch|brass|string/.test(n)) return 'orch';
    if (/bass|sub/.test(n)) return 'bass';
    if (/pad|drone|string|choir|atmo/.test(n)) return 'pad';
    if (/guitar|gtr/.test(n)) return 'guitar';
    if (/^fx|fx$|tex|noise|sfx/.test(n)) return 'fx';
    if (/lead|arp|pluck|bell|synth|key|piano|melod/.test(n)) return 'lead';
    return 'other';
  }
  function suitsOf(L, lv) {   // variant IDs of layer L suited to level lv (0 calm, 1 medium, 2 intense)
    var key = ['calm', 'medium', 'intense'][lv];
    var ids = VIDS[L].filter(function (v) { return (VAR[L][v].suits || []).indexOf(key) >= 0; });
    return ids.length ? ids : VIDS[L];
  }
  // Sensible random, suits-aware: always a pad; drums low in calm; heavy sounds kept for intense;
  // sometimes a different variant per level (calm sound -> intense sound) on rhythm/bass/guitar/orch layers.
  function randomLayers() {
    var o = blankLayers(), seen = {};
    var pads = LAYERS.filter(function (L) { return role(L) === 'pad'; });
    var mustPad = pads.length ? pick(pads) : LAYERS.filter(function (L) { return role(L) !== 'drums'; })[0];
    LAYERS.forEach(function (L) {
      var r = role(L), nth = seen[r] = (seen[r] || 0) + 1, l = R.defaultLayer();
      var p = { drums: nth > 1 ? 0.55 : 0.9, bass: 0.85, pad: 0.6, orch: 0.55, lead: nth > 1 ? 0.4 : 0.6, guitar: 0.55, fx: 0.65, other: 0.5 }[r];
      if (L !== mustPad && !chance(p)) return;
      var perLevel = /drums|bass|guitar|orch/.test(r) && chance(0.35), vv;
      if (perLevel) {
        vv = [pick(suitsOf(L, 0)), pick(suitsOf(L, 1)), pick(suitsOf(L, 2))];
        if ((r === 'guitar' || r === 'drums') && chance(0.5)) vv[0] = 'Off';
      } else { var one = pick(VIDS[L]); vv = [one, one, one]; }
      l.variant = R.normVariant(vv.join('/'));
      var main = VAR[L][vv[2] !== 'Off' ? vv[2] : vv[1]], a = avail(main);
      var d = (main.desc + ' ' + main.label).toLowerCase(), su = main.suits || [];
      var calmOk = !!(VAR[L][vv[0]] && (VAR[L][vv[0]].suits || []).indexOf('calm') >= 0);
      if (r === 'pad' || L === mustPad) {
        l.vol = [rnd(45, 62), rnd(55, 70), rnd(45, 75)];
        if (chance(0.6)) l.rev = rnd(10, 35);
        if (chance(0.35)) l.lp = [rnd(25, 50), rnd(5, 25), 0];
      } else if (r === 'drums') {
        l.vol = [calmOk ? rnd(10, 30) : rnd(0, 8), rnd(45, 65), rnd(85, 100)];
        if (chance(0.5)) l.lp = [rnd(30, 55), rnd(0, 20), 0];
      } else if (r === 'bass') {
        l.vol = [calmOk ? rnd(15, 40) : rnd(0, 15), rnd(55, 75), rnd(80, 100)];
        if (chance(0.2)) l.drv = rnd(10, 35);
      } else if (r === 'guitar' && !perLevel && ((su.length === 1 && su[0] === 'intense') || /chug|palm|heavy|distort/.test(d))) {
        l.vol = [0, rnd(0, 30), rnd(65, 90)];
      } else if (r === 'orch') {
        l.vol = [calmOk ? rnd(25, 50) : 0, rnd(50, 75), rnd(60, 90)];
      } else if (r === 'guitar' || r === 'lead') {
        l.vol = su.indexOf('intense') >= 0 && su.indexOf('calm') < 0 ? [0, rnd(25, 45), rnd(60, 85)]
          : r === 'guitar' ? [rnd(25, 50), rnd(35, 55), rnd(0, 45)] : [rnd(20, 45), rnd(35, 60), rnd(30, 65)];
        if (chance(0.45)) { l.dly = rnd(15, 35); l.dlyT = pick(R.DLY_TIMES); }
        if (chance(0.5)) l.rev = rnd(10, 30);
        if (chance(0.4)) l.pan = (chance(0.5) ? -1 : 1) * rnd(10, 35);
      } else if (r === 'fx') {
        l.vol = [rnd(25, 55), rnd(25, 50), rnd(20, 45)];
      } else l.vol = [rnd(10, 45), rnd(35, 60), rnd(45, 75)];
      if (a.B && chance(0.6)) l.pat = 'AB';
      if (a.Fill && (r === 'drums' || chance(0.3))) l.fill = chance(0.75) ? 4 : 2;
      o[L] = l;
    });
    return o;
  }
  function addMix(m) { doc.mixes.push(R.normMix(m, LAYERS)); selectMix(m.id); changed(); }
  function firstOf(r) { return LAYERS.filter(function (L) { return role(L) === r; })[0]; }
  function actNew() {
    var l = blankLayers(), dr = firstOf('drums'), ba = firstOf('bass'), pa = firstOf('pad') || LAYERS[0];
    if (dr) {
      var calm = VIDS[dr].filter(function (v) { var su = VAR[dr][v].suits; return su ? su.indexOf('calm') >= 0 : /minimal|calm|soft|pulse/i.test(VAR[dr][v].desc); })[0];
      l[dr] = Object.assign(R.defaultLayer(), { variant: calm || VIDS[dr][0], vol: [calm ? 15 : 0, 55, 85] });
    }
    if (ba) l[ba] = Object.assign(R.defaultLayer(), { variant: VIDS[ba][0], vol: [20, 60, 85] });
    if (pa) l[pa] = Object.assign(R.defaultLayer(), { variant: VIDS[pa][0], vol: [55, 65, 60] });
    addMix({ id: newId(), name: uniqueName('New Mix'), rotation: false, layers: l });
    $('mixName').focus(); $('mixName').select();
  }
  function actDup() {
    var m = curMix(); if (!m) return;
    var c = clone(m); c.id = newId(); c.rotation = false; c.name = uniqueName(m.name.slice(0, 27) + ' copy');
    addMix(c);
  }
  function actRandom() {
    addMix({ id: newId(), name: uniqueName(pick(W1) + ' ' + pick(W2)), rotation: false, layers: randomLayers() });
    status('RANDOM MIX: ' + curMix().name, A.playing ? 'ok' : '');
  }
  function actDelete() {
    var m = curMix(); if (!m) return;
    if (!window.confirm('Delete preset "' + m.name + '"? (Takes effect when you Save.)')) return;
    var i = doc.mixes.indexOf(m); doc.mixes.splice(i, 1);
    if (!doc.mixes.length) { actNew(); return; }
    selectMix(doc.mixes[Math.min(i, doc.mixes.length - 1)].id); changed();
  }
  function actRenameCommit() {
    var m = curMix(); if (!m) return;
    var n = uniqueName($('mixName').value, m.id);
    $('mixName').value = n;
    if (n !== m.name) { m.name = n; renderPresets(); changed(); }
  }
  function actSave() {
    actRenameCommit();
    $('btnSave').disabled = true; status('SAVING…');
    return saveDoc(doc).then(function (d) {
      var idx = doc.mixes.indexOf(curMix());
      doc = normDoc(d); savedJson = JSON.stringify(doc); setMaster();
      curId = (doc.mixes[idx] || doc.mixes[0] || {}).id;
      renderPresets(); changed();
      status('SAVED ' + (LOCAL ? 'IN THIS BROWSER ' : '') + new Date().toLocaleTimeString(), 'ok');
    }).catch(function (e) { status('SAVE FAILED: ' + e.message, 'err'); changed(); });
  }
  function actRevert() {
    return loadDoc().then(function (d) {
      doc = normDoc(d); savedJson = JSON.stringify(doc); setMaster();
      var keep = doc.mixes.some(function (m) { return m.id === curId; }) ? curId : (doc.mixes[0] || {}).id;
      selectMix(keep); changed(); status(LOCAL ? 'RELOADED (BROWSER STORAGE)' : 'RELOADED FROM SERVER');
    });
  }

  function openImport() { $('modalErr').textContent = ''; $('modalText').value = ''; $('modal').hidden = false; $('modalText').focus(); }
  function closeModal() { $('modal').hidden = true; }
  function doImport() {
    var lines = $('modalText').value.split(/\r?\n/), added = [], errs = [], warns = [], mode = null, sens = {};
    lines.forEach(function (raw, n) {
      var t = raw.trim();
      if (!t || t[0] === '[' || t[0] === ';') return;
      var mm = /^MusicMode\s*=\s*(\w+)/i.exec(t);
      var mv = /^MixVolume\s*=\s*"?(-?[\d.]+)"?\s*$/i.exec(t);
      if (mv) { doc.mixVolume = R.clampVol(mv[1]); setMaster(); return; }
      if (mm) { var md = R.MODES.filter(function (x) { return x.toLowerCase() === mm[1].toLowerCase(); })[0]; if (md) mode = md; return; }
      var ms = /^(MediumAt|IntenseAt|CalmDownTime)\s*=\s*"?([^"]*)"?\s*$/i.exec(t);
      if (ms) { var sd = R.SENS.filter(function (x) { return x.key.toLowerCase() === ms[1].toLowerCase(); })[0]; sens[sd.id] = ms[2]; return; }
      try {
        var r = R.parseRecipe(t, LAYERS), mix = r.mix;
        mix.id = newId(); mix.rotation = true; mix.name = uniqueName(mix.name);
        doc.mixes.push(R.normMix(mix, LAYERS)); added.push(mix);
        r.warnings.forEach(function (w) { warns.push(mix.name + ': ' + w); });
      } catch (e) { errs.push('line ' + (n + 1) + ': ' + e.message); }
    });
    if (mode) doc.mode = mode;
    if (Object.keys(sens).length) {   // a pasted Game.ini section: missing keys mean the defaults
      R.SENS.forEach(function (s) { doc[s.id] = s.id in sens ? sens[s.id] : s.def; });
      var sv = R.sensOf(doc); R.SENS.forEach(function (s) { doc[s.id] = sv[s.id]; });
    }
    if (mode || Object.keys(sens).length) changed();
    if (added.length) { selectMix(added[added.length - 1].id); changed(); }
    if (errs.length || warns.length) {
      $('modalErr').textContent = (added.length ? 'Imported ' + added.length + '. ' : '') + errs.concat(warns).join('\n');
      if (errs.length) return;
    } else closeModal();
    status('IMPORTED ' + added.length + ' MIX' + (added.length === 1 ? '' : 'ES'), 'ok');
  }
  function copyIni() {
    var text = $('ini').textContent, msg = $('copyMsg');
    function ok() { msg.textContent = 'Copied to clipboard.'; }
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { msg.textContent = 'Copy blocked: select the text and press Ctrl+C.'; }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }

  // ------------------------------------------------------------------ wiring
  function wire() {
    $('btnPlay').addEventListener('click', function () {
      if (A.playing) { stop(); return; }
      $('btnPlay').disabled = true;
      play().catch(function (e) { status('AUDIO FAILED: ' + e.message, 'err'); }).then(function () { $('btnPlay').disabled = false; });
    });
    var seg = document.querySelectorAll('#segIntensity .seg-btn');
    for (var i = 0; i < seg.length; i++) seg[i].addEventListener('click', function () { setLevel(+this.getAttribute('data-lvl')); });
    $('btnAuto').addEventListener('click', function () {
      if (auto.on) { setAuto(false); return; }
      setAuto(true);
      if (!A.playing && !$('btnPlay').disabled) $('btnPlay').click();
    });
    $('master').addEventListener('input', function () { setMaster(true); });
    $('btnNew').addEventListener('click', actNew);
    $('btnDup').addEventListener('click', actDup);
    $('btnRename').addEventListener('click', function () { $('mixName').focus(); $('mixName').select(); });
    $('btnRandom').addEventListener('click', actRandom);
    $('btnDelete').addEventListener('click', actDelete);
    $('btnImport').addEventListener('click', openImport);
    $('btnSave').addEventListener('click', actSave);
    $('btnRevert').addEventListener('click', function () { if (window.confirm('Discard unsaved changes?')) actRevert(); });
    $('mixName').addEventListener('change', actRenameCommit);
    $('mixName').addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });
    $('mode').addEventListener('change', function () { doc.mode = this.value; changed(); });
    R.SENS.forEach(function (s) { $('sens' + s.key).addEventListener('input', sensInput); });
    $('sensReset').addEventListener('click', sensReset);
    $('btnCopy').addEventListener('click', copyIni);
    $('modalOk').addEventListener('click', doImport);
    $('modalCancel').addEventListener('click', closeModal);
    $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) {
      var tg = e.target.tagName;
      if (tg === 'INPUT' && e.target.type !== 'range' || tg === 'TEXTAREA' || tg === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { closeModal(); return; }
      if (!$('modal').hidden) return;
      if (e.key === ' ') { e.preventDefault(); if (!$('btnPlay').disabled) $('btnPlay').click(); }
      else if (e.key === '1' || e.key === '2' || e.key === '3') setLevel(+e.key - 1);
    });
    window.addEventListener('beforeunload', function (e) { if (doc && isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  }

  function boot() {
    wire();
    status('LOADING KIT');
    return loadKit().then(function (k) { return Promise.all([k, loadDoc()]); }).then(function (r) {
      kit = r[0];
      kit.layers.forEach(function (l) {
        LAYERS.push(l.name); VIDS[l.name] = l.variants.map(function (v) { return v.id; });
        VAR[l.name] = {}; l.variants.forEach(function (v) { VAR[l.name][v.id] = v; });
      });
      var nst = kit.layers.reduce(function (n, l) { return n + l.variants.reduce(function (a, v) { return a + Object.keys(v.patterns).length; }, 0); }, 0);
      $('kitInfo').textContent = 'Stem kit · ' + LAYERS.length + ' layers · ' + nst + ' loops · ' + kit.bpm + ' BPM · ' + kit.key + ' · ' + kit.bars + '-bar loops';
      doc = normDoc(r[1]); if (doc.mixVolume == null) doc.mixVolume = 80;
      savedJson = JSON.stringify(doc);
      buildStrips(); setMaster();
      if (!doc.mixes.length) actNew(); else selectMix(doc.mixes[0].id);
      setLevel(0); changed();
      if (/[?&]openfx=1/.test(location.search)) LAYERS.forEach(function (L) { strips[L].bfx.click(); });
      setInterval(tick, 33);
      var b = $('btnPlay'); b.disabled = false; b.querySelector('.lbl').textContent = 'PLAY';
      status((LOCAL ? 'BROWSER MODE \u00b7 ' : '') + 'READY  ·  ' + nst + ' LOOPS', 'ok');
      // warm the HTTP cache with the current mix's stems (decode happens on PLAY)
      filesFor(curMix()).forEach(function (f) { fetchRaw(f).catch(function () { /* reported on play */ }); });
    }).catch(function (e) { status('LOAD FAILED: ' + e.message, 'err'); throw e; });
  }

  // ------------------------------------------------------------------ self-test (?selftest=1)
  var stLines = [];
  function selftestLog(s) { stLines.push(s); var p = $('selftest'); if (p) { p.hidden = false; p.textContent = stLines.join('\n'); } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function selftest() {
    var fails = 0;
    function check(c, msg) { selftestLog((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; }
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext, m0 = curMix();
    return (LOCAL ? Promise.resolve(null) : api('GET', 'api/export')).then(function (txt) {
      if (LOCAL) selftestLog('INFO browser mode (no Python server): presets in localStorage');
      else check(txt === R.iniSection(doc, LAYERS), 'JS iniSection == server api/export');
      if (m0.layers[LAYERS[0]].variant === 'Off')   // the engine checks below use the first layer: make sure it plays (unsaved)
        Object.assign(m0.layers[LAYERS[0]], { variant: VIDS[LAYERS[0]][0], vol: [50, 60, 70] });
      check(LAYERS.length === kit.layers.length && LAYERS.every(function (L) { return strips[L].sel.options.length >= VIDS[L].length + 1; }),
        'strips built from kit: ' + LAYERS.length + ' layers');
      if (kit.layerOrder) check(LAYERS.join(',') === kit.layerOrder.join(','), 'layer order = report layer_order: ' + LAYERS.join(' '));
      var trip = R.parseRecipe('T|Bass=V1/V1/V7:40,70,90|Guitar=Off/V1/V7:0,30,90:pat=AB|Pad=V2/V2/V2:1,2,3', LAYERS).mix;
      check(trip.layers.Bass ? trip.layers.Bass.variant === 'V1/V1/V7' && trip.layers.Pad.variant === 'V2' && R.recipeLine(trip, LAYERS).indexOf('Guitar=Off/V1/V7:0,30,90:pat=AB') > 0 : true, 'per-level variant recipe parses/collapses');
      var rt = doc.mixes.every(function (m) { var p = R.parseRecipe(R.recipeLine(m, LAYERS), LAYERS).mix; p.id = m.id; p.rotation = m.rotation; return R.recipeLine(R.normMix(p, LAYERS), LAYERS) === R.recipeLine(m, LAYERS); });
      check(rt, 'every preset recipe round-trips');
      var iniLines = R.iniSection(doc, LAYERS).split('\n').filter(function (x) { return x.indexOf('+Mixes=') === 0; });
      var qok = iniLines.every(function (x) { return /^\+Mixes="[^"]+"$/.test(x) && '+Mixes="' + R.recipeLine(R.normMix(R.parseRecipe(x, LAYERS).mix, LAYERS), LAYERS) + '"' === x; });
      var uq = R.parseRecipe('+Mixes=Q|Drums=V1:1,2,3', LAYERS).mix, qq = R.parseRecipe('+Mixes="Q|Drums=V1:1,2,3"', LAYERS).mix;
      check(qok && R.recipeLine(uq, LAYERS) === R.recipeLine(qq, LAYERS), 'Game.ini lines are quoted (' + iniLines.length + ') and re-import; unquoted import still works');
      var mvLine = R.iniSection(doc, LAYERS).split('\n')[2];
      check(mvLine === 'MixVolume=' + R.mixVolumeOf(doc), 'export has ' + mvLine + ' (master fader)');
      var sx = function (o) { return R.iniSection(Object.assign({ mode: 'Classic', mixes: [] }, o), LAYERS).split('\n').slice(3).join(' ').trim(); };
      check(sx({}) === '' && sx({ mediumAt: 5, intenseAt: 20, calmDownTime: 10 }) === '' &&
            sx({ mediumAt: 2, intenseAt: 5, calmDownTime: 20 }) === 'MediumAt=2 IntenseAt=5 CalmDownTime=20' &&
            sx({ mediumAt: 0.5, intenseAt: 1.5, calmDownTime: 6 }) === 'MediumAt=0.5 IntenseAt=1.5 CalmDownTime=6' &&
            sx({ mediumAt: 4, intenseAt: 3 }) === 'MediumAt=4 IntenseAt=4.5' && sx({ mediumAt: 'x', intenseAt: 99, calmDownTime: 2.4 }) === 'IntenseAt=30 CalmDownTime=5' &&
            sx({ mediumAt: '2.74' }) === 'MediumAt=2.5',
        'sensitivity export: defaults (5/20/10) write nothing, v3.0 values 2/5/20 are written, test/bad values snap + clamp, IntenseAt > MediumAt');
      check(/equally likely \(Classic 1 in \d+\)/.test($('modeHint').textContent) || doc.mode !== 'Random', 'MusicMode hint: ' + $('modeHint').textContent.slice(0, 60));
      var keepMv = doc.mixVolume, t1 = { layers: {} }, L0 = LAYERS[0], L1 = LAYERS[1];
      LAYERS.forEach(function (L) { t1.layers[L] = R.defaultLayer(); });
      t1.layers[L0] = Object.assign(R.defaultLayer(), { variant: VIDS[L0][0], vol: [100, 50, 0] });
      t1.layers[L1] = Object.assign(R.defaultLayer(), { variant: VIDS[L1][0], vol: [100, 0, 0] });
      doc.mixVolume = 100;
      var e0 = loudAt(t1, 0), e1 = loudAt(t1, 1), e2 = loudAt(t1, 2), lu0 = VAR[L0][VIDS[L0][0]].patterns.A.lufs;
      lu0 = lu0 == null ? -20 : lu0;
      doc.mixVolume = 80; var e0m = loudAt(t1, 0);
      doc.mixVolume = keepMv;
      var tl = Object.assign(R.defaultLayer(), { rev: 100, dly: 100, drv: 0 });
      check(Math.abs(fxGainDb(tl) - (10 * Math.log10(1 + 0.49 / (1 - DLY_FB * DLY_FB)) + 10 * Math.log10(1.49))) < 0.01 && Math.abs(20 * Math.log10(wetGain(50)) - (40 * Math.log10(0.5) - 3.1)) < 0.01 && fxGainDb(R.defaultLayer()) === 0,
        'FX levels: wet(50) = ' + (20 * Math.log10(wetGain(50))).toFixed(2) + ' dB, rev+dly 100 add ' + fxGainDb(tl).toFixed(2) + ' dB');
      check(Math.abs(e1 - (lu0 - 12.04)) < 0.05 && e2 === -Infinity && e0 > e1 && Math.abs(e0 - e0m - 40 * Math.log10(1.25)) < 0.01,
        'loudness estimate: 1 loop @50 = ' + e1.toFixed(1) + ', 2 loops @100 = ' + e0.toFixed(1) + ', master 80 = ' + (e0m - e0).toFixed(2) + ' dB');
      var seq = [], l = { pat: 'AB', fill: 4 };
      for (var k = 0; k < 8; k++) { var pf = R.patternFor(l, { A: 1, B: 1, Fill: 1 }, k); seq.push(pf.base + (pf.fill ? '+F' : '')); }
      check(seq.join(' ') === 'A B A B+F A B A B+F', 'patternFor AB fill4: ' + seq.join(' '));
      seq = []; for (k = 0; k < 4; k++) { pf = R.patternFor({ pat: 'A', fill: 2 }, { A: 1 }, k); seq.push(pf.base + (pf.fill ? '+F' : '')); }
      check(seq.join(' ') === 'A A A A', 'fill without a Fill pattern plays A');
      // offline: decode one pattern per layer and render it through the full FX chain
      var oc = new OAC(2, kit.sampleRate * 4, kit.sampleRate), files = LAYERS.map(function (L) { return VAR[L][VIDS[L][0]].patterns.A.file; });
      return Promise.all(files.map(function (f) { return fetchRaw(f).then(function (ab) { return decodeOn(oc, ab); }); })).then(function (bs) {
        var bad = bs.filter(function (b) { return b.length !== kit.loopSamples; });
        check(!bad.length, 'decoded loops = ' + kit.loopSamples + ' samples (' + bs.length + ' checked)');
        return oc.audioWorklet.addModule('js/onepole-worklet.js').then(function () { return bs; });
      }).then(function (bs) {
        var G = buildGraph(oc, true); setDelayTimes(G, 1);
        bs.forEach(function (b, i) {
          var L = LAYERS[i], s = oc.createBufferSource(); s.buffer = b; s.loop = true; s.connect(G.layers[L].in); s.start(0);
          applyStaticTo(G, L, Object.assign(R.defaultLayer(), { hp: 25, pan: i % 2 ? -40 : 40, rev: 50, dly: 40, dlyT: R.DLY_TIMES[i % R.DLY_TIMES.length], drv: 60 }));
          setLP(G.layers[L], 40, 0, true); G.layers[L].fader.gain.value = R.gainOf(60);
        });
        return oc.startRendering();
      });
    }).then(function (out) {
      var d0 = out.getChannelData(0), d1 = out.getChannelData(1), s = 0, peak = 0, finite = true;
      for (var i = 0; i < d0.length; i++) { s += d0[i] * d0[i]; peak = Math.max(peak, Math.abs(d0[i]), Math.abs(d1[i])); if (!isFinite(d0[i] + d1[i])) finite = false; }
      var r = Math.sqrt(s / d0.length);
      check(finite && r > 0.01, 'offline render through HP/LP/drive/pan/reverb/delay: rms ' + r.toFixed(3) + ', peak ' + peak.toFixed(2));
      check(Math.abs(lpHz(48) - 1484) < 1 && Math.abs(lpHz(100) - 17) < 0.5 && Math.abs(hpHz(58) - 2489) < 1 && Math.abs(hpHz(50) - 1249) < 1 && lpHz(0) === 20000,
        'Wwise table: LPF 48 = ' + Math.round(lpHz(48)) + ' Hz, LPF 100 = ' + Math.round(lpHz(100)) + ' Hz, HPF 58 = ' + Math.round(hpHz(58)) + ' Hz, HPF 50 = ' + Math.round(hpHz(50)) + ' Hz');
      // one-pole check: sine at fc and 8*fc through the worklet LP (LPF 50 = 1249 Hz) and HP (HPF 50 = 1249 Hz)
      var fc = lpHz(50), tones = [[fc, 'lp'], [fc * 8, 'lp'], [fc, 'hp'], [fc / 8, 'hp']];
      return Promise.resolve().then(function () {
        return Promise.all(tones.map(function (tn) {
          var c = new OAC(1, 24000, 48000);
          return c.audioWorklet.addModule('js/onepole-worklet.js').then(function () {
            var o = c.createOscillator(); o.frequency.value = tn[0];
            var f = new AudioWorkletNode(c, 'am-onepole', { outputChannelCount: [1] });
            f.parameters.get(tn[1]).value = fc; o.connect(f); f.connect(c.destination); o.start(0);
            return c.startRendering();
          }).then(function (b) {
            var d = b.getChannelData(0), s2 = 0, n = 0; for (var i = 6000; i < d.length; i++) { s2 += d[i] * d[i]; n++; }
            return 10 * Math.log10(s2 / n / 0.5);   // vs unfiltered sine power 0.5
          });
        }));
      }).then(function (db) {
        var exp = [10 * Math.log10(lpPow(fc, fc)), 10 * Math.log10(lpPow(fc * 8, fc)), 10 * Math.log10(hpPow(fc, fc)), 10 * Math.log10(hpPow(fc / 8, fc))];
        var ok = db.every(function (x, i) { return Math.abs(x - exp[i]) < 0.3; }) && Math.abs(db[0] + 3) < 0.5 && db[1] < -16 && db[1] > -20;
        check(ok, 'one-pole filters (6 dB/oct) at 1249 Hz: LP @fc ' + db[0].toFixed(1) + ' dB, @8fc ' + db[1].toFixed(1) + ' dB; HP @fc ' + db[2].toFixed(1) + ', @fc/8 ' + db[3].toFixed(1) + ' (estimator ' + exp.map(function (x) { return x.toFixed(1); }).join('/') + ')');
        // delay inserts: impulse -> first echo at the game's time with the game's wet level (-3.1 dB at v=100)
        return Promise.all(['4', '8d'].map(function (dt) {
          var c = new OAC(2, 72000, 48000), G = buildGraph(c, false), L = LAYERS[0], x = G.layers[L];
          applyStaticTo(G, L, Object.assign(R.defaultLayer(), { dly: 100, dlyT: dt })); x.fader.gain.value = 1;
          var b = c.createBuffer(2, 72000, 48000); b.getChannelData(0)[4800] = 1; b.getChannelData(1)[4800] = 1;
          var src = c.createBufferSource(); src.buffer = b; src.connect(x.in); src.start(0);
          return c.startRendering().then(function (o) {
            var d = o.getChannelData(0);
            function en(t0) { var e = 0; for (var i = Math.round(t0 * 48000) - 240; i < Math.round(t0 * 48000) + 240; i++) e += d[i] * d[i]; return e; }
            var dt_s = dt === '4' ? 2 / 3 : 0.5, other = dt === '4' ? 0.5 : 2 / 3;
            return [10 * Math.log10(en(0.1 + dt_s) / en(0.1)), 10 * Math.log10((en(0.1 + other) + 1e-12) / en(0.1))];
          });
        })).then(function (r) {
          check(Math.abs(r[0][0] + 3.1) < 0.3 && Math.abs(r[1][0] + 3.1) < 0.3 && r[0][1] < -60 && r[1][1] < -60,
            'delay inserts: 1/4 echo at 0.667 s ' + r[0][0].toFixed(1) + ' dB, dotted 1/8 echo at 0.5 s ' + r[1][0].toFixed(1) + ' dB (game -3.1)');
          return play();
        });
      });
    }).then(function () {
      check(A.ctx.state === 'running' && A.onepole, 'AudioContext running (' + A.ctx.sampleRate + ' Hz), filter worklet ' + (A.onepole ? 'loaded' : 'MISSING'));
      return sleep(1200);
    }).then(function () {
      var L = LAYERS[0]; schedLayer(L, A.Lc + 1);
      var segs = A.st[L].segs.slice().sort(function (a, b) { return a.start - b.start; });
      var join = segs.length >= 2 && segs.every(function (s, i) { return i === 0 || Math.abs(segs[i - 1].end - s.start) < 1e-9; });
      check(join && Math.abs(segs[1].start - (A.t0 + A.Lc)) < 1e-9, L + ': loop segments butt-join on the loop grid (' + segs.length + ' planned)');
      var vids = VIDS[L], cur = m0.layers[L].variant, nv = vids.filter(function (v) { return v !== cur; })[0];
      return ensure([VAR[L][nv].patterns.A.file]).then(function () { return { L: L, vids: vids, nv: nv }; });
    }).then(function (c) {
      var L = c.L, vids = c.vids, nv = c.nv;
      m0.layers[L].variant = nv; onLayerChanged(L, 'bar');
      var T = A.st[L].pendingAt, kb = (T - A.t0) / A.barC;
      var news = A.st[L].segs.filter(function (s) { return s.file === VAR[L][nv].patterns.A.file; });
      check(T > A.ctx.currentTime && Math.abs(kb - Math.round(kb)) < 1e-6 && news.length && Math.abs(news[0].start - T) < 1e-9,
        'variant switch cuts in exactly on bar ' + kb.toFixed(4));
      // synthetic A/B/short-fill variant to exercise the pattern scheduler with real buffers
      var fa = VAR[L][vids[0]].patterns.A.file, fbf = VAR[L][vids[1] || vids[0]].patterns.A.file;
      return ensure([fa, fbf]).then(function (bufs) {
        var fill = A.ctx.createBuffer(2, Math.round(bufs[0].length / kit.bars), bufs[0].sampleRate);
        A.cache['selftest:fill'] = { buf: fill, used: 1e9, p: Promise.resolve(fill) };
        VAR[L].V99 = { id: 'V99', label: 'selftest', desc: 'selftest', patterns: { A: { file: fa }, B: { file: fbf }, Fill: { file: 'selftest:fill' } } };
        Object.assign(m0.layers[L], { variant: 'V99', pat: 'AB', fill: 2 });
        onLayerChanged(L, 'loop');
        schedLayer(L, A.Lc * 4);
        var Tl = nextLoop(A.ctx.currentTime + 0.05), k0 = Math.round((Tl - A.t0) / A.Lc);
        var plan = A.st[L].segs.filter(function (s) { return s.start >= Tl - 1e-9; }).sort(function (a, b) { return a.start - b.start; });
        var desc = plan.map(function (s) {
          var k = Math.floor((s.start - A.t0) / A.Lc + 1e-7), tag = s.file === 'selftest:fill' ? 'F' : s.file === fbf && fbf !== fa ? 'B' : 'A';
          return 'L' + k + ':' + tag;
        });
        var exp = [], kk;
        for (kk = k0; kk < k0 + 4; kk++) { var pf = R.patternFor({ pat: 'AB', fill: 2 }, { A: 1, B: 1, Fill: 1 }, kk); exp.push('L' + kk + ':' + pf.base); if (pf.fill) exp.push('L' + kk + ':F'); }
        var contig = plan.every(function (s, i) { return i === 0 || Math.abs(plan[i - 1].end - s.start) < 1e-9; });
        var fills = plan.filter(function (s) { return s.file === 'selftest:fill'; });
        var fillOk = fills.length && fills.every(function (s) { var e = A.t0 + (Math.floor((s.start - A.t0) / A.Lc + 1e-7) + 1) * A.Lc; return Math.abs(s.end - e) < 1e-9 && Math.abs(e - s.start - A.Lc / kit.bars) < 1e-3; });
        check(vids.length > 1 ? desc.slice(0, exp.length).join(' ') === exp.join(' ') : true, 'pattern plan from next loop: ' + desc.slice(0, exp.length).join(' ') + ' (expected ' + exp.join(' ') + ')');
        check(contig && fillOk, 'pattern segments contiguous; short fill fills the last bar of its loop');
        delete VAR[L].V99; delete A.cache['selftest:fill'];
        Object.assign(m0.layers[L], { variant: nv, pat: 'A', fill: 0 }); onLayerChanged(L, 'bar');
        return sleep(Math.max(0, (A.st[L].pendingAt - A.ctx.currentTime) * 1000) + 300);
      });
    }).then(function () {
      // real kit: Varied + Fill every 4 = A, B, A, Fill (full-length fill replaces the loop)
      var L = LAYERS[0], ml = m0.layers[L], keep = clone(ml), v = VAR[L][VIDS[L][0]];
      if (!(v.patterns.B && v.patterns.Fill)) { selftestLog('SKIP A/B/Fill sequence (kit has no B/Fill)'); return; }
      Object.assign(ml, { variant: VIDS[L][0], pat: 'AB', fill: 4 });
      return ensure([v.patterns.A.file, v.patterns.B.file, v.patterns.Fill.file]).then(function () {
        onLayerChanged(L, 'loop'); schedLayer(L, A.Lc * 5);
        var Tl = nextLoop(A.ctx.currentTime + 0.05), tag = {};
        tag[v.patterns.A.file] = 'A'; tag[v.patterns.B.file] = 'B'; tag[v.patterns.Fill.file] = 'Fill';
        var plan = A.st[L].segs.filter(function (s) { return s.start >= Tl - 1e-9; }).sort(function (a, b) { return a.start - b.start; });
        var byK = {}, ok = true;
        plan.forEach(function (s) { var k = Math.round((s.start - A.t0) / A.Lc); if (byK[k]) ok = false; byK[k] = tag[s.file]; if (Math.abs(s.end - s.start - A.Lc) > 1e-6) ok = false; });
        var ks = Object.keys(byK).map(Number).sort(function (a, b) { return a - b; });
        var seq = ks.map(function (k) { return byK[k]; }), exp = ks.map(function (k) { return ['A', 'B', 'A', 'Fill'][k % 4]; });
        check(ok && ks.length >= 4 && seq.join(' ') === exp.join(' '), 'Varied + Fill 4 on real kit, loops ' + ks.join(',') + ': ' + seq.join(' ') + ' (one full-loop segment each; A B A Fill per 4)');
        Object.assign(ml, keep); onLayerChanged(L, 'loop');
      });
    }).then(function () {
      // per-level variant: switch on the next bar when the level changes
      var L = LAYERS.filter(function (x) { return VIDS[x].length >= 2; })[0], ml = m0.layers[L], keep = clone(ml);
      var a = VIDS[L][0], b = VIDS[L][VIDS[L].length - 1];
      Object.assign(ml, { variant: R.normVariant(a + '/' + a + '/' + b), vol: [60, 60, 60], pat: 'A', fill: 0 });
      return ensure([VAR[L][a].patterns.A.file, VAR[L][b].patterns.A.file]).then(function () {
        onLayerChanged(L, 'bar');
        return sleep(Math.max(0, (A.st[L].pendingAt - A.ctx.currentTime) * 1000) + 200);
      }).then(function () {
        setLevel(2);
        var T = A.st[L].pendingAt, kb = (T - A.t0) / A.barC;
        var seg = A.st[L].segs.filter(function (s) { return s.file === VAR[L][b].patterns.A.file && Math.abs(s.start - T) < 1e-9; });
        check(T > 0 && Math.abs(kb - Math.round(kb)) < 1e-6 && seg.length === 1, L + ' ' + ml.variant + ': level change -> ' + b + ' cuts in on bar ' + kb.toFixed(4));
        setLevel(0);
        var T0 = A.st[L].pendingAt;
        check(A.st[L].segs.some(function (s) { return s.file === VAR[L][a].patterns.A.file && Math.abs(s.start - T0) < 1e-9; }), 'back to CALM -> ' + a + ' on the next bar');
        Object.assign(ml, keep); onLayerChanged(L, 'bar');
      });
    }).then(function () {
      // memory: audition many variants; decoded cache must stay bounded
      var L = LAYERS[0], ml = m0.layers[L], keep = ml.variant, chain = Promise.resolve(), n = 0;
      LAYERS.slice(0, 4).forEach(function (Lx) { VIDS[Lx].forEach(function (vx) { chain = chain.then(function () { return ensure([VAR[Lx][vx].patterns.A.file, VAR[Lx][vx].patterns.B && VAR[Lx][vx].patterns.B.file]); }).then(function () { n++; }); }); });
      return chain.then(function () {
        var dec = Object.keys(A.cache).filter(function (f) { return A.cache[f].buf; }), mb = 0;
        dec.forEach(function (f) { var b = A.cache[f].buf; mb += b.length * b.numberOfChannels * 4 / 1048576; });
        var lim = Math.max(CACHE_MAX, filesFor(curMix()).length);
        check(dec.length <= lim, 'auditioned ' + n + ' variants (A+B): ' + dec.length + ' decoded loops kept (' + Math.round(mb) + ' MB, limit ' + lim + ')');
        ml.variant = keep;
        return sleep(Math.max(0, (A.st[L].pendingAt - A.ctx.currentTime) * 1000) + 300);
      });
    }).then(function () {
      var L = LAYERS[0], now = A.ctx.currentTime;
      check(A.st[L].segs.some(function (s) { return s.start <= now && s.end > now && s.file === variantOf(L).patterns.A.file; }), 'after the bar line the new variant is the sounding segment');
      setLevel(2);
      m0.layers[L].lp = [70, 30, 10];
      return sleep(3400);
    }).then(function () {
      var L = LAYERS[0], x = A.G.layers[L], l = m0.layers[L];
      var g = x.fader.gain.value, want = R.gainOf(l.vol[2]), f = lpNowHz(x), wf = lpHz(l.lp[2]);
      check(Math.abs(g - want) < 0.02 && Math.abs(f - wf) / wf < 0.05, 'INTENSE reached after 3 s ramp (gain ' + g.toFixed(3) + '/' + want.toFixed(3) + ', LP ' + Math.round(f) + '/' + Math.round(wf) + ' Hz)');
      check(rms(A.G.an) > 0.2, 'master meter has signal');
      var r = R.parseRecipe('X|Drums=V1:1,2,3:dly=20,8|Bass=V1:1,2,3:dly=10,4|@Tape=2|@Key=-1', LAYERS);
      var line = R.recipeLine(r.mix, LAYERS);
      check(line.indexOf('@') < 0 && line.indexOf('dly=20,8d') > 0 && line.indexOf('dly=10,4') > 0 && !r.warnings.length && !('tape' in R.normMix({ tape: 2, key: 1, layers: {} }, LAYERS)),
        'old @Tape/@Key ignored silently, delay 8 -> 8d: ' + line.split('|').slice(0, 3).join('|'));
      check(R.DLY_TIMES.join(',') === '4,8d' && strips[LAYERS[0]].tsel.options.length === 2 && !document.getElementById('tape') && !document.getElementById('key'), 'UI: delay 1/4 + dotted 1/8 only; no Tape/Key controls');
      stop();
    }).then(function () {
      selftestLog(fails ? 'SELFTEST FAIL (' + fails + ')' : 'SELFTEST PASS');
      document.title = fails ? 'SELFTEST FAIL' : 'SELFTEST PASS';
    }).catch(function (e) { selftestLog('SELFTEST ERROR ' + (e && e.stack || e)); document.title = 'SELFTEST ERROR'; })
      .then(function () { return fetch('api/selftest', { method: 'PUT', body: navigator.userAgent + '\n' + stLines.join('\n') + '\n' }); });
  }

  var bootP = boot();
  if (/[?&]selftest=1/.test(location.search)) bootP.then(selftest);
})();
