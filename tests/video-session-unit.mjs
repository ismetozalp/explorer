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

function makeProc(argv) {
    let settle;
    const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    p.argv = argv;
    p.closed = null;
    p.close = (why) => { p.closed = why || 'closed'; };
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
const cockpit = {
    spawn(argv) {
        spawns.push(argv);
        if (argv[0] === 'ffmpeg') { const p = makeProc(argv); procs.push(p); return p; }
        if (argv[0] === 'cat') {
            const text = (catQueue && catQueue.length) ? catQueue.shift() : FAKE_PLAYLIST;
            const p = Promise.resolve(text); p.close = () => {}; return p;
        }
        // rm -rf <dir> / sh -c … all succeed immediately.
        const p = Promise.resolve('');
        p.close = () => {};
        return p;
    },
    file() { return { read: async () => null, close() {} }; },
};

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
    setTimeout, clearTimeout, Promise, Date,
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
    constructor() { this.destroyed = false; this.src = null; this.media = null; hlsInstances.push(this); }
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
