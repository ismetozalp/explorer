#!/usr/bin/env node
// Fails if any top-level object-literal key is defined in more than one of the
// component sources (app.js + js/features/*.js). A spread silently overwrites
// duplicates, so this is the safety net that replaces a test runner.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['js/app.js'];
const featDir = path.join(root, 'js/features');
if (fs.existsSync(featDir)) {
    for (const f of fs.readdirSync(featDir).sort()) if (f.endsWith('.js')) files.push('js/features/' + f);
}

// Collect member keys at 4-space indent (`name(...) {` or `name: value`), the
// one level of indentation the component's own members sit at inside both
// Alpine.data('explorer', () => ({ … })) and window.ExplorerX = { … }.
const seen = new Map(); // key -> [file,...]
const KEY = /^    (?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/;
for (const rel of files) {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const line of txt.split('\n')) {
        const m = KEY.exec(line);
        if (!m) continue;
        const k = m[1];
        if (!seen.has(k)) seen.set(k, []);
        const arr = seen.get(k);
        if (!arr.includes(rel)) arr.push(rel);
    }
}

const dups = [...seen].filter(([, fl]) => fl.length > 1);
if (dups.length) {
    console.error('Duplicate component keys (a spread would silently overwrite):');
    for (const [k, fl] of dups) console.error(`  ${k}: ${fl.join(', ')}`);
    process.exit(1);
}
console.log(`OK — ${seen.size} unique keys across ${files.length} file(s)`);
