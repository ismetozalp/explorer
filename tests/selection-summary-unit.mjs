// Unit tests for ExplorerFileList.selectionSummary (js/core/filelist.js).
// Loads utils.js (for Util.humanSize) + filelist.js into one vm sandbox and
// calls the method on a stub `this`, same pattern as preview-load-race-unit.mjs.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8'), sandbox, { filename: new URL('../js/utils.js', import.meta.url).pathname });
sandbox.Util = sandbox.window.Util; // filelist.js refers to the bare global, same as in a real page
vm.runInNewContext(fs.readFileSync(new URL('../js/core/filelist.js', import.meta.url), 'utf8'), sandbox, { filename: new URL('../js/core/filelist.js', import.meta.url).pathname });
const FL = sandbox.window.ExplorerFileList;

// Builds a stub `this` exposing exactly what selectionSummary() calls:
// this.selectedFiles(tab) and this.currentPane(). Mirrors the real
// selectedFiles() behaviour (tab.selection paths -> tab.files entries).
function makeThis(tab) {
    return {
        selectedFiles(t) {
            t = t || tab;
            const m = new Map(t.files.map(f => [f.path, f]));
            return t.selection.map(p => m.get(p)).filter(Boolean);
        },
        currentPane() { return tab; },
    };
}

function summary(files, selectedPaths) {
    const tab = { files, selection: selectedPaths };
    return FL.selectionSummary.call(makeThis(tab), tab);
}

const file = (path, size) => ({ path, type: 'f', size });
const dir = (path) => ({ path, type: 'd', size: 0 });
const symlink = (path, size) => ({ path, type: 'l', size });

// ── Fixture: 5 total items (3 files, 2 folders) ─────────────────────────────
const allFiles = [
    file('/a.txt', 1000),
    file('/b.txt', 2000),
    dir('/dirA'),
    dir('/dirB'),
    symlink('/link', 500),
];

// 1. Files only (plural)
assert.strictEqual(
    summary(allFiles, ['/a.txt', '/b.txt']),
    '2 of 5 selected · 2 files · 2.9 KB'
);

// 2. Single file (singular)
assert.strictEqual(
    summary(allFiles, ['/a.txt']),
    '1 of 5 selected · 1 file · 1000 B'
);

// 3. Folders only (plural) — size omitted, not printed as "0 B"
assert.strictEqual(
    summary(allFiles, ['/dirA', '/dirB']),
    '2 of 5 selected · 2 folders'
);

// 4. Single folder (singular) — size omitted
assert.strictEqual(
    summary(allFiles, ['/dirA']),
    '1 of 5 selected · 1 folder'
);

// 5. Mixed files + folders
assert.strictEqual(
    summary(allFiles, ['/a.txt', '/dirA']),
    '2 of 5 selected · 1 file, 1 folder · 1000 B'
);

// 6. Symlink counted as a file in the breakdown (not folder, doesn't crash on
//    the 'l' type) — but per spec the size total only sums type === 'f'
//    (unchanged from the pre-existing behaviour), so a symlink-only
//    selection shows 0 B rather than the symlink's own size.
assert.strictEqual(
    summary(allFiles, ['/link']),
    '1 of 5 selected · 1 file · 0 B'
);

// 7. Symlink + regular file together => "2 files", and size only sums the
//    plain file ('f'), not the symlink ('l') — matches the existing
//    (pre-change) size-total behaviour of only counting type === 'f'.
assert.strictEqual(
    summary(allFiles, ['/a.txt', '/link']),
    '2 of 5 selected · 2 files · 1000 B'
);

// 8. Empty selection
assert.strictEqual(summary(allFiles, []), '0 of 5 selected');

// 9. Everything selected — size sums only the two plain files (3000 B); the
//    symlink's own size is excluded per the type === 'f' rule above.
assert.strictEqual(
    summary(allFiles, ['/a.txt', '/b.txt', '/dirA', '/dirB', '/link']),
    '5 of 5 selected · 3 files, 2 folders · 2.9 KB'
);

console.log('selection-summary-unit: OK');
