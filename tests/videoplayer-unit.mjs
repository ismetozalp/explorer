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

// ─────────────────────────────────────────────────────────────────────────
// 3.1.0 seek support — the pure parts.
// ─────────────────────────────────────────────────────────────────────────

// (1) ffmpeg argv: forced keyframes on the transcode path only, and the
// restart triple (-ss before -i, -start_number, -output_ts_offset).
{
    const SEG = V._vpSegSecs;
    assert.strictEqual(typeof SEG, 'number');
    const x264 = V._vpBuildHlsArgs({ inputPath: '/m/a.avi', dir: '/c/s', videoCodec: 'x264' });
    const jx = x264.join(' ');
    assert.ok(jx.includes('-force_key_frames expr:gte(t,n_forced*' + SEG + ')'),
        'the transcode path must force keyframes on the segment grid — without it segments are GOP-length and index→time is unknowable');
    assert.ok(jx.includes('-hls_time ' + SEG), 'hls_time must come from the same constant as the keyframe expression');
    // Remux is explicitly out of scope: -c:v copy has no encoder to force
    // keyframes on, so its segments stay irregular and it keeps 3.0.x behaviour.
    const copy = V._vpBuildHlsArgs({ inputPath: '/m/a.mkv', dir: '/c/s', videoCodec: 'copy' }).join(' ');
    assert.ok(!copy.includes('-force_key_frames'), 'the remux path must NOT force keyframes (there is no encoder)');
    // No restart flags on a normal (index 0) run.
    assert.ok(!jx.includes('-start_number') && !jx.includes('-output_ts_offset') && !jx.includes('-ss'),
        'the initial run must not carry restart flags');

    const r = V._vpBuildHlsArgs({ inputPath: '/m/a.avi', dir: '/c/s', videoCodec: 'x264', startIndex: 1200 });
    const t = String(1200 * SEG);
    assert.ok(r.indexOf('-ss') !== -1 && r.indexOf('-ss') < r.indexOf('-i'),
        '-ss must precede -i (input-side fast seek) — after -i it decodes the whole file up to the point');
    assert.strictEqual(r[r.indexOf('-ss') + 1], t);
    assert.strictEqual(r[r.indexOf('-start_number') + 1], '1200', 'the restart must write seg_01200.ts onward');
    assert.strictEqual(r[r.indexOf('-output_ts_offset') + 1], t, 'restarted output must stay on the global timeline');
    assert.strictEqual(r[r.length - 1], '/c/s/index.m3u8', 'restart writes into the SAME session dir');
    console.log('OK seek argv: force_key_frames (x264 only) + -ss/-start_number/-output_ts_offset at ' + t + 's');
}

// (2) time ↔ segment index mapping
{
    const SEG = V._vpSegSecs;
    assert.strictEqual(V._vpSegStartTime(0), 0);
    assert.strictEqual(V._vpSegStartTime(1200), 1200 * SEG);
    assert.strictEqual(V._vpSegIndexForTime(0), 0);
    assert.strictEqual(V._vpSegIndexForTime(SEG - 0.001), 0, 'just before the boundary is still segment 0');
    assert.strictEqual(V._vpSegIndexForTime(SEG), 1, 'the boundary itself starts the next segment');
    assert.strictEqual(V._vpSegIndexForTime(4800), Math.floor(4800 / SEG));
    assert.strictEqual(V._vpSegIndexForTime(-5), 0);
    assert.strictEqual(V._vpSegIndexForTime(NaN), 0);
    // Round trip: the start time of the segment holding t is never after t.
    for (const t of [0, 3.9, 4, 100, 4800, 6238.9]) {
        const k = V._vpSegIndexForTime(t);
        assert.ok(V._vpSegStartTime(k) <= t && V._vpSegStartTime(k + 1) > t, 'segment ' + k + ' must contain t=' + t);
    }
    assert.strictEqual(V._vpSegName(0), 'seg_00000.ts');
    assert.strictEqual(V._vpSegName(1200), 'seg_01200.ts', 'name must match ffmpeg -hls_segment_filename seg_%05d.ts');
    assert.strictEqual(V._vpSegIndexFromName('seg_01200.ts'), 1200);
    assert.strictEqual(V._vpSegIndexFromName('index.m3u8'), null);
    assert.strictEqual(V._vpSegIndexFromName('seg_01200.ts.tmp'), null);
    assert.strictEqual(V._vpSegIndexFromName(''), null);
    console.log('OK time↔segment mapping: t=4800 → ' + V._vpSegIndexForTime(4800) + ' → ' + V._vpSegName(V._vpSegIndexForTime(4800)));
}

// (3) the synthetic VOD playlist generator
{
    const SEG = V._vpSegSecs;
    // Unknown/unusable duration → null (caller falls back to ffmpeg's playlist).
    for (const bad of [0, -1, null, undefined, NaN, Infinity, '600'])
        assert.strictEqual(V._vpBuildVodPlaylist(bad), null, 'unusable duration ' + String(bad) + ' must not produce a playlist');
    assert.strictEqual(V._vpSegCount(0), 0);
    assert.strictEqual(V._vpSegCount(null), 0);

    // A duration that divides exactly: 40s / 4s = 10 whole segments.
    const exact = V._vpBuildVodPlaylist(10 * SEG);
    const exactSegs = exact.match(/^seg_\d+\.ts$/gm) || [];
    const exactInf = (exact.match(/#EXTINF:([0-9.]+)/g) || []).map((s) => parseFloat(s.split(':')[1]));
    assert.strictEqual(exactSegs.length, 10, 'an exactly-dividing duration must not produce a spurious 11th segment');
    assert.strictEqual(exactInf.length, 10);
    assert.strictEqual(exactInf[9], SEG, 'the last segment of an exact division is a FULL segment, not a 0-length one');
    assert.ok(Math.abs(exactInf.reduce((a, b) => a + b, 0) - 10 * SEG) < 1e-6, 'summed #EXTINF must equal the duration');

    // A duration that does not divide: the ~1h44m sample used for live
    // verification (6239.024s). 6239.024/4 → 1560 segments, last one short.
    const D = 6239.024;
    const pl = V._vpBuildVodPlaylist(D);
    const n = Math.ceil(D / SEG);
    assert.strictEqual(n, 1560);
    const segs = pl.match(/^seg_\d+\.ts$/gm) || [];
    const infs = (pl.match(/#EXTINF:([0-9.]+)/g) || []).map((s) => parseFloat(s.split(':')[1]));
    assert.strictEqual(segs.length, n, 'one entry per segment for k = 0..N-1');
    assert.strictEqual(infs.length, n, 'every segment entry must carry its own #EXTINF');
    assert.strictEqual(segs[0], 'seg_00000.ts');
    assert.strictEqual(segs[n - 1], V._vpSegName(n - 1));
    assert.ok(Math.abs(infs[n - 1] - (D - (n - 1) * SEG)) < 1e-6,
        'the last #EXTINF must be the remainder (' + (D - (n - 1) * SEG).toFixed(3) + 's), not a full segment');
    for (let i = 0; i < n - 1; i++) assert.strictEqual(infs[i], SEG, 'every non-final #EXTINF must be exactly one segment');
    assert.ok(Math.abs(infs.reduce((a, b) => a + b, 0) - D) < 1e-6,
        'summed #EXTINF must equal the probed duration — this IS the duration the player shows');

    // Tags: without VOD + ENDLIST hls.js treats the level as live and refuses
    // to seek past what it has seen (the whole bug this feature fixes).
    assert.ok(pl.startsWith('#EXTM3U'), 'must start with #EXTM3U');
    assert.ok(pl.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'must be tagged VOD');
    assert.ok(/#EXT-X-ENDLIST\s*$/.test(pl), 'must be closed with #EXT-X-ENDLIST — hls.js drives its `live` flag off this tag alone');
    const target = parseInt(/#EXT-X-TARGETDURATION:(\d+)/.exec(pl)[1], 10);
    assert.ok(target >= Math.max(...infs), 'TARGETDURATION (' + target + ') must be >= the longest #EXTINF');
    assert.ok(pl.indexOf('#EXT-X-ENDLIST') > pl.lastIndexOf('seg_'), 'ENDLIST must come after every segment');
    console.log('OK VOD playlist: ' + n + ' segments for ' + D + 's, last #EXTINF=' + infs[n - 1].toFixed(3) + 's, TARGETDURATION=' + target + ', VOD+ENDLIST present');
}

// (4) the wait-vs-restart decision
{
    const TOL = V._vpSegAheadTolerance;
    // Ready on disk (this run's or an earlier run's — same timeline) → serve.
    assert.strictEqual(V._vpSegAction({ ready: true, index: 5, runStart: 900, frontier: 950 }), 'serve',
        'a ready segment must be served without any further thought, even from a region this run skipped');
    // Normal read-ahead: at or just past the frontier → wait for ffmpeg.
    assert.strictEqual(V._vpSegAction({ ready: false, index: 10, runStart: 0, frontier: 9 }), 'wait');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 9 + TOL, runStart: 0, frontier: 9 }), 'wait',
        'the last segment inside the tolerance window must wait, not restart');
    // Nothing flushed yet by a fresh run (frontier = runStart-1) → wait.
    assert.strictEqual(V._vpSegAction({ ready: false, index: 1200, runStart: 1200, frontier: 1199 }), 'wait',
        'a just-restarted run has flushed nothing yet — that must not immediately restart again (thrash)');
    // Far ahead: a forward seek this run would take hours to reach → restart.
    assert.strictEqual(V._vpSegAction({ ready: false, index: 10 + TOL, runStart: 0, frontier: 9 }), 'restart',
        'one segment past the tolerance window is a seek, not buffering');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 1200, runStart: 0, frontier: 40 }), 'restart');
    // Behind the current run's start: it only writes forward — waiting is futile.
    assert.strictEqual(V._vpSegAction({ ready: false, index: 300, runStart: 1200, frontier: 1250 }), 'restart',
        'a segment below the run start can never appear by waiting');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 1199, runStart: 1200, frontier: 1400 }), 'restart');
    // Garbage in → restart (safe: bounded by the caller's deadline).
    assert.strictEqual(V._vpSegAction({ ready: false, index: 5, runStart: NaN, frontier: 5 }), 'restart');
    console.log('OK _vpSegAction: serve / wait (<= frontier+' + TOL + ') / restart (ahead of tolerance, or below runStart)');
}

// (4b) completeness: "the file exists" is not "the segment is playable" —
// ffmpeg creates a segment when it STARTS writing it and lists it only when it
// closes it, so the frontier (for the current run) and the recorded ranges of
// superseded runs are what may be read.
{
    const done = [{ start: 0, end: 40 }, { start: 900, end: 905 }];
    // Current run's range: the playlist frontier is the authority.
    assert.strictEqual(V._vpSegKnownComplete({ index: 1202, runStart: 1200, frontier: 1202, doneRuns: done }), true);
    assert.strictEqual(V._vpSegKnownComplete({ index: 1203, runStart: 1200, frontier: 1202, doneRuns: done }), false,
        'the segment being written right now must NOT be served — a half-written .ts is a demux error');
    assert.strictEqual(V._vpSegKnownComplete({ index: 1200, runStart: 1200, frontier: 1199, doneRuns: done }), false,
        'a run that has flushed nothing yet has nothing readable');
    // Earlier runs: only what they were observed to have completed.
    assert.strictEqual(V._vpSegKnownComplete({ index: 40, runStart: 1200, frontier: 1202, doneRuns: done }), true,
        'a segment an earlier run completed is still valid — a restart never deletes segments');
    assert.strictEqual(V._vpSegKnownComplete({ index: 41, runStart: 1200, frontier: 1202, doneRuns: done }), false,
        'past an earlier run\'s recorded end, the file on disk may be the one it died mid-write on');
    assert.strictEqual(V._vpSegKnownComplete({ index: 902, runStart: 1200, frontier: 1202, doneRuns: done }), true);
    assert.strictEqual(V._vpSegKnownComplete({ index: 500, runStart: 1200, frontier: 1202, doneRuns: done }), false);
    assert.strictEqual(V._vpSegKnownComplete({ index: 5, runStart: 1200, frontier: 1202, doneRuns: [] }), false);
    assert.strictEqual(V._vpSegKnownComplete({ index: 5, runStart: 0, frontier: undefined, doneRuns: [] }), false);
    console.log('OK _vpSegKnownComplete: current run gated by its playlist frontier, earlier runs by their recorded ranges');
}

// (5) run-progress read (ffmpeg's own playlist is now only a progress counter)
assert.strictEqual(V._vpCountSegments(null), 0);
assert.strictEqual(V._vpCountSegments('#EXTM3U\n#EXT-X-VERSION:3\n'), 0);
assert.strictEqual(V._vpCountSegments('#EXTM3U\n#EXTINF:4.004,\nseg_01200.ts\n#EXTINF:4.004,\nseg_01201.ts\n'), 2,
    'the frontier is derived from this count — miscounting makes every request look like a seek');
console.log('OK _vpCountSegments: counts flushed segments of the current run');

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

// Fix-round-1 (Important 2): "is there anything at all to play yet" — the
// narrower question the 60s backstop degrade path asks, distinct from
// _vpPlaylistBuffered's "is the FULL 30s target met".
assert.strictEqual(V._vpPlaylistHasSegments(''), false);
assert.strictEqual(V._vpPlaylistHasSegments(null), false);
assert.strictEqual(V._vpPlaylistHasSegments('#EXTM3U\n#EXT-X-VERSION:3\n'), false, 'playlist header alone, no segments yet, is not playable');
assert.strictEqual(V._vpPlaylistHasSegments('#EXTM3U\n#EXTINF:7.0,\nseg_00000.ts\n'), true, 'even a single segment is enough to degrade-attach on');
console.log('OK _vpPlaylistHasSegments: false until at least one #EXTINF exists');

// Fix-round-1 (Important 3): _vpHeaderPv is the entire justification for
// FIX C's header badge/duration not throwing on non-video windows (the
// title bar renders for every window kind). Three cases per review:
// editor window, native-mode video, hls-mode video.
{
    const withActiveWin = (win) => ({ activeWin: () => win });
    assert.strictEqual(
        V._vpHeaderPv.call(withActiveWin({ kind: 'editor', lang: 'js' })), null,
        'editor window (no .pv at all) must return null, not throw');
    assert.strictEqual(
        V._vpHeaderPv.call(withActiveWin({ kind: 'preview', pv: { kind: 'video', mode: 'native' } })), null,
        'native-mode video (plain <video>, no transcoding) must return null — the header is hls-only');
    const hlsPv = { kind: 'video', mode: 'hls', transcodeState: 'transcoding', totalDuration: 100 };
    assert.strictEqual(
        V._vpHeaderPv.call(withActiveWin({ kind: 'preview', pv: hlsPv })), hlsPv,
        'hls-mode video must return its own pv object');
    assert.strictEqual(V._vpHeaderPv.call(withActiveWin(null)), null, 'no active window must return null');
    console.log('OK _vpHeaderPv: editor -> null, native video -> null, hls video -> pv');
}

// Fix-round-1 (Important 3): FIX D's ffprobe argv must actually request
// format=duration — reverting `-show_entries` back to stream-only entries
// left the offline suite green before this test existed, since
// video-session-unit stubs _vpProbeStreams directly rather than exercising
// the real argv. cockpit isn't otherwise defined in this sandbox; supplied
// here just for this one call.
{
    const spawnCalls = [];
    sandbox.cockpit = {
        spawn: async (argv) => {
            spawnCalls.push(argv);
            return JSON.stringify({
                format: { duration: '123.5' },
                streams: [{ codec_type: 'video', codec_name: 'h264' }],
            });
        },
    };
    const probed = await V._vpProbeStreams('/m/a.mkv');
    assert.strictEqual(spawnCalls.length, 1);
    const argv = spawnCalls[0];
    assert.ok(argv.includes('ffprobe'), 'must spawn ffprobe');
    const entriesIdx = argv.indexOf('-show_entries');
    assert.ok(entriesIdx !== -1 && /format=duration/.test(argv[entriesIdx + 1]),
        'must request format=duration in -show_entries — dropping this silently breaks FIX D');
    assert.strictEqual(probed.duration, 123.5, 'format.duration must be parsed onto the returned object');
    assert.strictEqual(probed.streams.length, 1);
    console.log('OK _vpProbeStreams: ffprobe argv requests format=duration, and it is parsed');
}

// FIX D: duration formatter — H:MM:SS over an hour, M:SS under, '' when unusable
assert.strictEqual(V._vpFormatDuration(5741), '1:35:41');   // 1h35m sample
assert.strictEqual(V._vpFormatDuration(6239), '1:43:59');   // 1h44m sample
assert.strictEqual(V._vpFormatDuration(59), '0:59');
assert.strictEqual(V._vpFormatDuration(60), '1:00');
assert.strictEqual(V._vpFormatDuration(0), '');
assert.strictEqual(V._vpFormatDuration(0.4), '', 'Fix-round-1: rounds to 0 — must not render as the misleading "0:00"');
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
