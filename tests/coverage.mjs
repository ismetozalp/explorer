#!/usr/bin/env node
// tests/coverage.mjs — turn coverage/lcov.info into COVERAGE.html.
//
// The lcov file is machine output: per-line hit counts that nobody reads and a
// diff cannot show. COVERAGE.html is the part worth keeping in the repository —
// one row per source file, columns sortable, because the question is almost
// always "what is worst?" rather than "how did js/core/tabs.js do?".
//
// HTML rather than Markdown because a Markdown table cannot sort. The trade is
// that GitHub shows this file as source rather than rendering it; open it from a
// checkout instead. Nothing is fetched — the styles and the sorting are inline,
// so the file works from a file:// URL with no network.
//
// Percentages ONLY, deliberately. Recording which lines are uncovered would make
// the file churn on every insertion anywhere above them, and a report that
// changes when nothing about the testing changed is a report people stop
// reading. The line numbers live in coverage/lcov.info, regenerated on demand
// and never committed.
//
//   node tests/coverage.mjs            reads coverage/lcov.info, writes COVERAGE.html
//   node tests/coverage.mjs --check    exit 1 if COVERAGE.html is out of date
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LCOV = path.join(ROOT, 'coverage', 'lcov.info');
const OUT = path.join(ROOT, 'COVERAGE.html');

// Kept in step with COVERAGE_MIN in the Makefile. Stated in the report because a
// percentage with no floor beside it is a number, not a promise.
const FLOORS = { lines: 48, branches: 77, functions: 33 };

// --- lcov -----------------------------------------------------------------

// One record per source file. Only the six summary counters are read; the
// per-line DA: records are what makes the file enormous and are not needed for
// a percentage.
function parseLcov(text) {
    const files = [];
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            cur = { file: line.slice(3), LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
            continue;
        }
        if (!cur) continue;
        if (line === 'end_of_record') { files.push(cur); cur = null; continue; }
        const m = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
        if (m) cur[m[1]] = Number(m[2]);
    }
    return files;
}

// A file with nothing to measure is 100%, not 0%. An empty module scoring zero
// would drag a total down for having no code in it, which says nothing true.
function pct(hit, found) {
    if (!found) return 100;
    return (hit / found) * 100;
}

function fmt(n) { return n.toFixed(2) + '%'; }

function totals(files) {
    const sum = (k) => files.reduce((n, f) => n + f[k], 0);
    return {
        lines: pct(sum('LH'), sum('LF')),
        branches: pct(sum('BRH'), sum('BRF')),
        functions: pct(sum('FNH'), sum('FNF'))
    };
}

// --- the report -----------------------------------------------------------

// Everything in this file comes from lcov.info and VERSION, both of which this
// repository generates — but escaping is not optional just because today's input
// is trusted. A path is the one field that could ever carry a bracket.
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Three bands, so the eye finds the bad rows without reading any numbers. The
// boundaries are the floors themselves: green means "above the line explorer
// enforces", amber means "passing but close", red means "this would fail".
function band(value, floor) {
    if (value < floor) return 'bad';
    if (value < floor + 5) return 'near';
    return 'good';
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1b1f; --muted: #5c5f6b; --line: #d7d9e0;
  --head: #f4f5f8; --good: #1a7f37; --near: #9a6700; --bad: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171b; --fg: #e6e7ea; --muted: #9a9ca6; --line: #2e3037;
    --head: #1e2027; --good: #4ac26b; --near: #d4a72c; --bad: #ff6b5e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; }
p.sub { color: var(--muted); margin: 0 0 1.75rem; }
.wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
caption { text-align: left; padding: .75rem 1rem; color: var(--muted); }
th, td { padding: .5rem .9rem; border-bottom: 1px solid var(--line); text-align: right; }
th:first-child, td:first-child { text-align: left; }
tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
thead th {
  background: var(--head); position: sticky; top: 0; font-weight: 600;
  border-bottom: 1px solid var(--line);
}
thead th button {
  all: unset; cursor: pointer; display: block; width: 100%; text-align: inherit;
  padding: 0; color: inherit; font: inherit;
}
thead th button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
thead th button::after { content: ""; opacity: .45; padding-left: .4em; }
thead th[aria-sort="ascending"] button::after { content: "\\2191"; opacity: 1; }
thead th[aria-sort="descending"] button::after { content: "\\2193"; opacity: 1; }
thead th[data-sort]:not([aria-sort]) button::after { content: "\\2195"; }
td.file { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
td.good { color: var(--good); }
td.near { color: var(--near); }
td.bad  { color: var(--bad); font-weight: 600; }
.totals { margin: 0 0 1.5rem; }
.totals table { font-size: 15px; }
.totals td, .totals th { border-bottom: 1px solid var(--line); }
ul { padding-left: 1.15rem; }
li { margin: .35rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 13px; }
`;

// Sorts the tbody rows in place by the numeric value stashed on each cell, so
// "9.00%" never sorts above "88.00%" as it would by text.
const SCRIPT = `
(function () {
  var table = document.getElementById('files');
  var heads = table.tHead.rows[0].cells;
  function sortBy(index, dir) {
    var body = table.tBodies[0];
    var rows = Array.prototype.slice.call(body.rows);
    rows.sort(function (a, b) {
      var x = a.cells[index].dataset.value, y = b.cells[index].dataset.value;
      var n = parseFloat(x), m = parseFloat(y);
      var r = isNaN(n) || isNaN(m) ? String(x).localeCompare(String(y)) : n - m;
      // Ties fall back to the path, so the order is total and a re-sort of the
      // same column never shuffles equal rows.
      if (r === 0) r = a.cells[0].dataset.value.localeCompare(b.cells[0].dataset.value);
      return dir === 'ascending' ? r : -r;
    });
    rows.forEach(function (row) { body.appendChild(row); });
    for (var i = 0; i < heads.length; i++) heads[i].removeAttribute('aria-sort');
    heads[index].setAttribute('aria-sort', dir);
  }
  for (var i = 0; i < heads.length; i++) (function (index) {
    var th = heads[index];
    if (!th.hasAttribute('data-sort')) return;
    var button = th.querySelector('button');
    button.addEventListener('click', function () {
      // Ascending first, then toggle. For a percentage that means worst-first,
      // which is the reason anyone sorts a coverage column; for the path it
      // means A to Z.
      var toggled = th.getAttribute('aria-sort') === 'ascending';
      sortBy(index, toggled ? 'descending' : 'ascending');
    });
  })(i);
  // Worst lines first on load: the top of the table is the work queue.
  sortBy(1, 'ascending');
})();
`;

function headCell(label, sortable) {
    if (!sortable) return '<th scope="col">' + esc(label) + '</th>';
    return '<th scope="col" data-sort><button type="button">' + esc(label) + '</button></th>';
}

function render(files, version) {
    const t = totals(files);
    // Emitted sorted by path, never by score, so the DIFF between two releases
    // shows what changed rather than a reshuffle. The browser re-sorts on load.
    const rows = files.slice().sort((a, b) => a.file.localeCompare(b.file));

    const cell = (value, floor) =>
        '<td class="' + band(value, floor) + '" data-value="' + value.toFixed(4) + '">' +
        fmt(value) + '</td>';

    const out = [];
    out.push('<!doctype html>');
    out.push('<html lang="en">');
    out.push('<head>');
    out.push('<meta charset="utf-8">');
    out.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    out.push('<title>explorer ' + esc(version) + ' — coverage</title>');
    out.push('<style>' + STYLE + '</style>');
    out.push('</head>');
    out.push('<body>');
    out.push('<main>');
    out.push('<h1>Coverage</h1>');
    out.push('<p class="sub">explorer ' + esc(version) +
        ' &middot; generated by <code>make coverage</code> &middot; do not edit by hand</p>');

    out.push('<div class="wrap totals">');
    out.push('<table>');
    out.push('<caption>Totals across every measured file, and the floors below ' +
        'which <code>make test</code> fails.</caption>');
    out.push('<thead><tr><th scope="col"></th><th scope="col">lines</th>' +
        '<th scope="col">branches</th><th scope="col">functions</th></tr></thead>');
    out.push('<tbody>');
    out.push('<tr><th scope="row">measured</th>' +
        '<td><strong>' + fmt(t.lines) + '</strong></td>' +
        '<td><strong>' + fmt(t.branches) + '</strong></td>' +
        '<td><strong>' + fmt(t.functions) + '</strong></td></tr>');
    out.push('<tr><th scope="row">floor</th>' +
        '<td>' + FLOORS.lines + '%</td><td>' + FLOORS.branches + '%</td>' +
        '<td>' + FLOORS.functions + '%</td></tr>');
    out.push('</tbody>');
    out.push('</table>');
    out.push('</div>');

    out.push('<h2>By file</h2>');
    out.push('<div class="wrap">');
    out.push('<table id="files">');
    out.push('<caption>Click a column to sort. Opens worst lines first.</caption>');
    out.push('<thead><tr>' + headCell('file', true) + headCell('lines', true) +
        headCell('branches', true) + headCell('functions', true) + '</tr></thead>');
    out.push('<tbody>');
    for (const f of rows) {
        out.push('<tr>' +
            '<td class="file" data-value="' + esc(f.file) + '">' + esc(f.file) + '</td>' +
            cell(pct(f.LH, f.LF), FLOORS.lines) +
            cell(pct(f.BRH, f.BRF), FLOORS.branches) +
            cell(pct(f.FNH, f.FNF), FLOORS.functions) +
            '</tr>');
    }
    out.push('</tbody>');
    out.push('</table>');
    out.push('</div>');

    out.push('<h2>What this number does not include</h2>');
    out.push('<p>A coverage figure that quietly omits part of the shipped logic is ' +
        'worse than no figure, so the omissions are named here. The percentages above ' +
        'come from <code>tests/*-unit.mjs</code> alone.</p>');
    out.push('<ul>');
    out.push('<li>The <strong>e2e, smoke and real-Cockpit suites</strong> ' +
        '(<code>tests/*-e2e.mjs</code>, <code>tests/smoke.mjs</code>) drive this same ' +
        'source through a real browser against a live Cockpit. They execute far more of ' +
        'it than the unit tests do and would raise every number here, but Playwright runs ' +
        'the code in the browser, out of reach of node’s instrumentation, so none of it ' +
        'is counted.</li>');
    out.push('<li><code>ffmpeg</code> — the transcode/HLS path in ' +
        '<code>js/features/videoplayer.js</code> drives ffmpeg as a subprocess. Its ' +
        'behaviour is tested; the subprocess is invisible to node’s coverage.</li>');
    out.push('<li><code>index.html</code>, <code>css/</code>, <code>html/</code> — markup ' +
        'and styles, with no executable logic to cover.</li>');
    out.push('<li><code>tests/</code> — a test file’s own coverage says nothing about the ' +
        'code under test.</li>');
    out.push('</ul>');
    out.push('<p>A file only appears above once a unit test has loaded it; modules reached ' +
        'solely through the browser suites are therefore absent rather than scored zero.</p>');

    out.push('<footer>Per-line detail lives in <code>coverage/lcov.info</code>, which is ' +
        'regenerated on demand and not committed. GitHub shows this file as source rather ' +
        'than rendering it — open it from a checkout.</footer>');
    out.push('</main>');
    out.push('<script>' + SCRIPT + '</script>');
    out.push('</body>');
    out.push('</html>');
    out.push('');
    return out.join('\n');
}

export { parseLcov, pct, fmt, totals, band, esc, render, FLOORS };

// --- main -----------------------------------------------------------------

// Importing this file must not run it: a module that read /coverage on import
// would fail on any machine that had not just run `make coverage`.
const invokedDirectly = process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (!invokedDirectly) {
    // Nothing else to do — the exports are the point.
} else main();

function main() {
    if (!fs.existsSync(LCOV)) {
        console.error('tests/coverage.mjs: no ' + path.relative(ROOT, LCOV) + ' — run `make coverage`');
        process.exit(1);
    }

    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    const files = parseLcov(fs.readFileSync(LCOV, 'utf8'));
    if (!files.length) {
        console.error('tests/coverage.mjs: ' + path.relative(ROOT, LCOV) + ' holds no records');
        process.exit(1);
    }
    const report = render(files, version);

    if (process.argv.includes('--check')) {
        const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (existing !== report) {
            console.error('COVERAGE.html is out of date — run `make coverage`');
            process.exit(1);
        }
        console.log('COVERAGE.html is up to date');
        process.exit(0);
    }

    fs.writeFileSync(OUT, report);
    const t = totals(files);
    console.log('Wrote COVERAGE.html — ' + files.length + ' files, ' +
        fmt(t.lines) + ' lines, ' + fmt(t.branches) + ' branches, ' +
        fmt(t.functions) + ' functions');
}
