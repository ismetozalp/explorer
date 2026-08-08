#!/usr/bin/env node
// Fails if any top-level object-literal key is defined in more than one of the
// component sources (app.js + js/features/*.js). A spread silently overwrites
// duplicates, so this is the safety net that replaces a test runner.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['js/app.js'];
for (const sub of ['js/features', 'js/core']) { const d = path.join(root, sub); if (fs.existsSync(d)) for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.js')) files.push(sub + '/' + f); }
const featDir = path.join(root, 'js/features');
// (features + core loaded above)

// Collect member keys at 4-space indent (`name(...) {` or `name: value`), the
// one level of indentation the component's own members sit at inside both
// Alpine.data('explorer', () => ({ … })) and window.ExplorerX = { … }.
const seen = new Map(); // key -> [file,...] (with repeats, so intra-file dups show)
const KEY = /^    (?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/;
for (const rel of files) {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const line of txt.split('\n')) {
        const m = KEY.exec(line);
        if (!m) continue;
        const k = m[1];
        if (!seen.has(k)) seen.set(k, []);
        seen.get(k).push(rel); // keep repeats: two defs in ONE file must be caught too
    }
}

// Cross-file: same key in ≥2 different files (a spread would silently overwrite).
// Intra-file: same key twice in ONE file — a duplicate object-literal key where the
// later definition silently shadows the earlier one (the 2.4.2 globalActions bug).
const cross = [], intra = [];
for (const [k, fl] of seen) {
    const uniq = [...new Set(fl)];
    if (uniq.length > 1) cross.push([k, uniq]);
    for (const f of uniq) { const n = fl.filter(x => x === f).length; if (n > 1) intra.push([k, f, n]); }
}
if (cross.length || intra.length) {
    if (cross.length) {
        console.error('Duplicate component keys across files (a spread would silently overwrite):');
        for (const [k, fl] of cross) console.error(`  ${k}: ${fl.join(', ')}`);
    }
    if (intra.length) {
        console.error('Duplicate keys within a single file (later definition silently shadows the earlier):');
        for (const [k, f, n] of intra) console.error(`  ${k}: ${f} (${n}×)`);
    }
    process.exit(1);
}
console.log(`OK — ${seen.size} unique keys across ${files.length} file(s)`);
