// Unit tests for the pure helpers in js/features/scc.js — OS install hints,
// JSON parsing, and the aggregators that feed the table pane, the complexity
// hotspots, and the tree complexity badges. vm-loaded with {filename} for coverage.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../js/features/scc.js', import.meta.url), 'utf8'),
    sb, { filename: new URL('../js/features/scc.js', import.meta.url).pathname });
const S = sb.window.ExplorerScc;
assert.ok(S, 'ExplorerScc defined');

// ── install hints per OS ──────────────────────────────────────────────────
assert.strictEqual(S._sccInstallHint('ID=fedora\nID_LIKE="centos rhel"').primary, 'go install github.com/boyter/scc/v3@latest');
assert.strictEqual(S._sccInstallHint('ID=ubuntu\nID_LIKE=debian').primary, 'sudo snap install scc');
assert.strictEqual(S._sccInstallHint('ID=arch').primary, 'sudo pacman -S scc');
assert.strictEqual(S._sccInstallHint('ID=alpine').primary, 'sudo apk add scc');
assert.ok(/github\.com\/boyter\/scc\/releases/.test(S._sccInstallHint('ID=void').primary), 'unknown Linux → binary download');
assert.ok(Array.isArray(S._sccInstallHint('ID=debian').alt), 'alt routes present');

// ── turnkey install command per OS ──────────────────────────────────────────
assert.strictEqual(S._sccInstallCmd('ID=arch'), 'pacman -S --noconfirm scc');
assert.strictEqual(S._sccInstallCmd('ID=alpine'), 'apk add scc');
{
    const c = S._sccInstallCmd('ID=fedora\nID_LIKE="centos rhel"');
    assert.ok(c.includes('releases/latest/download/scc_') && c.includes('/usr/local/bin/scc'), 'RHEL → binary download to /usr/local/bin');
    assert.ok(c.includes('uname -m') && c.includes('curl') && c.includes('wget'), 'detects arch, curl with wget fallback');
}
assert.ok(S._sccInstallCmd('ID=ubuntu\nID_LIKE=debian').includes('releases/latest/download'), 'Debian → binary download (turnkey)');

// ── JSON parse (defensive) ──────────────────────────────────────────────────
assert.strictEqual(S._sccParse('not json').length, 0, 'bad JSON → []');
assert.strictEqual(S._sccParse('{"x":1}').length, 0, 'non-array JSON → []');
assert.strictEqual(S._sccParse('[]').length, 0);

// ── sample scc --by-file output ─────────────────────────────────────────────
const langs = [
    { Name: 'Java', Count: 2, Lines: 300, Blank: 30, Comment: 40, Code: 230, Complexity: 90, Files: [
        { Filename: 'A.java', Location: 'src/A.java', Language: 'Java', Lines: 200, Code: 150, Comment: 30, Blank: 20, Complexity: 60, Bytes: 4000 },
        { Filename: 'B.java', Location: 'src/B.java', Language: 'Java', Lines: 100, Code: 80, Comment: 10, Blank: 10, Complexity: 30, Bytes: 2000 },
    ] },
    { Name: 'JSON', Count: 1, Lines: 1000, Blank: 0, Comment: 0, Code: 1000, Complexity: 0, Files: [
        { Filename: 'data.json', Location: 'res/data.json', Language: 'JSON', Lines: 1000, Code: 1000, Comment: 0, Blank: 0, Complexity: 0, Bytes: 90000 },
    ] },
];

// table rows: sorted by code desc (JSON 1000 > Java 230), totals appended, JSON marked data
const { rows, total } = S._sccTableRows(langs);
assert.deepStrictEqual([...rows].map(r => r.name), ['JSON', 'Java'], 'sorted by code desc');
assert.strictEqual(rows[0].kind, 'data', 'JSON flagged as data');
assert.strictEqual(rows[1].kind, '', 'Java is program source');
assert.strictEqual(total.code, 1230, 'total code'); assert.strictEqual(total.files, 3, 'total files');
assert.strictEqual(total.complexity, 90, 'total complexity');

// per-file flatten + cxPerKloc
const files = S._sccFiles(langs);
assert.strictEqual(files.length, 3);
const a = files.find(f => f.filename === 'A.java');
assert.strictEqual(a.cxPerKloc, Math.round(60 * 1000 / 150), 'A cx/kloc = 400');
assert.strictEqual(S._sccFiles([{ Name: 'X', Files: [{ Location: 'z', Code: 0, Complexity: 5 }] }])[0].cxPerKloc, 0, 'code 0 → cx/kloc 0 (no divide-by-zero)');

// top complexity (ties broken by code)
const top = S._sccTopComplex(files, 2);
assert.deepStrictEqual([...top].map(f => f.filename), ['A.java', 'B.java'], 'top-2 by complexity');
assert.strictEqual(S._sccTopComplex(files, 50).length, 3, 'n larger than set → all files');

// complexity-by-path map for the tree (absolute paths)
const cx = S._sccComplexityByPath(files, '/repo');
assert.strictEqual(cx['/repo/src/A.java'], 60);
assert.strictEqual(cx['/repo/res/data.json'], 0);
assert.strictEqual(Object.keys(cx).length, 3);

// sort rows (pure): numeric desc/asc, alpha for name
const sr = S._sccSortRows(rows, { col: 'complexity', dir: 'desc' });
assert.deepStrictEqual([...sr].map(r => r.name), ['Java', 'JSON'], 'complexity desc → Java(90) before JSON(0)');
const sa = S._sccSortRows(rows, { col: 'code', dir: 'asc' });
assert.deepStrictEqual([...sa].map(r => r.name), ['Java', 'JSON'], 'code asc → Java(230) before JSON(1000)');
const sn = S._sccSortRows(rows, { col: 'name', dir: 'asc' });
assert.deepStrictEqual([...sn].map(r => r.name), ['Java', 'JSON'], 'name asc → alphabetical');

// report data assembly (pure): totals, source/data split, hotspots, insights
{
    const table = S._sccTableRows(langs);
    const files = S._sccFiles(langs);
    const data = S._sccReportData(table, files, { title: 'Demo', branch: 'main', root: '/repo' });
    assert.strictEqual(data.totals.code, 1230, 'report totals.code');
    assert.strictEqual(data.totals.languages, 2);
    assert.strictEqual(data.totals.bytes, 96000, 'bytes summed from files');
    assert.strictEqual(data.hotspots[0].filename, 'A.java', 'hotspot = most complex');
    assert.strictEqual(data.largest[0].filename, 'data.json', 'largest = most code');
    assert.ok(data.insights.length >= 2 && data.insights[0].title, 'insights generated');
    assert.strictEqual(data.title, 'Demo');
    assert.strictEqual(S._sccReportFilename(), 'code-census.pdf');
}

// churn parse: count commits per path, decode simple quoting, skip blanks
{
    const log = 'src/A.java\nsrc/B.java\n\nsrc/A.java\n"src/quoted \\"x\\".java"\n\nsrc/A.java\n';
    const churn = S._sccParseChurn(log);
    assert.strictEqual(churn['src/A.java'], 3, 'A.java touched by 3 commits');
    assert.strictEqual(churn['src/B.java'], 1);
    assert.ok('src/quoted "x".java' in churn, 'quoted path decoded');
    assert.strictEqual(Object.keys(S._sccParseChurn('')).length, 0, 'empty log → {}');
}
// hotspots: score = churn × complexity, only files with both > 0, sorted desc
{
    const files = S._sccFiles(langs);  // A.java cx=60, B.java cx=30, data.json cx=0
    const churn = { 'src/A.java': 2, 'src/B.java': 5, 'res/data.json': 9 };
    const hot = S._sccHotspots(files, churn, 50);
    assert.strictEqual(hot.length, 2, 'data.json (cx 0) excluded despite high churn');
    assert.strictEqual(hot[0].filename, 'B.java', 'B: 5×30=150 beats A: 2×60=120');
    assert.strictEqual(hot[0].score, 150);
    assert.strictEqual(hot[1].filename, 'A.java');
    assert.strictEqual(S._sccHotspots(files, {}, 50).length, 0, 'no churn → no hotspots');
}

// lcov parse: DA-based coverage, per file + totals + lowest-first rows
{
    const lcov = [
        'TN:', 'SF:js/a.js', 'DA:1,3', 'DA:2,0', 'DA:3,1', 'DA:4,0', 'end_of_record',
        'SF:js/b.js', 'DA:1,5', 'DA:2,5', 'end_of_record',
    ].join('\n');
    const cov = S._sccParseLcov(lcov);
    assert.strictEqual(cov['js/a.js'].lines, 4);
    assert.strictEqual(cov['js/a.js'].hit, 2, 'a.js: 2 of 4 lines hit');
    assert.strictEqual(cov['js/a.js'].pct, 50);
    assert.strictEqual(cov['js/b.js'].pct, 100);
    const rows = S._sccCoverageRows(cov, 10);
    assert.deepStrictEqual([...rows].map(r => r.filename), ['a.js', 'b.js'], 'lowest coverage first');
    const tot = S._sccCoverageTotal(cov);
    assert.strictEqual(tot.lines, 6); assert.strictEqual(tot.hit, 4);
    assert.strictEqual(tot.pct, Math.round(1000 * 4 / 6) / 10, 'overall = 4/6');
    assert.strictEqual(Object.keys(S._sccParseLcov('')).length, 0, 'empty lcov → {}');
    // no trailing end_of_record still flushes the last file
    assert.ok('js/c.js' in S._sccParseLcov('SF:js/c.js\nDA:1,1'), 'final record flushed without end_of_record');
}

// ── TODO census parse ───────────────────────────────────────────────────────
{
    const g = 'js/a.js:12: // TODO fix this\njs/b.js:3:code(); // FIXME later\nREADME.md:1:no marker here\njs/a.js:40:  // HACK\n';
    const r = S._sccParseTodos(g);
    assert.strictEqual(r.items.length, 3, 'three marker lines');
    assert.strictEqual(r.counts.TODO, 1); assert.strictEqual(r.counts.FIXME, 1); assert.strictEqual(r.counts.HACK, 1);
    assert.strictEqual(r.items[0].file, 'js/a.js'); assert.strictEqual(r.items[0].line, 12); assert.strictEqual(r.items[0].marker, 'TODO');
    assert.strictEqual(S._sccParseTodos('').items.length, 0);
}
// ── external tool parsers (sample outputs) ──────────────────────────────────
{
    const gl = JSON.stringify([{ File: 'src/x.js', StartLine: 9, RuleID: 'aws-key', Description: 'AWS key' }]);
    const r = S._sccParseGitleaks(gl);
    assert.strictEqual(r.findings.length, 1); assert.strictEqual(r.findings[0].file, 'src/x.js'); assert.strictEqual(r.findings[0].rule, 'aws-key');
    assert.ok(/potential secret/.test(r.summary));
    assert.strictEqual(S._sccParseGitleaks('not json').findings.length, 0, 'bad JSON → no findings');
}
{
    const osv = JSON.stringify({ results: [{ packages: [{ package: { name: 'lodash', version: '4.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-x', summary: 'proto', database_specific: { severity: 'HIGH' } }] }] }] });
    const r = S._sccParseOsv(osv);
    assert.strictEqual(r.findings.length, 1); assert.strictEqual(r.findings[0].package, 'lodash'); assert.strictEqual(r.findings[0].id, 'GHSA-x'); assert.strictEqual(r.findings[0].severity, 'HIGH');
    assert.strictEqual(S._sccParseOsv('{}').findings.length, 0);
    // A long CVSS vector must NOT become the severity value (it overran the table
    // in the report) — fall back to the compact CVSS-version label instead.
    const vec = JSON.stringify({ results: [{ packages: [{ package: { name: 'logback', version: '1.5.12' }, vulnerabilities: [{ id: 'GHSA-y', severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:H/AT:P/PR:P/UI:N/VC:L/VI:L/VA:N/SC:L/SI:L/SA:L' }] }] }] }] });
    assert.strictEqual(S._sccParseOsv(vec).findings[0].severity, 'CVSS V4', 'CVSS vector → compact version label');
    // A short bare score (not a vector) is kept as-is.
    const num = JSON.stringify({ results: [{ packages: [{ package: { name: 'p', version: '1' }, vulnerabilities: [{ id: 'CVE-1', severity: [{ type: 'CVSS_V3', score: '9.8' }] }] }] }] });
    assert.strictEqual(S._sccParseOsv(num).findings[0].severity, '9.8', 'short bare score kept');
}
{
    const j = JSON.stringify({ statistics: { total: { percentage: 3.4 } }, duplicates: [{ firstFile: { name: 'a.js', start: 1 }, secondFile: { name: 'b.js', start: 5 }, lines: 20 }] });
    const r = S._sccParseJscpd(j);
    assert.strictEqual(r.findings.length, 1); assert.strictEqual(r.findings[0].fileA, 'a.js'); assert.strictEqual(r.findings[0].lines, 20);
    assert.ok(/3.4% duplicated/.test(r.summary));
}
{
    // realistic lizard --csv: NLOC,CCN,token,PARAM,length,"func@start-end@file","file","func","long_name",start,end
    const csv = '5,3,20,1,7,"foo@2-8@src/a.js","src/a.js","foo","foo ( x )",2,8\n'
        + '40,60,300,4,120,"bar@10-120@src/b.js","src/b.js","bar","bar ( a , b )",10,120\n'
        + 'bad,row\n';
    const r = S._sccParseLizard(csv);
    assert.strictEqual(r.findings.length, 2, 'malformed row skipped');
    assert.strictEqual(r.findings[0].func, 'bar'); assert.strictEqual(r.findings[0].ccn, 60, 'sorted by CCN desc');
    assert.strictEqual(r.findings[0].file, 'src/b.js', 'file extracted from location, not the trailing columns');
    assert.strictEqual(r.findings[0].nloc, 40);
    assert.ok(/over CCN 15/.test(r.summary));
}
// ── tool install commands ───────────────────────────────────────────────────
assert.strictEqual(S._sccToolInstallCmd('dup', ''), 'npm install -g jscpd');
assert.ok(S._sccToolInstallCmd('fn', '').includes('lizard') && S._sccToolInstallCmd('fn', '').includes('pip'), 'lizard via pip');
{
    const c = S._sccToolInstallCmd('secrets', '');
    assert.ok(c.includes('gitleaks/gitleaks') && c.includes('/usr/local/bin/gitleaks') && c.includes('tar xzf'), 'gitleaks: github tarball → /usr/local/bin');
    const o = S._sccToolInstallCmd('deps', '');
    assert.ok(o.includes('google/osv-scanner') && o.includes('/usr/local/bin/osv-scanner') && !o.includes('tar xzf'), 'osv-scanner: bare binary');
}

// generic table sort (used by all non-language tables)
{
    const rows = [{ file: 'b.js', ccn: 5 }, { file: 'a.js', ccn: 30 }, { file: 'c.js', ccn: 12 }];
    assert.deepStrictEqual(S._sccApplySort(rows, { col: 'ccn', dir: 'desc' }).map(r => r.ccn), [30, 12, 5], 'numeric desc');
    assert.deepStrictEqual(S._sccApplySort(rows, { col: 'ccn', dir: 'asc' }).map(r => r.ccn), [5, 12, 30], 'numeric asc');
    assert.deepStrictEqual(S._sccApplySort(rows, { col: 'file', dir: 'asc' }).map(r => r.file), ['a.js', 'b.js', 'c.js'], 'string asc');
    assert.strictEqual(S._sccApplySort(rows, null).length, 3, 'no sort → copy unchanged');
    // aiSccSortBy toggles direction and picks a sensible default per column type
    const sess = { scc: { sorts: {}, table: {}, cx: {}, hot: {}, cov: {}, todo: {}, tools: {} } };
    // stub _sccEnsure via the object itself already having scc
    S.aiSccSortBy.call(Object.assign(Object.create(S), { _sccEnsure: () => sess.scc }), sess, 'cx', 'complexity');
    assert.strictEqual(sess.scc.sorts.cx.col, 'complexity'); assert.strictEqual(sess.scc.sorts.cx.dir, 'desc', 'numeric col → desc first');
    S.aiSccSortBy.call(Object.assign(Object.create(S), { _sccEnsure: () => sess.scc }), sess, 'cx', 'complexity');
    assert.strictEqual(sess.scc.sorts.cx.dir, 'asc', 'second click toggles to asc');
    S.aiSccSortBy.call(Object.assign(Object.create(S), { _sccEnsure: () => sess.scc }), sess, 'cx', 'filename');
    assert.strictEqual(sess.scc.sorts.cx.dir, 'asc', 'text col → asc first');
}

// inline repo panel (Diff + Census on a git-repo dir tab)
{
    // paneSession: agent tab → active AI session; dir tab → the synthetic repoPane
    const agentSess = { id: 'a1' };
    const ctx = Object.assign(Object.create(S), {
        activePane: (t) => t,
        aiActiveSession: () => agentSess,
        _sccEnsure: (s) => { S._sccEnsure(s); },   // real, to attach .scc
        aiSccOpen: () => { ctx._opened = true; },
    });
    assert.strictEqual(S.paneSession.call(ctx, null), null, 'no tab → null');
    assert.strictEqual(S.paneSession.call(ctx, { kind: 'agent' }), agentSess, 'agent tab → active session');

    // _repoPaneEnsure: only for dir tabs; builds a diff + scc-bearing session once
    assert.strictEqual(S._repoPaneEnsure.call(ctx, { kind: 'agent' }), null, 'non-dir → null');
    const dirTab = { id: 't9', kind: 'dir', path: '/repo/sub' };
    const pane = S._repoPaneEnsure.call(ctx, dirTab);
    assert.ok(pane && pane.diff && pane.scc, 'repoPane has diff + scc');
    assert.strictEqual(pane.dir, '/repo/sub', 'roots at the active pane path');
    assert.strictEqual(pane.diff.mode, 'all', 'diff starts in all mode');
    assert.strictEqual(S._repoPaneEnsure.call(ctx, dirTab), pane, 'memoized — same instance on re-ensure');
    assert.strictEqual(S.paneSession.call(ctx, dirTab), pane, 'dir tab → its repoPane');
    assert.strictEqual(S.aiSccActive.call(ctx, dirTab), pane, 'aiSccActive resolves to paneSession');
    // _sccRoot reads the pane dir (diff.root still empty) so census targets the repo
    assert.strictEqual(S._sccRoot(pane), '/repo/sub', 'census root = pane dir until diff resolves');

    // aiRepoSetView('census') ensures the pane and opens scc
    ctx._opened = false;
    S.aiRepoSetView.call(ctx, dirTab, 'census');
    assert.strictEqual(dirTab.repoView, 'census'); assert.ok(ctx._opened, 'census view opens scc');
}

// _sccAbsFile: resolve a table's file path against the census root for 👁/✎
{
    sb.Util = { joinPath: (a, b) => String(a).replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '') };
    const rootCtx = Object.assign(Object.create(S), { _sccRoot: () => '/home/ismet/repo' });
    assert.strictEqual(S._sccAbsFile.call(rootCtx, {}, 'js/app.js'), '/home/ismet/repo/js/app.js', 'root-relative → joined');
    assert.strictEqual(S._sccAbsFile.call(rootCtx, {}, './src/a.c'), '/home/ismet/repo/src/a.c', 'leading ./ stripped');
    assert.strictEqual(S._sccAbsFile.call(rootCtx, {}, '/etc/hosts'), '/etc/hosts', 'absolute path passes through');
    assert.strictEqual(S._sccAbsFile.call(rootCtx, {}, ''), '', 'empty → empty');
    assert.strictEqual(S._sccAbsFile.call(rootCtx, {}, '?'), '', 'placeholder ? → empty');
}

// _sccResetAnalyses invalidates an in-flight analysis: a slow response from the
// OLD repo must not publish into the NEW repo's pane (codex 4.0→4.2 round 2).
{
    let release;
    const ctx = Object.assign(Object.create(S), { _sccRun: () => new Promise(r => { release = r; }), _sccDisposeSession() {} });
    const s = { dir: '/A' }; S._sccEnsure(s); s.scc.installed = true;
    const p = ctx.aiSccRefreshTable(s);          // starts, awaiting the stubbed _sccRun
    s.dir = '/B'; ctx._sccResetAnalyses(s);       // repo changed → bump generations
    release([{ Name: 'A-only', Count: 1, Lines: 12, Blank: 0, Comment: 0, Code: 12, Complexity: 0, Files: [] }]);
    await p;
    assert.strictEqual(s.scc.table.rows.length, 0, 'stale table result must not publish after reset');
    assert.strictEqual(s.scc.table.loading, false, 'reset clears the loading flag');
}

// _repoPaneReconcile: overlapping lookups on rapid navigation — the OLDER
// rev-parse finishing last must NOT re-root the panel to the previous repo.
{
    const pending = {};
    sb.cockpit = { spawn: (argv) => new Promise(res => { pending[argv[2]] = res; }) };   // argv[2] = the -C dir
    const tab = { kind: 'dir', repoPanelOpen: true, path: '/A', repoView: 'diff', repoPane: { dir: '/orig', diff: {} } };
    const ctx = Object.assign(Object.create(S), { activePane: (t) => t, _sccResetAnalyses() {}, aiRefreshDiff() {}, aiSccOpen() {} });
    const a1 = ctx._repoPaneReconcile(tab);       // here = '/A', generation 1
    tab.path = '/B';
    const b1 = ctx._repoPaneReconcile(tab);       // here = '/B', generation 2 (newest)
    pending['/B']('/B'); await b1;                 // newest resolves → re-roots to /B
    pending['/A']('/A'); await a1;                 // older resolves late → superseded, ignored
    assert.strictEqual(tab.repoPane.dir, '/B', 'a superseded reconcile must not re-root to the previous repo');
}

// _sccArgs: scc invocation argv, with/without --by-file
{
    assert.deepStrictEqual([...S._sccArgs(false)], ['scc', '--format', 'json', '.']);
    assert.deepStrictEqual([...S._sccArgs(true)], ['scc', '--format', 'json', '--by-file', '.']);
}

// _sccListFor: maps a sub-pane key to its rows; null session and unknown key → []
{
    assert.deepStrictEqual([...S._sccListFor(null, 'cx')], []);
    const sess = {};
    S._sccEnsure(sess);
    sess.scc.cx.top = [{ filename: 'a' }];
    sess.scc.tools.secrets.findings = [{ file: 'x' }, { file: 'y' }];
    assert.strictEqual(S._sccListFor(sess, 'cx').length, 1);
    assert.strictEqual(S._sccListFor(sess, 'secrets').length, 2);
    assert.deepStrictEqual([...S._sccListFor(sess, 'nope')], [], 'unknown key → []');
}

// _sccToolFindingsSummary: only tools that actually ran appear, with their counts
{
    const sess = {}; S._sccEnsure(sess);
    sess.scc.tools.secrets.ranAt = 123; sess.scc.tools.secrets.findings = [{}, {}]; sess.scc.tools.secrets.summary = '2 potential secrets';
    // deps never ran (ranAt 0) → excluded
    const out = S._sccToolFindingsSummary(sess.scc);
    assert.ok(out.secrets && out.secrets.count === 2, 'ran tool included with count');
    assert.strictEqual(out.deps, undefined, 'a tool that never ran is omitted');
}

// _sccInsights: each narrative paragraph is gated on its own data being present
{
    const total = { code: 1000, complexity: 300 };
    const rows = [{ name: 'JavaScript', code: 800, kind: '' }, { name: 'JSON', code: 200, kind: 'data' }];
    const hotspots = [{ filename: 'big.js', complexity: 120, code: 400 }];
    const risk = [{ filename: 'hot.js', churn: 40, complexity: 90 }];
    const full = S._sccInsights(total, rows, hotspots, 800, 200, risk);
    assert.strictEqual(full.length, 4, 'all four insights when every input is present');
    assert.ok(/risk/i.test(full[0].title));
    // none of the optional inputs → only the "largest language" insight (rows[0] present)
    const some = S._sccInsights(total, rows, [], 1000, 0, []);
    assert.strictEqual(some.length, 1, 'no data/hotspots/risk → just the language insight');
    // truly empty → no insights
    assert.strictEqual(S._sccInsights({ code: 0 }, [], [], 0, 0, []).length, 0);
}

// _sccReportData: risk bands + file-size buckets from per-file scc data
{
    const table = {
        rows: [{ name: 'Go', code: 900, kind: '' }, { name: 'JSON', code: 100, kind: 'data' }],
        total: { files: 5, lines: 1200, code: 1000, comments: 100, complexity: 250 },
    };
    const files = [
        { filename: 'a.go', code: 30, complexity: 0, bytes: 400 },     // band none, size b1
        { filename: 'b.go', code: 80, complexity: 8, bytes: 900 },     // band low, size b2
        { filename: 'c.go', code: 150, complexity: 18, bytes: 3000 },  // band moderate, size b3
        { filename: 'd.go', code: 300, complexity: 45, bytes: 6000 },  // band high, size b4
        { filename: 'e.go', code: 900, complexity: 130, bytes: 90000 },// band extreme, size b6
    ];
    const d = S._sccReportData(table, files, { title: 'Explorer' }, [], {});
    assert.strictEqual(d.title, 'Explorer');
    assert.strictEqual(d.totals.files, 5);
    assert.strictEqual(d.totals.languages, 2);
    assert.strictEqual(d.totals.cxPerKloc, Math.round(250 * 1000 / 1000), 'cx/kloc from totals');
    assert.strictEqual(d.riskBands.none, 1); assert.strictEqual(d.riskBands.low, 1);
    assert.strictEqual(d.riskBands.moderate, 1); assert.strictEqual(d.riskBands.high, 1);
    assert.strictEqual(d.riskBands.extreme, 1);
    assert.strictEqual(d.sizeBuckets.b1, 1); assert.strictEqual(d.sizeBuckets.b6, 1);
    assert.ok(Array.isArray(d.insights), 'insights computed as part of report data');
    assert.strictEqual(d.totals.bytes, 400 + 900 + 3000 + 6000 + 90000, 'bytes summed across files');
    // empty input must not divide-by-zero
    const e = S._sccReportData({ rows: [], total: {} }, [], null, [], {});
    assert.strictEqual(e.totals.cxPerKloc, 0);
}

// aiSccReport must ALWAYS clear scc.reporting — otherwise the Report button
// stays disabled forever. Covers dialog-cancel and an analysis that throws.
{
    const mk = () => { const s = {}; S._sccEnsure(s); s.scc.installed = true;
        // pretend every analysis already ran so none re-run on the happy paths
        s.scc.table.ranAt = s.scc.cx.ranAt = s.scc.hot.ranAt = s.scc.cov.ranAt = s.scc.todo.ranAt = 1;
        return s; };
    const base = {
        _sccEnsure: (x) => x.scc, _sccRoot: () => '/x', toast() {}, _sccSaveAnalyses() {},
        aiSccRefreshTable() {}, aiSccRefreshComplexity() {}, aiSccRefreshHotspots() {},
        aiSccRefreshCoverage() {}, aiSccRefreshTodos() {},
    };
    // 1) user dismisses the folder picker → reporting cleared
    {
        const s = mk();
        const ctx = Object.assign(Object.create(S), base, { askDirectory: () => Promise.resolve(null) });
        await S.aiSccReport.call(ctx, s);
        assert.strictEqual(s.scc.reporting, false, 'dialog cancel clears reporting');
    }
    // 2) an analysis throws → reporting still cleared (was the stuck-disabled bug)
    {
        const s = mk(); s.scc.cx.ranAt = 0;   // force complexity to run
        const ctx = Object.assign(Object.create(S), base, {
            aiSccRefreshComplexity() { throw new Error('boom'); },
            askDirectory: () => Promise.resolve(null),
        });
        await S.aiSccReport.call(ctx, s);
        assert.strictEqual(s.scc.reporting, false, 'a thrown analysis must not leave reporting stuck true');
    }
    // 3) double-click while generating is ignored (no second run)
    {
        const s = mk(); s.scc.reporting = true;
        let dialogs = 0;
        const ctx = Object.assign(Object.create(S), base, { askDirectory: () => { dialogs++; return Promise.resolve(null); } });
        await S.aiSccReport.call(ctx, s);
        assert.strictEqual(dialogs, 0, 'a click while already reporting is ignored');
        assert.strictEqual(s.scc.reporting, true, 'the in-flight report keeps its own flag');
    }
}

// _sccInstallHint: the remaining distro branches (id and ID_LIKE fallbacks)
{
    assert.strictEqual(S._sccInstallHint('ID=manjaro').primary, 'sudo pacman -S scc', 'manjaro → pacman');
    assert.strictEqual(S._sccInstallHint('ID=linuxmint').primary, 'sudo snap install scc', 'mint → snap');
    assert.strictEqual(S._sccInstallHint('ID=raspbian').primary, 'sudo snap install scc', 'raspbian → snap');
    assert.ok(/go install/.test(S._sccInstallHint('ID=rocky').primary), 'rocky → go');
    assert.ok(/go install/.test(S._sccInstallHint('ID=almalinux').primary), 'almalinux → go');
    const suse = S._sccInstallHint('ID=opensuse-leap\nID_LIKE="suse opensuse"');
    assert.strictEqual(suse.label, 'openSUSE', 'opensuse → SUSE label');
    assert.ok(/go install/.test(S._sccInstallHint('ID=sles').primary), 'sles → go');
    // per-tool install commands: npm (jscpd) and pip (lizard) branches
    assert.strictEqual(S._sccToolInstallCmd('dup', ''), 'npm install -g jscpd', 'jscpd → npm -g');
    const fn = S._sccToolInstallCmd('fn', '');
    assert.ok(fn.includes('python3 -m pip install') && fn.includes('lizard') && fn.includes('--break-system-packages'),
        'lizard → python3 -m pip, PEP668-safe');
    assert.ok(fn.includes('--prefix=/usr/local'), 'pip install targets /usr/local (on PATH)');
    // turnkey install command for the same families
    assert.strictEqual(S._sccInstallCmd('ID=manjaro'), 'pacman -S --noconfirm scc');
    assert.ok(S._sccInstallCmd('ID=opensuse-tumbleweed\nID_LIKE=suse').includes('zypper')
        || S._sccInstallCmd('ID=opensuse-tumbleweed\nID_LIKE=suse').includes('releases/latest/download'),
        'suse install cmd is a package or a binary download');
}

// aiSccBusy: reports the ACTIVE sub-pane's loading flag
{
    assert.strictEqual(S.aiSccBusy(null), false, 'no session → not busy');
    const s = {}; S._sccEnsure(s);
    s.scc.sub = 'cx'; s.scc.cx.loading = true; assert.strictEqual(S.aiSccBusy(s), true, 'cx loading');
    s.scc.sub = 'hot'; assert.strictEqual(S.aiSccBusy(s), false, 'hot not loading');
    s.scc.sub = 'todo'; s.scc.todo.loading = true; assert.strictEqual(S.aiSccBusy(s), true, 'todo loading');
    s.scc.sub = 'secrets'; s.scc.tools.secrets.loading = true; assert.strictEqual(S.aiSccBusy(s), true, 'tool loading');
    s.scc.sub = 'table'; s.scc.table.loading = true; assert.strictEqual(S.aiSccBusy(s), true, 'table loading');
}

// aiSccRefreshActive: dispatches to the refresher for the active sub, then saves
{
    const calls = [];
    const mk = (sub) => { const s = {}; S._sccEnsure(s); s.scc.sub = sub; return s; };
    const ctx = Object.assign(Object.create(S), {
        aiSccRefreshComplexity() { calls.push('cx'); }, aiSccRefreshHotspots() { calls.push('hot'); },
        aiSccRefreshCoverage() { calls.push('cov'); }, aiSccRefreshTodos() { calls.push('todo'); },
        aiSccRunTool(_s, k) { calls.push('tool:' + k); }, aiSccRefreshTable() { calls.push('table'); },
        _sccSaveAnalyses() { calls.push('save'); },
    });
    for (const [sub, want] of [['cx', 'cx'], ['hot', 'hot'], ['cov', 'cov'], ['todo', 'todo'], ['deps', 'tool:deps'], ['table', 'table']]) {
        calls.length = 0;
        await ctx.aiSccRefreshActive(mk(sub));
        assert.deepStrictEqual([...calls], [want, 'save'], sub + ' → ' + want + ' then save');
    }
}

// JSON export helpers (per-table + export-all manifest)
{
    const s = {}; S._sccEnsure(s); const scc = s.scc;
    // nothing run yet → every table exports null, manifest empty
    assert.strictEqual(S._sccExportData(scc, 'table'), null, 'un-run table → null');
    assert.strictEqual(S._sccExportData(null, 'table'), null, 'no scc → null');
    assert.strictEqual(Object.keys(S._sccExportAll(scc)).length, 0, 'nothing run → empty manifest');
    assert.strictEqual(S.aiSccCanExport({ scc }), false, 'canExport false when active table un-run');

    // populate a couple of tables
    scc.table.ranAt = 1; scc.table.rows = [{ name: 'Go', code: 100 }]; scc.table.total = { code: 100, files: 2 };
    scc.cx.ranAt = 1; scc.cx.top = [{ filename: 'a.go', complexity: 12 }];
    scc.tools.secrets.ranAt = 1; scc.tools.secrets.findings = [{ file: 'x', line: 3 }]; scc.tools.secrets.summary = '1 potential secret';

    const td = S._sccExportData(scc, 'table');
    assert.strictEqual(td.table, 'languages'); assert.strictEqual(td.languages.length, 1); assert.strictEqual(td.total.code, 100);
    const cd = S._sccExportData(scc, 'cx');
    assert.strictEqual(cd.table, 'complexity'); assert.strictEqual(cd.files[0].filename, 'a.go');
    const sd = S._sccExportData(scc, 'secrets');
    assert.strictEqual(sd.table, 'secrets'); assert.strictEqual(sd.findings.length, 1);
    assert.strictEqual(S._sccExportData(scc, 'hot'), null, 'un-run hotspots still null');

    // manifest contains only the tables with data, keyed by friendly filename
    const man = S._sccExportAll(scc);
    assert.deepStrictEqual(Object.keys(man).sort(), ['census-complexity.json', 'census-languages.json', 'census-secrets.json']);
    assert.deepStrictEqual(JSON.parse(man['census-languages.json']).languages, [{ name: 'Go', code: 100 }], 'manifest holds valid pretty JSON');

    scc.sub = 'cx'; assert.strictEqual(S.aiSccCanExport({ scc }), true, 'canExport true when active table has data');
    scc.sub = 'hot'; assert.strictEqual(S.aiSccCanExport({ scc }), false, 'active un-run table → cannot export');
}

// _sccEnsure MUST initialize reporting/exporting to false (not leave them
// undefined): the Report/Zip :disabled bindings resolve to `undefined` when the
// flag is undefined, and Alpine sets a boolean attribute for undefined — which
// left the buttons wrongly disabled before any report/export ran.
{
    const s = {}; S._sccEnsure(s);
    assert.strictEqual(s.scc.reporting, false, 'reporting must start as boolean false, not undefined');
    assert.strictEqual(s.scc.exporting, false, 'exporting must start as boolean false, not undefined');
}

console.log('scc-unit: OK');
