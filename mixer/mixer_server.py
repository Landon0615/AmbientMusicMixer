#!/usr/bin/env python3
"""Ambient Music v3 - Music Mixer page server (Python 3.8+ stdlib only).

Serves the mixer page + OGG stems and stores presets in data/music_mixes.json.

    python3 mixer_server.py [--port 8765] [--lan] [--open]      (default: 127.0.0.1 only)

API (JSON unless noted):
    GET  api/kit      -> stem kit: tempo + layers -> variants -> patterns (A/B/Fill) -> file (data-driven)
    GET  api/mixes    -> {"version":4,"mode":"Mix","mixVolume":80,"mixes":[{id,name,rotation,layers:{<Layer>:{variant,vol[3],
                         lp[3],hp,pan,rev,dly,dlyT,drv,pat,fill}}}]}   (v1 files are migrated on load, backup kept)
    PUT  api/mixes    -> replace the whole document (validated, atomic write, previous copy kept as .bak)
    GET  api/export   -> text/plain Game.ini section for the current rotation (same text the page shows)
    PUT  api/selftest -> page self-test report (index.html?selftest=1) written to data/selftest_result.txt

Panel integration later: import `mixlib` functions (load_doc/save_doc/validate_doc/ini_section/build_kit) from
this file and mount the static folder + these four routes under the panel; the page only uses relative URLs.
This server never writes any Game.ini.
"""
import argparse
import json
import math
import mimetypes
import os
import re
import secrets
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
STEMS_DIR = os.path.join(HERE, 'stems')
DATA_DIR = os.path.join(HERE, 'data')
MIXES_FILE = os.path.join(DATA_DIR, 'music_mixes.json')
# kit description: the live build report if this folder sits next to audio_src/, else the copy in data/
KIT_REPORTS = [os.path.normpath(os.path.join(HERE, '..', 'audio_src', 'stems', 'kit_report.json')),
               os.path.join(DATA_DIR, 'kit_report.json')]

DEFAULT_LAYERS = ['Drums', 'Bass', 'Pad', 'Lead', 'Guitar', 'FX']
CANON_ORDER = ['drums', 'perc', 'percussion', 'bass', 'sub', 'pad', 'drone', 'keys', 'piano', 'strings', 'lead',
               'lead2', 'arp', 'pluck', 'bells', 'guitar', 'fx', 'texture']
DLY_TIMES = ['4', '8d']        # 1/4, dotted 1/8 ('8' = 1/8 was removed 2026-11-06 and is read as '8d')
PATS = ['A', 'AB']
FILLS = [0, 2, 4]
LAYER_RE = re.compile(r'^[A-Za-z][A-Za-z0-9]{0,15}$')
VARIANT_RE = re.compile(r'^(Off|V\d{1,2})(/(Off|V\d{1,2})/(Off|V\d{1,2}))?$')
DOC_VERSION = 4        # 3 = v3.1 kit IDs (schema 2); 4 = no tape/key, delay 1/4 or dotted 1/8 only
LEAD_V1_TO_V31 = {'V1': 'V5', 'V2': 'V3', 'V3': 'V2'}   # old Arp/PluckMotif/DarkBells -> SynthPulse/WarmLead/NeyFlute
MAX_LAYERS = 24
MODES = ['Mix', 'Classic', 'Random']
SECTION = '[/AmbientMusic/Mutators/AmbientMusic.AmbientMusic_C]'
NAME_MAX = 32
MAX_MIXES = 200
MAX_BODY = 512 * 1024
STEM_RE = re.compile(r'^AM_([A-Za-z][A-Za-z0-9]*)_V(\d+)(?:_([A-Za-z0-9_]+))?\.ogg$')

# v3.1 demo mixes (audio_src/stems_demo/demo_report.json); (name, layers, pattern, fill)
SEED = [
    ('Night Ops', 'Drums=Off|Perc=V5:70,60,40|Bass=V1:50,65,80|Pad=V2:70,60,50|Orch=V2:40,55,50|Lead=V2:35,40,30|Guitar=V5:25,35,0|FX=V5:40,40,30', 'AB', 0),
    ('Ghost Recon', 'Drums=V5:15,60,75|Perc=V1:20,75,95|Bass=V6:30,65,80|Pad=V4:55,45,40|Orch=V1:30,75,90|Lead=V1:40,60,45|Guitar=Off|FX=V4:0,45,55', 'AB', 0),
    ('John Wick', 'Drums=V6:0,60,95|Perc=V4:0,45,60|Bass=V7:0,60,90|Pad=V3:20,45,55|Orch=V4:0,40,60|Lead=V4:0,40,65|Guitar=V7:0,45,90|FX=V4:20,40,50', 'AB', 0),
    ('Full Build', 'Drums=V6:0,25,90|Perc=V1:15,70,85|Bass=V4:45,70,90|Pad=V2:65,50,35|Orch=V1:0,70,80|Lead=V5:25,50,55|Guitar=V7:0,0,80|FX=V5:40,30,20', 'AB', 4),
]
SEED_TAG = 'v3.1-demos'

_lock = threading.Lock()


# ---------------------------------------------------------------- mixlib (keep in sync with js/recipe.js)
def jsround(v):
    return int(math.floor(v + 0.5))  # JS Math.round


def clamp_int(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = 0.0
    if v != v or v in (float('inf'), float('-inf')):
        v = 0.0
    return max(lo, min(hi, jsround(v)))


def clamp_vol(v):
    return clamp_int(v, 0, 100)


def sanitize_name(s):
    s = re.sub(r'[|=:,;@"\\\[\]\x00-\x1f\x7f]', ' ', str(s if s is not None else ''))
    s = re.sub(r'\s+', ' ', s).strip()
    if len(s) > NAME_MAX:
        s = s[:NAME_MAX].strip()
    return s or 'Mix'


def _tri(a):
    a = a if isinstance(a, list) else [0, 0, 0]
    a = (a + [0, 0, 0])[:3]
    return [clamp_vol(x) for x in a]


def default_layer():
    return {'variant': 'Off', 'vol': [0, 0, 0], 'lp': [0, 0, 0], 'hp': 0, 'pan': 0, 'rev': 0, 'dly': 0, 'dlyT': '8d',
            'drv': 0, 'pat': 'A', 'fill': 0}


def norm_variant(v):
    """'Off' | 'Vn' | 'Va/Vb/Vc' (calm/medium/intense). Equal triples collapse to one ID."""
    if not isinstance(v, str) or not VARIANT_RE.match(v):
        return 'Off'
    p = v.split('/')
    if len(p) == 3 and p[0] == p[1] == p[2]:
        return p[0]
    return v


def level_variants(v):
    p = norm_variant(v).split('/')
    return p * 3 if len(p) == 1 else p


def norm_layer(l):
    l = l if isinstance(l, dict) else {}
    v = norm_variant(l.get('variant'))
    fill = l.get('fill')
    try:
        fill = int(fill) if float(fill) in FILLS else 0
    except (TypeError, ValueError):
        fill = 0
    return {'variant': v, 'vol': _tri(l.get('vol')), 'lp': _tri(l.get('lp')), 'hp': clamp_vol(l.get('hp')),
            'pan': clamp_int(l.get('pan'), -100, 100), 'rev': clamp_vol(l.get('rev')), 'dly': clamp_vol(l.get('dly')),
            'dlyT': '4' if str(l.get('dlyT')).strip() == '4' else '8d', 'drv': clamp_vol(l.get('drv')),
            'pat': l.get('pat') if l.get('pat') in PATS else 'A', 'fill': fill}


def layer_order(mix, layer_names):
    names = list(layer_names or DEFAULT_LAYERS)
    for L in sorted((mix.get('layers') or {}).keys()):
        l = mix['layers'][L]
        if L not in names and LAYER_RE.match(L) and isinstance(l, dict) and norm_variant(l.get('variant')) != 'Off':
            names.append(L)
    return names


def layer_spec(l):
    l = norm_layer(l)
    if l['variant'] == 'Off':
        return 'Off'
    s = '%s:%s' % (l['variant'], ','.join(map(str, l['vol'])))
    if any(l['lp']):
        s += ':lp=' + ','.join(map(str, l['lp']))
    for k in ('hp', 'pan', 'rev'):
        if l[k]:
            s += ':%s=%d' % (k, l[k])
    if l['dly']:
        s += ':dly=%d,%s' % (l['dly'], l['dlyT'])
    if l['drv']:
        s += ':drv=%d' % l['drv']
    if l['pat'] != 'A':
        s += ':pat=' + l['pat']
    if l['fill']:
        s += ':fill=%d' % l['fill']
    return s


def recipe_line(mix, layer_names=None):
    parts = [sanitize_name(mix.get('name'))]
    for L in layer_order(mix, layer_names):
        parts.append(L + '=' + layer_spec((mix.get('layers') or {}).get(L)))
    return '|'.join(parts)


def mix_volume_of(doc):
    """Master fader = in-game MixVolume: bus gain (MixVolume/100)^2, default 80."""
    v = doc.get('mixVolume')
    return 80 if v is None or v == '' else clamp_vol(v)


# v3.1 music sensitivity = mutator MediumAt / IntenseAt / CalmDownTime (whole server, all modes). Same rules as
# recipe.js sensOf/sensLines: snapped to the step, clamped, IntenseAt > MediumAt; exported only when not default.
# Defaults since 2026-11-06: 5 / 20 / 10 (v3.0 behaviour = 2 / 5 / 20); IntenseAt max 30.
SENS = [('mediumAt', 'MediumAt', 5, 0.5, 10, 0.5), ('intenseAt', 'IntenseAt', 20, 1, 30, 0.5),
        ('calmDownTime', 'CalmDownTime', 10, 5, 90, 1)]
_DEC = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$')


def _sens_num(v, lo, hi, step):
    if isinstance(v, str):
        v = v.strip()
        if not _DEC.match(v):
            return None
        v = float(v)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    v = float(v)
    if v != v or v in (float('inf'), float('-inf')):
        return None
    return max(lo, min(hi, jsround(v / step) * step))


def sens_of(doc):
    o = {}
    for sid, _key, dflt, lo, hi, step in SENS:
        v = _sens_num((doc or {}).get(sid), lo, hi, step)
        o[sid] = dflt if v is None else v
    if o['intenseAt'] <= o['mediumAt']:
        o['intenseAt'] = o['mediumAt'] + 0.5
    return {k: (int(v) if float(v).is_integer() else v) for k, v in o.items()}   # 2.0 -> 2 (JSON/JS look the same)


def _fmt(v):
    return '%d' % v if float(v).is_integer() else repr(float(v))


def sens_lines(doc):
    o = sens_of(doc)
    return ['%s=%s' % (key, _fmt(o[sid])) for sid, key, dflt, _lo, _hi, _st in SENS if o[sid] != dflt]


def ini_section(doc, layer_names=None):
    lines = [SECTION, 'MusicMode=' + (doc.get('mode') if doc.get('mode') in MODES else 'Mix'),
             'MixVolume=%d' % mix_volume_of(doc)] + sens_lines(doc)
    # quoted: Unreal's ini reader truncates an unquoted value at the first '|' (names never contain '"' or '\\')
    lines += ['+Mixes="%s"' % recipe_line(m, layer_names) for m in doc.get('mixes', []) if m.get('rotation')]
    return '\n'.join(lines) + '\n'


# ---------------------------------------------------------------- kit (data-driven from the report + files present)
def _norm_pat(p):
    q = str(p if p is not None else 'A').strip()
    low = q.lower()
    if low in ('', 'a', 'main', 'base', 'loop'):
        return 'A'
    if low == 'b':
        return 'B'
    if low in ('fill', 'f', 'x') or low.startswith('fill'):
        return 'Fill'
    return q[:1].upper() + q[1:]


def _norm_vid(v):
    if isinstance(v, (int, float)):
        return 'V%d' % int(v)
    m = re.match(r'^[Vv]?(\d{1,2})$', str(v or '').strip())
    return 'V%d' % int(m.group(1)) if m else None


def _label_from(desc, short):
    if desc and ':' in desc:
        return desc.split(':')[0].strip()
    if desc and len(desc) <= 28:
        return desc
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', short or '').strip() or (desc or '')[:28]


def _first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d.get(k)
    return None


def _report_entries(rep):
    """Flatten any reasonable report shape into (meta, [entry]) with entry = layer, vid, pat, file, desc, label."""
    meta, out = {}, []
    def add(layer, vid, pat, f, desc=None, label=None, samples=None):
        vid = _norm_vid(vid)
        if layer and vid and f:
            out.append({'layer': str(layer), 'vid': vid, 'pat': _norm_pat(pat), 'file': os.path.basename(str(f)),
                        'desc': desc, 'label': label, 'samples': samples})
    if isinstance(rep, list):
        for r in rep:
            if isinstance(r, dict):
                add(r.get('layer'), r.get('variant'), r.get('pattern'), r.get('file'), r.get('desc'), r.get('label'),
                    r.get('samples'))
        return meta, out
    if not isinstance(rep, dict):
        return meta, out
    for k, alts in (('bpm', ('bpm', 'tempo')), ('bars', ('bars', 'loop_bars')), ('beatsPerBar', ('beatsPerBar', 'beats_per_bar')),
                    ('sampleRate', ('sampleRate', 'sample_rate', 'sr')), ('loopSamples', ('loopSamples', 'loop_samples')),
                    ('key', ('key',))):
        v = _first(rep, *alts)
        if v is not None:
            meta[k] = v
    layers = _first(rep, 'layers', 'kit') or []
    if isinstance(layers, dict):
        layers = [dict({'name': k}, **(v if isinstance(v, dict) else {'variants': v})) for k, v in layers.items()]
    for layer in layers if isinstance(layers, list) else []:
        if not isinstance(layer, dict):
            continue
        lname = _first(layer, 'name', 'layer', 'id')
        variants = layer.get('variants') or []
        if isinstance(variants, dict):
            variants = [dict({'id': k}, **(v if isinstance(v, dict) else {'file': v})) for k, v in variants.items()]
        for v in variants if isinstance(variants, list) else []:
            if not isinstance(v, dict):
                continue
            vid = _first(v, 'id', 'variant', 'name')
            desc, label = _first(v, 'desc', 'description'), _first(v, 'label', 'title')
            pats = _first(v, 'patterns', 'files')
            if isinstance(pats, dict):
                for pn, pv in pats.items():
                    add(lname, vid, pn, _first(pv, 'file', 'ogg', 'wav') if isinstance(pv, dict) else pv, desc, label,
                        _first(pv, 'samples') if isinstance(pv, dict) else None)
            elif isinstance(pats, list):
                for pv in pats:
                    if isinstance(pv, dict):
                        add(lname, vid, _first(pv, 'id', 'name', 'pattern'), _first(pv, 'file', 'ogg', 'wav'), desc, label,
                            pv.get('samples'))
                    else:
                        add(lname, vid, None, pv, desc, label)
            elif v.get('file'):
                add(lname, vid, v.get('pattern'), v.get('file'), desc, label, v.get('samples'))
    return meta, out


def _ogg_for(fname):
    base = os.path.splitext(fname)[0]
    for cand in (base + '.ogg', fname):
        if cand.endswith('.ogg') and os.path.isfile(os.path.join(STEMS_DIR, cand)):
            return cand
    return None


ROLE_TO_PAT = {'main': 'A', 'alt': 'B', 'fill': 'Fill'}


def _kit_schema2(rep):
    """Native reader for kit_report.json schema 2 (v3.1 kit): layer_order, layer ids, variant label/description/suits,
    pattern role. Returns None if nothing in it is playable from mixer/stems."""
    fmt = rep.get('format') or {}
    layers_by_id = {}
    for layer in rep.get('layers') or []:
        if isinstance(layer, dict) and LAYER_RE.match(str(layer.get('id') or '')):
            layers_by_id[layer['id']] = layer
    order = [L for L in (rep.get('layer_order') or []) if L in layers_by_id]
    order += [L for L in layers_by_id if L not in order]
    out = []
    for L in order:
        layer, vs = layers_by_id[L], []
        for v in layer.get('variants') or []:
            vid = _norm_vid(v.get('id'))
            if not vid:
                continue
            pats = {}
            for p in v.get('patterns') or []:
                pid = ROLE_TO_PAT.get(p.get('role')) or _norm_pat(p.get('id'))
                ogg = _ogg_for(os.path.basename(str(p.get('ogg') or p.get('file') or '')))
                if ogg and pid not in pats:
                    pats[pid] = {'file': 'stems/' + ogg, 'samples': p.get('samples'), 'desc': p.get('description'),
                                 'lufs': p.get('lufs')}
            if not pats:
                continue
            if 'A' not in pats:
                pats['A'] = pats.pop(sorted(pats)[0])
            desc = v.get('description') or v.get('desc') or ''
            label = v.get('label') or _label_from(desc, v.get('name'))
            vs.append({'id': vid, 'label': label, 'desc': '%s: %s' % (label, desc) if desc else label,
                       'suits': [x for x in (v.get('suits') or []) if x in ('calm', 'medium', 'intense')],
                       'patterns': pats})
        if vs:
            vs.sort(key=lambda x: int(x['id'][1:]))
            out.append({'name': L, 'title': layer.get('name') or L, 'description': layer.get('description') or '',
                        'variants': vs})
    if not out:
        return None
    seq = [_norm_pat(x) for x in rep.get('pattern_sequence_suggested') or ['A', 'B', 'A', 'Fill']]
    return {'bpm': float(fmt.get('bpm') or 90), 'beatsPerBar': int(str(fmt.get('meter') or '4/4').split('/')[0]),
            'bars': int(fmt.get('bars') or 8), 'sampleRate': int(fmt.get('sample_rate') or 48000),
            'loopSamples': int(fmt.get('samples') or 1024000), 'key': str(fmt.get('key') or 'A minor'),
            'schema': 2, 'kitName': rep.get('kit'), 'layerOrder': [l['name'] for l in out], 'patternSequence': seq,
            'layers': out}


def _attach_spectra(kit):
    """Add each pattern's measured 1/6-octave spectrum (data/kit_spectra.json, from tools/kit_spectra.py) so the
    page can estimate how much a Wwise LPF/HPF setting lowers a loop's loudness."""
    try:
        with open(os.path.join(DATA_DIR, 'kit_spectra.json'), encoding='utf-8') as f:
            sp = json.load(f)
    except (OSError, ValueError):
        return kit
    files = sp.get('files') or {}
    kit['specBands'] = sp.get('bands')
    for l in kit['layers']:
        for v in l['variants']:
            for p in v['patterns'].values():
                s = files.get(os.path.basename(p['file']))
                if s:
                    p['spec'] = s
    return kit


def build_kit():
    return _attach_spectra(_build_kit())


def _build_kit():
    meta, entries, used_report = {}, [], None
    for path in KIT_REPORTS:
        try:
            with open(path, encoding='utf-8') as f:
                rep = json.load(f)
            if isinstance(rep, dict) and rep.get('schema') == 2:
                kit = _kit_schema2(rep)
                if kit:
                    kit['report'] = os.path.relpath(path, os.path.dirname(HERE))
                    return kit
            meta, entries = _report_entries(rep)
            used_report = path
            break
        except (OSError, ValueError):
            continue
    layers, order, seen = {}, [], set()

    def put(layer, vid, pat, ogg, desc, label, samples=None):
        L = layers.setdefault(layer, {})
        if layer not in order:
            order.append(layer)
        v = L.setdefault(vid, {'id': vid, 'desc': desc, 'label': label, 'patterns': {}})
        v['desc'] = v['desc'] or desc
        v['label'] = v['label'] or (None if v['desc'] else label)
        if pat not in v['patterns']:
            v['patterns'][pat] = {'file': 'stems/' + ogg, 'samples': samples}
        seen.add(ogg)

    for e in entries:
        ogg = _ogg_for(e['file'])
        if ogg and LAYER_RE.match(e['layer']):
            put(e['layer'], e['vid'], e['pat'], ogg, e['desc'], e['label'], e['samples'])
    report_layers = list(order)
    try:
        files = sorted(os.listdir(STEMS_DIR))
    except OSError:
        files = []
    for fn in files:  # files the report does not describe (or no report at all)
        m = STEM_RE.match(fn)
        if not m or fn in seen or not LAYER_RE.match(m.group(1)):
            continue
        toks = [t for t in (m.group(3) or '').split('_') if t]
        pat = 'A'
        for t in toks:
            if t in ('A', 'B') or t.lower() == 'fill':
                pat = _norm_pat(t)
        short = ''.join(t for t in toks if not (t in ('A', 'B') or t.lower() == 'fill'))
        put(m.group(1), 'V' + str(int(m.group(2))), pat, fn, None, _label_from(None, short))
    def rank(L):
        if L in report_layers:
            return (0, report_layers.index(L), L)
        low = L.lower()
        return (1, CANON_ORDER.index(low) if low in CANON_ORDER else 99, L)
    out_layers = []
    for L in sorted(order, key=rank):
        vs = []
        for vid in sorted(layers[L], key=lambda x: int(x[1:])):
            v = layers[L][vid]
            if 'A' not in v['patterns']:   # promote the first pattern so every variant can play
                first = sorted(v['patterns'])[0]
                v['patterns']['A'] = v['patterns'].pop(first)
            desc = v['desc'] or v['label'] or vid
            vs.append({'id': vid, 'label': v['label'] or _label_from(desc, ''), 'desc': desc, 'patterns': v['patterns']})
        if vs:
            out_layers.append({'name': L, 'variants': vs})
    bpm = float(meta.get('bpm') or 90)
    return {'bpm': bpm, 'beatsPerBar': int(meta.get('beatsPerBar') or 4), 'bars': int(meta.get('bars') or 8),
            'sampleRate': int(meta.get('sampleRate') or 48000), 'loopSamples': int(meta.get('loopSamples') or 1024000),
            'key': str(meta.get('key') or 'A minor'), 'report': os.path.relpath(used_report, os.path.dirname(HERE)) if used_report else None,
            'layers': out_layers}


def kit_layer_names(kit=None):
    return [l['name'] for l in (kit or build_kit())['layers']]


# ---------------------------------------------------------------- presets document
def new_id():
    return 'm_' + secrets.token_hex(4)


def norm_mix(m, layer_names=()):
    layers = {}
    for L, l in (m.get('layers') or {}).items():
        if LAYER_RE.match(str(L)):
            layers[str(L)] = norm_layer(l)
    for L in layer_names:
        layers.setdefault(L, default_layer())
    return {'id': m.get('id'), 'name': sanitize_name(m.get('name')), 'rotation': bool(m.get('rotation')),
            'layers': layers}


def validate_doc(doc):
    """Return a clean v2 copy of a client document or raise ValueError. Layers/variants that are not in the
    current kit are kept (so a kit swap never deletes data); the page flags them."""
    if not isinstance(doc, dict) or not isinstance(doc.get('mixes'), list):
        raise ValueError('document must be an object with a "mixes" list')
    if len(doc['mixes']) > MAX_MIXES:
        raise ValueError('too many mixes (max %d)' % MAX_MIXES)
    old_kit = not isinstance(doc.get('version'), int) or doc.get('version') < 3   # Lead IDs changed in doc v3
    seeded = [str(x) for x in doc.get('seeded') or [] if isinstance(x, str)][:20]
    out = {'version': DOC_VERSION, 'kitSchema': 2, 'seeded': seeded,
           'mode': doc.get('mode') if doc.get('mode') in MODES else 'Mix', 'mixVolume': mix_volume_of(doc), 'mixes': []}
    out.update(sens_of(doc))
    names = kit_layer_names()
    seen_names, seen_ids = set(), set()
    for m in doc['mixes']:
        if not isinstance(m, dict):
            raise ValueError('mix entries must be objects')
        if len(m.get('layers') or {}) > MAX_LAYERS:
            raise ValueError('too many layers in a mix')
        nm = norm_mix(m, names)
        if old_kit and 'Lead' in nm['layers']:   # pre-v3.1 preset: Lead IDs meant the removed v1 leads
            lv = nm['layers']['Lead']
            lv['variant'] = norm_variant('/'.join(LEAD_V1_TO_V31.get(x, x) for x in level_variants(lv['variant'])))
        if nm['name'].lower() in seen_names:
            raise ValueError('duplicate mix name: %s' % nm['name'])
        seen_names.add(nm['name'].lower())
        mid = str(m.get('id') or '')
        if not re.match(r'^[A-Za-z0-9_-]{1,40}$', mid) or mid in seen_ids:
            mid = new_id()
        seen_ids.add(mid)
        nm['id'] = mid
        out['mixes'].append(nm)
    return out


def parse_layers(spec, pat='A', fill=0):
    layers = {}
    for part in spec.split('|'):
        L, s = part.split('=')
        if s == 'Off':
            layers[L] = default_layer()
        else:
            var, vols = s.split(':')
            layers[L] = dict(default_layer(), variant=var, vol=[int(x) for x in vols.split(',')], pat=pat, fill=fill)
    return layers


def seed_mixes(rotation):
    return [norm_mix({'id': new_id(), 'name': n, 'rotation': rotation, 'layers': parse_layers(s, p, f)})
            for n, s, p, f in SEED]


def seed_doc():
    return {'version': DOC_VERSION, 'kitSchema': 2, 'seeded': [SEED_TAG], 'mode': 'Mix', 'mixes': seed_mixes(True)}


def load_doc():
    with _lock:
        if not os.path.exists(MIXES_FILE):
            _write(seed_doc())
        with open(MIXES_FILE, encoding='utf-8') as f:
            doc = json.load(f)
        changed = False
        if doc.get('version') != DOC_VERSION:   # migrate once, keep the original next to it
            bak = MIXES_FILE + '.v%s-backup' % doc.get('version', 1)
            if not os.path.exists(bak):
                with open(bak, 'w', encoding='utf-8') as f:
                    json.dump(doc, f, indent=1)
            doc = validate_doc(doc)
            changed = True
        if SEED_TAG not in (doc.get('seeded') or []):   # add the v3.1 demo mixes once; never touch user presets
            taken = {m['name'].lower() for m in doc['mixes']}
            doc['mixes'] += [m for m in seed_mixes(False) if m['name'].lower() not in taken]
            doc['seeded'] = list(doc.get('seeded') or []) + [SEED_TAG]
            changed = True
        if changed:
            _write(doc)
        return doc


def save_doc(doc):
    clean = validate_doc(doc)
    with _lock:
        if os.path.exists(MIXES_FILE):
            with open(MIXES_FILE, 'rb') as src, open(MIXES_FILE + '.bak', 'wb') as dst:
                dst.write(src.read())
        _write(clean)
    return clean


def _write(doc):
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix='.mixes-', suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    os.chmod(tmp, 0o644)
    os.replace(tmp, MIXES_FILE)


# ---------------------------------------------------------------- HTTP
STATIC_OK = re.compile(r'^(index\.html|css/[\w.-]+\.css|js/[\w.-]+\.js|stems/[\w.-]+\.ogg|favicon\.svg)$')
mimetypes.add_type('audio/ogg', '.ogg')
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('image/svg+xml', '.svg')


class Handler(BaseHTTPRequestHandler):
    server_version = 'AmbientMixer/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype='application/json; charset=utf-8', cache=False):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'public, max-age=3600' if cache else 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def _path(self):
        p = unquote(urlparse(self.path).path).lstrip('/')
        return p or 'index.html'

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        p = self._path()
        try:
            if p == 'api/kit':
                return self._json(200, build_kit())
            if p == 'api/mixes':
                return self._json(200, load_doc())
            if p == 'api/export':
                return self._send(200, ini_section(load_doc(), kit_layer_names()), 'text/plain; charset=utf-8')
        except Exception as e:  # noqa: BLE001 - report to client
            return self._json(500, {'error': str(e)})
        if not STATIC_OK.match(p) or '..' in p:
            return self._json(404, {'error': 'not found'})
        fp = os.path.join(HERE, p)
        if not os.path.isfile(fp):
            return self._json(404, {'error': 'not found'})
        with open(fp, 'rb') as f:
            data = f.read()
        ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        if ctype.startswith('text/'):
            ctype += '; charset=utf-8'
        self._send(200, data, ctype, cache=p.startswith('stems/'))

    def do_PUT(self):
        if self._path() == 'api/selftest':  # page self-test report (?selftest=1), plain text, small
            n = min(int(self.headers.get('Content-Length') or 0), 16384)
            with open(os.path.join(DATA_DIR, 'selftest_result.txt'), 'wb') as f:
                f.write(self.rfile.read(n))
            return self._json(200, {'ok': True})
        if self._path() != 'api/mixes':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {'error': 'body size'})
            doc = json.loads(self.rfile.read(n).decode('utf-8'))
            return self._json(200, save_doc(doc))
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {'error': str(e)})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--host', default='127.0.0.1', help='bind address (default 127.0.0.1 = this PC only)')
    ap.add_argument('--lan', action='store_true', help='listen on all interfaces (0.0.0.0) so other PCs on your LAN can open it')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--open', action='store_true', help='open the page in the default browser')
    a = ap.parse_args()
    host = '0.0.0.0' if a.lan else a.host
    load_doc()  # seeds the presets file on first run
    try:
        httpd = ThreadingHTTPServer((host, a.port), Handler)
    except OSError as e:
        print('Cannot listen on %s:%d (%s). Is the mixer already running? Try another port: --port 8766' % (host, a.port, e))
        sys.exit(1)
    url = 'http://localhost:%d/' % a.port
    print('Ambient Music mixer running: %s   (bound to %s; presets: %s)' % (url, host, MIXES_FILE), flush=True)
    if host != '127.0.0.1':
        print('LAN mode: other PCs can open http://<this-PC-IP>:%d/ (no password; use only on a trusted LAN).' % a.port, flush=True)
    print('Press Ctrl+C (or close this window) to stop.', flush=True)
    if a.open:
        import webbrowser
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
