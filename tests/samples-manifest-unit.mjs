// Pins tests/samples/ (the committed previewable-fixture set) against the
// actual preview-kind detectors in js/utils.js. Pure node + vm, no browser —
// this is the fast "did the fixture set drift, or did a detector regress"
// guard that samples-preview-e2e.mjs then exercises for real in the UI.
//
// Two independent things are asserted per file:
//   1. The fixture set itself is exactly what's expected (deepStrictEqual
//      against a hand-maintained manifest) — catches an accidental add/
//      remove/rename under tests/samples/ going unnoticed.
//   2. Util's detectors classify each fixture into the SAME preview group
//      the manifest says it belongs to — catches a detector regression
//      (e.g. an extension silently dropped from isVideo()'s allowlist).
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(__dirname, 'samples');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const U = sandbox.window.Util;
const f = (name) => ({ name, type: 'f' });

function listFiles(dir, base) {
    base = base || '';
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = base ? base + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

const files = listFiles(SAMPLES).sort();

// group: 'image' | 'pdf' | 'docx' | 'spreadsheet' | 'markdown' | 'audio' |
//        'video-native' (browser <video> decodes directly) |
//        'video-ffmpeg' (needs the ffmpeg->HLS transcode/remux path) |
//        'text' (syntax-highlighted code/text preview)
const GROUPS = {
    '.gitignore': 'text',
    'Makefile': 'text',
    'README.md': 'markdown',
    'sample.avif': 'image', 'sample.bmp': 'image', 'sample.gif': 'image', 'sample.ico': 'image',
    'sample.jpeg': 'image', 'sample.jpg': 'image', 'sample.png': 'image', 'sample.svg': 'image', 'sample.webp': 'image',
    'sample.pdf': 'pdf',
    'sample.docx': 'docx',
    'sample.xlsx': 'spreadsheet', 'sample.ods': 'spreadsheet', 'sample.csv': 'spreadsheet',
    'sample.md': 'markdown', 'sample.markdown': 'markdown',
    'sample.conf': 'text', 'sample.css': 'text', 'sample.html': 'text', 'sample.ini': 'text',
    'sample.js': 'text', 'sample.json': 'text', 'sample.log': 'text', 'sample.py': 'text',
    'sample.sh': 'text', 'sample.sql': 'text', 'sample.ts': 'text', 'sample.txt': 'text',
    'sample.xml': 'text', 'sample.yaml': 'text', 'sample.yml': 'text',
    'audio/sample.aac': 'audio', 'audio/sample.flac': 'audio', 'audio/sample.m4a': 'audio',
    'audio/sample.mp3': 'audio', 'audio/sample.ogg': 'audio', 'audio/sample.opus': 'audio', 'audio/sample.wav': 'audio',
    'video/sample.mp4': 'video-native', 'video/sample.webm': 'video-native', 'video/sample.m4v': 'video-native',
    'video/sample.mkv': 'video-ffmpeg', 'video/sample.mov': 'video-ffmpeg', 'video/sample.avi': 'video-ffmpeg',
    'video/sample.wmv': 'video-ffmpeg', 'video/sample.flv': 'video-ffmpeg', 'video/sample.mpg': 'video-ffmpeg',
    'video/sample.mpeg': 'video-ffmpeg', 'video/sample.m2ts': 'video-ffmpeg', 'video/sample.mts': 'video-ffmpeg',
    'video/sample.3gp': 'video-ffmpeg', 'video/sample.ogm': 'video-ffmpeg', 'video/sample.ogv': 'video-ffmpeg',
    'video/sample.divx': 'video-ffmpeg', 'video/sample.vob': 'video-ffmpeg', 'video/sample.asf': 'video-ffmpeg',
    'video/sample.rm': 'video-ffmpeg',
};

const expectedFiles = Object.keys(GROUPS).sort();
assert.deepStrictEqual(files, expectedFiles,
    `tests/samples/ drifted from the expected fixture manifest\n  found:    ${JSON.stringify(files)}\n  expected: ${JSON.stringify(expectedFiles)}`);
assert.strictEqual(files.length, 60, `expected exactly 60 sample files, found ${files.length}`);

for (const rel of files) {
    const file = f(path.basename(rel));
    const group = GROUPS[rel];
    assert.ok(U.isPreviewable(file), `${rel}: Util.isPreviewable should be true`);
    switch (group) {
        case 'image':
            assert.ok(U.isImage(file), `${rel}: Util.isImage should be true`);
            break;
        case 'pdf':
            assert.ok(U.isPdf(file), `${rel}: Util.isPdf should be true`);
            break;
        case 'docx':
            assert.ok(U.isDocx(file), `${rel}: Util.isDocx should be true`);
            break;
        case 'spreadsheet':
            assert.ok(U.isSpreadsheet(file), `${rel}: Util.isSpreadsheet should be true`);
            break;
        case 'markdown':
            assert.ok(U.isMarkdown(file), `${rel}: Util.isMarkdown should be true`);
            break;
        case 'audio':
            assert.ok(U.isAudio(file), `${rel}: Util.isAudio should be true`);
            break;
        case 'video-native':
            assert.ok(U.isVideo(file), `${rel}: Util.isVideo should be true`);
            assert.ok(U.isVideoNative(file), `${rel}: Util.isVideoNative should be true (native <video>)`);
            break;
        case 'video-ffmpeg':
            assert.ok(U.isVideo(file), `${rel}: Util.isVideo should be true`);
            assert.ok(!U.isVideoNative(file), `${rel}: Util.isVideoNative should be false (needs ffmpeg->HLS)`);
            break;
        case 'text':
            assert.ok(U.isTextLike(file), `${rel}: Util.isTextLike should be true`);
            break;
        default:
            assert.fail(`unhandled group "${group}" for ${rel}`);
    }
}

// A few named regression pins, so a future edit here can't quietly widen the
// switch above into a no-op: these are the exact fixtures the e2e/smoke
// suites key off of.
assert.ok(U.isVideoNative(f('sample.mp4')) && GROUPS['video/sample.mp4'] === 'video-native', 'mp4 must stay the native-video fixture');
assert.ok(!U.isVideoNative(f('sample.ogv')) && U.isVideo(f('sample.ogv')), 'ogv must stay routed through ffmpeg (3.1.6 black-picture regression)');
assert.ok(U.isSpreadsheet(f('sample.csv')), 'csv must route to the spreadsheet renderer, not plain text');

console.log(`samples-manifest-unit: OK — ${files.length} sample files present under tests/samples/ and correctly classified`);
