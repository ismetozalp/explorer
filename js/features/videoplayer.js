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
            '-hls_segment_filename', dir + '/seg_%05d.ts',
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
    async _vpProbeFfmpeg() {
        if (this.video.ffmpeg) return this.video.ffmpeg;
        const check = async (bin) => { try { await cockpit.spawn(['command', '-v', bin], { err: 'ignore' }); return true; } catch (e) { return false; } };
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
    // Kill a bare {proc, dir} pair without touching video._sessions — used
    // when a session has already been superseded (a newer startPreviewVideo
    // call for the same window won the race) so we must free THIS process's
    // resources without deleting the newer, still-live registration.
    async _vpKillProcAndDir(proc, dir) {
        try { proc && proc.close && proc.close('cancelled'); } catch (e) {}
        if (dir) { try { await cockpit.spawn(['rm', '-rf', dir]); } catch (e) {} }
    },
    // Fixed-round-1: unified "this attempt is done, one way or another"
    // cleanup, called from every non-success exit of startPreviewVideo (not
    // just the happy path). `token` is the session id this particular call
    // registered; if it's still the one in video._sessions[winId] we own the
    // pv state and do a full teardown (kills ffmpeg, deletes the on-disk
    // session dir, clears the session). If a newer start already superseded
    // us (rapid ◀/▶ before this one finished waiting), we must NOT touch the
    // newer session or its pv — just kill our own stray process + directory.
    async _vpEndSession(winId, token, proc, dir, reason) {
        const s = this.video._sessions[winId];
        if (s && s.token === token) {
            const ww = this._win(winId);
            if (reason && ww && ww.pv) { ww.pv.reason = reason; ww.pv.transcodeState = 'error'; }
            await this._teardownPreviewVideo(winId);
        } else {
            await this._vpKillProcAndDir(proc, dir);
        }
    },
    // Spawn ffmpeg → HLS in a fresh session dir and attach hls.js to <video id="previewVideo">.
    async startPreviewVideo(winId, file) {
        const w = this._win(winId); if (!w) return;
        await this._teardownPreviewVideo(winId);
        const home = this.homePath || await FS.homeDir();
        const root = this._vpCacheRoot(home);
        const id = Util.uid();
        const dir = this._vpSessionDir(root, id);
        await FS.mkdir(dir);
        const ff = await this._vpProbeFfmpeg();
        const codec = (ff.ffprobe ? this._vpProbeDecision(await this._vpProbeStreams(file.path)) : 'x264');
        // Reflect state in the badge.
        if (w.pv) { w.pv.transcodeState = codec === 'copy' ? 'remuxing' : 'transcoding'; }
        const proc = cockpit.spawn(['ffmpeg', ...this._vpBuildHlsArgs({ inputPath: file.path, dir, videoCodec: codec })], { err: 'message' });
        // Register the session IMMEDIATELY (before any further await) — every
        // exit path below (ensureHls throwing, the playlist wait timing out,
        // being superseded while waiting, hls.js unsupported, or the happy
        // path) can now find this proc+dir via video._sessions[winId] and is
        // responsible for freeing it. `token` (=id) is compared by
        // isCurrent()/_vpEndSession() so a later startPreviewVideo() call for
        // this same window supersedes — and tears down — this one instead of
        // both ffmpeg processes surviving.
        this.video._sessions[winId] = { hls: null, proc, dir, token: id };
        const isCurrent = () => { const s = this.video._sessions[winId]; return !!(s && s.token === id); };
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
            if (!window.Hls || !window.Hls.isSupported() || !el) { this._vpEndSession(winId, id, proc, dir, 'This browser cannot play the converted stream.'); return; }
            const hls = new window.Hls({ pLoader: Loader, fLoader: Loader });
            hls.loadSource(this._vpSourceUrl(id));
            hls.attachMedia(el);
            const s = this.video._sessions[winId];
            if (s && s.token === id) s.hls = hls; // still current: let teardown destroy() it later
        });
    },
    async _teardownPreviewVideo(winId) {
        const s = this.video._sessions[winId];
        if (!s) return;
        delete this.video._sessions[winId];
        try { s.hls && s.hls.destroy(); } catch (e) {}
        await this._vpKillProcAndDir(s.proc, s.dir);
    },
    async reapOrphanPreviews() {
        const home = this.homePath || await FS.homeDir();
        const root = this._vpCacheRoot(home);
        try { await cockpit.spawn(['pkill', '-9', '-f', root]); } catch (e) {}
        try { await cockpit.spawn(['rm', '-rf', root]); } catch (e) {}
    },
};
