import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
// TextDecoder/TextEncoder are real platform globals present in every browser
// (unlike document/cockpit); node:vm's fresh context doesn't inherit Node's
// globals automatically, so they're supplied here to match what a page
// actually provides — the loader class calls `new TextDecoder()` at runtime.
const sandbox = { window: {}, console, TextDecoder, TextEncoder };
vm.runInNewContext(fs.readFileSync(new URL('../js/features/videoplayer.js', import.meta.url), 'utf8'), sandbox);
const V = sandbox.window.ExplorerVideo;

// codec args
// V lives in a separate vm realm (Array !== this realm's Array), so
// deepStrictEqual's identity-sensitive prototype check needs the array
// re-homed via Array.from() before comparing to a main-realm literal.
assert.deepStrictEqual(Array.from(V._vpVideoCodecArgs('copy')), ['-c:v', 'copy']);
assert.ok(V._vpVideoCodecArgs('x264').join(' ').includes('libx264'));

// probe decision
assert.strictEqual(V._vpProbeDecision([{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }]), 'copy');
assert.strictEqual(V._vpProbeDecision([{ codec_type: 'video', codec_name: 'hevc' }]), 'x264');
assert.strictEqual(V._vpProbeDecision([]), 'x264'); // unknown → transcode

// hls args (local file, no curl/url/live flags)
const args = V._vpBuildHlsArgs({ inputPath: '/m/a.mkv', dir: '/c/s', videoCodec: 'copy' });
const j = args.join(' ');
assert.ok(args.includes('-i') && args.includes('/m/a.mkv'));
assert.ok(j.includes('-c:v copy') && j.includes('-c:a aac'));
// Multichannel-audio regression guard: forced stereo downmix. Verified live
// against the user's 5.1-AC3-source file that omitting this produces
// 6-channel AAC, which Chromium's MSE rejects on every append (native
// SourceBuffer 'error' events, readyState stuck at HAVE_NOTHING forever).
assert.ok(j.includes('-ac 2'), 'must force a stereo downmix — multichannel AAC breaks MSE playback in Chromium');
assert.ok(j.includes('-hls_list_size 0') && j.includes('-f hls'));
// FIX A regression guard: `event`, not `vod` — verified live against the
// user's real files that `vod` makes this ffmpeg build (7.1.5) buffer the
// ENTIRE playlist in memory and never write index.m3u8 until the muxer
// closes (full completion or a kill signal), which starves FIX B's
// buffering wait for any file whose encode outlives the timeout. `event`
// writes incrementally (same timing as no tag at all) and still gets
// #EXT-X-ENDLIST once ffmpeg reaches EOF naturally. See the long comment on
// _vpBuildHlsArgs for the full trail (including why plain `vod` also
// wasn't buying anything: the vendored hls.js's `live` flag is driven only
// by #EXT-X-ENDLIST, never by the PLAYLIST-TYPE value).
assert.ok(j.includes('-hls_playlist_type event'), 'must tag the playlist so it is not read as an unbounded live feed, without breaking incremental writes');
assert.ok(!j.includes('-hls_playlist_type vod'), 'must NOT use vod — verified to defer the whole playlist write until ffmpeg exits on this host');
assert.ok(args[args.length - 1] === '/c/s/index.m3u8');
assert.ok(!j.includes('-reconnect') && !j.includes('m3u8 ') && !j.includes('-user_agent')); // no IPTV bits

// FIX B: playlist "enough buffered to start" decision
assert.strictEqual(V._vpPlaylistBuffered('', 30), false, 'empty/no playlist is never buffered');
assert.strictEqual(V._vpPlaylistBuffered(null, 30), false);
{
    // 3 segments * 7.048711s ≈ 21.1s — below the 30s target.
    const under = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:7.048711,\nseg_00000.ts\n#EXTINF:7.048711,\nseg_00001.ts\n#EXTINF:7.048711,\nseg_00002.ts\n';
    assert.strictEqual(V._vpPlaylistBuffered(under, 30), false, 'sum below target must not be considered buffered');
    // A 4th segment pushes the sum to ~28.2s — still under.
    const stillUnder = under + '#EXTINF:7.048711,\nseg_00003.ts\n';
    assert.strictEqual(V._vpPlaylistBuffered(stillUnder, 30), false);
    // A 5th segment pushes the sum to ~35.2s — over the target.
    const over = stillUnder + '#EXTINF:7.048711,\nseg_00004.ts\n';
    assert.strictEqual(V._vpPlaylistBuffered(over, 30), true, 'sum at/above target must be considered buffered');
    // #EXT-X-ENDLIST means ffmpeg is done — a short clip must attach even
    // though its total content never reaches the 30s target.
    const shortDone = '#EXTM3U\n#EXTINF:7.048711,\nseg_00000.ts\n#EXT-X-ENDLIST\n';
    assert.strictEqual(V._vpPlaylistBuffered(shortDone, 30), true, 'ENDLIST must attach immediately regardless of the sum');
    console.log('OK _vpPlaylistBuffered: under-target false, at/over-target true, ENDLIST always true');
}

// FIX D: duration formatter — H:MM:SS over an hour, M:SS under, '' when unusable
assert.strictEqual(V._vpFormatDuration(5741), '1:35:41');   // Mortal Kombat, real probed length
assert.strictEqual(V._vpFormatDuration(6239), '1:43:59');   // Invincible, real probed length
assert.strictEqual(V._vpFormatDuration(59), '0:59');
assert.strictEqual(V._vpFormatDuration(60), '1:00');
assert.strictEqual(V._vpFormatDuration(0), '');
assert.strictEqual(V._vpFormatDuration(-5), '');
assert.strictEqual(V._vpFormatDuration(null), '');
assert.strictEqual(V._vpFormatDuration(undefined), '');
assert.strictEqual(V._vpFormatDuration(NaN), '');
console.log('OK _vpFormatDuration: H:MM:SS / M:SS / empty-on-unusable');

// session paths
assert.strictEqual(V._vpCacheRoot('/home/u'), '/home/u/.cache/cockpit-explorer/preview');
assert.strictEqual(V._vpSessionDir('/r', 'sid'), '/r/sid');
assert.strictEqual(V._vpPlaylist('/r/sid'), '/r/sid/index.m3u8');
assert.strictEqual(V._vpSegPattern('/r/sid'), '/r/sid/seg_%05d.ts');
assert.strictEqual(V._vpSourceUrl('sid'), 'explorer-preview://sid/index.m3u8');
assert.strictEqual(V._vpFileName('explorer-preview://sid/seg_00007.ts?x=1'), 'seg_00007.ts');
assert.strictEqual(V._vpResolveInDir('/c/sid', 'explorer-preview://sid/seg_00007.ts'), '/c/sid/seg_00007.ts');

// pkg-manager mapping
const osr = (id, like) => `NAME="x"\nID=${id}\n` + (like ? `ID_LIKE="${like}"\n` : '');
assert.ok(V._pkgInstallCommand(osr('ubuntu')).includes('apt-get install -y ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('debian')).includes('apt-get install -y ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('linuxmint', 'ubuntu debian')).includes('apt-get'));
assert.ok(V._pkgInstallCommand(osr('fedora')).includes('dnf install -y ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('rocky', 'rhel centos fedora')).includes('dnf install -y ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('arch')).includes('pacman -S --noconfirm ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('opensuse-leap', 'suse')).includes('zypper install -y ffmpeg'));
assert.ok(V._pkgInstallCommand(osr('alpine')).includes('apk add ffmpeg'));
assert.strictEqual(V._pkgInstallCommand('ID=plan9\n'), null);

// loader class: reads bytes, resolves path, ArrayBuffer vs text
(async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const Loader = V._vpLoaderClass(async (p) => (p.endsWith('index.m3u8') ? enc('#EXTM3U') : new Uint8Array([1,2,3])),
                                  (u) => '/c/sid/' + V._vpFileName(u));
  const l = new Loader();
  const out = {};
  l.load({ url: 'explorer-preview://sid/index.m3u8', responseType: '' }, {}, {
    onSuccess: (r) => { out.text = r.data; }, onError: () => { out.err = true; },
  });
  // readFile() is a main-realm promise being adopted by the vm-realm's
  // Promise.resolve() inside the loader (cross-realm thenable adoption
  // costs an extra microtask tick vs. same-realm code, which is all a real
  // browser page ever runs) — a macrotask flush is a robust way to wait for
  // it out rather than hard-coding a tick count.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(typeof out.text, 'string');
  assert.ok(out.text.includes('#EXTM3U'));
  console.log('videoplayer-unit: OK');
})();
