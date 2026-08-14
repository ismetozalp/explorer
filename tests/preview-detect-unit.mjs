import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
// Load utils.js into a sandbox that provides the `window` it assigns to.
const src = fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const U = sandbox.window.Util;
const f = (name) => ({ name, type: 'f' });

assert.strictEqual(U.isMarkdown(f('README.md')), true);
assert.strictEqual(U.isMarkdown(f('notes.markdown')), true);
assert.strictEqual(U.isMarkdown(f('a.txt')), false);
assert.strictEqual(U.isDocx(f('Report.DOCX')), true);
assert.strictEqual(U.isDocx(f('a.doc')), false);            // legacy .doc not supported
assert.strictEqual(U.isSpreadsheet(f('book.xlsx')), true);
assert.strictEqual(U.isSpreadsheet(f('data.csv')), true);
assert.strictEqual(U.isSpreadsheet(f('sheet.ods')), true);
assert.strictEqual(U.isSpreadsheet(f('x.xls')), true);
assert.strictEqual(U.isVideoNative(f('clip.mp4')), true);
assert.strictEqual(U.isVideoNative(f('clip.webm')), true);
assert.strictEqual(U.isVideoNative(f('movie.mkv')), false); // native<video> can't
assert.strictEqual(U.isVideo(f('movie.mkv')), true);        // but it IS a video
assert.strictEqual(U.isPreviewable(f('movie.mkv')), true);
// Non-native containers ffmpeg->HLS must handle (fix round 1, Task 7):
// isVideo() true (routes to the video/ffmpeg branch), isVideoNative() false
// (browser can't decode them directly), isPreviewable() true throughout.
for (const name of ['clip.avi', 'clip.wmv', 'clip.flv', 'clip.ts', 'clip.m4v',
                     'clip.mpg', 'clip.mpeg', 'clip.m2ts', 'clip.mts', 'clip.3gp',
                     'clip.ogm', 'clip.divx', 'clip.vob', 'clip.asf', 'clip.rm', 'clip.rmvb']) {
    assert.strictEqual(U.isVideo(f(name)), true, `isVideo(${name}) should be true`);
    assert.strictEqual(U.isPreviewable(f(name)), true, `isPreviewable(${name}) should be true`);
    assert.strictEqual(U.isTextLike(f(name)), false, `isTextLike(${name}) should be false (excluded as video)`);
}
// m4v is BOTH natively playable AND in isVideo()'s allowlist (it always was
// native; isVideo() just needs to agree so it's previewable at all).
assert.strictEqual(U.isVideoNative(f('clip.m4v')), true);
// Everything else in the new list is non-native — ffmpeg is required.
for (const name of ['clip.avi', 'clip.wmv', 'clip.flv', 'clip.ts',
                     'clip.mpg', 'clip.mpeg', 'clip.m2ts', 'clip.mts', 'clip.3gp',
                     'clip.ogm', 'clip.divx', 'clip.vob', 'clip.asf', 'clip.rm', 'clip.rmvb']) {
    assert.strictEqual(U.isVideoNative(f(name)), false, `isVideoNative(${name}) should be false`);
}
assert.strictEqual(U.isPreviewable(f('pic.png')), true);
assert.strictEqual(U.isPreviewable(f('README.md')), true);
assert.strictEqual(U.isPreviewable(f('song.mp3')), true);
assert.strictEqual(U.isPreviewable(f('doc.pdf')), true);
assert.strictEqual(U.isPreviewable(f('code.js')), true);    // text-like
assert.strictEqual(U.isPreviewable({ name: 'dir', type: 'd' }), false);
assert.strictEqual(U.isPreviewable(f('a.bin')), false);     // binary, not previewable
console.log('preview-detect-unit: OK');
