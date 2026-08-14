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

    // Fix-round-1 (I1a): a trailing remainder shorter than one frame is a
    // PHANTOM segment — ffmpeg has no frame to put in it and writes one fewer
    // than ceil() claims, and a segment the encoder will never produce freezes
    // the player (no loader timeout in hls.js + six 404 retries with backoff).
    // 100.048980 is a real probed duration: ffmpeg produced 25 segments.
    // Absolute expectations, so the clamp cannot be silently removed.
    assert.strictEqual(V._vpSegCount(100.048980), 25, 'a sub-frame tail must NOT get its own segment');
    // (0.08s is comfortably clear of the 0.05 threshold — testing exactly ON it
    // would only measure float noise: 100.05 - 100 is 0.04999999999999716.)
    assert.strictEqual(V._vpSegCount(100.08), 26, 'a tail of one frame or more is a real segment');
    assert.strictEqual(V._vpSegCount(100), 25, 'an exact division stays exact');
    assert.strictEqual(V._vpSegCount(6239.024458), 1560);
    assert.strictEqual(V._vpSegCount(2), 1, 'a file shorter than one segment is still one segment');
    assert.strictEqual(V._vpSegCount(0.01), 1);
    {
        const short = V._vpBuildVodPlaylist(100.048980);
        const shortSegs = short.match(/^seg_\d+\.ts$/gm) || [];
        const shortInf = (short.match(/#EXTINF:([0-9.]+)/g) || []).map((s) => parseFloat(s.split(':')[1]));
        assert.strictEqual(shortSegs.length, 25);
        assert.ok(Math.abs(shortInf[24] - 4.048980) < 1e-6, 'the folded-in tail must extend the LAST #EXTINF, not vanish from the duration');
        assert.ok(Math.abs(shortInf.reduce((a, b) => a + b, 0) - 100.048980) < 1e-6, 'the declared duration must still be the probed one');
        const shortTarget = parseInt(/#EXT-X-TARGETDURATION:(\d+)/.exec(short)[1], 10);
        assert.strictEqual(shortTarget, 5, 'TARGETDURATION must cover a last segment that is longer than the nominal length');
        console.log('OK sub-frame tail: 100.048980s → 25 segments (last #EXTINF ' + shortInf[24].toFixed(6) + 's), TARGETDURATION ' + shortTarget);
    }

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

    // Fix-round-1 (I2): the cases above are all written in terms of TOL, so
    // moving the constant moves the expectations with it and the tests stay
    // green either way (a 3→2 and a 3→12 mutation both survived). These pin the
    // boundary with ABSOLUTE indices: with the run at 0 and 41 segments flushed
    // (frontier 40), 43 is the last index that may wait and 44 must restart.
    assert.strictEqual(V._vpSegAction({ ready: false, index: 41, runStart: 0, frontier: 40 }), 'wait', 'frontier+1 waits');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 42, runStart: 0, frontier: 40 }), 'wait', 'frontier+2 waits');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 43, runStart: 0, frontier: 40 }), 'wait',
        'frontier+3 is the LAST index treated as read-ahead — a smaller tolerance would restart here and thrash the encoder during normal buffering');
    assert.strictEqual(V._vpSegAction({ ready: false, index: 44, runStart: 0, frontier: 40 }), 'restart',
        'frontier+4 is a seek — a larger tolerance would sit and wait for an encoder that is 16+ seconds of video away');
    assert.strictEqual(V._vpSegAheadTolerance, 3, 'the tolerance the absolute cases above are calibrated against');
    console.log('OK _vpSegAction boundary (absolute): frontier 40 → 43 waits, 44 restarts');
}

// (4c) run-progress read (Fix-round-1, I2): a `runStart + count` off-by-one
// here serves the segment ffmpeg is writing RIGHT NOW — the exact failure the
// completeness gate exists to prevent — and survived the previous round
// because nothing tested _vpRunFrontier itself. Absolute expected values.
{
    const saved = sandbox.cockpit;
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.004,\nseg_01200.ts\n#EXTINF:4.004,\nseg_01201.ts\n#EXTINF:4.004,\nseg_01202.ts\n';
    sandbox.cockpit = { spawn: async () => playlist };
    const s = { dir: '/c/sid', runStart: 1200 };
    assert.strictEqual(await V._vpRunFrontier(s), 1202,
        'a run started at 1200 having flushed 3 segments has produced up to 1202 — 1203 is still being written');
    assert.strictEqual(s.frontier, 1202, 'the frontier must be cached on the session (a restart records it as a completed range)');
    playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
    assert.strictEqual(await V._vpRunFrontier(s), 1199, 'a run that has flushed nothing sits one below its start');
    const s0 = { dir: '/c/sid', runStart: 0 };
    playlist = '#EXTM3U\n#EXTINF:4.004,\nseg_00000.ts\n';
    assert.strictEqual(await V._vpRunFrontier(s0), 0, 'one flushed segment on the initial run → frontier 0');
    sandbox.cockpit = saved;
    console.log('OK _vpRunFrontier: 1200 + 3 flushed → 1202 (absolute); nothing flushed → 1199');
}

// (4d) doneRuns range merging (Fix-round-1, M5)
{
    assert.deepStrictEqual(JSON.parse(JSON.stringify(V._vpMergeRanges([], { start: 0, end: 40 }))), [{ start: 0, end: 40 }]);
    // Adjacent ranges are one continuous stretch of segments.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(V._vpMergeRanges([{ start: 0, end: 40 }], { start: 41, end: 90 }))),
        [{ start: 0, end: 90 }], 'adjacent ranges must merge, or repeated seeks grow the list without bound');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(V._vpMergeRanges([{ start: 0, end: 40 }], { start: 20, end: 90 }))),
        [{ start: 0, end: 90 }], 'overlapping ranges must merge');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(V._vpMergeRanges([{ start: 0, end: 40 }], { start: 10, end: 20 }))),
        [{ start: 0, end: 40 }], 'a contained range must not extend anything');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(V._vpMergeRanges([{ start: 100, end: 200 }], { start: 0, end: 40 }))),
        [{ start: 0, end: 40 }, { start: 100, end: 200 }], 'disjoint ranges stay separate and sorted');
    // Repeated identical pushes must not accumulate.
    let acc = [];
    for (let i = 0; i < 50; i++) acc = V._vpMergeRanges(acc, { start: 0, end: 10 });
    assert.strictEqual(acc.length, 1);
    console.log('OK _vpMergeRanges: merges adjacent/overlapping, keeps disjoint, cannot grow unbounded');
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
    // Fix-round-1: ABOVE the live run's reach, an earlier run's record still
    // counts — after a restart back near the start of the file, the segments a
    // previous run produced around minute 80 are untouched and still valid.
    assert.strictEqual(V._vpSegKnownComplete({ index: 1200, runStart: 100, frontier: 102, doneRuns: [{ start: 1200, end: 1202 }] }), true,
        'a range an earlier run completed, which the live run has not reached, must remain reusable');
    // …but not once the live run is encoding back over it.
    assert.strictEqual(V._vpSegKnownComplete({ index: 103, runStart: 100, frontier: 102, doneRuns: [{ start: 0, end: 2000 }] }), false,
        'the segment the live run is rewriting right now is half-written, whatever an older range claims');
    assert.strictEqual(V._vpSegKnownComplete({ index: 500, runStart: 100, frontier: 102, doneRuns: [{ start: 0, end: 2000 }] }), true,
        'further ahead the live run has not touched anything yet, so the older range still holds');
    console.log('OK _vpSegKnownComplete: current run gated by its playlist frontier, earlier runs by their recorded ranges');
}

// (5) run-progress read: how many segments has THIS run flushed?
// Fix-round-2: ffmpeg does not truncate index.m3u8 when a restarted run
// spawns (measured against ffmpeg 7.1.5: the killed run's playlist was still
// on disk ~700ms in), so the count must be attributed by segment NAME, not
// taken as "however many entries are in the file".
{
    const pl = (start, n) => {
        let t = '#EXTM3U\n#EXT-X-VERSION:3\n';
        for (let i = 0; i < n; i++) t += '#EXTINF:4.004,\nseg_' + String(start + i).padStart(5, '0') + '.ts\n';
        return t;
    };
    assert.strictEqual(V._vpRunFlushed(null, 0), 0);
    assert.strictEqual(V._vpRunFlushed('#EXTM3U\n#EXT-X-VERSION:3\n', 0), 0, 'a header with no segments is no progress');
    assert.strictEqual(V._vpRunFlushed(pl(0, 3), 0), 3);
    assert.strictEqual(V._vpRunFlushed(pl(1200, 2), 1200), 2, 'a restarted run\'s own playlist counts normally');
    // The stale-playlist window: the file still belongs to the previous run.
    assert.strictEqual(V._vpRunFlushed(pl(0, 185), 900), 0,
        'a playlist written by a DIFFERENT run must count as zero progress — crediting it is what recorded completed ranges for runs that wrote nothing');
    assert.strictEqual(V._vpRunFlushed(pl(0, 30), 41), 0,
        'and it must not vouch for the half-written segment a killed run left behind at index 41');
    assert.strictEqual(V._vpRunFlushed(pl(1200, 3), 600), 0, 'a stale playlist with HIGHER indices is just as wrong');
    // A gap stops the count: only a contiguous run from runStart is progress.
    assert.strictEqual(V._vpRunFlushed(pl(0, 2) + '#EXTINF:4.004,\nseg_00009.ts\n', 0), 2);
    console.log('OK _vpRunFlushed: counts only entries contiguous from this run\'s start; another run\'s playlist counts 0');
}

// The same thing through _vpRunFrontier, with absolute values — this is the
// transient half of the fix-round-2 finding: a backward restart at 41 while
// the outgoing run's 30-entry playlist is still on disk used to compute a
// frontier of 70, which vouched for seg_00041.ts all on its own (no doneRuns
// involved).
{
    const saved = sandbox.cockpit;
    let text = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (let i = 0; i < 30; i++) text += '#EXTINF:4.004,\nseg_' + String(i).padStart(5, '0') + '.ts\n';
    sandbox.cockpit = { spawn: async () => text };
    const s = { dir: '/c/sid', runStart: 41 };
    assert.strictEqual(await V._vpRunFrontier(s), 40,
        'a run that has published nothing sits one below its start, however many entries the PREVIOUS run left in the file');
    sandbox.cockpit = saved;
    console.log('OK _vpRunFrontier: previous run\'s 30-entry playlist + runStart 41 → frontier 40 (was 70)');
}

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
