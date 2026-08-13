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
};
