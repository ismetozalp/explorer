import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
// Load utils.js into a sandbox that provides the `window` it assigns to.
const src = fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const U = sandbox.window.Util;
const f = (name) => ({ name, type: 'f' });

// PDF — the reported bug: a typeless blob makes Chrome's PDF viewer bail
// out to a download prompt instead of rendering inline.
assert.strictEqual(U.mimeType(f('doc.pdf')), 'application/pdf');
assert.strictEqual(U.mimeType(f('DOC.PDF')), 'application/pdf'); // case-insensitive

// Images — must match everything Util.isImage() recognises.
assert.strictEqual(U.mimeType(f('pic.png')), 'image/png');
assert.strictEqual(U.mimeType(f('pic.jpg')), 'image/jpeg');
assert.strictEqual(U.mimeType(f('pic.jpeg')), 'image/jpeg');
assert.strictEqual(U.mimeType(f('pic.gif')), 'image/gif');
assert.strictEqual(U.mimeType(f('pic.webp')), 'image/webp');
assert.strictEqual(U.mimeType(f('pic.bmp')), 'image/bmp');
assert.strictEqual(U.mimeType(f('pic.ico')), 'image/x-icon');
assert.strictEqual(U.mimeType(f('pic.avif')), 'image/avif');
assert.strictEqual(U.mimeType(f('pic.svg')), 'image/svg+xml');

// Audio — must match everything Util.isAudio() recognises.
assert.strictEqual(U.mimeType(f('song.mp3')), 'audio/mpeg');
assert.strictEqual(U.mimeType(f('song.wav')), 'audio/wav');
assert.strictEqual(U.mimeType(f('song.ogg')), 'audio/ogg');
assert.strictEqual(U.mimeType(f('song.flac')), 'audio/flac');
assert.strictEqual(U.mimeType(f('song.m4a')), 'audio/mp4');
assert.strictEqual(U.mimeType(f('song.aac')), 'audio/aac');
assert.strictEqual(U.mimeType(f('song.opus')), 'audio/opus');

// Natively-playable video — must match Util.isVideoNative(), not the wider
// Util.isVideo() (non-native containers go through the ffmpeg->HLS path and
// never become a plain blob: URL, so they don't need a MIME type here).
assert.strictEqual(U.mimeType(f('clip.mp4')), 'video/mp4');
assert.strictEqual(U.mimeType(f('clip.m4v')), 'video/mp4');
assert.strictEqual(U.mimeType(f('clip.webm')), 'video/webm');
assert.strictEqual(U.mimeType(f('clip.ogv')), 'video/ogg');

// Fallback: unknown / text / non-native-video extensions get '' — matches
// readBinaryAsBlob's default (untyped Blob) and is the correct behavior for
// text previews (rendered from string content, never a blob: URL).
assert.strictEqual(U.mimeType(f('movie.mkv')), '');
assert.strictEqual(U.mimeType(f('code.js')), '');
assert.strictEqual(U.mimeType(f('a.bin')), '');
assert.strictEqual(U.mimeType(f('noext')), '');
assert.strictEqual(U.mimeType(null), '');
assert.strictEqual(U.mimeType({}), '');

// Consistency check: every isImage/isAudio/isVideoNative/isPdf-recognised
// extension must resolve to a non-empty MIME type (guards against the two
// lists drifting apart in a future edit).
for (const name of ['png','jpg','jpeg','gif','webp','bmp','ico','avif','svg']) {
    assert.notStrictEqual(U.mimeType(f('x.' + name)), '', `image ext ${name} must have a MIME type`);
}
for (const name of ['mp3','wav','ogg','flac','m4a','aac','opus']) {
    assert.notStrictEqual(U.mimeType(f('x.' + name)), '', `audio ext ${name} must have a MIME type`);
}
for (const name of ['mp4','m4v','webm','ogv']) {
    assert.notStrictEqual(U.mimeType(f('x.' + name)), '', `native video ext ${name} must have a MIME type`);
}

console.log('mime-unit: OK');
