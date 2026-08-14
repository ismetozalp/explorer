// Regression test for the ffmpeg/HLS session state machine in
// js/features/videoplayer.js. Two findings from the final branch review would
// have been caught here:
//
//   C1 — ffmpeg detection used cockpit.spawn(['command','-v',bin]). cockpit.spawn
//        execs argv directly with NO shell, and `command` is a shell builtin
//        (/usr/bin/command exists only on Red Hat, from the bash RPM), so the
//        probe threw on Debian/Ubuntu/Alpine and reported ffmpeg as missing
//        forever. The probe must use the `sh -c 'command -v X'` form the rest
//        of the repo already uses (mounts.js, terminal.js).
//
//   C2 — startPreviewVideo() registered its session AFTER several awaits with
//        no "am I still the newest start" check, so on rapid ◀/▶ a slow OLDER
//        call could overwrite a NEWER call's registry entry. The newer entry
//        (its hls.js instance + live ffmpeg + segment dir) then became
//        unreachable and nothing ever destroyed/killed it.
//
// The async boundaries (cockpit.spawn, FS, hls.js, $nextTick) are stubbed so
// the interleaving is deterministic — the older start is parked mid-probe
// while the newer one runs to completion, then released.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

// ── sandbox: runtime.js (ExRT registries) + videoplayer.js, plus the page
// globals the mixin uses bare (cockpit/FS/Util/document/window).
const spawns = [];              // every cockpit.spawn argv, in order
const procs = [];               // the ffmpeg process handles we handed out
let uidSeq = 0;

// close() REJECTS the promise, exactly as cockpit.spawn() does when a channel
// is closed early — the seek-restart path closes the outgoing ffmpeg while its
// session is alive, so "a close is not a failure" has to be modelled here or
// the regression it guards (restart tearing the session down) is untestable.
// The inert `.catch` keeps that rejection from ever surfacing as an unhandled
// rejection for procs that are killed before anything attaches a handler.
function makeProc(argv) {
    let settle;
    const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    p.catch(() => {});
    p.argv = argv;
    p.closed = null;
    p.close = (why) => { if (p.closed) return; p.closed = why || 'closed'; settle.reject(new Error(p.closed)); };
    p._exit = () => settle.resolve('');
    return p;
}

// A playlist that _vpWaitForPlaylist's FIX-B buffer check accepts on the
// very first read (3 segments * 12s = 36s ≥ the 30s target) — keeps this
// state-machine test deterministic and fast, same as the old `test -s`
// immediate-resolve behaviour it replaces.
const FAKE_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:12.0,\nseg_00000.ts\n#EXTINF:12.0,\nseg_00001.ts\n#EXTINF:12.0,\nseg_00002.ts\n';
// Under the 30s target on its own (one 5s segment) — used by the Fix-round-1
// "the wait actually loops" test below via `catQueue`: when set, 'cat' calls
// shift responses off this queue in order; once exhausted (or when it's
// null, the default for every other test block), 'cat' falls back to the
// already-buffered FAKE_PLAYLIST so nothing else in this file has to change.
const UNDER_BUFFERED_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5.0,\nseg_00000.ts\n';
let catQueue = null;
let onFfmpeg = null;    // test hook: called with every ffmpeg argv as it spawns
const cockpit = {
    spawn(argv) {
        spawns.push(argv);
        if (argv[0] === 'ffmpeg') { const p = makeProc(argv); procs.push(p); if (onFfmpeg) onFfmpeg(argv); return p; }
        if (argv[0] === 'cat') {
            const text = (catQueue && catQueue.length) ? catQueue.shift() : FAKE_PLAYLIST;
            const p = Promise.resolve(text); p.close = () => {}; return p;
        }
        // rm -rf <dir> / sh -c … all succeed immediately.
        const p = Promise.resolve('');
        p.close = () => {};
        return p;
    },
    // Virtual segment store for the 3.1.0 seek tests: `produced` holds the
    // segment indices ffmpeg has "written" into the session dir. Every other
    // test block leaves it empty, which reads exactly like the old
    // always-null stub.
    file(p) {
        return {
            read: async () => {
                const m = /seg_(\d+)\.ts$/.exec(String(p));
                if (m && produced.has(parseInt(m[1], 10))) return new Uint8Array([0x47, 0, 0, 0]);
                return null;
            },
            close() {},
        };
    },
};
const produced = new Set();

// Fake setInterval/clearInterval: the heartbeat (preview-reap-hardening FIX 1)
// must be testable without a real 30s wall-clock timer. Handles are plain
// integers; `fn` is stashed so a test can fire a tick manually and
// deterministically, and activeIntervals.size is the "how many timers are
// actually running" ground truth teardown must drive to zero.
let intervalSeq = 0;
const activeIntervals = new Map();   // handle -> { fn, ms }
function fakeSetInterval(fn, ms) { const h = ++intervalSeq; activeIntervals.set(h, { fn, ms }); return h; }
function fakeClearInterval(h) { activeIntervals.delete(h); }

const sandbox = {
    window: {}, console, cockpit,
    FS: { homeDir: async () => '/home/u', mkdir: async () => {} },
    Util: { uid: () => 'sid' + (++uidSeq) },
    document: { getElementById: () => ({ tagName: 'VIDEO' }) },   // a mounted <video>
    setTimeout, clearTimeout, Promise, Date, TextEncoder, TextDecoder,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
};
vm.runInNewContext(fs.readFileSync(new URL('../js/runtime.js', import.meta.url), 'utf8'), sandbox);
sandbox.ExRT = sandbox.window.ExRT;
vm.runInNewContext(fs.readFileSync(new URL('../js/features/videoplayer.js', import.meta.url), 'utf8'), sandbox);
const V = sandbox.window.ExplorerVideo;
const ExRT = sandbox.ExRT;

// hls.js stub — records instances so we can prove which one survived.
const hlsInstances = [];
class FakeHls {
    // `config` is captured so a test can instantiate the real loader class the
    // mixin passed in (pLoader/fLoader) and drive it like hls.js would.
    constructor(config) { this.config = config || {}; this.destroyed = false; this.src = null; this.media = null; hlsInstances.push(this); }
    loadSource(u) { this.src = u; }
    attachMedia(el) { this.media = el; }
    destroy() { this.destroyed = true; }
}
FakeHls.isSupported = () => true;
sandbox.window.Hls = FakeHls;

// ── the component stub: mixin methods + the reactive-ish state they touch.
function makeApp() {
    const app = Object.assign(Object.create(null), V, {
        homePath: '/home/u',
        activeWinId: 'w1',
        hostVisible: true,
        video: { ffmpeg: { ffmpeg: true, ffprobe: true }, installLog: '' },
        windows: [{ id: 'w1', kind: 'preview', _file: { path: '/v/a.mkv' }, pv: { kind: 'video', mode: 'hls', transcodeState: 'remuxing' } }],
        _win(id) { return this.windows.find(w => w.id === id); },
        $nextTick(fn) { fn(); },                 // deterministic: attach happens inline
        _ensureHls: async () => {},
    });
    return app;
}

// ─────────────────────────────────────────────────────────────────────────
// (b) C1 guard: the ffmpeg probe must go through a shell.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    app.video.ffmpeg = null;                     // force a real probe
    spawns.length = 0;
    const ff = await V._vpProbeFfmpeg.call(app);
    const probeArgvs = spawns.filter(a => String(a[2] || '').includes('command -v'));
    assert.strictEqual(probeArgvs.length, 2, 'expected one probe per binary (ffmpeg, ffprobe)');
    for (const argv of probeArgvs) {
        assert.strictEqual(argv[0], 'sh', 'probe must exec a shell, not the Red-Hat-only /usr/bin/command');
        assert.strictEqual(argv[1], '-c');
        assert.match(argv[2], /^command -v (ffmpeg|ffprobe)\b/);
    }
    assert.ok(!spawns.some(a => a[0] === 'command'),
        'cockpit.spawn(["command", …]) execs argv with no shell — /usr/bin/command does not exist on Debian/Ubuntu/Alpine');
    assert.deepStrictEqual({ ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe }, { ffmpeg: true, ffprobe: true });
    console.log('OK C1: probe argv = ' + JSON.stringify(probeArgvs[0]) + ' (shell form, works on every distro)');
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-round-1 (Important 3): FIX B's wait must actually RE-POLL the
// playlist, not just check it once. The reviewer found that reverting
// _vpWaitForPlaylist's body to the old bare `test -s` existence check left
// this suite green, because every prior test's fake 'cat' response was
// already buffered on the first read. Here the first read is deliberately
// under the 30s target (via catQueue), so a correct implementation must
// loop at least once more before it can attach — and a reverted
// implementation (checking existence instead of content, or not looping at
// all) would either attach immediately on bad data or never issue a second
// 'cat' call. Also closes the FIX D stateful gap: pv.totalDuration must
// carry the ffprobe-probed value all the way through to the window's pv,
// not just be computed and dropped.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    catQueue = [UNDER_BUFFERED_PLAYLIST];   // 1st 'cat' read: 5s, under target; then falls back to FAKE_PLAYLIST (36s, buffered)
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264' }], duration: 4242 });

    await app.startPreviewVideo('w1', { path: '/v/a.mkv' });

    const catCalls = spawns.filter((a) => a[0] === 'cat');
    assert.ok(catCalls.length >= 2,
        'the wait must re-poll the playlist after an under-buffered read, not attach on the first (or a bare existence) check — got ' + catCalls.length + ' cat call(s)');
    assert.ok(!spawns.some((a) => a[0] === 'test'), 'must not use the old test -s existence check anymore');

    const w = app._win('w1');
    assert.strictEqual(w.pv.totalDuration, 4242,
        'the ffprobe-probed duration must be threaded through onto pv.totalDuration, not just computed and dropped');

    const s = ExRT.video.sessions.get('w1');
    assert.ok(s && s.hls instanceof FakeHls, 'must still reach a successful attach once the buffer target is met');
    console.log('OK FIX B loop: attached after ' + catCalls.length + ' cat read(s) (1 under-buffered + buffered); pv.totalDuration=' + w.pv.totalDuration + ' threaded from the probe');

    await V._teardownPreviewVideo.call(app, 'w1');
    catQueue = null;   // reset for every block below
}

// ─────────────────────────────────────────────────────────────────────────
// (a) C2 guard: an older overlapping start must not clobber the newer
//     session's registry entry, and must free its own ffmpeg + dir.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();

    // Park the FIRST start inside its ffprobe; let every later one run straight
    // through. This is exactly the rapid-◀/▶ interleaving: call A is still
    // probing when call B starts, finishes, and attaches.
    let releaseA;
    const aParked = new Promise((resolve) => { releaseA = resolve; });
    let probeCalls = 0;
    app._vpProbeStreams = async () => {
        if (++probeCalls === 1) await aParked;
        return { streams: [{ codec_type: 'video', codec_name: 'h264' }], duration: 123 };
    };

    const pA = app.startPreviewVideo('w1', { path: '/v/a.mkv' });   // older (deliberately un-awaited)
    while (probeCalls === 0) await new Promise((r) => setTimeout(r, 0));  // A is now parked mid-probe
    const aDir = '/home/u/.cache/cockpit-explorer/preview/sid1';    // uid() order: A took sid1 before parking
    const pB = app.startPreviewVideo('w1', { path: '/v/b.mkv' });   // newer, supersedes A
    await pB;

    const afterB = ExRT.video.sessions.get('w1');
    assert.ok(afterB, 'the newer start must own the session');
    const bToken = afterB.token, bDir = afterB.dir, bHls = afterB.hls;
    assert.ok(bHls instanceof FakeHls, 'the newer start must have attached hls.js');
    assert.strictEqual(bHls.media.tagName, 'VIDEO');

    releaseA();                    // A's probe finally resolves — the dangerous moment
    await pA;

    const afterA = ExRT.video.sessions.get('w1');
    assert.ok(afterA, 'session entry must still exist after the older start finishes');
    assert.strictEqual(afterA.token, bToken, 'the OLDER start clobbered the NEWER session registry entry');
    assert.strictEqual(afterA.dir, bDir);
    assert.strictEqual(afterA.hls, bHls, 'the newer hls.js instance must still be reachable for teardown');
    assert.strictEqual(bHls.destroyed, false, 'the newer, still-current hls.js must not be destroyed');

    // …and the older attempt must have freed everything it allocated: no
    // surviving ffmpeg of its own, and its segment dir cleaned up.
    const bProc = procs.find(p => p.argv.includes('/v/b.mkv'));
    const aProcs = procs.filter(p => p.argv.includes('/v/a.mkv'));
    for (const p of aProcs) assert.strictEqual(p.closed, 'cancelled', 'a superseded ffmpeg was never closed — it would transcode forever');
    assert.strictEqual(bProc.closed, null, 'the current ffmpeg must stay alive');
    assert.notStrictEqual(aDir, bDir);
    assert.ok(spawns.some(a => a[0] === 'rm' && a[1] === '-rf' && a[2] === aDir),
        'the superseded session dir must be removed (' + aDir + ')');
    assert.ok(!spawns.some(a => a[0] === 'rm' && a[1] === '-rf' && a[2] === bDir),
        'the live session dir must NOT be removed');
    console.log('OK C2: older start bailed (' + aProcs.length + ' stray ffmpeg, all closed; ' + aDir + ' removed); newer session ' + bToken + ' intact');

    // Teardown of the survivor frees it completely.
    await V._teardownPreviewVideo.call(app, 'w1');
    assert.strictEqual(ExRT.video.sessions.get('w1'), undefined, 'teardown must drop the registry entry');
    assert.strictEqual(bHls.destroyed, true, 'teardown must destroy hls.js');
    assert.strictEqual(bProc.closed, 'cancelled', 'teardown must close ffmpeg');
    assert.ok(spawns.some(a => a[0] === 'rm' && a[1] === '-rf' && a[2] === bDir), 'teardown must remove the session dir');
    console.log('OK teardown: hls destroyed, ffmpeg closed, dir removed, registry empty');
}

// ─────────────────────────────────────────────────────────────────────────
// Same clobber test, but with the older start parked AFTER it has already
// spawned ffmpeg and registered (parked in the lazy hls.js load). It must
// notice it was superseded, free its own process/dir, and leave the newer
// registration — and the newer hls.js — untouched.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();

    let releaseA, hlsCalls = 0;
    const aParked = new Promise((resolve) => { releaseA = resolve; });
    app._ensureHls = async () => { if (++hlsCalls === 1) await aParked; };

    const pA = app.startPreviewVideo('w1', { path: '/v/a.mkv' });   // registers, then parks
    while (hlsCalls === 0) await new Promise((r) => setTimeout(r, 0));
    const aProc = procs.find(p => p.argv.includes('/v/a.mkv'));
    assert.ok(aProc, 'the older start should have spawned ffmpeg before parking');
    assert.strictEqual(ExRT.video.sessions.get('w1').dir, '/home/u/.cache/cockpit-explorer/preview/sid1');

    const pB = app.startPreviewVideo('w1', { path: '/v/b.mkv' });   // supersedes A
    await pB;
    const bEntry = ExRT.video.sessions.get('w1');
    assert.strictEqual(aProc.closed, 'cancelled', 'superseding must kill the older ffmpeg immediately');

    releaseA();
    await pA;

    const after = ExRT.video.sessions.get('w1');
    assert.strictEqual(after, bEntry, 'the older start clobbered the newer registration after resuming');
    assert.strictEqual(after.token, bEntry.token);
    assert.ok(after.hls instanceof FakeHls && after.hls.destroyed === false, 'the newer hls.js must survive');
    assert.strictEqual(after.proc.closed, null, 'the newer ffmpeg must survive');
    assert.strictEqual(hlsInstances.length, 1, 'the superseded start must not attach a second hls.js');
    console.log('OK C2 (post-registration): older start resumed after supersession and left session ' + after.token + ' intact');
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-round-1 (Important 2): the 60s backstop must degrade, not error, when
// SOME content exists but the 30s target wasn't reached in time — and must
// still error when there is genuinely nothing to play. _vpWaitForPlaylist
// is stubbed directly (a real 60000ms timeout is not worth a real wait
// here); this exercises the call-site branching in startPreviewVideo added
// in this round.
// ─────────────────────────────────────────────────────────────────────────
{
    // (a) timeout + some content on disk -> attach anyway (no error).
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    app._vpWaitForPlaylist = async () => ({ status: 'timeout', text: '#EXTINF:5.0,\nseg_00000.ts\n' });

    await app.startPreviewVideo('w1', { path: '/v/a.mkv' });

    const w = app._win('w1');
    assert.strictEqual(w.pv.reason, undefined, 'a slow host with SOME buffered content must degrade-attach, not error');
    const s = ExRT.video.sessions.get('w1');
    assert.ok(s && s.hls instanceof FakeHls, 'must still attach hls.js on the degrade path');
    console.log('OK degrade: timeout with a partial buffer attaches instead of erroring');
    await V._teardownPreviewVideo.call(app, 'w1');
}
{
    // (b) timeout + genuinely nothing on disk -> the original hard error.
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    app._vpWaitForPlaylist = async () => ({ status: 'timeout', text: '' });

    await app.startPreviewVideo('w1', { path: '/v/a.mkv' });

    const w = app._win('w1');
    assert.strictEqual(w.pv.transcodeState, 'error', 'a timeout with NOTHING playable must still be a hard error');
    assert.match(w.pv.reason || '', /did not produce a playable stream in time/);
    assert.strictEqual(ExRT.video.sessions.get('w1'), undefined, 'the failed attempt must not leave a session registered');
    console.log('OK hard-error: timeout with no segments at all still errors and tears down');
}

// ─────────────────────────────────────────────────────────────────────────
// A teardown that lands WHILE a start is in flight (close/◀ before the probe
// resolves) must leave nothing registered and nothing running.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();

    let release;
    const parked = new Promise((resolve) => { release = resolve; });
    app._vpProbeStreams = async () => { await parked; return { streams: [], duration: null }; };

    const p = app.startPreviewVideo('w1', { path: '/v/a.mkv' });
    await Promise.resolve();
    await V._teardownPreviewVideo.call(app, 'w1');   // window closed mid-start
    release();
    await p;

    assert.strictEqual(ExRT.video.sessions.get('w1'), undefined,
        'a start superseded by a teardown must not register a session for a closed window');
    assert.strictEqual(procs.length, 0, 'no ffmpeg should be spawned once the start is superseded before the spawn point');
    console.log('OK teardown-during-start: nothing registered, no ffmpeg spawned');
}

// ─────────────────────────────────────────────────────────────────────────
// Heartbeat lifecycle (preview-reap-hardening FIX 1): the shared timer starts
// when the FIRST session registers, is never duplicated by a second session,
// keeps running while at least one session remains, and is cleared — handle
// set back to null, no timer left in activeIntervals — once the LAST session
// is dropped. setInterval/clearInterval are the fakes above: fully
// deterministic, nothing here waits on a real clock tick.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); intervalSeq = 0;

    assert.strictEqual(ExRT.video.hb, null, 'no heartbeat before any session exists');

    await app.startPreviewVideo('w1', { path: '/v/a.mkv' });
    const hb1 = ExRT.video.hb;
    assert.ok(hb1 !== null, 'heartbeat must start once a session registers');
    assert.ok(activeIntervals.has(hb1), 'the handle in ExRT.video.hb must be a live interval');
    assert.ok(spawns.some((a) => a[0] === 'touch' && a.some((x) => String(x).endsWith('/.alive'))),
        'registering a session must touch its .alive marker immediately, before the first tick');

    // A second window's session must reuse the SAME shared timer.
    app.windows.push({ id: 'w2', kind: 'preview', _file: { path: '/v/c.mkv' }, pv: { kind: 'video', mode: 'hls', transcodeState: 'remuxing' } });
    await app.startPreviewVideo('w2', { path: '/v/c.mkv' });
    assert.strictEqual(ExRT.video.hb, hb1, 'a second session must not spawn a second heartbeat timer');
    assert.strictEqual(activeIntervals.size, 1, 'exactly one shared interval for all sessions, never one per session');

    // Firing the tick must touch .alive for every live session dir in one go.
    spawns.length = 0;
    activeIntervals.get(hb1).fn();
    const touchCall = spawns.find((a) => a[0] === 'touch');
    assert.ok(touchCall, 'a heartbeat tick must touch .alive markers');
    assert.strictEqual(touchCall.length - 1, 2, 'one touch call covering both live session dirs');

    // Dropping one of two sessions must leave the shared timer running.
    await V._teardownPreviewVideo.call(app, 'w1');
    assert.strictEqual(ExRT.video.hb, hb1, 'heartbeat must stay alive while any session remains');
    assert.strictEqual(activeIntervals.size, 1);

    // Dropping the LAST session must clear the timer.
    await V._teardownPreviewVideo.call(app, 'w2');
    assert.strictEqual(ExRT.video.hb, null, 'heartbeat handle must be cleared once the last session is gone');
    assert.strictEqual(activeIntervals.size, 0, 'no interval may be left running with zero sessions');
    console.log('OK heartbeat: starts on first session, shared not per-session, cleared with the last session');
}

// ─────────────────────────────────────────────────────────────────────────
// 3.1.0 seek support, stateful half. Drives the REAL loader class the mixin
// handed to hls.js (captured off FakeHls.config) exactly as hls.js would:
// playlist request first, then fragment requests. Covers the synthetic
// playlist, serving an already-produced segment, the seek-restart (with its
// argv), restart coalescing, and the leak invariants a restart must not
// break (old ffmpeg killed, session dir KEPT, session registration and
// heartbeat intact, teardown still frees everything).
// ─────────────────────────────────────────────────────────────────────────
{
    const DURATION = 6239.024;             // ~1h44m sample (mpeg4 → transcode path)
    const SEEK_INDEX = 1200;               // 4800s ≈ 80 minutes in
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear();
    produced.clear();
    app._vpSegPollMs = 5;                  // keep the poll loop fast; logic is unchanged
    // mpeg4 video → _vpProbeDecision says x264 → the transcode (seekable) path.
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: DURATION });
    // Model ffmpeg: a run started at -start_number K flushes K, K+1, K+2 shortly
    // after it spawns (the initial run starts at 0).
    onFfmpeg = (argv) => {
        const i = argv.indexOf('-start_number');
        const start = i === -1 ? 0 : parseInt(argv[i + 1], 10);
        setTimeout(() => { for (let k = start; k < start + 3; k++) produced.add(k); }, 10);
    };

    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const sess = ExRT.video.sessions.get('w1');
    assert.ok(sess && sess.hls instanceof FakeHls, 'the transcode session must attach');
    assert.strictEqual(sess.runStart, 0, 'the initial run starts at segment 0');
    assert.strictEqual(sess.codec, 'x264');
    assert.strictEqual(sess.srcPath, '/v/a.avi', 'the source path must be recorded — a restart has to rebuild the same command');
    const initialProc = sess.proc;
    assert.ok(initialProc.argv.join(' ').includes('-force_key_frames'), 'the transcode run must force keyframes onto the segment grid');

    // Drive the loader hls.js was given.
    const Loader = sess.hls.config.pLoader;
    assert.strictEqual(sess.hls.config.fLoader, Loader, 'playlist and fragment loaders are the same class');
    const loadVia = (url, responseType) => new Promise((resolve, reject) => {
        const l = new Loader();
        l.load({ url, responseType: responseType || '' }, {}, {
            onSuccess: (r) => resolve(r.data),
            onError: (e) => reject(new Error('loader error ' + JSON.stringify(e))),
        });
    });

    // (1) The playlist hls.js gets is the SYNTHETIC one — full duration, every
    // segment listed, VOD + ENDLIST — not ffmpeg's growing 3-segment file.
    const text = await loadVia('explorer-preview://sid1/index.m3u8');
    assert.ok(text.includes('#EXT-X-ENDLIST') && text.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
        'hls.js must be handed a complete VOD playlist, or it treats the level as live and refuses to seek');
    const listed = (text.match(/^seg_\d+\.ts$/gm) || []).length;
    assert.strictEqual(listed, Math.ceil(DURATION / V._vpSegSecs),
        'the playlist must cover the whole probed duration up front (got ' + listed + ' segments)');
    assert.ok(text.includes(V._vpSegName(SEEK_INDEX)), 'the seek target must already be listed as a normal segment');
    assert.ok(!spawns.some((a) => a[0] === 'cat' && a.length && String(a[1]).includes('index.m3u8') && false), 'sanity');

    // (2) A segment already on disk is served straight through, with no restart.
    const spawnsBefore = spawns.filter((a) => a[0] === 'ffmpeg').length;
    const frag0 = await loadVia('explorer-preview://sid1/seg_00000.ts', 'arraybuffer');
    assert.ok(frag0 && frag0.byteLength > 0, 'an existing segment must be served as bytes');
    assert.strictEqual(spawns.filter((a) => a[0] === 'ffmpeg').length, spawnsBefore,
        'serving an existing segment must not respawn ffmpeg');

    // (3) THE FEATURE: a fragment request for a region ffmpeg has not reached
    // (and, at 1200 segments ahead, never would in time) restarts ffmpeg there.
    // Two overlapping requests around the same target must coalesce into ONE
    // restart.
    const [fragA, fragB] = await Promise.all([
        loadVia('explorer-preview://sid1/seg_01200.ts', 'arraybuffer'),
        loadVia('explorer-preview://sid1/seg_01201.ts', 'arraybuffer'),
    ]);
    assert.ok(fragA && fragA.byteLength > 0 && fragB && fragB.byteLength > 0,
        'seeking into a not-yet-converted region must actually produce playable bytes');
    const ffmpegRuns = spawns.filter((a) => a[0] === 'ffmpeg');
    assert.strictEqual(ffmpegRuns.length, 2,
        'exactly one restart for a burst of requests around one seek target (got ' + ffmpegRuns.length + ' ffmpeg runs)');
    const restartArgv = ffmpegRuns[1];
    const T = String(SEEK_INDEX * V._vpSegSecs);
    assert.strictEqual(restartArgv[restartArgv.indexOf('-ss') + 1], T, 'the restart must seek the input to the segment boundary');
    assert.ok(restartArgv.indexOf('-ss') < restartArgv.indexOf('-i'), '-ss must precede -i');
    assert.strictEqual(restartArgv[restartArgv.indexOf('-start_number') + 1], String(SEEK_INDEX));
    assert.strictEqual(restartArgv[restartArgv.indexOf('-output_ts_offset') + 1], T);
    assert.strictEqual(restartArgv[restartArgv.length - 1], sess.dir + '/index.m3u8', 'the restart must write into the SAME session dir');

    // (4) Leak/teardown invariants across the restart.
    const after = ExRT.video.sessions.get('w1');
    assert.strictEqual(after, sess, 'the session registration must survive a restart (same entry, same token)');
    assert.strictEqual(after.runStart, SEEK_INDEX, 'the new run start must be recorded, or the next request re-restarts');
    assert.strictEqual(initialProc.closed, 'cancelled', 'the outgoing ffmpeg must be killed — never two ffmpegs per session');
    assert.notStrictEqual(after.proc, initialProc);
    assert.strictEqual(after.proc.closed, null, 'the new run must be alive');
    assert.ok(!spawns.some((a) => a[0] === 'rm' && a[2] === sess.dir),
        'a restart must NOT delete the session dir — the segments already converted stay valid and reusable');
    await new Promise((r) => setTimeout(r, 20));   // let the killed proc's rejection settle
    const w = app._win('w1');
    assert.strictEqual(w.pv.reason, undefined,
        'closing the outgoing ffmpeg is not a failure — it must not surface as an error or tear the session down');
    assert.strictEqual(w.pv.transcodeState, 'transcoding');
    assert.ok(ExRT.video.sessions.get('w1'), 'the session must still be registered after the killed run rejected');
    assert.ok(ExRT.video.hb !== null && activeIntervals.size === 1, 'the heartbeat must keep running across a restart');

    // (5) A seek BACK into an already-converted region is served from disk.
    const spawnsBeforeBack = spawns.filter((a) => a[0] === 'ffmpeg').length;
    const back = await loadVia('explorer-preview://sid1/seg_00001.ts', 'arraybuffer');
    assert.ok(back && back.byteLength > 0);
    assert.strictEqual(spawns.filter((a) => a[0] === 'ffmpeg').length, spawnsBeforeBack,
        'segments from an earlier run are still valid for the same timeline positions — no restart needed');

    // (5b) A segment file that is on disk but NOT yet listed by the run writing
    // it is half-written: it must not be served. (Here seg_01250 "exists" while
    // the run's frontier is 1202 — the gate must force a restart at 1250 rather
    // than hand hls.js a truncated .ts.)
    produced.add(1250);
    const runsBeforeGate = spawns.filter((a) => a[0] === 'ffmpeg').length;
    const gated = await loadVia('explorer-preview://sid1/seg_01250.ts', 'arraybuffer');
    const gateRuns = spawns.filter((a) => a[0] === 'ffmpeg');
    assert.strictEqual(gateRuns.length, runsBeforeGate + 1,
        'a segment past the current run\'s playlist frontier must not be read off disk — it is still being written');
    assert.strictEqual(gateRuns[gateRuns.length - 1][gateRuns[gateRuns.length - 1].indexOf('-start_number') + 1], '1250');
    assert.ok(gated && gated.byteLength > 0, 'and it must still end up served once the run that owns it lists it');
    console.log('OK seek: half-written segment (on disk, not yet listed) is not served — restarted at 1250 instead');

    // (6) Teardown still frees everything after a restart.
    const lastProc = after.proc;
    await V._teardownPreviewVideo.call(app, 'w1');
    assert.strictEqual(ExRT.video.sessions.get('w1'), undefined);
    assert.strictEqual(lastProc.closed, 'cancelled', 'teardown must close the RESTARTED ffmpeg');
    assert.ok(spawns.some((a) => a[0] === 'rm' && a[1] === '-rf' && a[2] === sess.dir), 'teardown must remove the session dir');
    assert.strictEqual(ExRT.video.hb, null);
    console.log('OK seek: synthetic VOD playlist (' + listed + ' segments), 1 coalesced restart at -ss ' + T + '/-start_number ' + SEEK_INDEX + ', dir kept, old ffmpeg killed, teardown clean');
    onFfmpeg = null; produced.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-round-1 (C1): an ABANDONED fragment request must stop dead. hls.js
// aborts the in-flight fragment when the media seeks; before the fix the
// abandoned request's serve loop kept running for its full 30s deadline and
// kept making restart decisions, so it and the new seek's request fought over
// the encoder — reproduced as 6 spawn/kill cycles for a single seek, with
// runStarts ping-ponging [0,1200,5,1200,5,1200]. Here: park a read-ahead
// request for seg 5 in the wait window, abort it, then seek far away — the
// only ffmpeg respawn allowed is the seek's.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    app._vpSegPollMs = 5;
    app._vpSegWaitMs = 4000;
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: 6239.024458 });
    onFfmpeg = (argv) => {
        const i = argv.indexOf('-start_number');
        const start = i === -1 ? 0 : parseInt(argv[i + 1], 10);
        setTimeout(() => { for (let k = start; k < start + 3; k++) produced.add(k); }, 10);
    };
    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const sess = ExRT.video.sessions.get('w1');
    const Loader = sess.hls.config.pLoader;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // seg 5 is inside the tolerance window of a run whose frontier is 2, so it
    // parks in the wait branch (nothing will ever produce it here).
    const stale = new Loader();
    let staleOutcome = null;
    stale.load({ url: 'explorer-preview://sid1/seg_00005.ts', responseType: 'arraybuffer' }, {}, {
        onSuccess: () => { staleOutcome = 'success'; }, onError: (e) => { staleOutcome = e; },
    });
    await wait(60);
    const runsWhileParked = spawns.filter((a) => a[0] === 'ffmpeg').length;
    assert.strictEqual(runsWhileParked, 1, 'a read-ahead request inside the tolerance window must WAIT, not respawn ffmpeg');

    stale.abort();     // hls.js does this on seek
    const seeked = await new Promise((resolve, reject) => {
        new Loader().load({ url: 'explorer-preview://sid1/seg_01200.ts', responseType: 'arraybuffer' }, {}, {
            onSuccess: (r) => resolve(r.data), onError: (e) => reject(new Error(JSON.stringify(e))),
        });
    });
    assert.ok(seeked && seeked.byteLength > 0, 'the seek target must still be produced and served');
    await wait(400);   // ~80 poll intervals: ample time for an un-cancelled loop to fight back

    const runs = spawns.filter((a) => a[0] === 'ffmpeg');
    const runStarts = runs.map((a) => { const i = a.indexOf('-start_number'); return i === -1 ? 0 : parseInt(a[i + 1], 10); });
    assert.deepStrictEqual(Array.from(runStarts), [0, 1200],
        'exactly ONE restart, for the seek — an aborted request must never (re)start ffmpeg. Got runStarts ' + JSON.stringify(runStarts));
    assert.strictEqual(ExRT.video.sessions.get('w1').runStart, 1200, 'the encoder must be left where the live request wants it');
    assert.strictEqual(staleOutcome, null, 'an aborted request must not call back at all');
    console.log('OK C1: aborted read-ahead caused 0 restarts; the seek caused exactly 1 (runStarts ' + JSON.stringify(runStarts) + ')');
    await V._teardownPreviewVideo.call(app, 'w1');
    onFfmpeg = null; produced.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-round-1 (C1, second guard): the same collision, but with the stale
// request NEVER aborted. _vpSegMaxRestarts is then the only thing standing
// between two live loops and an encoder ping-ponging between their targets
// (the reviewer's [0,1200,5,1200,5,1200]). Each request may move it once, so
// the collision costs one wasted respawn and stops — and both requests are
// still served, because a range an earlier run completed stays readable while
// the live run is nowhere near it.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    // Worst case on purpose: NOTHING is ever produced (no onFfmpeg hook), so
    // neither request can be satisfied and both keep re-deciding for their
    // whole deadline. That is the only way the two loops can actually fight —
    // and with the budget in place each may move the encoder just once, so the
    // spawn count is bounded no matter how long they run.
    app._vpSegPollMs = 5;
    app._vpSegWaitMs = 300;
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: 6239.024458 });
    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const sess = ExRT.video.sessions.get('w1');
    const Loader = sess.hls.config.pLoader;
    const req = (name) => new Promise((resolve) => {
        new Loader().load({ url: 'explorer-preview://sid1/' + name, responseType: 'arraybuffer' }, {}, {
            onSuccess: (r) => resolve({ ok: true, bytes: r.data.byteLength }), onError: (e) => resolve({ ok: false, e }),
        });
    });
    const stalePromise = req('seg_00005.ts');          // parks in the wait window, never aborted
    await new Promise((r) => setTimeout(r, 60));
    const seekPromise = req('seg_01200.ts');           // the live request
    const [staleRes, seekRes] = await Promise.all([stalePromise, seekPromise]);
    await new Promise((r) => setTimeout(r, 200));

    const runStarts2 = spawns.filter((a) => a[0] === 'ffmpeg')
        .map((a) => { const i = a.indexOf('-start_number'); return i === -1 ? 0 : parseInt(a[i + 1], 10); });
    assert.ok(runStarts2.length <= 3,
        'the initial run plus at most one respawn per colliding request — got ' + runStarts2.length + ' ffmpeg runs: ' + JSON.stringify(runStarts2)
        + '. Unbounded here is the reported ping-pong: every poll interval kills ffmpeg and respawns it with -ss into the source file.');
    assert.ok(!staleRes.ok && !seekRes.ok, 'with nothing producible both requests must end in a clean 404, not spin forever');
    assert.strictEqual(seekRes.e.code, 404);
    console.log('OK C1 budget: un-aborted collision bounded to ' + runStarts2.length + ' ffmpeg runs ' + JSON.stringify(runStarts2) + ' over ' + app._vpSegWaitMs + 'ms of contention');
    await V._teardownPreviewVideo.call(app, 'w1');
    onFfmpeg = null; produced.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-round-1 (C2): the frontier belongs to the run that produced it. Leaving
// the outgoing run's value in place across a restart let a SECOND restart
// record a doneRuns range for segments the new run had never written — and the
// completeness gate would then read those half-written files.
// ─────────────────────────────────────────────────────────────────────────
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: 6239.024458 });
    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const s = ExRT.video.sessions.get('w1');
    const token = s.token;

    await app._vpRunFrontier(s);                       // initial run: 3 flushed → frontier 2
    assert.strictEqual(s.frontier, 2);
    await app._vpRestartAt('w1', token, 1200);         // records {0,2}
    assert.strictEqual(s.runStart, 1200);
    assert.strictEqual(s.frontier, 1199, 'a fresh run has flushed nothing — its frontier must be reset with runStart');
    await app._vpRunFrontier(s);                       // → 1202
    await app._vpRestartAt('w1', token, 500);          // records {1200,1202}
    // The run at 500 is killed before it flushes anything: its playlist is
    // still empty when the next restart measures it, so there is nothing to
    // record. (Pre-fix this pushed {500, <the previous run's frontier>} — a
    // range covering ~700 segments that had never been written.)
    catQueue = ['#EXTM3U\n#EXT-X-VERSION:3\n'];
    await app._vpRestartAt('w1', token, 100);
    catQueue = null;

    // Array.from: doneRuns is a vm-realm array (see the deepStrictEqual note at
    // the top of tests/videoplayer-unit.mjs).
    const ranges = Array.from(s.doneRuns, (r) => ({ start: r.start, end: r.end }));
    assert.deepStrictEqual(ranges, [{ start: 0, end: 2 }, { start: 1200, end: 1202 }],
        'a run that produced nothing must contribute no completed range. Got ' + JSON.stringify(ranges));
    for (const idx of [500, 600, 900, 1100]) {
        assert.strictEqual(V._vpSegKnownComplete.call(app, { index: idx, runStart: s.runStart, frontier: s.frontier, doneRuns: s.doneRuns }), false,
            'segment ' + idx + ' was never written — the completeness gate must not offer it (a half-written .ts is an MSE append error)');
    }
    assert.strictEqual(V._vpSegKnownComplete.call(app, { index: 1, runStart: s.runStart, frontier: s.frontier, doneRuns: s.doneRuns }), true,
        'genuinely completed ranges must still be reusable');
    console.log('OK C2: doneRuns after restarts 1200→500→100 = ' + JSON.stringify(ranges) + ' (no phantom range)');

    // Fix-round-1 (M4): a RESTARTED run reaching EOF says nothing about the
    // stretch before its start, so it must not flip the badge to 'done'.
    const w = app._win('w1');
    s.proc._exit();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(w.pv.transcodeState, 'transcoding',
        'a run started at a seek target reaching the end of the file must NOT claim the whole video is converted');

    // Fix-round-1 (M5): the restart path must MERGE ranges, not append blindly,
    // or repeated seeking grows doneRuns without bound.
    s.doneRuns = [{ start: 0, end: 99 }];
    s.runStart = 100;                       // its measured frontier will be 100+3-1 = 102
    await app._vpRestartAt('w1', token, 900);
    assert.strictEqual(s.doneRuns.length, 1, 'an adjacent range must merge into the existing one, not be pushed alongside it');
    assert.strictEqual(s.doneRuns[0].start, 0);
    assert.strictEqual(s.doneRuns[0].end, 102);
    console.log('OK M5: [0..99] + [100..102] merged into [0..102] at the restart call site');

    // Only ONE restart in flight per session: two concurrent restart requests
    // must collapse onto the same promise and respawn ffmpeg once. (The
    // segment-level coalescing test above no longer proves this on its own —
    // a second request for a NEARBY index now resolves to 'wait' before it
    // ever asks for a restart, so the gate itself needs its own assertion.)
    const before = spawns.filter((a) => a[0] === 'ffmpeg').length;
    await Promise.all([app._vpRestartAt('w1', token, 700), app._vpRestartAt('w1', token, 700)]);
    assert.strictEqual(spawns.filter((a) => a[0] === 'ffmpeg').length - before, 1,
        'two concurrent restarts must coalesce into a single ffmpeg respawn');
    assert.strictEqual(ExRT.video.sessions.get('w1').restarting, null, 'the in-flight restart promise must be cleared when it settles');
    console.log('OK coalescing: 2 concurrent _vpRestartAt calls → 1 ffmpeg respawn');
    await V._teardownPreviewVideo.call(app, 'w1');
}

// Fix-round-1 (I1b): once the run that owns a range has EXITED, a segment
// beyond its frontier can never appear — fail immediately instead of burning
// the whole deadline (hls.js applies no timeout to a custom loader and retries
// a 404 six times, so waiting turns a phantom final segment into minutes of a
// frozen player).
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    app._vpSegPollMs = 5;
    app._vpSegWaitMs = 30000;      // the REAL deadline: the test must not depend on it
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: 100.048980 });
    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const s = ExRT.video.sessions.get('w1');
    s.proc._exit();                                     // ffmpeg reached EOF
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(s.runExited, true, 'the session must know its run has exited');
    assert.strictEqual(app._win('w1').pv.transcodeState, 'done',
        'the INITIAL run (runStart 0) reaching EOF does mean the whole file is converted');
    const t0 = Date.now();
    const err = await new Promise((resolve) => {
        new (s.hls.config.pLoader)().load({ url: 'explorer-preview://sid1/seg_00099.ts', responseType: 'arraybuffer' }, {}, {
            onSuccess: () => resolve(null), onError: (e) => resolve(e),
        });
    });
    const ms = Date.now() - t0;
    assert.ok(err && err.code === 404, 'a segment past a finished run must report 404');
    assert.ok(ms < 2000, 'it must fail FAST (took ' + ms + 'ms) — waiting out the 30s deadline per 404 retry freezes the player for minutes');
    assert.strictEqual(spawns.filter((a) => a[0] === 'ffmpeg').length, 1, 'and it must not respawn ffmpeg for a segment past the end of the file');
    console.log('OK I1b: segment past a finished run 404s in ' + ms + 'ms instead of waiting out the deadline');
    await V._teardownPreviewVideo.call(app, 'w1');
}

// A segment that never appears must fail the loader (not hang forever) — and a
// session torn down mid-request must stop immediately without restarting
// anything for a window nobody is watching.
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    app._vpSegPollMs = 5;
    app._vpSegWaitMs = 60;                  // real timeout logic, test-scale deadline
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'mpeg4' }], duration: 600 });
    await app.startPreviewVideo('w1', { path: '/v/a.avi' });
    const s = ExRT.video.sessions.get('w1');
    const Loader = s.hls.config.pLoader;
    const err = await new Promise((resolve) => {
        new Loader().load({ url: 'explorer-preview://sid1/seg_00007.ts', responseType: 'arraybuffer' }, {}, {
            onSuccess: () => resolve(null), onError: (e) => resolve(e),
        });
    });
    assert.ok(err && err.code === 404, 'an unproducible segment must come back as a loader error, not a hung request');
    await V._teardownPreviewVideo.call(app, 'w1');
    console.log('OK seek: unproducible segment reports a loader error within the bounded wait');
}

// The remux path must be untouched: no forced keyframes, and hls.js still gets
// ffmpeg's own playlist (its segments are GOP-length, so index→time mapping —
// and therefore the whole restart mechanism — does not hold there).
{
    const app = makeApp();
    spawns.length = 0; procs.length = 0; hlsInstances.length = 0; uidSeq = 0;
    ExRT.video.sessions.clear(); ExRT.video.gen.clear();
    ExRT.video.hb = null; activeIntervals.clear(); produced.clear();
    app._vpProbeStreams = async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264' }], duration: 600 });
    await app.startPreviewVideo('w1', { path: '/v/a.mkv' });
    const s = ExRT.video.sessions.get('w1');
    assert.strictEqual(s.codec, 'copy');
    assert.ok(!s.proc.argv.includes('-force_key_frames'), 'remux must not carry forced keyframes');
    const text = await new Promise((resolve, reject) => {
        new (s.hls.config.pLoader)().load({ url: 'explorer-preview://sid1/index.m3u8', responseType: '' }, {}, {
            onSuccess: (r) => resolve(r.data), onError: (e) => reject(new Error(JSON.stringify(e))),
        });
    }).catch(() => null);
    assert.ok(text === null || !text.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
        'the remux path must keep reading ffmpeg\'s own playlist off disk, not a synthetic one');
    await V._teardownPreviewVideo.call(app, 'w1');
    console.log('OK remux path unchanged: no forced keyframes, no synthetic playlist');
}

// The registry must not live on Alpine-reactive component state.
{
    const app = makeApp();
    assert.strictEqual(app.video._sessions, undefined,
        'session handles must live in ExRT.video.sessions, not on reactive state (js/runtime.js firewall)');
    // Duck-typed, not `instanceof Map`: ExRT is built inside the vm realm, so
    // its Map has a different constructor than this realm's.
    for (const reg of [ExRT.video.sessions, ExRT.video.gen, ExRT.preview.workbooks])
        assert.ok(reg && typeof reg.get === 'function' && typeof reg.set === 'function' && typeof reg.delete === 'function');
    console.log('OK reactivity firewall: sessions/generations live in ExRT');
}

console.log('video-session-unit: OK');
