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
// NOTE: 'ts' is deliberately excluded — see the .ts regression guard below
// (fix round 2).
// 'ogv' joined this group in 3.1.6 (fix round 3): it almost always carries
// Theora video, which modern Chrome can no longer decode — see the
// isVideoNative() comment in js/utils.js for the canPlayType() evidence.
// It sits alongside 'ogm' (already here, same underlying codec risk).
for (const name of ['clip.avi', 'clip.wmv', 'clip.flv', 'clip.m4v',
                     'clip.mpg', 'clip.mpeg', 'clip.m2ts', 'clip.mts', 'clip.3gp',
                     'clip.ogm', 'clip.ogv', 'clip.divx', 'clip.vob', 'clip.asf', 'clip.rm', 'clip.rmvb']) {
    assert.strictEqual(U.isVideo(f(name)), true, `isVideo(${name}) should be true`);
    assert.strictEqual(U.isPreviewable(f(name)), true, `isPreviewable(${name}) should be true`);
    assert.strictEqual(U.isTextLike(f(name)), false, `isTextLike(${name}) should be false (excluded as video)`);
}
// m4v is BOTH natively playable AND in isVideo()'s allowlist (it always was
// native; isVideo() just needs to agree so it's previewable at all).
assert.strictEqual(U.isVideoNative(f('clip.m4v')), true);
// Everything else in the new list is non-native — ffmpeg is required.
for (const name of ['clip.avi', 'clip.wmv', 'clip.flv',
                     'clip.mpg', 'clip.mpeg', 'clip.m2ts', 'clip.mts', 'clip.3gp',
                     'clip.ogm', 'clip.ogv', 'clip.divx', 'clip.vob', 'clip.asf', 'clip.rm', 'clip.rmvb']) {
    assert.strictEqual(U.isVideoNative(f(name)), false, `isVideoNative(${name}) should be false`);
}
// Direct regression guard for the reported bug: a real .ogv sample played
// with working controls/audio but a permanently black picture, because
// Chrome's generic 'video/ogg' canPlayType() answers 'maybe' even though it
// cannot decode the Theora video track the container almost always holds.
// isVideoNative() must say false so the file is routed to the ffmpeg->HLS
// path instead of a bare <video src>.
assert.strictEqual(U.isVideoNative(f('sample.ogv')), false, '.ogv must not be treated as natively playable (Theora black-picture bug)');
assert.strictEqual(U.isVideo(f('sample.ogv')), true, '.ogv must still be handled as video (via ffmpeg)');
// Fix round 2 regression guard: a bare .ts is TypeScript source, not an
// MPEG transport stream — it must stay on the text/code preview path, not
// get swept into the video branch (isVideo() gates BEFORE isTextLike() at
// the routing point in js/features/editor.js).
assert.strictEqual(U.isVideo(f('app.ts')), false, 'app.ts must not be treated as video');
assert.strictEqual(U.isTextLike(f('app.ts')), true, 'app.ts must stay text-like (syntax-highlighted code preview)');
assert.strictEqual(U.isPreviewable(f('app.ts')), true, 'app.ts must still be previewable (as text)');
assert.strictEqual(U.isPreviewable(f('pic.png')), true);
assert.strictEqual(U.isPreviewable(f('README.md')), true);
assert.strictEqual(U.isPreviewable(f('song.mp3')), true);
assert.strictEqual(U.isPreviewable(f('doc.pdf')), true);
assert.strictEqual(U.isPreviewable(f('code.js')), true);    // text-like
assert.strictEqual(U.isPreviewable({ name: 'dir', type: 'd' }), false);
assert.strictEqual(U.isPreviewable(f('a.bin')), false);     // binary, not previewable
console.log('preview-detect-unit: OK');
