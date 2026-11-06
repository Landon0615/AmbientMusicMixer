/* Ambient Music v3 - mix model + recipe format, shared by the mixer page and node tests.
   Keep in sync with mixlib in mixer_server.py (the self-test compares both outputs).

   Recipe = one +Mixes= value in Game.ini, parsed by the AmbientMusic mutator. In Game.ini the value MUST be
   double-quoted (+Mixes="Name|..."): Unreal's ini reader cuts an unquoted value at the first '|'.
     Name|<Layer>=<Variant>:<calm>,<medium>,<intense>[:<opt>=<val>]...|...|[@Tape=<st>]|[@Key=<st>]
     <Layer>=Off                              layer silent
     <Layer>=V1/V1/V7:<c>,<m>,<i>             per-intensity variant (calm/medium/intense; any may be Off),
                                              switched at the next bar like a Wwise switch at Next Bar
   Layer options (all optional, omitted when default, unknown keys ignored by readers):
     lp=c,m,i   low-pass per intensity, Wwise Voice LPF units 0-100 (0 = open)
     hp=v       high-pass, Wwise Voice HPF units 0-100 (0 = off)
     pan=v      -100 (left) .. 100 (right)
     rev=v      reverb send 0-100
     dly=v,T    delay send 0-100, T = 4 (1/4) or 8d (dotted 1/8); an old 8 (1/8) is read as 8d
     drv=v      drive 0-100
     pat=AB     pattern variation: A (steady, default) or AB (A/B alternating per loop)
     fill=N     fill pattern on every Nth loop: 0 (off, default), 2, 4
   Globals: none at the moment. Old @Tape / @Key (removed 2026-11-06, the game has no pitch shifter) are ignored.
   Version-1 recipes (no options, six fixed layers) are valid version-2 recipes. Volume gain = (v/100)^2. */
(function (root) {
  'use strict';
  var DEFAULT_LAYERS = ['Drums', 'Bass', 'Pad', 'Lead', 'Guitar', 'FX'];   // v1 kit; real list comes from api/kit
  var MODES = ['Mix', 'Classic', 'Random'];
  var SECTION = '[/AmbientMusic/Mutators/AmbientMusic.AmbientMusic_C]';
  var NAME_MAX = 32;
  var DLY_TIMES = ['4', '8d'];
  function normDlyT(t) { t = String(t == null ? '' : t).trim(); return t === '4' ? '4' : '8d'; }   // '8' (removed) -> '8d'
  var PATS = ['A', 'AB'];
  var FILLS = [0, 2, 4];
  var LAYER_RE = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
  var VARIANT_RE = /^(Off|V\d{1,2})(\/(Off|V\d{1,2})\/(Off|V\d{1,2}))?$/;

  // 'Off' | 'Vn' | 'Va/Vb/Vc' (calm/medium/intense); equal triples collapse to one ID.
  function normVariant(v) {
    if (typeof v !== 'string' || !VARIANT_RE.test(v)) return 'Off';
    var p = v.split('/');
    return p.length === 3 && p[0] === p[1] && p[1] === p[2] ? p[0] : v;
  }
  function levelVariants(v) { var p = normVariant(v).split('/'); return p.length === 1 ? [p[0], p[0], p[0]] : p; }

  // Characters that would break the recipe or the ini line.
  function sanitizeName(s) {
    s = String(s == null ? '' : s)
      .replace(/[|=:,;@"\\\[\]\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).trim();
    return s || 'Mix';
  }
  function clampInt(v, lo, hi) {
    v = Math.round(Number(v));
    if (!isFinite(v)) v = 0;
    return Math.max(lo, Math.min(hi, v));
  }
  function clampVol(v) { return clampInt(v, 0, 100); }
  function gainOf(v) { var x = clampVol(v) / 100; return x * x; }
  function tri(a) { a = Array.isArray(a) ? a : [0, 0, 0]; return [clampVol(a[0]), clampVol(a[1]), clampVol(a[2])]; }

  function defaultLayer() {
    return { variant: 'Off', vol: [0, 0, 0], lp: [0, 0, 0], hp: 0, pan: 0, rev: 0, dly: 0, dlyT: '8d', drv: 0, pat: 'A', fill: 0 };
  }
  // Fill in defaults / clamp; used for migration of v1 presets and for anything imported.
  function normLayer(l) {
    l = l || {};
    var v = normVariant(l.variant);
    return {
      variant: v, vol: tri(l.vol), lp: tri(l.lp), hp: clampVol(l.hp), pan: clampInt(l.pan, -100, 100),
      rev: clampVol(l.rev), dly: clampVol(l.dly), dlyT: normDlyT(l.dlyT),
      drv: clampVol(l.drv), pat: PATS.indexOf(l.pat) >= 0 ? l.pat : 'A',
      fill: FILLS.indexOf(Number(l.fill)) >= 0 ? Number(l.fill) : 0
    };
  }
  function normMix(m, layerNames) {
    var out = { id: m.id, name: sanitizeName(m.name), rotation: !!m.rotation, layers: {} };
    var src = m.layers || {};
    Object.keys(src).forEach(function (L) { if (LAYER_RE.test(L)) out.layers[L] = normLayer(src[L]); });
    (layerNames || []).forEach(function (L) { if (!out.layers[L]) out.layers[L] = defaultLayer(); });
    return out;
  }

  // Layer order for the recipe: kit layers first (in kit order), then any other layer that is not Off.
  function layerOrder(mix, layerNames) {
    var names = (layerNames || DEFAULT_LAYERS).slice();
    Object.keys(mix.layers || {}).sort().forEach(function (L) {
      if (names.indexOf(L) < 0 && LAYER_RE.test(L) && mix.layers[L] && normVariant(mix.layers[L].variant) !== 'Off') names.push(L);
    });
    return names;
  }

  function layerSpec(l) {
    l = normLayer(l);
    if (l.variant === 'Off') return 'Off';
    var s = l.variant + ':' + l.vol.join(',');
    if (l.lp[0] || l.lp[1] || l.lp[2]) s += ':lp=' + l.lp.join(',');
    if (l.hp) s += ':hp=' + l.hp;
    if (l.pan) s += ':pan=' + l.pan;
    if (l.rev) s += ':rev=' + l.rev;
    if (l.dly) s += ':dly=' + l.dly + ',' + l.dlyT;
    if (l.drv) s += ':drv=' + l.drv;
    if (l.pat !== 'A') s += ':pat=' + l.pat;
    if (l.fill) s += ':fill=' + l.fill;
    return s;
  }

  function recipeLine(mix, layerNames) {
    var parts = [sanitizeName(mix.name)];
    layerOrder(mix, layerNames).forEach(function (L) { parts.push(L + '=' + layerSpec((mix.layers || {})[L])); });
    return parts.join('|');
  }

  // Master fader = in-game MixVolume: bus gain (MixVolume/100)^2, default 80.
  function mixVolumeOf(doc) { return doc.mixVolume == null || doc.mixVolume === '' ? 80 : clampVol(doc.mixVolume); }
  function iniSection(doc, layerNames) {
    var lines = [SECTION, 'MusicMode=' + (MODES.indexOf(doc.mode) >= 0 ? doc.mode : 'Mix'), 'MixVolume=' + mixVolumeOf(doc)];
    // Quoted: Unreal's ini reader truncates an unquoted value at the first '|'. Names never contain '"' or '\\'.
    (doc.mixes || []).forEach(function (m) { if (m.rotation) lines.push('+Mixes="' + recipeLine(m, layerNames) + '"'); });
    return lines.join('\n') + '\n';
  }

  // Accepts "Name|Layer=...", a whole "+Mixes=Name|..." line, quoted or not (v1/v2/v3). Returns {mix, warnings} or throws.
  function parseRecipe(text, layerNames) {
    var t = String(text).trim().replace(/^\+?Mixes\s*=\s*/, '').trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1).trim();   // one pair of quotes
    var parts = t.split('|'), warnings = [];
    if (parts.length < 2) throw new Error('not a recipe (needs Name|Layer=...)');
    var mix = { name: sanitizeName(parts[0]), rotation: false, layers: {} };
    (layerNames || DEFAULT_LAYERS).forEach(function (L) { mix.layers[L] = defaultLayer(); });
    parts.slice(1).forEach(function (p) {
      p = p.trim(); if (!p) return;
      var eq = p.indexOf('=');
      if (eq < 1) throw new Error('bad part: ' + p);
      var key = p.slice(0, eq).trim(), spec = p.slice(eq + 1).trim();
      if (key[0] === '@') {
        var g = key.slice(1).toLowerCase();
        if (g !== 'tape' && g !== 'key') warnings.push('ignored unknown global ' + key);   // @Tape/@Key: removed, silently dropped
        return;
      }
      var known = (layerNames || DEFAULT_LAYERS).filter(function (x) { return x.toLowerCase() === key.toLowerCase(); })[0];
      var L = known || key;
      if (!LAYER_RE.test(L)) throw new Error('bad layer name: ' + key);
      if (!known && layerNames) warnings.push('layer ' + L + ' is not in the current kit');
      var f = spec.split(':'), l = defaultLayer();
      var vp = f[0].trim().split('/').map(function (x) { x = x.trim(); return /^off$/i.test(x) ? 'Off' : /^v\d{1,2}$/i.test(x) ? 'V' + x.slice(1) : null; });
      if ((vp.length !== 1 && vp.length !== 3) || vp.indexOf(null) >= 0) throw new Error(L + ': bad variant "' + f[0] + '"');
      l.variant = normVariant(vp.join('/'));
      if (l.variant === 'Off') { mix.layers[L] = l; return; }
      var vols = (f[1] || '').split(',');
      if (vols.length !== 3 || vols.some(function (x) { return x.trim() === '' || !isFinite(Number(x)); }))
        throw new Error(L + '=' + l.variant + ' needs :calm,medium,intense');
      l.vol = tri(vols);
      f.slice(2).forEach(function (o) {
        var e = o.indexOf('='), k = (e > 0 ? o.slice(0, e) : o).trim().toLowerCase(), v = e > 0 ? o.slice(e + 1).trim() : '';
        var a = v.split(',');
        if (k === 'lp') { if (a.length !== 3) throw new Error(L + ': lp needs 3 values'); l.lp = tri(a); }
        else if (k === 'hp') l.hp = clampVol(v);
        else if (k === 'pan') l.pan = clampInt(v, -100, 100);
        else if (k === 'rev') l.rev = clampVol(v);
        else if (k === 'dly') { l.dly = clampVol(a[0]); if (a[1] != null) { if (['4', '8d', '8'].indexOf(a[1].trim()) < 0) throw new Error(L + ': delay time must be 4 or 8d'); l.dlyT = normDlyT(a[1]); } }
        else if (k === 'drv') l.drv = clampVol(v);
        else if (k === 'pat') { var P = v.toUpperCase(); if (PATS.indexOf(P) < 0) throw new Error(L + ': pat must be A or AB'); l.pat = P; }
        else if (k === 'fill') { if (FILLS.indexOf(Number(v)) < 0) throw new Error(L + ': fill must be 0, 2 or 4'); l.fill = Number(v); }
        else warnings.push(L + ': ignored unknown option ' + k);
      });
      mix.layers[L] = l;
    });
    return { mix: mix, warnings: warnings };
  }

  // Which pattern(s) a layer plays in loop k (k counts from the start of the music, shared by all layers).
  // pats = {A:true,B:true,Fill:true} availability. Returns the base pattern and whether this loop ends in the fill.
  function patternFor(l, pats, k) {
    var base = (l.pat === 'AB' && pats.B && k % 2 === 1) ? 'B' : 'A';
    var fill = !!(l.fill && pats.Fill && (k + 1) % l.fill === 0);
    return { base: base, fill: fill };
  }

  var api = { DEFAULT_LAYERS: DEFAULT_LAYERS, LAYERS: DEFAULT_LAYERS, MODES: MODES, SECTION: SECTION, NAME_MAX: NAME_MAX,
              DLY_TIMES: DLY_TIMES, sanitizeName: sanitizeName, clampVol: clampVol, clampInt: clampInt, gainOf: gainOf,
              mixVolumeOf: mixVolumeOf, defaultLayer: defaultLayer, normVariant: normVariant, levelVariants: levelVariants, normLayer: normLayer, normMix: normMix, layerSpec: layerSpec,
              recipeLine: recipeLine, iniSection: iniSection, parseRecipe: parseRecipe, patternFor: patternFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MixRecipe = api;
})(this);
