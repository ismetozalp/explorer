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
    // Without a playlist-type tag, ffmpeg writes a plain live-style playlist
    // (no #EXT-X-PLAYLIST-TYPE, and no #EXT-X-ENDLIST until the whole encode
    // finishes), which hls.js reads as a LIVE stream — reporting duration as
    // only the segments written so far (the "length shows ~7 seconds" bug —
    // that's literally the first segment's #EXTINF).
    //
    // FIX A originally shipped as `-hls_playlist_type vod` per an earlier
    // diagnosis, but that was disproven while live-verifying against the
    // user's real files on THIS host's ffmpeg (7.1.5): with `vod`, ffmpeg
    // buffers the entire playlist in memory and does not write index.m3u8 to
    // disk AT ALL until the muxer closes (full completion, or a termination
    // signal that triggers ffmpeg's graceful-shutdown path) — confirmed by
    // polling for the file every 500ms with no kill signal involved: it
    // never appeared while ffmpeg kept writing hundreds of .ts segments.
    // That starves FIX B's buffering wait for any file whose full encode
    // outlives the wait's timeout — i.e. it reproduces "ffmpeg did not
    // produce a playable stream in time" for exactly the transcode case this
    // was meant to fix. It's also unnecessary: inspecting the vendored
    // js/hls.min.js directly shows hls.js's `live` flag is driven ONLY by
    // the presence of `#EXT-X-ENDLIST` in the parsed playlist — the
    // PLAYLIST-TYPE tag's value is stored but never read for that decision
    // — so `vod` bought nothing for the live/duration behavior it was meant
    // to fix, while breaking incremental publishing.
    //
    // `event` is the flag that actually works here: verified empirically to
    // write index.m3u8 incrementally (appears within ~1s, matching the
    // untyped/default timing, and keeps growing segment-by-segment — for
    // both a remux and a real transcode of the user's files, the wait
    // target of 30s of buffered #EXTINF was reached in 1-3s of wall time),
    // and it still appends #EXT-X-ENDLIST once ffmpeg reaches EOF naturally
    // (verified with a truncated clip). It also isn't a no-op: the vendored
    // hls.js explicitly excludes EVENT-type levels from its `waitForLive`
    // gate (grep js/hls.min.js for `waitForLive`), which otherwise makes a
    // still-"live" (no-ENDLIST) level keep waiting rather than starting.
    //
    // `-ac 2`: found live-verifying against a real 5.1-AC3 source file
    // (`ffprobe` confirmed channels:6, channel_layout:"5.1(side)").
    // Without an explicit channel count,
    // ffmpeg's AAC encoder preserves the source layout, so `-c:a aac`
    // produced 6-channel AAC — confirmed via ffprobe on an actual output
    // segment. Chromium's MediaSource Extensions does not reliably accept
    // multichannel AAC: hls.js hit a native `SourceBuffer 'error'` event on
    // every single audio append, its media-error auto-recovery kept
    // detaching/reattaching (observed 30+ cycles/10s, forever), and the
    // <video> element's readyState never left HAVE_NOTHING — the exact
    // "badge says Remuxing, playback never starts" symptom from the bug
    // report, and unrelated to the live/duration issue FIX A/B address.
    // Forcing a stereo downmix (`-ac 2`, applied regardless of source
    // layout — cheap, and every source this maps through is either already
    // stereo/mono or a multichannel mix not worth preserving through a
    // lossy 128k preview transcode anyway) produces plain 2-channel AAC,
    // confirmed via ffprobe and via a live end-to-end replay of this exact
    // file (see the delivery report for the observed numbers).
    //
    // ── SEEK SUPPORT (3.1.0) ────────────────────────────────────────────
    // `-force_key_frames expr:gte(t,n_forced*SEG)` (transcode path only) is
    // what makes time↔segment mapping deterministic: the encoder is forced to
    // put a keyframe at the first frame at/after every multiple of SEG, and
    // `-hls_time SEG` then cuts there, so segment k always covers
    // [k*SEG, (k+1)*SEG) — measured on this host as a uniform 4.004s per
    // segment for 23.976fps content (the +0.004 is just frame quantisation:
    // the first frame at/after t=4.0 lands at 96/23.976). Without forced
    // keyframes ffmpeg can only cut on the source's own GOP boundaries, which
    // are irregular, and "which segment holds minute 80?" becomes unanswerable
    // without reading every segment.
    //
    // It is deliberately NOT applied on the remux path (`-c:v copy`): there is
    // no encoder to force keyframes on, the segments stay GOP-length and
    // variable, so the synthetic-playlist/seek machinery below is disabled for
    // remux and that path behaves exactly as it did in 3.0.x.
    //
    // `startIndex > 0` builds a RESTART run for a seek into a not-yet-converted
    // region (see _vpRestartAt):
    //   -ss <k*SEG>              input-side (fast) seek to the segment boundary
    //   -start_number <k>        write seg_<k>.ts, seg_<k+1>.ts, … so the output
    //                            lands exactly where the playlist expects it
    //   -output_ts_offset <k*SEG> keep the output timestamps on the GLOBAL
    //                            timeline, so the restarted run's media PTS
    //                            continue where the timeline says they should
    //                            and no #EXT-X-DISCONTINUITY handling is needed.
    _vpBuildHlsArgs({ inputPath, dir, videoCodec, startIndex }) {
        const seg = this._vpSegSecs;
        const k = Number.isFinite(startIndex) && startIndex > 0 ? Math.floor(startIndex) : 0;
        const offset = this._vpSegStartTime(k);
        return [
            '-y', '-hide_banner',
            ...(k > 0 ? ['-ss', String(offset)] : []),
            '-i', inputPath,
            '-map', '0:v:0?', '-map', '0:a:0?',
            ...this._vpVideoCodecArgs(videoCodec),
            ...(videoCodec === 'x264' ? ['-force_key_frames', 'expr:gte(t,n_forced*' + seg + ')'] : []),
            '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
            '-f', 'hls',
            '-hls_time', String(seg),
            '-hls_playlist_type', 'event',
            '-hls_list_size', '0',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'mpegts',
            ...(k > 0 ? ['-start_number', String(k), '-output_ts_offset', String(offset)] : []),
            '-hls_segment_filename', this._vpSegPattern(dir),
            dir + '/index.m3u8',
        ];
    },
    // ── segment/time mapping + synthetic playlist (all PURE, unit-tested) ──
    // One constant everything derives from: the nominal segment length in
    // seconds, used for -hls_time, the forced-keyframe expression, the
    // synthetic playlist's #EXTINF values and the time↔index mapping. Changing
    // it changes all of them together, which is the point.
    _vpSegSecs: 4,
    _vpSegName(index) { return 'seg_' + String(index).padStart(5, '0') + '.ts'; },
    // 'seg_00042.ts' → 42; anything else (index.m3u8, junk) → null.
    _vpSegIndexFromName(name) {
        const m = /^seg_(\d+)\.ts$/.exec(name || '');
        return m ? parseInt(m[1], 10) : null;
    },
    // Timeline position of a segment boundary, and the reverse mapping.
    _vpSegStartTime(index) { return (index > 0 ? index : 0) * this._vpSegSecs; },
    _vpSegIndexForTime(t) {
        if (!Number.isFinite(t) || t <= 0) return 0;
        return Math.floor(t / this._vpSegSecs);
    },
    // Fix-round-1 (I1a): a trailing remainder shorter than one frame is not a
    // segment. ffmpeg has no frame to put in it, so it writes one FEWER segment
    // than ceil(duration/segDur) claims — and a segment the encoder will never
    // produce is a phantom the player waits on forever (hls.js applies no
    // timeout to a custom loader and retries a 404 six times with backoff).
    // Reproduced with real ffmpeg: a probed duration of 100.048980s (remainder
    // 0.048980s) declared 26 segments where ffmpeg produced 25. 0.05s is just
    // over one frame at 20fps — below any frame rate this path realistically
    // handles, so it never drops a segment that would have had content.
    _vpSegMinTailSecs: 0.05,
    // Number of segments a file of `duration` seconds maps to (the last one is
    // short unless the duration divides exactly). 0 for an unknown/unusable
    // duration — the caller then falls back to ffmpeg's own playlist.
    _vpSegCount(duration) {
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return 0;
        const whole = Math.floor(duration / this._vpSegSecs);
        const tail = duration - whole * this._vpSegSecs;
        if (tail >= this._vpSegMinTailSecs) return whole + 1;
        return Math.max(whole, 1);   // a sub-frame tail folds into the previous segment
    },
    // PURE: add `range` to a sorted, non-overlapping list of {start,end} segment
    // ranges, merging anything it touches (adjacent counts: [0,40] and [41,90]
    // are one continuous stretch of segments). Keeps doneRuns from growing
    // without bound when a user seeks repeatedly, and keeps the lookup in
    // _vpSegKnownComplete short.
    _vpMergeRanges(ranges, range) {
        const all = (ranges || []).concat([range]).slice().sort((a, b) => a.start - b.start);
        const out = [];
        for (const r of all) {
            const last = out[out.length - 1];
            if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
            else out.push({ start: r.start, end: r.end });
        }
        return out;
    },
    // PURE: the whole point of the 3.1.0 seek work. hls.js is handed THIS
    // playlist instead of ffmpeg's, so it learns the file's real duration and
    // its full segment list up front — #EXT-X-PLAYLIST-TYPE:VOD plus a closing
    // #EXT-X-ENDLIST is what makes hls.js treat the level as complete (its
    // `live` flag is driven solely by ENDLIST — see the long note on
    // _vpBuildHlsArgs), so the player's own scrubber shows the true length
    // immediately and every position on it is seekable. Segments that ffmpeg
    // hasn't produced yet are listed anyway; _vpServeSegment is responsible for
    // making them appear (by waiting, or by restarting ffmpeg at that point).
    // Returns null when the duration is unknown/unusable.
    _vpBuildVodPlaylist(duration) {
        const n = this._vpSegCount(duration);
        if (!n) return null;
        const seg = this._vpSegSecs;
        // The last entry carries whatever is left, which after the sub-frame
        // clamp in _vpSegCount can be marginally MORE than one segment — so
        // TARGETDURATION is derived from it rather than assumed to be `seg`.
        const lastDur = duration - (n - 1) * seg;
        const out = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-TARGETDURATION:' + Math.max(Math.ceil(seg), Math.ceil(lastDur)),
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-INDEPENDENT-SEGMENTS',
        ];
        for (let k = 0; k < n; k++) {
            const d = k === n - 1 ? lastDur : seg;
            out.push('#EXTINF:' + d.toFixed(6) + ',');
            out.push(this._vpSegName(k));
        }
        out.push('#EXT-X-ENDLIST');
        return out.join('\n') + '\n';
    },
    // How far ahead of the current ffmpeg run's frontier a requested segment may
    // be before we treat the request as a SEEK rather than as normal buffering.
    // hls.js reads ahead of the playhead (its default maxBufferLength is 30s ≈
    // 7 segments here, but it requests them one at a time, so a request lands at
    // most a segment or two beyond what ffmpeg has flushed while it keeps up).
    // 3 segments ≈ 12s of tolerance: comfortably absorbs a transcoder that has
    // momentarily fallen behind the reader (wait — it will arrive in seconds),
    // while a real seek is always hundreds or thousands of segments away and so
    // is never mistaken for buffering. Deliberately small: restarting when we
    // could have waited costs a whole ffmpeg respawn, so the bias is towards
    // waiting.
    _vpSegAheadTolerance: 3,
    // Upper bound on how long a single segment request may block before the
    // loader reports failure to hls.js. Covers the worst realistic case: a
    // restart (ffmpeg spawn + input seek + encoding the first 4s segment) on a
    // slow host. Same order as the 30s start-buffer target.
    _vpSegWaitMs: 30000,
    _vpSegPollMs: 250,
    // Fix-round-1 (C1): how many times ONE fragment request may move the
    // encoder. One is enough by construction — a restart is aimed at exactly
    // the segment being requested, so the very next run produces it — and it
    // caps the damage from any request that outlives the fragment it was for:
    // it can waste at most one respawn, never trade the encoder back and forth
    // with a live request. A request that still can't be served then reports
    // 404 and hls.js retries with a fresh budget.
    _vpSegMaxRestarts: 1,
    // PURE: is segment `index` known to be COMPLETE on disk?
    //
    // "The file exists" is NOT the same as "the segment is playable": ffmpeg
    // creates a segment file when it STARTS writing it and only appends the
    // matching #EXTINF to its playlist when it CLOSES it. Handing hls.js a
    // half-written .ts is a demux error / stall, and it is exactly what happens
    // on a host where the encode barely outruns playback — the case the old
    // code never hit, because hls.js then only ever asked for segments ffmpeg
    // had already listed. (ffmpeg's own `-hls_flags temp_file` would give
    // atomic segment writes, but it was tried and rejected: on this ffmpeg it
    // also defers the PLAYLIST write to muxer close, so index.m3u8 stays 0
    // bytes for the whole run — that starves both the start-buffer gate and the
    // progress read below. Same trap as `-hls_playlist_type vod`.)
    //
    // So completeness is answered in two steps:
    //   • [runStart .. frontier] is the span the LIVE run has written, and its
    //     playlist is the authority for it — index <= frontier means closed,
    //     index == frontier+1 means "being written right now";
    //   • anything OUTSIDE that span the live run has not touched (it has not
    //     got there yet, or it starts above it), so an earlier run's record can
    //     be trusted: `doneRuns` holds the ranges each superseded run was last
    //     observed to have completed, and a restart never deletes segments, so
    //     those files are still there and still valid for the same timeline
    //     positions. Anything in neither is treated as unavailable (worst case:
    //     one extra restart to re-produce a segment that may in fact have been
    //     fine — the safe direction to be wrong in).
    // Checking the live span FIRST is what keeps this honest when a restarted
    // run encodes back over a range an earlier run had completed: while it is
    // rewriting seg k, k is inside [runStart..frontier+1] and the frontier — not
    // the stale doneRuns entry — decides.
    _vpSegKnownComplete({ index, runStart, frontier, doneRuns }) {
        if (!Number.isFinite(index) || !Number.isFinite(runStart)) return false;
        if (Number.isFinite(frontier) && index >= runStart) {
            if (index <= frontier) return true;        // the live run has closed it
            if (index <= frontier + 1) return false;   // the live run is writing it RIGHT NOW
        }
        return (doneRuns || []).some((r) => index >= r.start && index <= r.end);
    },
    // PURE: wait, restart, or serve? Decided from numbers only, so it is
    // directly unit-testable.
    //   ready     — the segment is on disk AND known complete (see
    //               _vpSegKnownComplete); a previous run's output is just as
    //               valid as this run's, it is the same timeline
    //   index     — the segment hls.js asked for
    //   runStart  — the `-start_number` of the ffmpeg run that is currently
    //               running (0 for the initial run)
    //   frontier  — the highest index this run is known to have produced
    //               (runStart-1 when it hasn't flushed anything yet)
    // A request BELOW runStart can never be satisfied by waiting: this run only
    // ever writes forward from runStart, so the user must have seeked back into
    // a hole — restart. A request far ABOVE the frontier is a forward seek into
    // a region this run would only reach after minutes/hours of encoding —
    // restart. Everything in between is ordinary read-ahead — wait.
    _vpSegAction({ ready, index, runStart, frontier }) {
        if (ready) return 'serve';
        if (!Number.isFinite(runStart) || !Number.isFinite(index)) return 'restart';
        if (index < runStart) return 'restart';
        const f = Number.isFinite(frontier) ? frontier : runStart - 1;
        return index <= f + this._vpSegAheadTolerance ? 'wait' : 'restart';
    },
    // PURE: how many segments has the current ffmpeg run flushed? ffmpeg appends
    // one #EXTINF to its own playlist per completed segment, so counting them is
    // a cheap, allocation-free progress read (one `cat`, no directory listing).
    _vpCountSegments(text) {
        if (!text) return 0;
        const m = text.match(/#EXTINF:/g);
        return m ? m.length : 0;
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
    // Fix-round-1 (C1): `readFile` is called with a SECOND argument, an
    // `isAborted()` probe bound to this loader instance. abort()/destroy() used
    // to only suppress the callback, which is fine for a plain file read but not
    // for the 3.1.0 on-demand segment producer: that one can run for up to 30s
    // and can respawn ffmpeg, so an abandoned request kept making restart
    // decisions for a fragment nobody wanted any more — two live loops (the
    // abandoned read-ahead and the new seek) then fought over the encoder,
    // ping-ponging it between their two targets. hls.js aborts the in-flight
    // fragment when the media seeks; propagating that is what makes the
    // abandoned request stop instead of racing.
    _vpLoaderClass(readFile, resolvePath) {
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const newStats = () => ({ aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
            loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } });
        return class CockpitLoader {
            constructor() { this.context = null; this.stats = newStats(); this._aborted = false; }
            load(context, _config, callbacks) {
                this.context = context; this._aborted = false; this.stats = newStats(); this.stats.loading.start = now();
                Promise.resolve(readFile(resolvePath(context.url), () => this._aborted)).then((data) => {
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
    // Header helper (FIX C/D template guard): the badge + duration display now
    // live in the modal title bar, outside the x-if that used to guarantee
    // pv.kind === 'video' && pv.mode === 'hls' for every expression under it
    // (see html/modals/windows.html). The title bar renders for EVERY window
    // kind, so `activeWin().pv.transcodeState` unguarded would throw a
    // TypeError the instant an editor window (no .pv at all) is active —
    // Alpine re-evaluates :class/x-text bindings even while x-show hides the
    // element (see the "activeWin() && guards throughout" comment already in
    // that file). Centralizing the full guard chain here means every header
    // expression can call this once instead of repeating (and risking
    // drifting) a 5-clause guard.
    _vpHeaderPv() {
        const w = this.activeWin && this.activeWin();
        if (!w || w.kind !== 'preview' || !w.pv || w.pv.kind !== 'video' || w.pv.mode !== 'hls') return null;
        return w.pv;
    },
    // Format a duration in seconds as H:MM:SS (or M:SS under an hour) for the
    // header display (FIX D). Anything that isn't a positive finite number
    // (unprobed, ffprobe missing/failed, unparsable) renders as '' rather than
    // NaN/0:00 — the caller x-shows on this being non-empty.
    _vpFormatDuration(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
        // Round FIRST, then reject a zero result — Fix-round-1: a value like
        // 0.4 passes the `seconds <= 0` guard above (it's positive) but
        // rounds to 0, which used to fall through and render as the
        // misleading '0:00' instead of ''.
        const total = Math.round(seconds);
        if (total <= 0) return '';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s));
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
    // FIX D: also fetches format=duration alongside the stream entries (one
    // ffprobe call, not two) so the header can show the file's real total
    // length immediately — hls.js's own duration only grows as segments are
    // written, which is what made a 5741s file briefly read as "7 seconds".
    // Returns { streams, duration } — duration is a number of seconds, or
    // null if ffprobe failed or the field couldn't be parsed (never NaN).
    async _vpProbeStreams(path) {
        try {
            const out = await cockpit.spawn(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', path], { err: 'message' });
            const j = JSON.parse(out);
            const raw = j.format && j.format.duration;
            const duration = raw != null ? parseFloat(raw) : NaN;
            return { streams: j.streams || [], duration: Number.isFinite(duration) ? duration : null };
        } catch (e) { return { streams: [], duration: null }; }
    },
    // FIX B: target amount of playlist content (summed #EXTINF, in seconds)
    // to have on disk before handing the source to hls.js. Segments here run
    // ffmpeg's `-hls_time 4` target (7-12s observed on the user's real
    // files), so this is typically 3-5 segments. Named so it's easy to tune.
    _vpStartBufferTargetSecs: 30,
    // Pure decision (unit-tested directly, no cockpit involved): given raw
    // m3u8 playlist text, has ffmpeg written enough for playback to start
    // without immediately stalling at the edge? Either the encode is already
    // finished (#EXT-X-ENDLIST present — a short clip must not wait for a
    // buffer target it will never reach) or the summed #EXTINF durations
    // reach targetSecs.
    _vpPlaylistBuffered(text, targetSecs) {
        if (!text) return false;
        if (text.includes('#EXT-X-ENDLIST')) return true;
        let total = 0;
        const re = /#EXTINF:([0-9.]+)/g;
        let m;
        while ((m = re.exec(text))) total += parseFloat(m[1]) || 0;
        return total >= targetSecs;
    },
    // Pure (unit-tested): does this playlist text list at least one media
    // segment at all? Fix-round-1 — used by the degrade path below: the 60s
    // backstop must not be all-or-nothing. Raising the bar from "one segment
    // exists" to "~30s buffered" (FIX B) made the OLD single boolean outcome
    // ("ready" vs "kill everything, hard error") much likelier to land on
    // the destructive branch on a slow host (a 0.3-0.5x realtime transcode
    // needs 60-100s of wall time just to reach 30s of encoded content) —
    // for a file that used to play (with stalls) under the pre-fix code,
    // this outright breaks it. So the backstop now asks a narrower
    // question: is there ANYTHING to play yet, even short of the target?
    _vpPlaylistHasSegments(text) {
        return !!(text && /#EXTINF:/.test(text));
    },
    // Poll until ffmpeg has flushed enough playlist content to start playback
    // (see _vpPlaylistBuffered / _vpStartBufferTargetSecs), or timeoutMs
    // elapses as a backstop. Reads the playlist's actual text every tick
    // (needed to sum #EXTINF — a bare existence check can no longer answer
    // "is there enough buffered yet"); `cat`-ing a not-yet-existent file just
    // rejects, which is treated the same as "not buffered" and retried.
    // hls.js calls our pLoader the instant loadSource() runs; a not-yet-ready
    // manifest resolves `readFile` to null → onError(404) → hls.js's own
    // retry budget for that is short (observed: it does not keep retrying
    // long enough for ffmpeg to catch up), so we wait here instead of racing
    // it.
    // `stopCheck`, if given, is polled too — returning false bails out
    // immediately (used to stop polling the instant a session is torn down
    // or superseded, instead of reading the playlist every 200ms for up to
    // timeoutMs after there's no one left who cares about the answer).
    //
    // Returns `{ status, text }` — Fix-round-1 (was a bare boolean): the
    // caller needs the LAST read playlist text to decide, on a timeout,
    // whether to degrade (attach with whatever's on disk) or genuinely
    // error (nothing at all was ever produced). `status` is 'buffered'
    // (target reached or ENDLIST seen), 'superseded' (stopCheck said stop —
    // caller must not touch pv, just free this attempt's resources), or
    // 'timeout' (deadline passed short of the target).
    async _vpWaitForPlaylist(path, timeoutMs, stopCheck) {
        const deadline = Date.now() + timeoutMs;
        let lastText = null;
        while (Date.now() < deadline) {
            if (stopCheck && !stopCheck()) return { status: 'superseded', text: lastText };
            let text = null;
            try { text = await cockpit.spawn(['cat', path], { err: 'ignore' }); } catch (e) {}
            lastText = text;
            if (this._vpPlaylistBuffered(text, this._vpStartBufferTargetSecs)) return { status: 'buffered', text };
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { status: 'timeout', text: lastText };
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
    // ── ffmpeg run lifecycle (one run at a time per session) ─────────────
    // Watch the ffmpeg process of a session's CURRENT run. Split out of
    // startPreviewVideo because a session can now go through several runs (the
    // initial one plus one per seek-restart), and each run's exit has to be
    // interpreted relative to the session as it stands when it exits:
    //   • still the current run of this session → the encode finished normally
    //     ('done' badge) or failed (error + full teardown, as before);
    //   • session gone (window closed / superseded by a newer start) → nobody
    //     will ever free this process or its dir, so do it here (unchanged
    //     3.0.x behaviour);
    //   • session still ours but a DIFFERENT proc is registered → we closed
    //     this run ourselves to restart at a seek target. The rejection is
    //     expected, and the session dir is still in active use — touching
    //     either would kill a healthy session (this is exactly the invariant a
    //     naive restart breaks: close(old) makes cockpit.spawn's promise reject,
    //     which used to funnel straight into _vpEndSession).
    _vpWatchProc(winId, token, proc, dir) {
        const sess = () => { const s = this._vpSessions().get(winId); return s && s.token === token ? s : null; };
        proc.then(() => {
            const s = sess();
            if (s && s.proc === proc) {
                s.runExited = true;   // nothing beyond this run's frontier will ever appear (I1b)
                const ww = this._win(winId);
                // Fix-round-1 (M4): 'done' means "there is nothing left to
                // convert", and that is only true when the run that just
                // finished started at the beginning of the timeline. A run
                // restarted at a seek target reaching EOF says nothing about
                // the stretch before its start — which may never have been
                // converted at all — so the badge stays on 'transcoding'
                // rather than claiming a completeness this session doesn't
                // have. (Simplest honest rule; tracking full coverage across
                // runs would buy only a cosmetic badge change.)
                if (ww && ww.pv && ww.pv.mode === 'hls' && s.runStart === 0) ww.pv.transcodeState = 'done';
            }
            else if (!s) this._vpKillProcAndDir(proc, dir);   // superseded session: its dir is orphaned
        }).catch((e) => {
            const s = sess();
            if (s && s.proc === proc) this._vpEndSession(winId, token, proc, dir, 'ffmpeg failed' + (e && e.message ? ': ' + e.message : ''));
            else if (!s) this._vpKillProcAndDir(proc, dir);
        });
    },
    // Restart this session's ffmpeg so that it produces segment `index` onward
    // (a seek into a region the current run will never reach). The session dir
    // is deliberately KEPT: every segment already on disk is still valid for the
    // same timeline positions (`-output_ts_offset` keeps the restarted run on
    // the global timeline), so a seek back into an already-converted region is
    // served straight from disk with no further restart.
    //
    // Anti-thrash: at most ONE restart in flight per session. A concurrent
    // request that also wants a restart awaits the in-flight one and then
    // re-decides (see _vpServeSegment's loop) — which, for a nearby index, comes
    // back as 'wait', so a burst of requests around one seek target collapses
    // into a single ffmpeg respawn.
    async _vpRestartAt(winId, token, index) {
        const s0 = this._vpSessions().get(winId);
        if (!s0 || s0.token !== token) return;
        if (s0.restarting) { await s0.restarting; return; }
        let wrapped;
        const run = (async () => {
            let cur = this._vpSessions().get(winId);
            if (!cur || cur.token !== token) return;
            // Measure the outgoing run's progress instead of trusting whatever
            // the last segment request happened to observe: the range recorded
            // below is the ONLY evidence that this run's segments are complete
            // once its playlist is overwritten by the new run, and a value that
            // is merely stale (or was never taken) silently costs a re-encode
            // of a stretch that had already been converted. One `cat`, once per
            // restart. (`restarting` is published synchronously by the caller
            // below, so this await cannot let a second restart slip past the
            // coalescing gate.)
            await this._vpRunFrontier(cur);
            cur = this._vpSessions().get(winId);
            if (!cur || cur.token !== token) return;   // torn down during that read
            // Kill the outgoing run FIRST: two ffmpegs writing one session dir
            // (and one of them unreachable) is exactly the leak this file's
            // rules exist to prevent. Detach it from the session BEFORE closing
            // it, so _vpWatchProc's "is this still the session's process?" test
            // is already false when close() rejects the spawn promise —
            // otherwise that rejection reads as "ffmpeg failed" and tears the
            // whole session down mid-seek. (It is also false by the time the
            // rejection microtask runs, since the assignment below is
            // synchronous, but a leak this expensive gets both guards.)
            // Remember what the outgoing run had finished before replacing it:
            // its segments stay on disk and stay valid, and this is the only
            // record that they are COMPLETE (its playlist is about to be
            // overwritten by the new run). Without it, seeking backwards into
            // an already-converted stretch would needlessly restart again.
            if (Number.isFinite(cur.frontier) && cur.frontier >= cur.runStart)
                cur.doneRuns = this._vpMergeRanges(cur.doneRuns, { start: cur.runStart, end: cur.frontier });
            const outgoing = cur.proc;
            cur.proc = null;
            try { outgoing && outgoing.close && outgoing.close('cancelled'); }
            catch (e) { console.warn('explorer: could not close ffmpeg process', e); }
            const proc = cockpit.spawn(['ffmpeg', ...this._vpBuildHlsArgs({ inputPath: cur.srcPath, dir: cur.dir, videoCodec: cur.codec, startIndex: index })], { err: 'message' });
            // The spawn is not awaited, but the session could still have been
            // torn down in the microtask between the two lines — re-check before
            // publishing the new process, and free it (dir included: with the
            // session gone, nobody else will) if it has.
            const now = this._vpSessions().get(winId);
            if (!now || now.token !== token) { await this._vpKillProcAndDir(proc, cur.dir); return; }
            now.proc = proc;
            now.runStart = index;
            // Fix-round-1 (C2): the frontier belongs to the run that produced
            // it, so it MUST be reset in the same synchronous block as
            // runStart. Leaving the outgoing run's value behind let a second
            // restart (before any _vpRunFrontier call) record
            // {start: newRunStart, end: staleFrontier} — a doneRuns range
            // covering segments the new run had not written at all, which the
            // completeness gate would then happily read half-written .ts files
            // from. -1 means "this run has flushed nothing yet".
            now.frontier = index - 1;
            now.runExited = false;
            this._vpWatchProc(winId, token, proc, now.dir);
            this._vpHbTouchDir(now.dir);
            const ww = this._win(winId);
            if (ww && ww.pv && ww.pv.mode === 'hls') ww.pv.transcodeState = 'transcoding';
        })();
        wrapped = run
            .catch((e) => { console.warn('explorer: ffmpeg restart failed', e); })
            .finally(() => { const c = this._vpSessions().get(winId); if (c && c.restarting === wrapped) c.restarting = null; });
        s0.restarting = wrapped;
        await wrapped;
    },
    // How far the current run has got: ffmpeg appends one #EXTINF to its own
    // playlist per completed segment, and the run started at `runStart`, so the
    // highest index it has flushed is runStart + count - 1 (runStart-1 when it
    // has flushed nothing yet). ffmpeg's playlist is otherwise unused now that
    // hls.js is served a synthetic one — it survives purely as this progress
    // read and as the start-buffer gate.
    // It is cached on the session as `frontier` because a restart needs the last
    // known value to record what the outgoing run had completed (see doneRuns).
    async _vpRunFrontier(s) {
        let text = null;
        try { text = await cockpit.spawn(['cat', this._vpPlaylist(s.dir)], { err: 'ignore' }); } catch (e) {}
        s.frontier = s.runStart + this._vpCountSegments(text) - 1;
        return s.frontier;
    },
    // Serve one segment to hls.js, producing it on demand if necessary. Returns
    // the bytes, or null (→ the loader reports a 404 to hls.js) if it cannot be
    // produced within _vpSegWaitMs or the session went away meanwhile.
    //
    // Every already-converted segment — from this run or any earlier one — is
    // served straight from disk on the first pass, so this costs one file read
    // in the common case.
    //
    // Fix-round-1 (C1): `isAborted` is the loader's abort probe. It is checked
    // at the top of every iteration AND immediately before any restart
    // decision — an abandoned request must never spawn (or respawn) ffmpeg.
    // `_vpSegMaxRestarts` is the second half of that guard: even a request that
    // is somehow never aborted can only move the encoder once, so two live
    // loops can no longer ping-pong it between their targets indefinitely.
    async _vpServeSegment(winId, token, index, readFile, isAborted) {
        const deadline = Date.now() + this._vpSegWaitMs;
        const aborted = () => !!(isAborted && isAborted());
        let restarts = 0;
        for (;;) {
            if (aborted()) return null;
            const s = this._vpSessions().get(winId);
            if (!s || s.token !== token) return null;    // closed/superseded: stop, don't restart anything
            // One cheap `cat` of ffmpeg's playlist answers both questions at
            // once: has the current run closed this segment (may we read it?)
            // and how far has it got (wait or restart?). Only needed for the
            // current run's range — earlier runs' output is answered from
            // s.doneRuns with no I/O at all.
            const frontier = index >= s.runStart ? await this._vpRunFrontier(s) : s.frontier;
            let ready = this._vpSegKnownComplete({ index, runStart: s.runStart, frontier, doneRuns: s.doneRuns });
            if (ready) {
                const bytes = await readFile(s.dir + '/' + this._vpSegName(index));
                if (bytes && bytes.byteLength) return bytes;
                ready = false;   // listed but unreadable (deleted under us): decide as if absent
            }
            // Fix-round-1 (I1b): the run that owns this range has EXITED and
            // never produced this segment — no amount of waiting or restarting
            // can conjure it (it is past the end of the file). Fail fast
            // instead of burning the full deadline: hls.js applies no timeout
            // of its own to a custom loader, and it retries a 404 six times
            // with backoff, so a 30s wait per attempt is minutes of a frozen
            // player before its fatal error.
            if (!ready && s.runExited && index >= s.runStart && index > frontier) return null;
            if (Date.now() >= deadline) return null;
            if (s.restarting) { await s.restarting; continue; }   // coalesce onto the in-flight restart
            const action = this._vpSegAction({ ready, index, runStart: s.runStart, frontier });
            if (action === 'restart') {
                if (aborted() || restarts >= this._vpSegMaxRestarts) return null;
                restarts++;
                await this._vpRestartAt(winId, token, index);
                continue;
            }
            await new Promise((resolve) => setTimeout(resolve, this._vpSegPollMs));
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
        const probed = ff.ffprobe ? await this._vpProbeStreams(file.path) : { streams: [], duration: null };
        const codec = this._vpProbeDecision(probed.streams);
        if (!isNewest()) { await this._vpKillProcAndDir(null, dir); return; }   // superseded while probing — nothing spawned yet
        // Reflect state in the badge, and surface the real total duration
        // (FIX D) straight away — hls.js's own duration only grows as
        // segments land, so without this the header would show ~7s for a
        // long file until the whole encode had been read.
        if (w.pv) { w.pv.transcodeState = codec === 'copy' ? 'remuxing' : 'transcoding'; w.pv.totalDuration = probed.duration; }
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
        // `srcPath`/`codec`/`runStart`/`restarting` are the 3.1.0 seek state: a
        // restart has to be able to rebuild the exact same ffmpeg command with a
        // different start point, and _vpSegAction needs to know where the
        // current run began. Still non-reactive (ExRT), still keyed by winId,
        // still the single authority for teardown.
        this._vpSessions().set(winId, { hls: null, proc, dir, token: id, srcPath: file.path, codec, runStart: 0, frontier: -1, doneRuns: [], restarting: null, runExited: false });
        // Start (or keep alive) the shared heartbeat and protect this brand-new
        // session immediately — before the first interval tick — so a reap
        // that races the very start of playback still sees a fresh .alive.
        this._vpHbEnsure();
        this._vpHbTouchDir(dir);
        const isCurrent = () => { const s = this._vpSessions().get(winId); return !!(isNewest() && s && s.token === id); };
        // Was an inline proc.then/catch pair; now shared with the seek-restart
        // path (see _vpWatchProc — a restart's close() of the outgoing process
        // must not be mistaken for "ffmpeg failed" and tear the session down).
        this._vpWatchProc(winId, id, proc, dir);
        const readFile = async (p) => { const h = cockpit.file(p, { binary: true }); try { return await h.read(); } catch (e) { return null; } finally { h.close(); } };
        // Seek support is the transcode path only: it needs the uniform,
        // forced-keyframe segments _vpBuildHlsArgs produces for x264 (a remux's
        // segments are GOP-length and irregular, so index k does not map to a
        // known time) and a probed duration to build the playlist from. When
        // either is missing, `serve` degrades to exactly the 3.0.x behaviour —
        // hand hls.js ffmpeg's own growing playlist and read segments off disk.
        const vodPlaylist = codec === 'x264' ? this._vpBuildVodPlaylist(probed.duration) : null;
        const serve = async (p, isAborted) => {
            if (!vodPlaylist) return readFile(p);
            const name = p.split('/').pop() || '';
            if (name === 'index.m3u8') return new TextEncoder().encode(vodPlaylist);
            const k = this._vpSegIndexFromName(name);
            if (k == null) return readFile(p);
            return this._vpServeSegment(winId, id, k, readFile, isAborted);
        };
        const Loader = this._vpLoaderClass(serve, (u) => this._vpResolveInDir(dir, u));
        // hls.js is lazy-loaded (no eager <script> tag) — must resolve before
        // touching window.Hls, both for the isSupported() check and `new Hls(...)`.
        try { await this._ensureHls(); }
        catch (e) { await this._vpEndSession(winId, id, proc, dir, 'Could not load the video player (hls.js failed to load).'); return; }
        // Don't hand hls.js a source until ffmpeg has actually produced the
        // manifest + enough of a buffer (see _vpWaitForPlaylist).
        const wait = await this._vpWaitForPlaylist(this._vpPlaylist(dir), 60000, isCurrent);
        if (wait.status === 'superseded') { await this._vpKillProcAndDir(proc, dir); return; }
        if (wait.status === 'timeout') {
            // Fix-round-1: degrade instead of erroring. The 60s backstop is
            // unchanged, but FIX B raised the bar it has to clear (~30s
            // buffered, not just "one segment exists") — on a slow host
            // (ARM NAS, small VPS transcoding well under realtime) that can
            // genuinely take longer than 60s even though the file WOULD
            // play (with stalls, same as before this round of fixes). Only
            // treat the timeout as fatal when there is truly nothing to
            // play yet; otherwise attach with whatever's on disk and let it
            // keep buffering in the background.
            if (!this._vpPlaylistHasSegments(wait.text)) {
                await this._vpEndSession(winId, id, proc, dir, 'ffmpeg did not produce a playable stream in time.');
                return;
            }
        }
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
            // startPosition:0 — Fix-round-1. hls.js's default is -1 ("start at
            // the live edge"), and `details.live` stays true until
            // #EXT-X-ENDLIST (the "EVENT"!==t.type carve-out in the vendored
            // hls.js only exempts the `waitForLive` gate, not
            // setStartPosition), so without this the encode's OWN wait-for-
            // buffer (FIX B) made it worse, not better: with
            // liveSyncDurationCount's default of 3 and this ffmpeg's real
            // segment lengths, a 30s buffer (~5 segments) computed a start
            // position around 11s in — the opening of the file was silently
            // skipped. The encode always starts at 0 and `-hls_list_size 0`
            // keeps every fragment listed, so there is nothing to lose by
            // forcing position 0 explicitly.
            const hls = new window.Hls({ pLoader: Loader, fLoader: Loader, startPosition: 0 });
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
