#!/usr/bin/env python3
"""Code Census report generator — pure-Python PDF, standard library only.

Usage:  python3 census.py <data.json> <out.pdf>

Cockpit's bridge already requires Python, so this runs on any host Cockpit runs
on — no pip installs, no headless browser, no vendored dependencies. The plugin
(js/features/scc.js) assembles <data.json> from scc and the other analyses and
invokes this script server-side via cockpit.spawn.

The PDF is written by hand: PDF is a simple object graph, and text + filled
rectangles + lines with the built-in Helvetica core fonts are enough for a
report of tables and bar charts. See _PDF below.
"""
import json
import sys
import datetime


# ── Helvetica core-font glyph widths (units/1000 em), for text measurement ──
# The 14 core fonts need no embedding. Digits, space and punctuation are what
# matter for right-aligned numeric columns; letters give good-enough wrapping.
_HELV_W = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
    '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
    '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
    'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
    'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
    'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
    '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
    'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
    'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
    'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
}


def _text_width(s, size):
    return sum(_HELV_W.get(c, 556) for c in s) * size / 1000.0


def _esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


# Common Unicode punctuation → Latin-1 equivalents (core fonts are Latin-1).
_SUBST = {0x2014: '-', 0x2013: '-', 0x2018: "'", 0x2019: "'", 0x201c: '"',
          0x201d: '"', 0x2026: '...', 0x2192: '->', 0x2022: '-', 0x00a0: ' '}


def _latin1(s):
    out = []
    for c in str(s):
        o = ord(c)
        if o < 256:
            out.append(c)
        elif o in _SUBST:
            out.append(_SUBST[o])
        else:
            out.append('?')
    return ''.join(out)


class _PDF:
    """Minimal multi-page PDF writer (A4 portrait, points; origin bottom-left)."""
    W, H = 595.28, 841.89           # A4 in points
    M = 48.0                        # page margin

    def __init__(self):
        self._pages = []            # list of content-stream strings
        self._buf = []              # current page ops

    def new_page(self):
        if self._buf:
            self._pages.append(''.join(self._buf))
        self._buf = []

    def _finish(self):
        if self._buf:
            self._pages.append(''.join(self._buf))
        self._buf = []

    # ── primitives ──────────────────────────────────────────────────────────
    def _op(self, s):
        self._buf.append(s)

    def color(self, rgb, stroke=False):
        r, g, b = rgb
        self._op('%.3f %.3f %.3f %s\n' % (r / 255.0, g / 255.0, b / 255.0, 'RG' if stroke else 'rg'))

    def rect(self, x, y, w, h, rgb):
        self.color(rgb)
        self._op('%.2f %.2f %.2f %.2f re f\n' % (x, self.H - y - h, w, h))

    def line(self, x1, y1, x2, y2, rgb, width=0.6):
        self.color(rgb, True)
        self._op('%.2f w %.2f %.2f m %.2f %.2f l S\n' % (width, x1, self.H - y1, x2, self.H - y2))

    def text(self, x, y, s, size=10, rgb=(30, 30, 30), bold=False, align='left'):
        s = _latin1(s)
        if align != 'left':
            w = _text_width(s, size)
            x = x - w if align == 'right' else x - w / 2.0
        self.color(rgb)
        font = '/F2' if bold else '/F1'
        self._op('BT %s %.2f Tf %.2f %.2f Td (%s) Tj ET\n' % (font, size, x, self.H - y, _esc(s)))

    def text_wrap(self, x, y, s, size, rgb, maxw, leading):
        """Word-wrap `s` into lines of <= maxw; returns the y after the block."""
        words = _latin1(s).split()
        line, yy = '', y
        for w in words:
            trial = (line + ' ' + w).strip()
            if _text_width(trial, size) > maxw and line:
                self.text(x, yy, line, size, rgb)
                yy += leading
                line = w
            else:
                line = trial
        if line:
            self.text(x, yy, line, size, rgb)
            yy += leading
        return yy

    # ── output ───────────────────────────────────────────────────────────────
    def save(self, path):
        self._finish()
        n = len(self._pages)
        # Deterministic object numbering: 1=font1, 2=font2, 3=Pages, 4..3+n=Page
        # objects, 4+n..3+2n=content streams, 4+2n=catalog. (The earlier version
        # miscomputed the Pages object number, so Page /Parent pointed at the wrong
        # object and viewers rendered only the first page.)
        FONT1, FONT2, PAGES = 1, 2, 3
        page_num = lambda i: 4 + i
        content_num = lambda i: 4 + n + i
        catalog = 4 + 2 * n
        objs = {}
        objs[FONT1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
        objs[FONT2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
        objs[PAGES] = '<< /Type /Pages /Kids [%s] /Count %d >>' % (
            ' '.join('%d 0 R' % page_num(i) for i in range(n)), n)
        for i in range(n):
            objs[page_num(i)] = ('<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] '
                                 '/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>'
                                 % (PAGES, self.W, self.H, FONT1, FONT2, content_num(i)))
        for i, c in enumerate(self._pages):
            objs[content_num(i)] = '<< /Length %d >>\nstream\n%s\nendstream' % (len(c), c)
        objs[catalog] = '<< /Type /Catalog /Pages %d 0 R >>' % PAGES

        total = catalog
        out = ['%PDF-1.4\n']
        offsets = {}
        pos = len(out[0])
        for i in range(1, total + 1):
            s = '%d 0 obj\n%s\nendobj\n' % (i, objs[i])
            offsets[i] = pos
            out.append(s)
            pos += len(s)
        xref_pos = pos
        out.append('xref\n0 %d\n' % (total + 1))
        out.append('0000000000 65535 f \n')
        for i in range(1, total + 1):
            out.append('%010d 00000 n \n' % offsets[i])
        out.append('trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n'
                   % (total + 1, catalog, xref_pos))
        with open(path, 'wb') as f:
            f.write(''.join(out).encode('latin-1', 'replace'))


# ── palette ──────────────────────────────────────────────────────────────────
INK = (33, 37, 41)
MUT = (120, 128, 138)
LINE = (222, 226, 230)
BLUE = (47, 111, 221)
GREEN = (26, 127, 55)
RED = (207, 34, 46)
AMBER = (191, 135, 0)
GREY = (176, 182, 190)
CARD = (247, 248, 250)


def _num(n):
    try:
        return '{:,}'.format(int(n))
    except Exception:
        return str(n)


def _human_bytes(n):
    n = float(n or 0)
    for u in ['B', 'KB', 'MB', 'GB', 'TB']:
        if n < 1024 or u == 'TB':
            return ('%.0f %s' % (n, u)) if u == 'B' else ('%.1f %s' % (n, u))
        n /= 1024.0


def _footer(pdf, data, page_no, pages):
    m = data.get('meta', {})
    pdf.line(_PDF.M, 812, _PDF.W - _PDF.M, 812, LINE)
    pdf.text(_PDF.M, 826, 'Code census · scc %s' % m.get('sccVersion', ''), 8, MUT)
    pdf.text(_PDF.W - _PDF.M, 826, '%d / %d' % (page_no, pages), 8, MUT, align='right')


def _header(pdf, data, label):
    m = data.get('meta', {})
    pdf.text(_PDF.M, 40, label, 9, INK, bold=True)
    right = 'branch %s · commit %s · %s' % (m.get('branch', '?'), (m.get('commit', '') or '')[:10], m.get('date', ''))
    pdf.text(_PDF.W - _PDF.M, 40, right, 8, MUT, align='right')
    pdf.line(_PDF.M, 48, _PDF.W - _PDF.M, 48, LINE)


def _bar_chart(pdf, x, y, w, items, maxv, color_fn, label_w, row_h=15, val_fmt=_num):
    """Horizontal bars. items: [(label, value, sublabel)]. Returns y after."""
    barx = x + label_w
    barw = w - label_w - 70
    for (label, val, sub) in items:
        pdf.text(x + label_w - 6, y + 10, label, 9, INK, align='right')
        bw = (barw * (val / maxv)) if maxv else 0
        pdf.rect(barx, y + 2, max(bw, 1), row_h - 5, color_fn(label, val))
        txt = val_fmt(val) + (('  ' + sub) if sub else '')
        pdf.text(barx + max(bw, 1) + 5, y + 10, txt, 8, MUT)
        y += row_h
    return y


# ── report pages ───────────────────────────────────────────────────────────
def page_cover(pdf, data):
    m = data.get('meta', {})
    t = data.get('totals', {})
    pdf.text(_PDF.M, 70, 'BRANCH', 9, MUT, bold=True)
    pdf.text(_PDF.M + 60, 70, m.get('branch', '?'), 10, BLUE, bold=True)
    pdf.text(_PDF.M + 200, 70, 'COMMIT', 9, MUT, bold=True)
    pdf.text(_PDF.M + 260, 70, (m.get('commit', '') or 'working tree')[:10] + '  ·  ' + m.get('date', ''), 9, MUT)

    pdf.text(_PDF.M, 190, data.get('title', 'Code'), 30, INK, bold=True)
    pdf.text(_PDF.M, 226, 'Census', 30, INK, bold=True)
    pdf.text_wrap(_PDF.M, 260, data.get('subtitle',
                  'A structural snapshot produced with scc: size, composition and complexity.'),
                  11, MUT, _PDF.W - 2 * _PDF.M, 15)

    lines = t.get('lines', 0)
    pdf.text(_PDF.M, 330, _num(lines), 40, INK, bold=True)
    pdf.text(_PDF.M + _text_width(_num(lines), 40) + 10, 330, 'lines across %s files' % _num(t.get('files', 0)), 12, INK)

    # stat cards (4 x 2)
    cards = [
        ('Code', _num(t.get('code', 0)), 'program + data source'),
        ('Comments', _num(t.get('comments', 0)), 'lines'),
        ('Blank', _num(t.get('blanks', 0)), 'lines'),
        ('Complexity', _num(t.get('complexity', 0)), 'cyclomatic total'),
        ('Languages', _num(t.get('languages', 0)), 'detected'),
        ('Files', _num(t.get('files', 0)), 'scanned'),
        ('Bytes', _human_bytes(t.get('bytes', 0)), _num(t.get('bytes', 0)) + ' bytes'),
        ('Cx / kloc', _num(t.get('cxPerKloc', 0)), 'per 1,000 code lines'),
    ]
    cw, ch, gap = (_PDF.W - 2 * _PDF.M - 3 * 12) / 4.0, 74, 12
    x0, y0 = _PDF.M, 380
    for i, (lab, val, sub) in enumerate(cards):
        cx = x0 + (i % 4) * (cw + gap)
        cy = y0 + (i // 4) * (ch + gap)
        pdf.rect(cx, cy, cw, ch, CARD)
        pdf.line(cx, cy, cx + cw, cy, LINE)
        pdf.text(cx + 10, cy + 20, lab, 9, MUT)
        pdf.text(cx + 10, cy + 46, val, 17, INK, bold=True)
        pdf.text(cx + 10, cy + 64, sub, 8, MUT)

    pdf.line(_PDF.M, 560, _PDF.W - _PDF.M, 560, LINE)
    meta_rows = [
        ('Generated', m.get('generated', '')),
        ('Tool', 'scc ' + m.get('sccVersion', '')),
        ('Root', m.get('root', '')),
    ]
    yy = 582
    for k, v in meta_rows:
        pdf.text(_PDF.M, yy, k, 9, INK, bold=True)
        pdf.text(_PDF.M + 80, yy, v, 9, MUT)
        yy += 18


def page_table(pdf, data):
    _header(pdf, data, 'Language breakdown')
    pdf.text(_PDF.M, 80, 'Every language scc detected', 16, INK, bold=True)
    langs = data.get('languages', [])
    cols = [('LANGUAGE', 'name', 'left', 130), ('FILES', 'files', 'right', 62),
            ('LINES', 'lines', 'right', 72), ('COMMENTS', 'comments', 'right', 78),
            ('CODE', 'code', 'right', 78), ('CX', 'complexity', 'right', 60)]
    x = _PDF.M
    y = 108
    cx = x
    for (title, key, align, w) in cols:
        pdf.text(cx if align == 'left' else cx + w - 4, y, title, 8, MUT, bold=True, align=align)
        cx += w
    y += 6
    pdf.line(x, y, x + sum(c[3] for c in cols), y, LINE)
    y += 14
    for r in langs:
        if y > 790:
            break
        cx = x
        for (title, key, align, w) in cols:
            val = r.get(key, 0)
            s = val if key == 'name' else _num(val)
            rgb = INK if key in ('name', 'code') else MUT
            bold = key == 'code'
            pdf.text(cx if align == 'left' else cx + w - 4, y, str(s), 8.5, rgb, bold=bold, align=align)
            cx += w
        if r.get('kind') == 'data':
            pdf.text(x + 128, y, 'data', 7, GREY)
        y += 15
        pdf.line(x, y - 11, x + sum(c[3] for c in cols), y - 11, (240, 242, 244))
    # totals
    tot = data.get('totals', {})
    pdf.line(x, y - 2, x + sum(c[3] for c in cols), y - 2, INK, 1.0)
    y += 12
    cx = x
    vals = {'name': 'Total', 'files': tot.get('files', 0), 'lines': tot.get('lines', 0),
            'comments': tot.get('comments', 0), 'code': tot.get('code', 0), 'complexity': tot.get('complexity', 0)}
    for (title, key, align, w) in cols:
        s = vals[key] if key == 'name' else _num(vals[key])
        pdf.text(cx if align == 'left' else cx + w - 4, y, str(s), 8.5, INK, bold=True, align=align)
        cx += w


def page_composition(pdf, data):
    _header(pdf, data, 'Composition')
    pdf.text(_PDF.M, 80, 'What the lines are made of', 16, INK, bold=True)
    pdf.text_wrap(_PDF.M, 98, 'Lines of code by language. Blue marks program source; grey marks data and configuration.',
                  9, MUT, _PDF.W - 2 * _PDF.M, 12)
    langs = [l for l in data.get('languages', []) if l.get('code', 0) > 0][:12]
    maxv = max([l['code'] for l in langs], default=1)
    total_code = data.get('totals', {}).get('code', 1) or 1

    def cf(label, val):
        row = next((l for l in langs if l['name'] == label), {})
        return GREY if row.get('kind') == 'data' else BLUE
    items = [(l['name'], l['code'], '(%0.1f%%)' % (100.0 * l['code'] / total_code)) for l in langs]
    y = _bar_chart(pdf, _PDF.M, 120, _PDF.W - 2 * _PDF.M, items, maxv, cf, 130)

    # source vs data split
    src = sum(l['code'] for l in data.get('languages', []) if l.get('kind') != 'data')
    dat = sum(l['code'] for l in data.get('languages', []) if l.get('kind') == 'data')
    tot = (src + dat) or 1
    y += 24
    pdf.text(_PDF.M, y, 'Source versus data', 11, INK, bold=True)
    y += 12
    bx, bw = _PDF.M + 90, _PDF.W - 2 * _PDF.M - 90
    sw = bw * src / tot
    pdf.rect(bx, y, sw, 16, BLUE)
    pdf.rect(bx + sw, y, bw - sw, 16, GREY)
    pdf.text(bx + sw / 2, y + 11, '%0.0f%%' % (100.0 * src / tot), 9, (255, 255, 255), align='center')
    pdf.text(bx + sw + (bw - sw) / 2, y + 11, '%0.0f%%' % (100.0 * dat / tot), 9, (255, 255, 255), align='center')
    pdf.text(_PDF.M, y + 11, 'All code', 9, INK, align='left')
    y += 30
    pdf.text_wrap(_PDF.M, y, '%s program-source lines versus %s data/config lines.' % (_num(src), _num(dat)),
                  9, MUT, _PDF.W - 2 * _PDF.M, 12)


def page_hotspots(pdf, data):
    _header(pdf, data, 'Hotspots')
    pdf.text(_PDF.M, 80, 'The files that carry the weight', 16, INK, bold=True)

    def file_table(title, rows, y, value_cols):
        pdf.text(_PDF.M, y, title, 12, INK, bold=True)
        y += 18
        for r in rows[:8]:
            pdf.text(_PDF.M, y, r.get('filename', '?'), 9, INK, bold=True)
            pdf.text(_PDF.M, y + 11, (r.get('location', '') or '')[:78], 7.5, MUT)
            cx = _PDF.W - _PDF.M
            for (lab, key, fmt) in reversed(value_cols):
                pdf.text(cx, y, fmt(r.get(key, 0)), 9, INK, align='right')
                cx -= 70
            y += 26
            pdf.line(_PDF.M, y - 6, _PDF.W - _PDF.M, y - 6, (240, 242, 244))
        return y + 8

    y = 108
    y = file_table('Most complex source files',
                   data.get('hotspots', []), y,
                   [('CODE', 'code', _num), ('CX', 'complexity', _num), ('CX/KLOC', 'cxPerKloc', _num)])
    y += 8
    file_table('Largest source files',
               data.get('largest', []), y,
               [('CODE', 'code', _num), ('BYTES', 'bytes', _human_bytes)])


def page_risk_hotspots(pdf, data):
    _header(pdf, data, 'Risk')
    pdf.text(_PDF.M, 80, 'Churn × complexity', 16, INK, bold=True)
    pdf.text_wrap(_PDF.M, 98,
                  'Files ranked by how often they change times how complex they are — the classic '
                  'hotspot metric. A file high on both is where change cost and defect risk concentrate: '
                  'the first place to add tests or split responsibility.',
                  9, MUT, _PDF.W - 2 * _PDF.M, 13)
    rows = data.get('riskHotspots', [])
    if not rows:
        pdf.text(_PDF.M, 140, 'No churn data (not a git repository, or no commits in the window).', 9, MUT)
        return
    x, y = _PDF.M, 130
    pdf.text(x, y, 'FILE', 8, MUT, bold=True)
    pdf.text(_PDF.W - _PDF.M - 150, y, 'CHURN', 8, MUT, bold=True, align='right')
    pdf.text(_PDF.W - _PDF.M - 75, y, 'CX', 8, MUT, bold=True, align='right')
    pdf.text(_PDF.W - _PDF.M, y, 'SCORE', 8, MUT, bold=True, align='right')
    y += 6
    pdf.line(x, y, _PDF.W - _PDF.M, y, LINE)
    y += 16
    maxscore = max((r.get('score', 0) for r in rows), default=1)
    for r in rows:
        if y > 790:
            break
        pdf.text(x, y, r.get('filename', '?'), 9, INK, bold=True)
        pdf.text(x, y + 11, (r.get('location', '') or '')[:74], 7.5, MUT)
        pdf.text(_PDF.W - _PDF.M - 150, y, _num(r.get('churn', 0)), 9, INK, align='right')
        pdf.text(_PDF.W - _PDF.M - 75, y, _num(r.get('complexity', 0)), 9, INK, align='right')
        pdf.text(_PDF.W - _PDF.M, y, _num(r.get('score', 0)), 9,
                 RED if r.get('score', 0) == maxscore else INK, align='right', bold=True)
        y += 24
        pdf.line(x, y - 6, _PDF.W - _PDF.M, y - 6, (240, 242, 244))


def page_risk(pdf, data):
    _header(pdf, data, 'Legend')
    pdf.text(_PDF.M, 80, 'Cyclomatic complexity: what the numbers mean', 15, INK, bold=True)
    pdf.text_wrap(_PDF.M, 100,
                  'Complexity counts the independent paths through code: one, plus one per decision point '
                  '(if, loop, case, catch, boolean operator, ternary). Each path is a case a test must exercise. '
                  'The bands below follow the widely used McCabe thresholds.',
                  9, MUT, _PDF.W - 2 * _PDF.M, 13)
    bands = [
        ('0', 'None', GREY, 'Data holders, constants, generated code.'),
        ('1-10', 'Low', GREEN, 'Straight-line logic; easy to test.'),
        ('11-20', 'Moderate', (60, 170, 90), 'Several paths; ensure branch tests exist.'),
        ('21-50', 'High', AMBER, 'Hard to reason about; split responsibility.'),
        ('51-100', 'Very high', (230, 120, 80), 'Beyond one reader; plan decomposition.'),
        ('101+', 'Extreme', RED, 'Refactor before extending.'),
    ]
    y = 150
    for (rng, name, rgb, meaning) in bands:
        pdf.rect(_PDF.M, y - 8, 12, 12, rgb)
        pdf.text(_PDF.M + 22, y, rng, 9, INK, bold=True)
        pdf.text(_PDF.M + 80, y, name, 9, INK, bold=True)
        pdf.text(_PDF.M + 160, y, meaning, 9, MUT)
        y += 24

    insights = data.get('insights', [])
    if insights:
        y += 10
        pdf.text(_PDF.M, y, 'What the numbers say', 13, INK, bold=True)
        y += 20
        for i, ins in enumerate(insights, 1):
            pdf.text(_PDF.M, y, str(i) + '.', 9, BLUE, bold=True)
            pdf.text(_PDF.M + 16, y, ins.get('title', ''), 10, INK, bold=True)
            y += 14
            y = pdf.text_wrap(_PDF.M + 16, y, ins.get('body', ''), 9, MUT, _PDF.W - 2 * _PDF.M - 16, 12)
            y += 8
            if y > 780:
                break


def page_quality(pdf, data):
    q = data.get('quality', {})
    _header(pdf, data, 'Quality')
    pdf.text(_PDF.M, 80, 'Quality signals', 16, INK, bold=True)
    y = 108
    cov = q.get('coverage')
    if cov and cov.get('total'):
        t = cov['total']
        pct = t.get('pct', 0)
        color = RED if pct < 50 else (AMBER if pct < 80 else GREEN)
        pdf.text(_PDF.M, y, 'Test coverage', 12, INK, bold=True)
        y += 22
        pdf.text(_PDF.M, y, str(pct) + '%', 20, color, bold=True)
        pdf.text(_PDF.M + 70, y, 'of lines — %s of %s lines, %s files (%s)'
                 % (_num(t.get('hit', 0)), _num(t.get('lines', 0)), _num(t.get('files', 0)), cov.get('path', '')),
                 9, MUT)
        y += 22
        pdf.text(_PDF.M, y, 'Lowest-covered files', 10, INK, bold=True)
        y += 16
        for f in cov.get('lowest', [])[:8]:
            pdf.text(_PDF.M, y, f.get('filename', '?'), 9, INK)
            pdf.text(_PDF.M + 170, y, (f.get('location', '') or '')[:52], 7.5, MUT)
            pc = f.get('pct', 0)
            pdf.text(_PDF.W - _PDF.M, y, str(pc) + '%', 9,
                     RED if pc < 50 else (AMBER if pc < 80 else GREEN), align='right', bold=True)
            y += 15
        y += 14
    todo = q.get('todo')
    if todo:
        pdf.text(_PDF.M, y, 'Technical-debt markers', 12, INK, bold=True)
        y += 18
        counts = todo.get('counts', {})
        line = '   '.join('%s %s' % (k, counts[k]) for k in counts) or 'none'
        pdf.text(_PDF.M, y, line, 11, INK)
        y += 14
        pdf.text(_PDF.M, y, '%d TODO / FIXME / HACK markers in the tree.' % todo.get('total', 0), 9, MUT)
        y += 24
    findings = q.get('findings', {})
    if findings:
        pdf.text(_PDF.M, y, 'Scanners', 12, INK, bold=True)
        y += 18
        for key in findings:
            fv = findings[key]
            pdf.text(_PDF.M, y, (fv.get('label', key)) + ':', 9, INK, bold=True)
            pdf.text(_PDF.M + 150, y, fv.get('summary', '') or (_num(fv.get('count', 0)) + ' findings'), 9, MUT)
            y += 16


def _vbars(pdf, x, y, w, h, items, color):
    """Vertical bar chart. items: [(label, value)]."""
    maxv = max((v for _, v in items), default=1) or 1
    n = len(items) or 1
    gap = 8
    bw = (w - gap * (n - 1)) / n
    base = y + h - 16
    for i, (label, val) in enumerate(items):
        bh = (h - 20) * (val / maxv)
        bx = x + i * (bw + gap)
        pdf.rect(bx, base - bh, bw, max(bh, 1), color)
        pdf.text(bx + bw / 2, base - bh - 3, _num(val), 8, INK, align='center')
        pdf.text(bx + bw / 2, base + 12, label, 7.5, MUT, align='center')


def page_density(pdf, data):
    _header(pdf, data, 'Quality signals')
    pdf.text(_PDF.M, 80, 'Density and complexity', 15, INK, bold=True)
    langs = [l for l in data.get('languages', []) if l.get('kind') != 'data' and l.get('code', 0) >= 200]
    cxk = sorted([(l['name'], int(round(1000.0 * l.get('complexity', 0) / max(l.get('code', 1), 1)))) for l in langs], key=lambda t: -t[1])[:8]
    pdf.text(_PDF.M, 106, 'Cyclomatic complexity per 1,000 code lines', 11, INK, bold=True)
    y = _bar_chart(pdf, _PDF.M, 116, _PDF.W - 2 * _PDF.M, [(n, v, '') for n, v in cxk], max([v for _, v in cxk], default=1), lambda l, v: AMBER, 120, 15)
    y += 18
    dens = sorted([(l['name'], round(100.0 * l.get('comment', 0) / max(l.get('code', 0) + l.get('comment', 0), 1), 1)) for l in langs], key=lambda t: -t[1])[:8]
    pdf.text(_PDF.M, y, 'Comment density (comments / code + comments)', 11, INK, bold=True)
    _bar_chart(pdf, _PDF.M, y + 10, _PDF.W - 2 * _PDF.M, [(n, v, '') for n, v in dens], max([v for _, v in dens], default=1), lambda l, v: BLUE, 120, 15, val_fmt=lambda v: str(v) + '%')


def page_distribution(pdf, data):
    _header(pdf, data, 'Distribution')
    pdf.text(_PDF.M, 80, 'Complexity bands and file size', 15, INK, bold=True)
    rb = data.get('riskBands', {})
    bands = [('None (0)', rb.get('none', 0), GREY), ('Low 1-10', rb.get('low', 0), GREEN),
             ('Moderate 11-20', rb.get('moderate', 0), (60, 170, 90)), ('High 21-50', rb.get('high', 0), AMBER),
             ('Very high 51-100', rb.get('veryHigh', 0), (230, 120, 80)), ('Extreme 101+', rb.get('extreme', 0), RED)]
    pdf.text(_PDF.M, 106, 'Files by cyclomatic-complexity band (McCabe)', 11, INK, bold=True)
    color_of = {b[0]: b[2] for b in bands}
    y = _bar_chart(pdf, _PDF.M, 116, _PDF.W - 2 * _PDF.M,
                   [(l, v, '') for l, v, _ in bands], max([v for _, v, _ in bands], default=1),
                   lambda l, v: color_of.get(l, BLUE), 130, 15)
    y += 24
    sb = data.get('sizeBuckets', {})
    hist = [('<50', sb.get('b1', 0)), ('50-99', sb.get('b2', 0)), ('100-199', sb.get('b3', 0)),
            ('200-399', sb.get('b4', 0)), ('400-799', sb.get('b5', 0)), ('800+', sb.get('b6', 0))]
    pdf.text(_PDF.M, y, 'File-size distribution (code lines per file)', 11, INK, bold=True)
    _vbars(pdf, _PDF.M, y + 10, _PDF.W - 2 * _PDF.M, 150, hist, BLUE)


def _detail_table(pdf, y, title, cols, rows, empty):
    """cols: [(header, key, align, width)]. Returns y after."""
    pdf.text(_PDF.M, y, title, 12, INK, bold=True)
    y += 16
    if not rows:
        pdf.text(_PDF.M, y, empty, 9, MUT)
        return y + 18
    x = _PDF.M
    cx = x
    for (h, k, al, w) in cols:
        pdf.text(cx if al == 'left' else cx + w - 4, y, h, 8, MUT, bold=True, align=al)
        cx += w
    y += 5
    pdf.line(x, y, x + sum(c[3] for c in cols), y, LINE)
    y += 13
    for r in rows:
        if y > 800:
            break
        cx = x
        for (h, k, al, w) in cols:
            v = r.get(k, '')
            s = _num(v) if isinstance(v, (int, float)) else str(v)
            if al == 'left' and len(s) > 46:
                s = s[:45] + '…'
            pdf.text(cx if al == 'left' else cx + w - 4, y, s, 8, INK if al == 'left' else MUT, align=al)
            cx += w
        y += 14
        pdf.line(x, y - 5, x + sum(c[3] for c in cols), y - 5, (242, 244, 246))
    return y + 10


def page_scanners(pdf, data):
    sc = (data.get('quality', {}) or {}).get('scanners', {}) or {}
    _header(pdf, data, 'Scanners')
    pdf.text(_PDF.M, 80, 'Security and duplication findings', 15, INK, bold=True)
    y = 106
    W = _PDF.W - 2 * _PDF.M
    if sc.get('secrets'):
        y = _detail_table(pdf, y, 'Secrets (gitleaks) — ' + (sc['secrets'].get('summary') or ''),
                          [('FILE', 'file', 'left', W - 200), ('LINE', 'line', 'right', 60), ('RULE', 'rule', 'right', 140)],
                          sc['secrets'].get('findings', [])[:10], 'No secrets found.')
    if sc.get('deps'):
        y = _detail_table(pdf, y + 8, 'Dependency vulnerabilities (osv-scanner) — ' + (sc['deps'].get('summary') or ''),
                          [('PACKAGE', 'package', 'left', 150), ('VERSION', 'version', 'left', 90), ('VULN', 'id', 'left', W - 380), ('SEVERITY', 'severity', 'right', 90)],
                          sc['deps'].get('findings', [])[:10], 'No known vulnerabilities.')
    if sc.get('dup'):
        y = _detail_table(pdf, y + 8, 'Duplication (jscpd) — ' + (sc['dup'].get('summary') or ''),
                          [('FILE A', 'fileA', 'left', (W - 70) / 2), ('FILE B', 'fileB', 'left', (W - 70) / 2), ('LINES', 'lines', 'right', 60)],
                          sc['dup'].get('findings', [])[:8], 'No significant duplication.')
    if sc.get('fn'):
        y = _detail_table(pdf, y + 8, 'Most complex functions (lizard) — ' + (sc['fn'].get('summary') or ''),
                          [('FUNCTION', 'func', 'left', 200), ('FILE', 'file', 'left', W - 340), ('CCN', 'ccn', 'right', 60), ('NLOC', 'nloc', 'right', 60)],
                          sc['fn'].get('findings', [])[:10], '')


def build(data, out_path):
    pdf = _PDF()
    q = data.get('quality', {}) or {}
    sc = q.get('scanners', {}) or {}
    pages = [page_cover, page_table, page_composition, page_density, page_distribution,
             page_hotspots, page_risk_hotspots]
    if q.get('coverage') or q.get('todo') or q.get('findings'):
        pages.append(page_quality)
    if any(sc.get(k) for k in ('secrets', 'deps', 'dup', 'fn')):
        pages.append(page_scanners)
    pages.append(page_risk)
    n = len(pages)
    for i, fn in enumerate(pages, 1):
        if i > 1:
            pdf.new_page()
        fn(pdf, data)
        _footer(pdf, data, i, n)
    pdf.save(out_path)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write('usage: census.py <data.json> <out.pdf>\n')
        return 2
    with open(argv[1], 'r', encoding='utf-8') as f:   # JSON.stringify emits raw UTF-8
        data = json.load(f)
    data.setdefault('meta', {}).setdefault('generated', datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))
    build(data, argv[2])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
