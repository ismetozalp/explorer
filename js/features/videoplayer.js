// Server-side video playback: ffmpeg remuxes/transcodes a LOCAL file into HLS
// segments in a private cache dir; hls.js plays them via a Cockpit byte-loader.
// Pure helpers here are unit-tested; stateful wiring lives in Task 5's additions.
window.ExplorerVideo = {
    _vpVideoCodecArgs(codec) {
        if (codec === 'x264') return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
        return ['-c:v', 'copy'];
    },
    // Decide remux (copy) vs transcode (x264) from ffprobe stream info.
    _vpProbeDecision(streams) {
        const v = (streams || []).find(s => s.codec_type === 'video');
        return (v && v.codec_name === 'h264') ? 'copy' : 'x264';
    },
    // ffmpeg argv (no leading 'ffmpeg'): read the local file directly → HLS on disk.
    _vpBuildHlsArgs({ inputPath, dir, videoCodec }) {
        return [
            '-y', '-hide_banner',
            '-i', inputPath,
            '-map', '0:v:0?', '-map', '0:a:0?',
            ...this._vpVideoCodecArgs(videoCodec),
            '-c:a', 'aac', '-b:a', '128k',
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '0',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', this._vpSegPattern(dir),
            dir + '/index.m3u8',
        ];
    },
    // ── session paths (ported from InFlightTV session.ts) ──
    _vpCacheRoot(home) { return home + '/.cache/cockpit-explorer/preview'; },
    _vpSessionDir(root, id) { return root + '/' + id; },
    _vpPlaylist(dir) { return dir + '/index.m3u8'; },
    _vpSegPattern(dir) { return dir + '/seg_%05d.ts'; },
    _vpSourceUrl(id) { return 'explorer-preview://' + id + '/index.m3u8'; },
    _vpFileName(url) { return (url.split('/').pop() || '').split('?')[0]; },
    _vpResolveInDir(dir, url) { return dir + '/' + this._vpFileName(url); },
    // ── hls.js Cockpit byte-loader (ported from InFlightTV hlsLoader.ts) ──
    _vpLoaderClass(readFile, resolvePath) {
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const newStats = () => ({ aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
            loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } });
        return class CockpitLoader {
            constructor() { this.context = null; this.stats = newStats(); this._aborted = false; }
            load(context, _config, callbacks) {
                this.context = context; this._aborted = false; this.stats = newStats(); this.stats.loading.start = now();
                Promise.resolve(readFile(resolvePath(context.url))).then((data) => {
                    if (this._aborted) return;
                    if (data == null) { callbacks.onError({ code: 404, text: 'not found' }, context, null, this.stats); return; }
                    let bytes = data;
                    if (context.rangeEnd) bytes = data.subarray(context.rangeStart || 0, context.rangeEnd);
                    const s = this.stats; s.loading.first = now(); s.loading.end = now(); s.loaded = s.total = bytes.byteLength;
                    const out = context.responseType === 'arraybuffer'
                        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
                        : new TextDecoder().decode(bytes);
                    callbacks.onSuccess({ url: context.url, data: out }, s, context, null);
                }).catch((e) => { if (!this._aborted) callbacks.onError({ code: 0, text: String(e) }, context, null, this.stats); });
            }
            abort() { this._aborted = true; this.stats.aborted = true; }
            destroy() { this.abort(); this.context = null; }
        };
    },
    // ── package-manager detection (pure) ──
    _pkgInstallCommand(osReleaseText) {
        const get = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(osReleaseText || ''); return m ? m[1].replace(/^"|"$/g, '').trim() : ''; };
        const id = get('ID').toLowerCase();
        const like = get('ID_LIKE').toLowerCase();
        const has = (s) => id === s || like.split(/\s+/).includes(s);
        if (has('debian') || has('ubuntu') || id === 'linuxmint' || id === 'raspbian') return 'apt-get update && apt-get install -y ffmpeg';
        if (has('fedora') || has('rhel') || has('centos') || id === 'rocky' || id === 'almalinux') return 'dnf install -y ffmpeg';
        if (has('arch') || id === 'manjaro') return 'pacman -S --noconfirm ffmpeg';
        if (has('suse') || id.includes('opensuse') || id === 'sles') return 'zypper install -y ffmpeg';
        if (has('alpine')) return 'apk add ffmpeg';
        return null;
    },
    // ── lazy hls.js loader (mirrors _ensureMarked/_ensureMammoth/_ensureXlsx in editor.js) ──
    async _ensureHls() { await this._ensureScript('js/hls.min.js', 'Hls'); },

    // ── stateful wiring (Task 5) ─────────────────────────────────────────
    // Non-reactive session registry + per-window start generation (see
    // js/runtime.js). Everything below goes through these instead of
    // this.video._sessions, which used to put hls.js/process handles on
    // Alpine reactive state.
    _vpSessions() { return ExRT.video.sessions; },
    // Bump and return this window's start generation. Every startPreviewVideo
    // takes a fresh generation at entry; a teardown bumps it too, so any start
    // still in flight for that window knows it has been superseded.
    _vpNextGen(winId) {
        const g = (ExRT.video.gen.get(winId) || 0) + 1;
        ExRT.video.gen.set(winId, g);
        return g;
    },
    async _vpProbeFfmpeg() {
        if (this.video.ffmpeg) return this.video.ffmpeg;
        // MUST go through `sh -c`: cockpit.spawn() execs argv directly with no
        // shell, and `command` is a shell BUILTIN — /usr/bin/command exists only
        // on Red Hat (shipped by the bash RPM), so argv-exec'ing it fails on
        // Debian/Ubuntu/Alpine and reported ffmpeg as missing everywhere else.
        // Same form as js/features/mounts.js and js/features/terminal.js.
        const check = async (bin) => {
            try { await cockpit.spawn(['sh', '-c', 'command -v ' + bin + ' 2>/dev/null'], { err: 'ignore' }); return true; }
            catch (e) { return false; }
        };
        this.video.ffmpeg = { ffmpeg: await check('ffmpeg'), ffprobe: await check('ffprobe') };
        return this.video.ffmpeg;
    },
    async _vpProbeStreams(path) {
        try {
            const out = await cockpit.spawn(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', path], { err: 'message' });
            const j = JSON.parse(out); return j.streams || [];
        } catch (e) { return []; }
    },
    // Poll (cheap `test -s`, no content read) until ffmpeg has flushed the
    // playlist + first segment, or timeoutMs elapses. hls.js calls our pLoader
    // the instant loadSource() runs; a not-yet-existent manifest resolves
    // `readFile` to null → onError(404) → hls.js's own retry budget for that
    // is short (observed: it does not keep retrying long enough for ffmpeg to
    // catch up), so we wait here instead of racing it.
    // `stopCheck`, if given, is polled too — returning false bails out
    // immediately (used to stop polling the instant a session is torn down
    // or superseded, instead of spawning `test` every 200ms for up to
    // timeoutMs after there's no one left who cares about the answer).
    async _vpWaitForPlaylist(path, timeoutMs, stopCheck) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (stopCheck && !stopCheck()) return false;
            try { await cockpit.spawn(['test', '-s', path], { err: 'ignore' }); return true; } catch (e) {}
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return false;
    },
    // Kill a bare {proc, dir} pair without touching the session registry — used
    // when a session has already been superseded (a newer startPreviewVideo
    // call for the same window won the race) so we must free THIS process's
    // resources without deleting the newer, still-live registration.
    // Failures here are logged, never swallowed silently: a throw out of
    // close()/rm means the ffmpeg process or its segments are still around, and
    // an empty catch turns that leak into an invisible one.
    async _vpKillProcAndDir(proc, dir) {
        try { proc && proc.close && proc.close('cancelled'); } catch (e) { console.warn('explorer: could not close ffmpeg process', e); }
        if (dir) { try { await cockpit.spawn(['rm', '-rf', dir]); } catch (e) { console.warn('explorer: could not remove session dir ' + dir, e); } }
    },
    // Fixed-round-1: unified "this attempt is done, one way or another"
    // cleanup, called from every non-success exit of startPreviewVideo (not
    // just the happy path). `token` is the session id this particular call
    // registered; if it's still the one in ExRT.video.sessions we own the
    // pv state and do a full teardown (kills ffmpeg, deletes the on-disk
    // session dir, clears the session). If a newer start already superseded
    // us (rapid ◀/▶ before this one finished waiting), we must NOT touch the
    // newer session or its pv — just kill our own stray process + directory.
    async _vpEndSession(winId, token, proc, dir, reason) {
        const s = this._vpSessions().get(winId);
        if (s && s.token === token) {
            const ww = this._win(winId);
            if (reason && ww && ww.pv) { ww.pv.reason = reason; ww.pv.transcodeState = 'error'; }
            await this._teardownPreviewVideo(winId);
        } else {
            await this._vpKillProcAndDir(proc, dir);
        }
    },
    // An HLS session is only worth starting for a window the user can actually
    // see: a restored-but-minimized preview (js/core/tabs.js persists open
    // preview windows and reopens them with {minimized:true}) would otherwise
    // burn a full ffmpeg run against a <video> element that is never mounted,
    // then report "this browser cannot play the converted stream" — a wrong
    // diagnosis for a window nobody opened. So the load path only marks the
    // preview `pending`, and the session starts here, the moment the window
    // becomes the visible, active one.
    _vpMaybeStart(winId) {
        const w = this._win(winId);
        if (!w || w.kind !== 'preview' || !w.pv) return;
        if (w.pv.kind !== 'video' || w.pv.mode !== 'hls' || !w.pv.pending) return;
        if (this.activeWinId !== winId || !this.hostVisible) return;
        if (!w._file) return;
        w.pv.pending = false;
        w.pv.transcodeState = 'remuxing';
        // Deliberately not awaited (callers are sync UI paths); the catch keeps
        // a failure from becoming an unhandled rejection with a player stuck on
        // "Remuxing" and no error text.
        this.startPreviewVideo(winId, w._file).catch((e) => {
            const ww = this._win(winId);
            if (ww && ww.pv) { ww.pv.reason = 'Could not start playback: ' + (e && e.message ? e.message : e); ww.pv.transcodeState = 'error'; }
        });
    },
    // Spawn ffmpeg → HLS in a fresh session dir and attach hls.js to <video id="previewVideo">.
    async startPreviewVideo(winId, file) {
        // Generation FIRST, before any await: two starts for one window overlap
        // whenever ◀/▶ is clicked faster than a probe resolves, and the older
        // one must never be able to register (and thereby orphan the newer
        // one's hls.js + ffmpeg, which nothing would then ever free).
        const gen = this._vpNextGen(winId);
        const isNewest = () => ExRT.video.gen.get(winId) === gen;
        const w = this._win(winId); if (!w) return;
        await this._vpDropSession(winId);   // drop any previous session WITHOUT bumping our own generation
        const home = this.homePath || await FS.homeDir();
        const root = this._vpCacheRoot(home);
        const id = Util.uid();
        const dir = this._vpSessionDir(root, id);
        // An unwritable/full ~/.cache must surface as a normal error state, not
        // an unhandled rejection behind a player stuck on "Remuxing".
        try { await FS.mkdir(dir); }
        catch (e) {
            if (isNewest()) { const ww = this._win(winId); if (ww && ww.pv) { ww.pv.reason = 'Could not create the transcode cache directory: ' + (e && e.message ? e.message : e); ww.pv.transcodeState = 'error'; } }
            return;
        }
        // Protect the dir the instant it exists: between here and the session
        // registration below, ffmpeg hasn't spawned yet (no pgrep match) and no
        // heartbeat interval is touching it yet either (the session isn't
        // registered until after ffmpeg spawns) — a second tab's reap landing
        // in that sub-second window would otherwise delete a dir out from under
        // a start that's still in flight. Registration re-touches once the
        // session is live; this is deliberate, harmless overlap.
        this._vpHbTouchDir(dir);
        const ff = await this._vpProbeFfmpeg();
        const codec = (ff.ffprobe ? this._vpProbeDecision(await this._vpProbeStreams(file.path)) : 'x264');
        if (!isNewest()) { await this._vpKillProcAndDir(null, dir); return; }   // superseded while probing — nothing spawned yet
        // Reflect state in the badge.
        if (w.pv) { w.pv.transcodeState = codec === 'copy' ? 'remuxing' : 'transcoding'; }
        const proc = cockpit.spawn(['ffmpeg', ...this._vpBuildHlsArgs({ inputPath: file.path, dir, videoCodec: codec })], { err: 'message' });
        // Register the session IMMEDIATELY (before any further await) — every
        // exit path below (ensureHls throwing, the playlist wait timing out,
        // being superseded while waiting, hls.js unsupported, or the happy
        // path) can now find this proc+dir via ExRT.video.sessions and is
        // responsible for freeing it. `token` (=id) is compared by
        // isCurrent()/_vpEndSession() so a later startPreviewVideo() call for
        // this same window supersedes — and tears down — this one instead of
        // both ffmpeg processes surviving. Registration itself is gated on
        // isNewest(): without that gate a slow older call could overwrite a
        // newer call's entry here and strand the newer hls+ffmpeg forever.
        if (!isNewest()) { await this._vpKillProcAndDir(proc, dir); return; }
        this._vpSessions().set(winId, { hls: null, proc, dir, token: id });
        // Start (or keep alive) the shared heartbeat and protect this brand-new
        // session immediately — before the first interval tick — so a reap
        // that races the very start of playback still sees a fresh .alive.
        this._vpHbEnsure();
        this._vpHbTouchDir(dir);
        const isCurrent = () => { const s = this._vpSessions().get(winId); return !!(isNewest() && s && s.token === id); };
        proc.then(() => {
            if (isCurrent()) { const ww = this._win(winId); if (ww && ww.pv && ww.pv.mode === 'hls') ww.pv.transcodeState = 'done'; }
            else { this._vpKillProcAndDir(proc, dir); } // superseded: ffmpeg exited clean, but its dir is now orphaned — nobody else will ever rm it
        }).catch((e) => { this._vpEndSession(winId, id, proc, dir, 'ffmpeg failed' + (e && e.message ? ': ' + e.message : '')); });
        const readFile = async (p) => { const h = cockpit.file(p, { binary: true }); try { return await h.read(); } catch (e) { return null; } finally { h.close(); } };
        const Loader = this._vpLoaderClass(readFile, (u) => this._vpResolveInDir(dir, u));
        // hls.js is lazy-loaded (no eager <script> tag) — must resolve before
        // touching window.Hls, both for the isSupported() check and `new Hls(...)`.
        try { await this._ensureHls(); }
        catch (e) { await this._vpEndSession(winId, id, proc, dir, 'Could not load the video player (hls.js failed to load).'); return; }
        // Don't hand hls.js a source until ffmpeg has actually produced the
        // manifest + first segment (see _vpWaitForPlaylist).
        const ready = await this._vpWaitForPlaylist(this._vpPlaylist(dir), 60000, isCurrent);
        if (!ready) { await this._vpEndSession(winId, id, proc, dir, 'ffmpeg did not produce a playable stream in time.'); return; }
        if (!isCurrent()) { await this._vpKillProcAndDir(proc, dir); return; } // superseded while waiting
        // hls.js attaches on the next tick once the <video> element exists.
        this.$nextTick(() => {
            if (!isCurrent()) { this._vpKillProcAndDir(proc, dir); return; } // superseded during the tick
            const el = document.getElementById('previewVideo');
            // Two distinct failures, two distinct messages: no <video> in the
            // DOM means this window isn't on screen (nothing to attach to), and
            // saying "this browser cannot play it" there is a false diagnosis.
            if (!el) { this._vpEndSession(winId, id, proc, dir, 'The video player is not on screen — reopen the preview to play this file.'); return; }
            if (!window.Hls || !window.Hls.isSupported()) { this._vpEndSession(winId, id, proc, dir, 'This browser cannot play the converted stream (HLS is not supported here).'); return; }
            const hls = new window.Hls({ pLoader: Loader, fLoader: Loader });
            hls.loadSource(this._vpSourceUrl(id));
            hls.attachMedia(el);
            const s = this._vpSessions().get(winId);
            if (isNewest() && s && s.token === id) s.hls = hls; // still current: let teardown destroy() it later
            else { try { hls.destroy(); } catch (e) { console.warn('explorer: hls destroy failed', e); } this._vpKillProcAndDir(proc, dir); }
        });
    },
    // Free a window's session without touching its generation counter — used by
    // startPreviewVideo, which has already taken its own generation and must
    // not invalidate itself.
    async _vpDropSession(winId) {
        const s = this._vpSessions().get(winId);
        if (!s) return;
        this._vpSessions().delete(winId);
        this._vpHbMaybeStop();   // last session gone? kill the shared heartbeat timer.
        try { s.hls && s.hls.destroy(); } catch (e) { console.warn('explorer: hls destroy failed', e); }
        await this._vpKillProcAndDir(s.proc, s.dir);
    },
    async _teardownPreviewVideo(winId) {
        // Bump the generation so a start still in flight for this window (the
        // ◀/▶ and close paths call this without awaiting the start) knows it
        // has been superseded and frees its own process instead of registering.
        this._vpNextGen(winId);
        await this._vpDropSession(winId);
    },
    // ── liveness heartbeat ──────────────────────────────────────────────
    // ffmpeg EXITS once it has finished remuxing/transcoding, but hls.js keeps
    // reading the already-written segments off disk for the rest of playback
    // — so "is there an ffmpeg for this dir?" stops being true long before the
    // dir stops being needed. A second Explorer tab's startup reap would then
    // see no process, assume garbage, and rm -rf a dir tab A is still playing.
    // Fix: while any session is live, touch <dir>/.alive for every session dir
    // every ~30s — proof of a live *player*, independent of ffmpeg. The reap
    // (see _vpReapScript) treats a fresh .alive as "still in use" even with no
    // matching process. Reading segment files does NOT bump their mtime, so an
    // mtime-only heuristic on the segments themselves would not work — this is
    // why a dedicated marker file exists.
    //
    // One shared interval for every live session (not one timer per session),
    // stored on ExRT.video.hb — never on Alpine-reactive state (see
    // js/runtime.js's reactivity-firewall comments: a timer handle is exactly
    // the kind of thing that firewall exists for).
    _vpHbIntervalMs: 30000,
    async _vpHbTouchDir(dir) {
        if (!dir) return;
        try { await cockpit.spawn(['touch', dir + '/.alive'], { err: 'ignore' }); }
        catch (e) { console.warn('explorer: heartbeat touch failed for ' + dir, e); }
    },
    async _vpHbTouchAll() {
        const dirs = Array.from(this._vpSessions().values(), (s) => s.dir).filter(Boolean);
        if (!dirs.length) return;
        try { await cockpit.spawn(['touch', ...dirs.map((d) => d + '/.alive')], { err: 'ignore' }); }
        catch (e) { console.warn('explorer: heartbeat touch failed', e); }
    },
    // Idempotent: safe to call on every session registration. Only starts a
    // timer when none is running and at least one session exists.
    _vpHbEnsure() {
        if (ExRT.video.hb || this._vpSessions().size === 0) return;
        ExRT.video.hb = setInterval(() => { this._vpHbTouchAll(); }, this._vpHbIntervalMs);
    },
    // Call after removing a session from the registry. Stops the shared timer
    // once nobody is left to protect — every teardown path (_vpDropSession,
    // and therefore _teardownPreviewVideo/_removeWindow/supersede paths that
    // funnel through it) ends up here.
    _vpHbMaybeStop() {
        if (this._vpSessions().size > 0) return;
        if (ExRT.video.hb) { clearInterval(ExRT.video.hb); ExRT.video.hb = null; }
    },

    // The reap shell script, as a standalone string so the unit test can run
    // exactly what ships (see tests/preview-reap-unit.mjs) instead of a copy
    // that could silently drift from the real one.
    //
    // Startup cleanup of leftover session dirs. Scoped: it removes only session
    // directories that NO running process refers to AND that have no recent
    // heartbeat. The previous blanket `pkill -9 -f <root>` + `rm -rf <root>`
    // also killed the ffmpeg of a SECOND Explorer tab and deleted its segments
    // mid-playback. A dir whose ffmpeg is still alive is indistinguishable from
    // another tab's live session, so it is left alone (cockpit-bridge kills a
    // session's processes when its channel closes, so a genuinely orphaned
    // ffmpeg is transient); ditto a dir with a fresh .alive heartbeat (§ above).
    //
    // `pgrep -f "$d" >/dev/null 2>&1` cannot tell "no match" (exit 1) apart from
    // "pgrep isn't installed" (exit 127) by exit code alone — treating both as
    // "no process" turned a missing procps package into "delete every session
    // dir, including ones in active use". Bailing out entirely via
    // `command -v pgrep || exit 0` when the binary isn't available makes that
    // failure mode inert instead of destructive: the reap simply does nothing
    // that run, rather than guessing. (This is the approach chosen over
    // branching on 126/127 per-iteration: pgrep's absence can't change mid-loop,
    // so checking once up front is simpler and just as safe, and it also covers
    // any other reason `command -v` might fail to resolve it.)
    //
    // Fix-round-1: the SAME reasoning applies to `find`, which now guards the
    // .alive liveness check — `$(find "$d/.alive" -mmin -2 2>/dev/null)` with
    // `find` missing/failing silently returns an empty string (the `2>/dev/null`
    // hides exactly why), so `[ -n "$(...)" ]` is false and the loop falls
    // through to `rm -rf "$d"` even for a dir with a brand-new heartbeat — the
    // exact outcome the heartbeat exists to prevent. An absent tool must never
    // silently flip a safety check into a destructive default, so `find` gets
    // the same up-front `command -v` bail as `pgrep`.
    _vpReapScript() {
        return '[ -d "$1" ] || exit 0\n'
            + 'command -v pgrep >/dev/null 2>&1 || exit 0\n'
            + 'command -v find  >/dev/null 2>&1 || exit 0\n'
            + 'for d in "$1"/*/; do d=${d%/}; [ -d "$d" ] || continue\n'
            + '  pgrep -f "$d" >/dev/null 2>&1 && continue\n'
            + '  [ -n "$(find "$d/.alive" -mmin -2 2>/dev/null)" ] && continue\n'
            + '  rm -rf "$d"\n'
            + 'done\n';
    },
    async reapOrphanPreviews() {
        const home = this.homePath || await FS.homeDir();
        const root = this._vpCacheRoot(home);
        try { await cockpit.spawn(['sh', '-c', this._vpReapScript(), 'sh', root], { err: 'ignore' }); }
        catch (e) { console.warn('explorer: preview cache reap failed', e); }
    },

    // ── turn-key ffmpeg install (Task 6) ────────────────────────────────
    // Confirm-gated superuser run of the distro-detected install command
    // (see _pkgInstallCommand), streaming output into video.installLog. On
    // success, forces a fresh _vpProbeFfmpeg() and retries the preview.
    async installFfmpeg(winId) {
        const w = this._win(winId); if (!w || !w.pv) return;
        const cmd = w.pv.installCmd;
        if (!cmd) { this.toast('No package-manager command detected', 'danger'); return; }
        const ok = await this.askConfirm('Install ffmpeg?', 'This runs, as administrator:\n\n' + cmd + '\n\nContinue?', 'Install');
        if (!ok) return;
        this.video.installLog = '$ ' + cmd + '\n';
        try {
            const proc = cockpit.spawn(['sh', '-c', cmd], { superuser: 'require', err: 'out' });
            proc.stream((data) => { this.video.installLog += data; });
            await proc;
            this.video.ffmpeg = null;                       // force a fresh probe
            const ff = await this._vpProbeFfmpeg();
            if (ff.ffmpeg) { this.video.installLog += '\nffmpeg installed — starting playback.\n'; await this._loadPreviewInto(winId, w._file); }
            else this.video.installLog += '\nInstall finished but ffmpeg still not found. Check the output above.\n';
        } catch (e) {
            this.video.installLog += '\nInstall failed: ' + (e.message || e) + '\n';
            this.toast('ffmpeg install failed', 'danger');
        }
    },
};
