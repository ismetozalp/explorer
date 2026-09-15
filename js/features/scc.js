// scc.js — code-census integration (sloc/complexity via the `scc` CLI).
// Powers the AI-view scc pane (language table + complexity hotspots), the
// per-file complexity numbers in the repo tree, and the PDF/HTML report.
//
// Data comes from ONE tool: `scc --by-file --format json <root>` returns an
// array of language objects, each carrying the language totals (Code,
// Complexity, Count, …) AND a Files[] array of per-file rows. The pure helpers
// below (unit-tested) turn that into sorted table rows, complexity hotspots,
// and a path→complexity map for the tree. Everything privileged goes through
// cockpit.spawn; nothing here mutates reactive state directly (the mixin does).
window.ExplorerScc = {

    // ── detection ────────────────────────────────────────────────────────────
    // Same shell-probe shape as the ffmpeg check (js/features/videoplayer.js):
    // `command` is a shell builtin, so it must run through `sh -c`, not argv-exec.
    async _sccProbe() {
        try { await cockpit.spawn(['sh', '-c', 'command -v scc 2>/dev/null'], { err: 'ignore' }); return true; }
        catch (e) { return false; }
    },

    // ── OS-specific install instructions (pure, unit-tested) ──────────────────
    // scc isn't in most base repos, so we give the most reliable per-OS route
    // plus the universal binary/Go fallback. Returned as display text (copy-paste)
    // — unlike ffmpeg we don't offer a one-click install, since the reliable
    // routes are a binary download or `go install`, not a single package name.
    _sccInstallHint(osReleaseText) {
        const get = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(osReleaseText || ''); return m ? m[1].replace(/^"|"$/g, '').trim() : ''; };
        const id = get('ID').toLowerCase();
        const like = get('ID_LIKE').toLowerCase();
        const has = (s) => id === s || like.split(/\s+/).includes(s);
        const GO = 'go install github.com/boyter/scc/v3@latest';
        const BINARY = 'Download the latest release from https://github.com/boyter/scc/releases and put the `scc` binary on your PATH.';
        if (has('arch') || id === 'manjaro') return { label: 'Arch Linux', primary: 'sudo pacman -S scc', alt: [GO, BINARY] };
        if (has('alpine')) return { label: 'Alpine', primary: 'sudo apk add scc', alt: [GO, BINARY] };
        if (has('debian') || has('ubuntu') || id === 'linuxmint' || id === 'raspbian') return { label: 'Debian / Ubuntu', primary: 'sudo snap install scc', alt: [GO, BINARY] };
        if (has('fedora') || has('rhel') || has('centos') || id === 'rocky' || id === 'almalinux') return { label: 'Fedora / RHEL', primary: GO, alt: ['(install Go first: sudo dnf install -y golang)', BINARY] };
        if (has('suse') || id.includes('opensuse') || id === 'sles') return { label: 'openSUSE', primary: GO, alt: [BINARY] };
        return { label: 'Linux', primary: BINARY, alt: [GO + '   (needs Go)'] };
    },

    // ── turnkey install command (pure, unit-tested) ──────────────────────────
    // A single shell command that installs scc without further input, chosen by
    // OS: the native package where scc is packaged cleanly (Arch, Alpine), else a
    // universal GitHub-release binary fetched to /usr/local/bin. scc's release
    // assets are version-less (scc_${OS}_${arch}.tar.gz), so /releases/latest/
    // download resolves with no API call. Run with superuser (writes system dirs).
    _sccInstallCmd(osReleaseText) {
        const get = (k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(osReleaseText || ''); return m ? m[1].replace(/^"|"$/g, '').trim() : ''; };
        const id = get('ID').toLowerCase();
        const like = get('ID_LIKE').toLowerCase();
        const has = (s) => id === s || like.split(/\s+/).includes(s);
        if (has('arch') || id === 'manjaro') return 'pacman -S --noconfirm scc';
        if (has('alpine')) return 'apk add scc';
        return [
            'set -e',
            'arch=$(uname -m)',   // Cockpit is Linux-only, so the OS is always Linux
            'case "$arch" in x86_64|amd64) a=x86_64;; aarch64|arm64) a=arm64;; i386|i686) a=i386;; *) a="$arch";; esac',
            'tmp=$(mktemp -d)',
            'url="https://github.com/boyter/scc/releases/latest/download/scc_Linux_${a}.tar.gz"',
            'echo "Downloading $url"',
            'curl -fSL "$url" -o "$tmp/scc.tgz" || wget -O "$tmp/scc.tgz" "$url"',
            'tar xzf "$tmp/scc.tgz" -C "$tmp" scc',
            'install -m 0755 "$tmp/scc" /usr/local/bin/scc',
            'rm -rf "$tmp"',
            'scc --version',
        ].join('\n');
    },

    // ── run ───────────────────────────────────────────────────────────────────
    // scc argv. `byFile` adds --by-file (per-file rows for hotspots + the tree).
    // JSON format; run FROM the repo root via the spawn `directory` option so the
    // Location paths are root-relative. err:'message' surfaces a real failure.
    _sccArgs(byFile) {
        const a = ['scc', '--format', 'json'];
        if (byFile) a.push('--by-file');
        a.push('.');
        return a;
    },
    async _sccRun(root, byFile) {
        const out = await cockpit.spawn(this._sccArgs(byFile), { err: 'message', directory: root });
        return this._sccParse(out);
    },
    // Parse scc JSON → array of language objects, or [] on anything unexpected.
    _sccParse(text) {
        try { const d = JSON.parse(text); return Array.isArray(d) ? d : []; }
        catch (e) { return []; }
    },

    // ── pure aggregators (unit-tested) ────────────────────────────────────────
    // Language table rows, sorted by Code desc, with a totals row appended.
    // `kind`: 'data' for formats scc treats as data/config (marked in the report),
    // else '' (program source). The DATA set mirrors the attached report.
    _sccTableRows(langs) {
        const DATA = new Set(['JSON', 'CSV', 'SVG', 'YAML', 'XML', 'Plain Text', 'Properties File', 'TOML', 'HTML', 'INI', 'BASH', 'Markdown']);
        const rows = (langs || []).map(l => ({
            name: l.Name || '?',
            files: l.Count || 0,
            lines: l.Lines || 0,
            blanks: l.Blank || 0,
            comments: l.Comment || 0,
            code: l.Code || 0,
            complexity: l.Complexity || 0,
            kind: DATA.has(l.Name) ? 'data' : '',
        }));
        rows.sort((a, b) => b.code - a.code);
        const tot = rows.reduce((t, r) => {
            t.files += r.files; t.lines += r.lines; t.blanks += r.blanks;
            t.comments += r.comments; t.code += r.code; t.complexity += r.complexity; return t;
        }, { name: 'Total', files: 0, lines: 0, blanks: 0, comments: 0, code: 0, complexity: 0, kind: 'total' });
        return { rows, total: tot };
    },

    // Flatten Files[] across languages → per-file rows (for hotspots + the tree).
    // cxPerKloc = complexity per 1,000 code lines (comparable across file sizes).
    _sccFiles(langs) {
        const out = [];
        for (const l of (langs || [])) {
            for (const f of (l.Files || [])) {
                const code = f.Code || 0;
                out.push({
                    filename: f.Filename || (f.Location || '').split('/').pop() || '?',
                    location: f.Location || '',
                    language: f.Language || l.Name || '?',
                    lines: f.Lines || 0,
                    code, comment: f.Comment || 0, blank: f.Blank || 0,
                    complexity: f.Complexity || 0,
                    bytes: f.Bytes || 0,
                    cxPerKloc: code > 0 ? Math.round((f.Complexity || 0) * 1000 / code) : 0,
                });
            }
        }
        return out;
    },
    // Top N files by complexity (ties broken by code size), from _sccFiles output.
    _sccTopComplex(files, n) {
        return (files || []).slice()
            .sort((a, b) => (b.complexity - a.complexity) || (b.code - a.code))
            .slice(0, n || 50);
    },
    // Absolute-path → complexity map for the tree (only files with complexity > 0
    // are worth a badge). `root` has no trailing slash; Location is root-relative.
    _sccComplexityByPath(files, root) {
        const m = {};
        for (const f of (files || [])) {
            if (f.location) m[root + '/' + f.location] = f.complexity || 0;
        }
        return m;
    },
    // Sort table rows by a column (pure, unit-tested). 'name' is alpha; the rest
    // are numeric. The Total row is kept OUT (rendered separately), so callers
    // pass only the language rows here.
    _sccSortRows(rows, sort) {
        const col = (sort && sort.col) || 'code';
        const dir = (sort && sort.dir) === 'asc' ? 1 : -1;
        return (rows || []).slice().sort((a, b) => {
            if (col === 'name') return dir * String(a.name).localeCompare(String(b.name));
            return dir * ((a[col] || 0) - (b[col] || 0));
        });
    },

    // ── reactive-facing pane methods (drive session.scc) ──────────────────────
    // scc analyzes the session's repo toplevel (or its plain dir). Not tied to
    // git — scc runs on any directory.
    _sccRoot(session) {
        return (session && session.diff && session.diff.repo && session.diff.root) || (session && session.dir) || '';
    },
    _sccEnsure(session) {
        if (!session.scc) session.scc = {
            sub: 'table', installed: null, hint: null, installing: false, installLog: '',
            table: { rows: [], total: null, loading: false, err: '', ranAt: 0 },
            cx: { files: [], top: [], loading: false, err: '', ranAt: 0 },
            hot: { files: [], churn: {}, loading: false, err: '', ranAt: 0, window: '1 year ago' },
            cov: { files: [], total: null, path: '', map: {}, loading: false, err: '', ranAt: 0 },
            todo: { items: [], counts: {}, loading: false, err: '', ranAt: 0 },
            tools: {
                secrets: this._sccToolState(), deps: this._sccToolState(),
                dup: this._sccToolState(), fn: this._sccToolState(),
            },
            sort: { col: 'code', dir: 'desc' }, sorts: {}, req: 0,
        };
        return session.scc;
    },
    _sccToolState() {
        return { installed: null, installing: false, installLog: '', hint: null, installCmd: '', loading: false, err: '', ranAt: 0, findings: [], summary: '' };
    },
    // Invalidate all analyses (used when the session's repo root changes) so each
    // sub-pane re-runs against the new root instead of showing the old repo's data.
    _sccResetAnalyses(session) {
        const scc = session && session.scc; if (!scc) return;
        // Invalidate every in-flight analysis so a slow response from the OLD
        // repo can't repopulate the NEW repo's pane (or save under its cache
        // key): each refresher checks its generation before publishing, so
        // bumping them here makes those late writes no-op. Also clear the
        // loading flags, since the guarded finally-blocks will now skip them.
        scc.req = (scc.req || 0) + 1; scc.table.loading = false;
        for (const k of ['cx', 'hot', 'cov', 'todo']) { scc[k]._gen = (scc[k]._gen || 0) + 1; scc[k].loading = false; }
        for (const k of Object.keys(scc.tools || {})) { scc.tools[k]._gen = (scc.tools[k]._gen || 0) + 1; scc.tools[k].loading = false; }
        scc.table.ranAt = 0; scc.table.rows = []; scc.table.total = null;
        scc.cx.ranAt = 0; scc.cx.files = []; scc.cx.top = [];
        scc.hot.ranAt = 0; scc.hot.files = []; scc.hot.churn = {};
        scc.cov.ranAt = 0; scc.cov.files = []; scc.cov.total = null; scc.cov.map = {};
        scc.todo.ranAt = 0; scc.todo.items = []; scc.todo.counts = {};
        for (const k of Object.keys(scc.tools || {})) { scc.tools[k].ranAt = 0; scc.tools[k].findings = []; scc.tools[k].summary = ''; }
        if (session.tree) session.tree.cx = {};
        scc._loaded = false;                // re-load the new repo's saved analyses
        this._sccDisposeSession(session);   // drop the old repo's cache watcher
        scc.auto = null;                    // re-check the timer state for the new root
    },
    // Hide/show the scc column; refit the terminal after the width change (mirrors
    // aiToggleDiff/aiToggleTree). Default collapsed (aiSccCollapsed undefined).
    async aiToggleScc(tab) {
        if (!tab) return;
        tab.aiSccCollapsed = (tab.aiSccCollapsed === false);
        if (tab.aiSccCollapsed === false) {
            const s = this.aiActiveSession(tab);
            if (s) await this.aiSccOpen(s);
        }
        this.$nextTick(() => {
            const s = this.aiActiveSession(tab);
            if (!s) return;
            const inst = ExRT.term.get(s.id);
            if (inst && inst.fitAddon) { try { inst.fitAddon.fit(); } catch (e) {} }
        });
    },
    // First open: probe scc; if missing, load the OS install hint and stop. Else
    // run the table analysis once (subsequent runs are the explicit Refresh).
    async aiSccOpen(session) {
        const scc = this._sccEnsure(session);
        // The session's dir can change (a shell `cd`, resolved into diff.root by
        // the diff poll). If the repo root moved since we last ran, invalidate all
        // analyses so the pane doesn't keep showing the previous repo's data.
        const root = this._sccRoot(session);
        if (root && scc.rootFor && scc.rootFor !== root) this._sccResetAnalyses(session);
        if (root) scc.rootFor = root;
        if (scc.installed === null) {
            scc.installed = await this._sccProbe();
            if (!scc.installed) {
                const osr = await cockpit.spawn(['sh', '-c', 'cat /etc/os-release 2>/dev/null']).catch(() => '');
                scc.hint = this._sccInstallHint(osr);
                scc.installCmd = this._sccInstallCmd(osr);
                return;
            }
        }
        // Load the last saved results from disk. Then auto-run the active analysis
        // ONLY if nothing was saved for it (first run) — otherwise show saved data.
        if (scc.installed && !scc._loaded) { scc._loaded = true; await this._sccLoadAnalyses(session); }
        if (scc.installed && !scc.auto) this.aiSccAutoStatus(session);   // reflect timer state + watch cache
        if (scc.installed) this.aiSccMaybeRun(session, scc.sub || 'table');
    },
    // Turnkey install: confirm, run the OS-appropriate command as administrator,
    // stream the output, then re-probe and start the analysis. Mirrors the ffmpeg
    // one-click install in js/features/videoplayer.js.
    async aiSccInstall(session) {
        const scc = this._sccEnsure(session);
        const cmd = scc.installCmd || this._sccInstallCmd(await cockpit.spawn(['sh', '-c', 'cat /etc/os-release 2>/dev/null']).catch(() => ''));
        const ok = await this.askConfirm('Install scc',
            'Install the scc code-census tool as administrator? This runs:\n\n' + cmd, 'Install');
        if (!ok) return;
        scc.installing = true;
        scc.installLog = '# installing scc…\n';
        try {
            const proc = cockpit.spawn(['sh', '-c', cmd], { superuser: 'require', err: 'out' });
            proc.stream((d) => { scc.installLog += d; });
            await proc;
            scc.installed = await this._sccProbe();
            if (scc.installed) {
                scc.installLog += '\nscc installed — starting analysis.\n';
                scc.hint = null;
                this.aiSccRefreshTable(session).then(() => this._sccSaveAnalyses(session));
            } else {
                scc.installLog += '\nInstall finished but scc still isn’t on PATH. See the manual steps below.\n';
            }
        } catch (e) {
            scc.installLog += '\nInstall failed: ' + (e.message || e) + '\n';
            this.toast('scc install failed — see the log', 'danger');
        } finally {
            scc.installing = false;
        }
    },
    async aiSccRefreshTable(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root || !scc.installed) return;
        const req = (scc.req = (scc.req || 0) + 1);
        scc.table.loading = true; scc.table.err = '';
        try {
            const langs = await this._sccRun(root, false);
            if (scc.req !== req) return;
            const t = this._sccTableRows(langs);
            scc.table.rows = this._sccSortRows(t.rows, scc.sort);
            scc.table.total = t.total;
            scc.table.ranAt = Date.now();
        } catch (e) {
            if (scc.req !== req) return;
            scc.table.err = e.message || String(e);
        } finally {
            if (scc.req === req) scc.table.loading = false;
        }
    },
    async aiSccRefreshComplexity(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root || !scc.installed) return;
        const gen = (scc.cx._gen = (scc.cx._gen || 0) + 1);   // newest run wins (out-of-order guard)
        scc.cx.loading = true; scc.cx.err = '';
        try {
            const langs = await this._sccRun(root, true);
            if (scc.cx._gen !== gen) return;
            const files = this._sccFiles(langs);
            scc.cx.files = files;
            scc.cx.top = this._sccTopComplex(files, 50);
            scc.cx.ranAt = Date.now();
            // Feed the tree: path → complexity for ALL files (not just the top 50).
            if (session.tree) session.tree.cx = this._sccComplexityByPath(files, root);
        } catch (e) {
            if (scc.cx._gen !== gen) return;
            scc.cx.err = e.message || String(e);
        } finally {
            if (scc.cx._gen === gen) scc.cx.loading = false;
        }
    },
    aiSccSetSub(session, sub) {
        const scc = this._sccEnsure(session);
        scc.sub = sub;
        // Tools: probe install state first (aiSccOpenTool also first-runs). Others:
        // auto-run ONLY if nothing is saved yet (first run); a cached analysis has
        // ranAt > 0 from _sccLoadAnalyses, so it shows saved data without re-running.
        if (this._sccToolDefs()[sub]) this.aiSccOpenTool(session, sub);
        else this.aiSccMaybeRun(session, sub);
    },
    // Run an analysis ONLY if it has no result yet (ranAt 0) — i.e. the first time
    // it's viewed for a repo with nothing on disk. Cached/already-run analyses are
    // left alone (Refresh or the timer re-runs them). Persists the fresh result.
    aiSccMaybeRun(session, sub) {
        const scc = this._sccEnsure(session);
        const save = () => this._sccSaveAnalyses(session);
        if (sub === 'cx') { if (scc.installed && !scc.cx.ranAt && !scc.cx.loading) this.aiSccRefreshComplexity(session).then(save); }
        else if (sub === 'hot') { if (scc.installed && !scc.hot.ranAt && !scc.hot.loading) this.aiSccRefreshHotspots(session).then(save); }
        else if (sub === 'cov') { if (!scc.cov.ranAt && !scc.cov.loading) this.aiSccRefreshCoverage(session).then(save); }
        else if (sub === 'todo') { if (!scc.todo.ranAt && !scc.todo.loading) this.aiSccRefreshTodos(session).then(save); }
        else if (this._sccToolDefs()[sub]) { const t = scc.tools[sub]; if (t.installed && !t.ranAt && !t.loading) this.aiSccRunTool(session, sub).then(save); }
        else { if (scc.installed && !scc.table.ranAt && !scc.table.loading) this.aiSccRefreshTable(session).then(save); }
    },

    // ── churn × complexity hotspots (git log, no extra tool) ──────────────────
    // Churn = how often a file changed (commits touching it in a time window).
    // The hotspot score = churn × complexity is the classic risk metric: files
    // that are BOTH complex and frequently edited are where change cost and
    // defect risk concentrate. Needs the complexity analysis (for the per-file
    // complexity) and a git repo (for churn).
    async aiSccRefreshHotspots(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root || !scc.installed) return;
        const gen = (scc.hot._gen = (scc.hot._gen || 0) + 1);
        scc.hot.loading = true; scc.hot.err = '';
        try {
            // Always refresh complexity first: the score is churn × complexity, so
            // stale per-file complexity (after edits/adds/deletes) would misrank.
            await this.aiSccRefreshComplexity(session);
            if (scc.hot._gen !== gen) return;
            if (scc.cx.err) { scc.hot.err = 'Complexity analysis failed: ' + scc.cx.err; return; }
            const win = scc.hot.window || '1 year ago';
            // NO -z (cockpit.spawn returns empty for a NUL stream); newline paths,
            // quotePath=false so ordinary paths line up with scc's Location.
            const text = (await cockpit.spawn(['git', '-C', root, '-c', 'core.quotePath=false', 'log', '--since=' + win, '--pretty=format:', '--name-only'], { err: 'message' }).catch((e) => { throw e; }));
            if (scc.hot._gen !== gen) return;
            const churn = this._sccParseChurn(text);
            scc.hot.churn = churn;
            scc.hot.files = this._sccHotspots(scc.cx.files, churn, 50);
            scc.hot.ranAt = Date.now();
        } catch (e) {
            if (scc.hot._gen !== gen) return;
            scc.hot.err = (/not a git repository/i.test(e.message || '')) ? 'Not a git repository — churn needs git history.' : (e.message || String(e));
        } finally {
            if (scc.hot._gen === gen) scc.hot.loading = false;
        }
    },
    // PURE (unit-tested): `git log --name-only` text → { relPath: commitCount }.
    _sccParseChurn(text) {
        const churn = {};
        const unq = (p) => (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p;
        for (const line of String(text || '').split('\n')) {
            const p = line.trim();
            if (!p) continue;
            const path = unq(p);
            churn[path] = (churn[path] || 0) + 1;
        }
        return churn;
    },
    // PURE (unit-tested): join per-file complexity with churn → top hotspots by
    // score = churn × complexity (only files with both > 0 are hotspots).
    _sccHotspots(files, churn, n) {
        const out = [];
        for (const f of (files || [])) {
            const c = (churn && churn[f.location]) || 0;
            if (c > 0 && (f.complexity || 0) > 0) {
                out.push({ filename: f.filename, location: f.location, language: f.language,
                    code: f.code, complexity: f.complexity, churn: c, score: c * f.complexity });
            }
        }
        out.sort((a, b) => (b.score - a.score) || (b.complexity - a.complexity));
        return out.slice(0, n || 50);
    },
    aiSccSort(session, col) {
        const scc = this._sccEnsure(session);
        if (scc.sort.col === col) scc.sort.dir = scc.sort.dir === 'desc' ? 'asc' : 'desc';
        else { scc.sort.col = col; scc.sort.dir = (col === 'name') ? 'asc' : 'desc'; }
        scc.table.rows = this._sccSortRows(scc.table.rows, scc.sort);
    },
    // The "pane session" a diff/scc pane operates on: for an agent tab it's the
    // active AI session; for a dir (file-browser) tab it's the synthetic repoPane.
    // This lets the SAME diff + scc pane markup drive both views.
    paneSession(tab) {
        if (!tab) return null;
        if (tab.kind === 'agent') return this.aiActiveSession(tab);
        return tab.repoPane || null;
    },
    aiSccActive(tab) { return this.paneSession(tab); },

    // ── inline Diff + code-census panel in the file browser (dir tabs) ─────────
    _repoPaneEnsure(tab) {
        if (!tab || tab.kind !== 'dir') return null;
        if (!tab.repoPane) {
            tab.repoPane = { id: tab.id + ':repo', dir: (this.activePane(tab) || tab).path,
                diff: { text: '', mode: 'all', repo: true, files: [], hash: '', note: '', selected: [], root: '', rootFor: '', focus: '' } };
            this._sccEnsure(tab.repoPane);   // adds .scc
        }
        return tab.repoPane;
    },
    aiRepoSetView(tab, view) {
        tab.repoView = view;
        const s = this._repoPaneEnsure(tab);
        if (!s) return;
        if (view === 'census') { this.aiSccOpen(s); }
        // Returning to Diff: the poll self-terminated while Census was showing
        // (its tick bails when repoView !== 'diff'), so refresh now and restart it.
        else if (view === 'diff') { this.aiRefreshDiff(s); this._repoStartPoll(tab); }
    },
    // Re-root the inline panel when the directory tab navigates to a DIFFERENT
    // repository (open in repo A, then browse into repo B): otherwise the diff,
    // census and editor links keep operating on A beside B's file listing.
    // Cheap-guarded — no-op unless a panel is open; called from navigate/back/fwd.
    async _repoPaneReconcile(tabOrPane) {
        let tab = tabOrPane;
        // A split-pane navigate passes the pane; the panel lives on the top-level
        // tab, so fall back to the active tab when the arg isn't panel-bearing.
        if (!tab || !tab.repoPanelOpen) tab = this.activeTab && this.activeTab();
        if (!tab || tab.kind !== 'dir' || !tab.repoPanelOpen || !tab.repoPane) return;
        const s = tab.repoPane;
        const here = (this.activePane(tab) || tab).path;
        if (!here) return;
        // Rapid navigation can overlap lookups; if an older rev-parse finishes
        // last it would re-root the panel at the previous repo. A per-tab token
        // lets only the newest lookup publish (shared with aiToggleRepoPanel).
        const gen = (tab._repoRootGen || 0) + 1; tab._repoRootGen = gen;
        let root = here;
        try { root = ((await cockpit.spawn(['git', '-C', here, 'rev-parse', '--show-toplevel'], { err: 'message' })) || '').trim() || here; } catch (e) {}
        if (tab._repoRootGen !== gen || !tab.repoPanelOpen) return;   // superseded, or panel closed mid-lookup
        if (root === s.dir) return;   // same repo — nothing to reconcile
        s.dir = root;
        // Drop the previous repo's diff + analyses so nothing stale is shown.
        s.diff.text = ''; s.diff.files = []; s.diff.hash = ''; s.diff.root = ''; s.diff.rootFor = ''; s.diff.selected = []; s.diff.focus = '';
        if (this._sccResetAnalyses) this._sccResetAnalyses(s);
        this.aiRefreshDiff(s);
        if (tab.repoView === 'census') this.aiSccOpen(s);
    },
    async aiToggleRepoPanel(tab) {
        if (!tab) return;
        tab.repoPanelOpen = !tab.repoPanelOpen;
        if (!tab.repoPanelOpen) { this._repoStopPoll(tab); return; }
        const s = this._repoPaneEnsure(tab);
        if (!tab.repoView) tab.repoView = 'diff';
        // Root the panel at the repo TOPLEVEL (so a subdir still shows the whole
        // repo's diff/census), then start the diff refresh loop. The gen token
        // (shared with _repoPaneReconcile) discards this lookup if a navigation
        // re-rooted the panel while our rev-parse was in flight.
        const here = (this.activePane(tab) || tab).path;
        const gen = (tab._repoRootGen || 0) + 1; tab._repoRootGen = gen;
        let root = here;
        try { root = ((await cockpit.spawn(['git', '-C', here, 'rev-parse', '--show-toplevel'], { err: 'message' })) || '').trim() || here; } catch (e) {}
        if (tab._repoRootGen !== gen || !tab.repoPanelOpen) return;   // superseded or closed mid-lookup
        s.dir = root;
        this.aiRefreshDiff(s);
        if (tab.repoView === 'census') this.aiSccOpen(s);
        this._repoStartPoll(tab);
    },
    _repoStartPoll(tab) {
        this._repoStopPoll(tab);
        const tick = async () => {
            if (!tab.repoPanelOpen) return;
            const at = this.activeTab && this.activeTab();
            const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
            if (!at || at.id !== tab.id || hidden || tab.repoView !== 'diff') { tab._repoTimer = null; return; }
            const s = tab.repoPane; if (s) await this.aiRefreshDiff(s);
            if (!tab.repoPanelOpen) return;
            tab._repoTimer = setTimeout(tick, 2000);
        };
        tab._repoTimer = setTimeout(tick, 250);
    },
    _repoStopPoll(tab) { if (tab && tab._repoTimer) { clearTimeout(tab._repoTimer); tab._repoTimer = null; } },
    // Called on close to free the repoPane's scc cache watcher.
    _repoPaneDispose(tab) { this._repoStopPoll(tab); if (tab && tab.repoPane) this._sccDisposeSession(tab.repoPane); },

    // ── open a file listed in any census table (preview / edit) ───────────────
    // Table paths are usually repo-root-relative (scc Location, git-grep, lcov);
    // a scanner may emit an absolute or ./-prefixed one. Resolve against the
    // census root so 👁/✎ work from every file-bearing table (cx, hot, cov,
    // todo, secrets, dup, fn).
    _sccAbsFile(session, file) {
        let f = String(file || '').trim();
        if (!f || f === '?') return '';
        if (f[0] === '/') return f;                 // already absolute
        f = f.replace(/^\.\//, '');                 // drop a leading ./
        const base = this._sccRoot(session);
        return base ? Util.joinPath(base, f) : f;
    },
    async _sccStatSize(path) { try { const st = await FS.statOne(path); return (st && st.size) || 0; } catch (e) { return 0; } },
    async aiSccPreviewFile(session, file) {
        const path = this._sccAbsFile(session, file); if (!path) return;
        await this.openPreview({ path, name: (path.split('/').pop() || path), type: 'f', size: await this._sccStatSize(path) });
    },
    async aiSccOpenFile(session, file) {
        const path = this._sccAbsFile(session, file); if (!path) return;
        await this.openEditor({ path, name: (path.split('/').pop() || path), type: 'f', size: await this._sccStatSize(path) });
    },

    // ── generic per-table sorting (Complexity, Hotspots, Coverage, TODO, and the
    //    scanner tables). The Language table keeps its own aiSccSort. ──────────
    // PURE (unit-tested): sort a copy of `arr` by `sort.col`; numbers numerically,
    // everything else by locale string compare.
    _sccApplySort(arr, sort) {
        if (!sort || !sort.col) return (arr || []).slice();
        const col = sort.col, dir = sort.dir === 'asc' ? 1 : -1;
        return (arr || []).slice().sort((a, b) => {
            const av = a[col], bv = b[col];
            if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
            return dir * String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv));
        });
    },
    _sccListFor(session, key) {
        const scc = session && session.scc; if (!scc) return [];
        const m = {
            cx: scc.cx.top, hot: scc.hot.files, cov: scc.cov.files, todo: scc.todo.items,
            secrets: scc.tools.secrets.findings, deps: scc.tools.deps.findings,
            dup: scc.tools.dup.findings, fn: scc.tools.fn.findings,
        };
        return m[key] || [];
    },
    // Sorted rows for a table, used directly in x-for. Unsorted until the user
    // clicks a header (keeps the analysis's own natural order by default).
    aiSccList(session, key) {
        const scc = session && session.scc; if (!scc) return [];
        return this._sccApplySort(this._sccListFor(session, key), scc.sorts[key]);
    },
    // Text columns default to ascending on first click; numeric to descending.
    _sccTextCols: { filename: 1, file: 1, func: 1, marker: 1, text: 1, location: 1, package: 1, id: 1, rule: 1, fileA: 1, fileB: 1, version: 1, severity: 1, ecosystem: 1, language: 1 },
    aiSccSortBy(session, key, col) {
        const scc = this._sccEnsure(session);
        const cur = scc.sorts[key];
        if (cur && cur.col === col) scc.sorts[key] = { col, dir: cur.dir === 'desc' ? 'asc' : 'desc' };
        else scc.sorts[key] = { col, dir: this._sccTextCols[col] ? 'asc' : 'desc' };
    },
    aiSccBusy(session) {
        const scc = session && session.scc; if (!scc) return false;
        const s = scc.sub;
        if (s === 'cx') return scc.cx.loading;
        if (s === 'hot') return scc.hot.loading;
        if (s === 'cov') return scc.cov.loading;
        if (s === 'todo') return scc.todo.loading;
        if (scc.tools[s]) return scc.tools[s].loading;
        return scc.table.loading;
    },
    async aiSccRefreshActive(session) {
        const scc = this._sccEnsure(session);
        if (scc.sub === 'cx') await this.aiSccRefreshComplexity(session);
        else if (scc.sub === 'hot') await this.aiSccRefreshHotspots(session);
        else if (scc.sub === 'cov') await this.aiSccRefreshCoverage(session);
        else if (scc.sub === 'todo') await this.aiSccRefreshTodos(session);
        else if (this._sccToolDefs()[scc.sub]) await this.aiSccRunTool(session, scc.sub);
        else await this.aiSccRefreshTable(session);
        this._sccSaveAnalyses(session);   // persist to disk after any manual refresh
    },

    // ── TODO / FIXME census (git grep, no extra tool) ─────────────────────────
    async aiSccRefreshTodos(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root) return;
        const gen = (scc.todo._gen = (scc.todo._gen || 0) + 1);
        scc.todo.loading = true; scc.todo.err = '';
        try {
            // In a repo, git grep (fast, respects .gitignore) — its exit 1 means
            // "no matches", NOT an error, so we must not fall through to grep -r on
            // it (that would rescan .git/node_modules/build output). Only use the
            // recursive grep OUTSIDE a repo, and even then exclude the usual junk.
            const P = 'TODO|FIXME|HACK|XXX|BUG';
            const cmd = 'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ' +
                'git grep -nI -E "' + P + '" -- . 2>/dev/null; ' +
                'else grep -rnI --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv -E "' + P + '" . 2>/dev/null; fi; true';
            const text = await cockpit.spawn(['sh', '-c', cmd], { directory: root, err: 'message' }).catch(() => '');
            if (scc.todo._gen !== gen) return;
            const r = this._sccParseTodos(text);
            scc.todo.items = r.items; scc.todo.counts = r.counts; scc.todo.ranAt = Date.now();
        } catch (e) { if (scc.todo._gen === gen) scc.todo.err = e.message || String(e); }
        finally { if (scc.todo._gen === gen) scc.todo.loading = false; }
    },
    // PURE (unit-tested): grep output ("path:line:content") → items + marker counts.
    _sccParseTodos(text) {
        const items = [], counts = {};
        const re = /\b(TODO|FIXME|HACK|XXX|BUG)\b/;
        for (const line of String(text || '').split('\n')) {
            if (!line) continue;
            const m1 = line.indexOf(':');
            const m2 = line.indexOf(':', m1 + 1);
            if (m1 < 0 || m2 < 0) continue;
            const file = line.slice(0, m1);
            const ln = parseInt(line.slice(m1 + 1, m2), 10) || 0;
            const body = line.slice(m2 + 1).trim();
            const mk = re.exec(body);
            if (!mk) continue;
            const marker = mk[1];
            counts[marker] = (counts[marker] || 0) + 1;
            if (items.length < 500) items.push({ file, line: ln, marker, text: body.slice(0, 200) });
        }
        return { items, counts };
    },

    // ── external analysis tools (gitleaks/osv-scanner/jscpd/lizard) ────────────
    // Each finds "findings" and shares one generic detect/install/run path. The
    // shell `cmd` writes JSON (or CSV) to stdout — via $1 (a temp file) for tools
    // that only write reports to a path — run from the repo root; `parse` is pure.
    _sccToolDefs() {
        return {
            secrets: {
                label: 'Secrets', bin: 'gitleaks', doc: 'https://github.com/gitleaks/gitleaks',
                install: { kind: 'binary', repo: 'gitleaks/gitleaks', tar: 'gitleaks', archX: { x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64', i386: 'x32', i686: 'x32' }, asset: 'gitleaks_${ver}_linux_${a}.tar.gz' },
                cmd: 'gitleaks detect --source . --no-git --no-banner -f json -r "$1" >/dev/null 2>&1; printf "EXIT %s\\n" "$?"; cat "$1" 2>/dev/null',
                okExits: [0, 1],   // 0 = clean, 1 = leaks found; higher = a real error
                parse: (t) => this._sccParseGitleaks(t),
            },
            deps: {
                label: 'Dependencies', bin: 'osv-scanner', doc: 'https://github.com/google/osv-scanner',
                install: { kind: 'binary-bare', repo: 'google/osv-scanner', out: 'osv-scanner', archX: { x86_64: 'amd64', arm64: 'arm64', aarch64: 'arm64' }, asset: 'osv-scanner_linux_${a}' },
                cmd: 'osv-scanner --format json --output "$1" --recursive . >/dev/null 2>&1; printf "EXIT %s\\n" "$?"; cat "$1" 2>/dev/null',
                okExits: [0, 1],   // 1 = vulnerabilities found
                emptyExits: { 128: 'No dependency manifests found to scan (no package-lock.json, go.mod, requirements.txt, …).' },
                parse: (t) => this._sccParseOsv(t),
            },
            dup: {
                label: 'Duplication', bin: 'jscpd', doc: 'https://github.com/kucherenko/jscpd',
                install: { kind: 'npm', pkg: 'jscpd' },
                cmd: 'd=$(mktemp -d); jscpd --silent --reporters json --output "$d" . >/dev/null 2>&1; e=$?; printf "EXIT %s\\n" "$e"; cat "$d/jscpd-report.json" 2>/dev/null; rm -rf "$d"',
                okExits: [0, 1],
                parse: (t) => this._sccParseJscpd(t),
            },
            fn: {
                label: 'Function complexity', bin: 'lizard', doc: 'https://github.com/terryyin/lizard',
                install: { kind: 'pip', pkg: 'lizard' },
                cmd: 'lizard --csv . > "$1" 2>/dev/null; printf "EXIT %s\\n" "$?"; cat "$1" 2>/dev/null',
                okExits: [0, 1],
                parse: (t) => this._sccParseLizard(t),
            },
        };
    },
    async aiSccOpenTool(session, key) {
        const scc = this._sccEnsure(session);
        const t = scc.tools[key];
        if (!t) return;
        if (t.installed === null) {
            const def = this._sccToolDefs()[key];
            try { await cockpit.spawn(['sh', '-c', 'command -v ' + def.bin + ' 2>/dev/null'], { err: 'ignore' }); t.installed = true; }
            catch (e) { t.installed = false; }
            if (!t.installed) {
                const osr = await cockpit.spawn(['sh', '-c', 'cat /etc/os-release 2>/dev/null']).catch(() => '');
                t.installCmd = this._sccToolInstallCmd(key, osr);
            }
        }
        // First-run the scan if installed and nothing is saved yet; otherwise the
        // cached findings show without re-scanning.
        if (t.installed) this.aiSccMaybeRun(session, key);
    },
    async aiSccRunTool(session, key) {
        const scc = this._sccEnsure(session);
        const def = this._sccToolDefs()[key];
        const t = scc.tools[key];
        const root = this._sccRoot(session);
        if (!def || !t || !root || !t.installed) return;
        const gen = (t._gen = (t._gen || 0) + 1);
        t.loading = true; t.err = '';
        try {
            const out = (await cockpit.spawn(['mktemp'], { err: 'message' })).trim();
            const text = await cockpit.spawn(['sh', '-c', def.cmd, 'sh', out], { directory: root, err: 'message' });
            await cockpit.spawn(['rm', '-f', out]).catch(() => {});
            if (t._gen !== gen) return;
            // The command prints "EXIT <code>" before the report. A code outside
            // the tool's ok-exits means it actually FAILED (not "clean") — surface
            // that instead of parsing the empty report into zero findings.
            const m = /^EXIT (\d+)\s*\n?/.exec(text);
            if (!m) { t.err = def.bin + ' produced no output (it may have failed).'; t.ranAt = Date.now(); return; }
            const code = parseInt(m[1], 10);
            // Some tools use a specific exit for "nothing to scan" (not an error):
            // report it as an empty result with a helpful note, not a failure.
            if (def.emptyExits && def.emptyExits[code] != null) { t.findings = []; t.summary = def.emptyExits[code]; t.ranAt = Date.now(); return; }
            const okExits = def.okExits || [0];
            if (okExits.indexOf(code) === -1) { t.err = def.bin + ' failed (exit ' + code + ').'; t.findings = []; t.summary = ''; t.ranAt = Date.now(); return; }
            const report = text.slice(m[0].length);
            const r = def.parse(report) || { findings: [], summary: '' };
            t.findings = r.findings || []; t.summary = r.summary || ''; t.ranAt = Date.now();
        } catch (e) { if (t._gen === gen) t.err = e.message || String(e); }
        finally { if (t._gen === gen) t.loading = false; }
    },
    // Turnkey install per tool: GitHub-release binary (tarball or bare), npm, or pip.
    _sccToolInstallCmd(key, osReleaseText) {
        const def = this._sccToolDefs()[key];
        const ins = def.install;
        if (ins.kind === 'npm') return 'npm install -g ' + ins.pkg;
        if (ins.kind === 'pip') {
            // Use `python3 -m pip`, NOT the pip/pip3 scripts (often not on PATH even
            // though python3 is — Cockpit requires python3). ensurepip bootstraps
            // pip when the module is missing. Install SYSTEM-wide (run as root, no
            // --user) so the `lizard` entry-point lands in /usr/{local/}bin — on
            // PATH — where the detection `command -v lizard` will find it; a --user
            // install would go to ~/.local/bin which the spawn PATH may not include.
            // --break-system-packages handles PEP 668 "externally-managed" distros.
            const p = ins.pkg;
            // --prefix=/usr/local forces the entry-point into /usr/local/bin (always
            // on PATH) instead of ~/.local/bin (which sudo's kept $HOME would target
            // and the spawn PATH may not include). Libs land in /usr/local/lib's
            // site-packages, on the default sys.path.
            return 'python3 -m ensurepip >/dev/null 2>&1 || true; ' +
                'python3 -m pip install --break-system-packages --prefix=/usr/local ' + p +
                ' || python3 -m pip install --prefix=/usr/local ' + p;
        }
        // Binary from a GitHub release (latest version fetched from the API). The
        // asset template keeps its ${ver}/${a} braces so the shell knows where each
        // variable ends — WITHOUT braces, `gitleaks_$ver_linux_$a` parses as one
        // variable `ver_linux_` and drops `$ver`/`_linux_` (a real 404 bug). ins.repo
        // and ins.asset are hard-coded constants, so this is not injectable.
        const archCases = Object.keys(ins.archX).map(k => k + ') a=' + ins.archX[k] + ';;').join(' ');
        const lines = [
            'set -e',
            'arch=$(uname -m); case "$arch" in ' + archCases + ' *) a="$arch";; esac',
            'ver=$(curl -fsSL https://api.github.com/repos/' + ins.repo + '/releases/latest | sed -n \'s/.*"tag_name": *"v\\{0,1\\}\\([^"]*\\)".*/\\1/p\' | head -1)',
            '[ -n "$ver" ] || { echo "could not determine the latest ' + ins.repo + ' version"; exit 1; }',
            'tmp=$(mktemp -d)',
            'url="https://github.com/' + ins.repo + '/releases/download/v${ver}/' + ins.asset + '"',
            'echo "Downloading $url"',
        ];
        if (ins.kind === 'binary') {   // tarball containing the binary named `tar`
            lines.push('curl -fSL "$url" -o "$tmp/a.tgz" || wget -O "$tmp/a.tgz" "$url"');
            lines.push('tar xzf "$tmp/a.tgz" -C "$tmp" ' + ins.tar);
            lines.push('install -m 0755 "$tmp/' + ins.tar + '" /usr/local/bin/' + def.bin);
        } else {                        // a bare binary asset
            lines.push('curl -fSL "$url" -o "$tmp/bin" || wget -O "$tmp/bin" "$url"');
            lines.push('install -m 0755 "$tmp/bin" /usr/local/bin/' + ins.out);
        }
        lines.push('rm -rf "$tmp"');
        lines.push(def.bin + ' --version 2>/dev/null || true');
        return lines.join('\n');
    },
    async aiSccInstallTool(session, key) {
        const scc = this._sccEnsure(session);
        const t = scc.tools[key];
        const def = this._sccToolDefs()[key];
        const cmd = t.installCmd || this._sccToolInstallCmd(key, await cockpit.spawn(['sh', '-c', 'cat /etc/os-release 2>/dev/null']).catch(() => ''));
        const sup = true;   // every route (npm -g, GitHub binary → /usr/local/bin, pip system) writes system dirs
        const ok = await this.askConfirm('Install ' + def.bin, 'Install ' + def.bin + (sup ? ' as administrator' : '') + '? This runs:\n\n' + cmd, 'Install');
        if (!ok) return;
        t.installing = true; t.installLog = '# installing ' + def.bin + '…\n';
        try {
            const opts = { err: 'out' };
            if (sup) opts.superuser = 'require';
            const proc = cockpit.spawn(['sh', '-c', cmd], opts);
            proc.stream((d) => { t.installLog += d; });
            await proc;
            try { await cockpit.spawn(['sh', '-c', 'command -v ' + def.bin + ' 2>/dev/null'], { err: 'ignore' }); t.installed = true; }
            catch (e) { t.installed = false; }
            if (t.installed) { t.installLog += '\n' + def.bin + ' installed — running.\n'; this.aiSccRunTool(session, key).then(() => this._sccSaveAnalyses(session)); }
            else t.installLog += '\nInstall finished but ' + def.bin + ' still isn’t on PATH.\n';
        } catch (e) {
            t.installLog += '\nInstall failed: ' + (e.message || e) + '\n';
            this.toast(def.bin + ' install failed — see the log', 'danger');
        } finally { t.installing = false; }
    },

    // ── tool output parsers (pure, unit-tested with sample output) ────────────
    _sccParseGitleaks(text) {
        let arr = []; try { arr = JSON.parse(text); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        const findings = arr.slice(0, 300).map(f => ({
            file: f.File || f.file || '?', line: f.StartLine || f.line || 0,
            rule: f.RuleID || f.Rule || '', desc: f.Description || f.desc || '',
        }));
        return { findings, summary: findings.length + (findings.length === 1 ? ' potential secret' : ' potential secrets') };
    },
    _sccParseOsv(text) {
        let d = {}; try { d = JSON.parse(text); } catch (e) { d = {}; }
        const findings = []; let pkgs = 0;
        for (const res of (d.results || [])) {
            for (const p of (res.packages || [])) {
                const pkg = (p.package || {});
                const vulns = p.vulnerabilities || [];
                if (vulns.length) pkgs++;
                for (const v of vulns) {
                    // Prefer a SHORT qualitative rating (HIGH/MODERATE/…). OSV's
                    // severity[].score is usually a full CVSS vector string
                    // ("CVSS:4.0/AV:N/AC:H/…") — too long for the table/report and
                    // not a rating — so only use it when it's a short bare score,
                    // else fall back to the compact CVSS-version label.
                    const so = (Array.isArray(v.severity) && v.severity[0]) ? v.severity[0] : null;
                    const raw = so ? String(so.score || '') : '';
                    let sev = '';
                    if (v.database_specific && v.database_specific.severity) sev = v.database_specific.severity;
                    else if (raw && !/^CVSS:/i.test(raw)) sev = raw;
                    else if (so) sev = String(so.type || '').replace(/_/g, ' ');
                    findings.push({ package: pkg.name || '?', version: pkg.version || '', ecosystem: pkg.ecosystem || '', id: v.id || '', severity: sev, summary: v.summary || '' });
                }
            }
        }
        return { findings: findings.slice(0, 300), summary: findings.length + ' vulnerabilities across ' + pkgs + ' packages' };
    },
    _sccParseJscpd(text) {
        let d = {}; try { d = JSON.parse(text); } catch (e) { d = {}; }
        const dups = (d.duplicates || []);
        const findings = dups.slice(0, 300).map(x => ({
            fileA: (x.firstFile && x.firstFile.name) || '?', lineA: (x.firstFile && x.firstFile.start) || 0,
            fileB: (x.secondFile && x.secondFile.name) || '?', lineB: (x.secondFile && x.secondFile.start) || 0,
            lines: x.lines || 0,
        }));
        const pct = d.statistics && d.statistics.total ? d.statistics.total.percentage : 0;
        return { findings, summary: (pct != null ? pct + '% duplicated · ' : '') + findings.length + ' clones' };
    },
    _sccParseLizard(text) {
        // lizard --csv rows: NLOC,CCN,token,PARAM,length,LOCATION,file,function,…
        // where LOCATION (column 5, quoted) is "function@startline-endline@file".
        // Parse ONLY column 5 — the trailing columns must not be swept in.
        const rows = [];
        for (const line of String(text || '').split('\n')) {
            if (!line.trim()) continue;
            const c = line.split(',');
            if (c.length < 6) continue;
            const ccn = parseInt(c[1], 10); if (!Number.isFinite(ccn)) continue;
            const loc = (c[5] || '').replace(/^"|"$/g, '');
            const parts = loc.split('@');
            const fn = parts[0] || '?';
            const file = parts.length >= 3 ? parts.slice(2).join('@') : (parts[1] || '');   // func@line@file
            rows.push({ func: fn, file, ccn, nloc: parseInt(c[0], 10) || 0, params: parseInt(c[3], 10) || 0 });
        }
        rows.sort((a, b) => b.ccn - a.ccn);
        const over = rows.filter(r => r.ccn > 15).length;
        return { findings: rows.slice(0, 100), summary: rows.length + ' functions · ' + over + ' over CCN 15' };
    },

    // ── coverage overlay (lcov, no extra tool) ────────────────────────────────
    // Reads an existing lcov file (whatever the project's test runner produced)
    // and reports per-file line coverage — lowest first, the "needs tests" view.
    // lcov SF: paths are repo-root-relative, matching scc's Location and the tree.
    async aiSccRefreshCoverage(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root) return;
        const gen = (scc.cov._gen = (scc.cov._gen || 0) + 1);
        scc.cov.loading = true; scc.cov.err = '';
        try {
            const finder = 'for f in coverage/lcov.info lcov.info coverage/coverage.info coverage.lcov coverage/lcov.dat; do [ -f "$f" ] && printf "%s" "$f" && exit 0; done';
            const found = ((await cockpit.spawn(['sh', '-c', finder, 'sh'], { directory: root, err: 'message' }).catch(() => '')) || '').trim();
            if (scc.cov._gen !== gen) return;
            if (!found) {
                scc.cov.err = 'No lcov file found (looked for coverage/lcov.info, lcov.info, …). Run your test suite’s coverage first.';
                scc.cov.files = []; scc.cov.total = null; scc.cov.ranAt = Date.now();
                return;
            }
            const text = await cockpit.spawn(['cat', found], { directory: root, err: 'message' });
            if (scc.cov._gen !== gen) return;
            const cov = this._sccParseLcov(text);
            scc.cov.path = found;
            scc.cov.map = cov;
            scc.cov.files = this._sccCoverageRows(cov, 100);
            scc.cov.total = this._sccCoverageTotal(cov);
            scc.cov.ranAt = Date.now();
        } catch (e) {
            if (scc.cov._gen !== gen) return;
            scc.cov.err = e.message || String(e);
        } finally {
            if (scc.cov._gen === gen) scc.cov.loading = false;
        }
    },
    // PURE (unit-tested): lcov text → { relPath: {lines, hit, pct} }. Counts DA:
    // records (line,hits) so it works whether or not the file emits LF:/LH:.
    _sccParseLcov(text) {
        const files = {};
        let cur = null, found = 0, hit = 0;
        const flush = () => { if (cur) files[cur] = { lines: found, hit, pct: found > 0 ? Math.round(1000 * hit / found) / 10 : 0 }; };
        for (const line of String(text || '').split('\n')) {
            if (line.startsWith('SF:')) { flush(); cur = line.slice(3).trim(); found = 0; hit = 0; }
            else if (line.startsWith('DA:')) { const h = parseInt(line.slice(3).split(',')[1], 10) || 0; found++; if (h > 0) hit++; }
            else if (line === 'end_of_record') { flush(); cur = null; found = 0; hit = 0; }
        }
        flush();
        return files;
    },
    // PURE: covered files as rows, lowest coverage first (biggest files break ties).
    _sccCoverageRows(covMap, n) {
        const rows = Object.keys(covMap || {}).map(p => ({
            location: p, filename: p.split('/').pop() || p,
            lines: covMap[p].lines, hit: covMap[p].hit, pct: covMap[p].pct,
        }));
        rows.sort((a, b) => (a.pct - b.pct) || (b.lines - a.lines));
        return n ? rows.slice(0, n) : rows;
    },
    // PURE: overall coverage across all files in the map.
    _sccCoverageTotal(covMap) {
        let f = 0, h = 0, n = 0;
        for (const p of Object.keys(covMap || {})) { f += covMap[p].lines; h += covMap[p].hit; n++; }
        return { files: n, lines: f, hit: h, pct: f > 0 ? Math.round(1000 * h / f) / 10 : 0 };
    },

    // ── report data assembly (pure, unit-tested) ──────────────────────────────
    // Build the JSON the Python generator (report/census.py) consumes from the
    // already-run table + complexity state. `meta` carries branch/commit/date/root.
    // Summaries of any external-tool analyses the user has already run (we don't
    // force-run gitleaks/osv-scanner/etc. for the report — they may be missing).
    _sccToolFindingsSummary(scc) {
        const out = {};
        for (const key of Object.keys(scc.tools || {})) {
            const t = scc.tools[key];
            if (t && t.ranAt) out[key] = { label: (this._sccToolDefs()[key] || {}).label || key, count: (t.findings || []).length, summary: t.summary || '' };
        }
        return out;
    },
    _sccReportData(table, files, meta, riskHotspots, quality) {
        const rows = (table && table.rows) || [];
        const total = (table && table.total) || {};
        const src = rows.filter(r => r.kind !== 'data').reduce((s, r) => s + (r.code || 0), 0);
        const dat = rows.filter(r => r.kind === 'data').reduce((s, r) => s + (r.code || 0), 0);
        const hotspots = this._sccTopComplex(files, 8);
        const largest = (files || []).slice().sort((a, b) => (b.code || 0) - (a.code || 0)).slice(0, 8);
        // Distributions computed here (compact) rather than shipping every file:
        // McCabe risk bands and a file-size histogram, both from per-file scc data.
        const bands = { none: 0, low: 0, moderate: 0, high: 0, veryHigh: 0, extreme: 0 };
        const size = { b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };   // <50,50-99,100-199,200-399,400-799,800+
        for (const f of (files || [])) {
            const c = f.complexity || 0;
            if (c === 0) bands.none++; else if (c <= 10) bands.low++; else if (c <= 20) bands.moderate++;
            else if (c <= 50) bands.high++; else if (c <= 100) bands.veryHigh++; else bands.extreme++;
            const cl = f.code || 0;
            if (cl < 50) size.b1++; else if (cl < 100) size.b2++; else if (cl < 200) size.b3++;
            else if (cl < 400) size.b4++; else if (cl < 800) size.b5++; else size.b6++;
        }
        return {
            title: (meta && meta.title) || 'Code',
            subtitle: 'A structural snapshot produced with scc: size, composition and complexity.',
            meta: meta || {},
            totals: {
                files: total.files || 0, lines: total.lines || 0, code: total.code || 0,
                comments: total.comments || 0, blanks: total.blanks || 0, complexity: total.complexity || 0,
                bytes: (files || []).reduce((s, f) => s + (f.bytes || 0), 0),
                languages: rows.length,
                cxPerKloc: total.code ? Math.round((total.complexity || 0) * 1000 / total.code) : 0,
            },
            languages: rows,
            hotspots, largest,
            riskHotspots: (riskHotspots || []).slice(0, 12),
            riskBands: bands, sizeBuckets: size,
            quality: quality || {},
            insights: this._sccInsights(total, rows, hotspots, src, dat, riskHotspots),
        };
    },
    _sccInsights(total, rows, hotspots, src, dat, riskHotspots) {
        const out = [];
        const n = (v) => Number(v || 0).toLocaleString();
        const tot = (src + dat) || 1;
        if (riskHotspots && riskHotspots[0]) { const h = riskHotspots[0]; out.push({ title: 'Risk concentrates where change meets complexity.', body:
            h.filename + ' scores highest on churn × complexity: ' + n(h.churn) + ' recent commits against ' + n(h.complexity) +
            ' complexity points. Files high on both are where defects and change cost concentrate — the first place to add tests or split responsibility.' }); }
        if (dat > 0) out.push({ title: 'Data versus source.', body:
            n(dat) + ' of ' + n(total.code) + ' code lines are data or configuration formats (JSON, SVG, CSV and similar). ' +
            'Any size metric that includes these — including scc’s default COCOMO estimate — overstates the engineering footprint.' });
        if (hotspots && hotspots[0]) { const h = hotspots[0]; out.push({ title: 'Complexity concentrates in a few files.', body:
            'The most complex file, ' + h.filename + ', carries ' + n(h.complexity) + ' complexity points in ' + n(h.code) +
            ' code lines. Files like it are the obvious candidates for decomposition if the review and testing burden should shrink.' }); }
        const top = (rows[0] || {});
        if (top.name) out.push({ title: 'The largest language dominates.', body:
            top.name + ' holds ' + n(top.code) + ' code lines (' + Math.round(100 * (top.code || 0) / (total.code || 1)) +
            '% of all code). The composition on the previous page shows how the rest is distributed.' });
        return out;
    },
    _sccReportFilename() { return 'code-census.pdf'; },

    // ── background auto-refresh via a per-repo systemd USER timer ──────────────
    // A oneshot service runs `scc --by-file` and writes a JSON cache; a timer
    // fires it every settings.sccRefreshMins. The pane watches the cache and
    // reloads when it updates. Enabling asks for consent first — it writes user
    // unit files and enables a timer. Everything is per-user (systemctl --user),
    // fully reversible from the same toggle.
    _sccUnitBase: 'cockpit-explorer-scc',
    async _sccEscape(root) {
        try { return (await cockpit.spawn(['systemd-escape', root], { err: 'message' })).trim(); }
        catch (e) { return ''; }
    },
    async _sccCachePath(root) {
        const esc = await this._sccEscape(root);
        if (!esc) return '';
        const home = this.homePath || await FS.homeDir();
        return home + '/.cache/cockpit-explorer/scc/' + esc + '.json';
    },
    async aiSccAutoStatus(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root) return;
        const esc = await this._sccEscape(root);
        if (!esc) { scc.auto = { enabled: false, available: false }; return; }
        const unit = this._sccUnitBase + '@' + esc + '.timer';
        let enabled = false;
        try { enabled = /enabled/.test(await cockpit.spawn(['systemctl', '--user', 'is-enabled', unit], { err: 'message' })); }
        catch (e) { enabled = false; }
        scc.auto = { enabled, available: true, esc };
        if (enabled) this._sccWatchCache(session);
    },
    async aiSccToggleAuto(session) {
        const scc = this._sccEnsure(session);
        const root = this._sccRoot(session);
        if (!root) return;
        const esc = await this._sccEscape(root);
        if (!esc) { this.toast('systemd-escape is unavailable on this host.', 'danger'); return; }
        const timer = this._sccUnitBase + '@' + esc + '.timer';
        if (scc.auto && scc.auto.enabled) {
            try { await cockpit.spawn(['systemctl', '--user', 'disable', '--now', timer], { err: 'message' }); scc.auto.enabled = false; this._sccDisposeSession(session); this.toast('Background auto-refresh disabled.', 'info'); }
            catch (e) { this.toast('Could not disable: ' + (e.message || e), 'danger'); }
            return;
        }
        const mins = Math.max(5, (this.settings && this.settings.sccRefreshMins) || 60);
        const ok = await this.askConfirm('Enable background auto-refresh',
            'Explorer will create two systemd USER units in ~/.config/systemd/user and enable a timer that runs `scc` on:\n\n' + root +
            '\n\nevery ' + mins + ' minutes in the background (even when this page is closed), writing results to ~/.cache/cockpit-explorer/scc. This pane reloads automatically when they update, and shows a loading state while the timer runs. Everything is per-user and you can turn it off from the same button. Continue?',
            'Enable');
        if (!ok) return;
        try {
            await this._sccWriteUnits(mins);
            await cockpit.spawn(['systemctl', '--user', 'daemon-reload'], { err: 'message' });
            await cockpit.spawn(['systemctl', '--user', 'enable', '--now', timer], { err: 'message' });
            scc.auto = { enabled: true, available: true, esc };
            this.toast('Background auto-refresh enabled (every ' + mins + ' min).', 'success');
            cockpit.spawn(['systemctl', '--user', 'start', this._sccUnitBase + '@' + esc + '.service'], { err: 'ignore' }).catch(() => {});
            this._sccWatchCache(session);
        } catch (e) {
            this.toast('Could not enable auto-refresh: ' + (e.message || e) + ' (a user systemd session may be required — try `loginctl enable-linger`).', 'danger');
        }
    },
    async _sccWriteUnits(mins) {
        const home = this.homePath || await FS.homeDir();
        const udir = home + '/.config/systemd/user';
        await cockpit.spawn(['mkdir', '-p', udir], { err: 'message' });
        const cache = '%h/.cache/cockpit-explorer/scc';
        // The repo path (%I) and the cache path are passed as ARGUMENTS ($1/$2),
        // never interpolated into the shell source — systemd expands %I before the
        // shell parses, so a path containing `$(...)`/backticks would otherwise run
        // as a command. `cd "$1"` + scc on `.` also keeps Location values
        // root-relative, matching the interactive run (so the tree/hotspots join).
        const service = [
            '[Unit]', 'Description=Explorer code-census refresh (%I)', '',
            '[Service]', 'Type=oneshot',
            'ExecStartPre=/bin/mkdir -p ' + cache,
            'ExecStart=/bin/sh -c \'cd "$1" && scc --by-file --format json . > "$2.tmp" 2>/dev/null && mv "$2.tmp" "$2"\' sh "%I" "' + cache + '/%i.json"', '',
        ].join('\n');
        const timer = [
            '[Unit]', 'Description=Explorer code-census timer (%I)', '',
            '[Timer]', 'OnBootSec=2min', 'OnUnitActiveSec=' + mins + 'min', 'Persistent=true', '',
            '[Install]', 'WantedBy=timers.target', '',
        ].join('\n');
        await cockpit.file(udir + '/' + this._sccUnitBase + '@.service').replace(service);
        await cockpit.file(udir + '/' + this._sccUnitBase + '@.timer').replace(timer);
    },
    // Watch the per-repo cache and reload table + complexity from it when the
    // timer rewrites it (a background run finished). Loads once immediately.
    async _sccWatchCache(session) {
        const scc = this._sccEnsure(session);
        if (scc._autoWatching) return;
        const root = this._sccRoot(session);
        const path = await this._sccCachePath(root);
        if (!path) return;
        scc._autoWatching = true;
        const load = async () => {
            try {
                const text = await cockpit.file(path).read();
                if (!text) return;
                const langs = this._sccParse(text);
                if (!langs.length) return;
                const t = this._sccTableRows(langs);
                scc.table.rows = this._sccSortRows(t.rows, scc.sort); scc.table.total = t.total; scc.table.ranAt = Date.now();
                const files = this._sccFiles(langs);
                scc.cx.files = files; scc.cx.top = this._sccTopComplex(files, 50); scc.cx.ranAt = Date.now();
                if (session.tree) session.tree.cx = this._sccComplexityByPath(files, root);
                this._sccSaveAnalyses(session);   // persist the auto-update result
            } catch (e) { /* cache not ready yet */ }
        };
        await load();
        try { scc._autoWatchHandle = cockpit.file(path).watch(() => load()); } catch (e) {}
    },
    // Close a session's cache watcher (on disable, or when the session/tab closes)
    // — otherwise the watch (and its closure over the session) leaks and keeps
    // firing for a discarded session. Called from closeTab/closeTerminal.
    _sccDisposeSession(session) {
        const scc = session && session.scc;
        if (scc && scc._autoWatchHandle) {
            try { scc._autoWatchHandle.remove ? scc._autoWatchHandle.remove() : scc._autoWatchHandle.close(); } catch (e) {}
            scc._autoWatchHandle = null;
        }
        if (scc) scc._autoWatching = false;
    },

    // ── persistence: save analyses to disk, load on open (no auto-run) ─────────
    // Results are cached per repo so they survive reloads. Analyses run ONLY on an
    // explicit Refresh or the systemd auto-update timer — opening the pane just
    // loads the last saved results.
    async _sccAnalysisCachePath(root) {
        const esc = await this._sccEscape(root);
        if (!esc) return '';
        const home = this.homePath || await FS.homeDir();
        return home + '/.cache/cockpit-explorer/scc/' + esc + '.analyses.json';
    },
    _sccSnapshot(scc) {
        const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
        return {
            savedAt: Date.now(), root: scc.rootFor,
            table: pick(scc.table, ['rows', 'total', 'ranAt']),
            cx: pick(scc.cx, ['files', 'top', 'ranAt']),
            hot: pick(scc.hot, ['files', 'churn', 'ranAt']),
            cov: pick(scc.cov, ['files', 'total', 'map', 'path', 'ranAt']),
            todo: pick(scc.todo, ['items', 'counts', 'ranAt']),
            tools: {
                secrets: pick(scc.tools.secrets, ['findings', 'summary', 'ranAt']),
                deps: pick(scc.tools.deps, ['findings', 'summary', 'ranAt']),
                dup: pick(scc.tools.dup, ['findings', 'summary', 'ranAt']),
                fn: pick(scc.tools.fn, ['findings', 'summary', 'ranAt']),
            },
        };
    },
    async _sccSaveAnalyses(session) {
        try {
            const root = this._sccRoot(session); if (!root) return;
            const path = await this._sccAnalysisCachePath(root); if (!path) return;
            await cockpit.spawn(['mkdir', '-p', path.replace(/\/[^/]*$/, '')], { err: 'ignore' }).catch(() => {});
            await cockpit.file(path).replace(JSON.stringify(this._sccSnapshot(session.scc)));
        } catch (e) { /* best-effort */ }
    },
    async _sccLoadAnalyses(session) {
        try {
            const root = this._sccRoot(session); if (!root) return false;
            const path = await this._sccAnalysisCachePath(root); if (!path) return false;
            const text = await cockpit.file(path).read();
            // The root can change (navigation) while this read is in flight — if
            // it did, don't repopulate the pane with the previous repo's cache.
            if (this._sccRoot(session) !== root) return false;
            if (!text) return false;
            const snap = JSON.parse(text);
            if (!snap || snap.root !== root) return false;   // stale / different repo
            const scc = session.scc;
            Object.assign(scc.table, snap.table || {});
            Object.assign(scc.cx, snap.cx || {});
            Object.assign(scc.hot, snap.hot || {});
            Object.assign(scc.cov, snap.cov || {});
            Object.assign(scc.todo, snap.todo || {});
            if (snap.tools) for (const k of ['secrets', 'deps', 'dup', 'fn']) if (snap.tools[k]) Object.assign(scc.tools[k], snap.tools[k]);
            scc.savedAt = snap.savedAt;
            if (session.tree && scc.cx.files && scc.cx.files.length) session.tree.cx = this._sccComplexityByPath(scc.cx.files, root);
            return true;
        } catch (e) { return false; }
    },

    // ── report generation (Python, no browser) ────────────────────────────────
    // Assemble the JSON, then run report/census.py server-side: `python3 - <json>
    // <out.pdf>` with the script fed on stdin (so it works regardless of where the
    // plugin is installed). Default location is the repo root with a git-ignored
    // filename; the picker lets the user choose another folder.
    async aiSccReport(session) {
        if (!session) return;
        const scc = this._sccEnsure(session);
        if (!scc.installed) { this.toast('scc isn’t installed — see the scc pane for install steps.', 'warning'); return; }
        const root = this._sccRoot(session);
        if (!root) { this.toast('No folder to analyze.', 'warning'); return; }
        if (scc.reporting) return;               // already generating — ignore a double-click
        // Show the Report button's loading state from the click — the analyses
        // below and the folder dialog can take a while, and without this the
        // user sees nothing happen. Cleared on every exit path.
        scc.reporting = true;
        // EVERYTHING below runs inside this try/finally so the button's loading
        // state is ALWAYS cleared — even if an analysis throws, the folder dialog
        // is dismissed, or generation fails. Otherwise `reporting` could stay
        // true and leave the Report button permanently disabled.
        try {
            // Need the analyses for a full report (table = languages, complexity =
            // hotspots, churn = risk hotspots). Hotspots are best-effort (no git → skip).
            if (!scc.table.ranAt) await this.aiSccRefreshTable(session);
            if (!scc.cx.ranAt) await this.aiSccRefreshComplexity(session);
            if (!scc.hot.ranAt) await this.aiSccRefreshHotspots(session);
            if (!scc.cov.ranAt) await this.aiSccRefreshCoverage(session);   // best-effort (no lcov → skipped)
            if (!scc.todo.ranAt) await this.aiSccRefreshTodos(session);
            this._sccSaveAnalyses(session);   // persist whatever the report just computed
            if (scc.table.err || scc.cx.err) { this.toast('scc analysis failed — ' + (scc.table.err || scc.cx.err), 'danger'); return; }

            // Where to save: default the repo root (report is git-ignored); the
            // picker lets the user pick another folder.
            const dir = await this.askDirectory('Save code-census report to…', root);
            if (!dir) return;
            const outPath = Util.joinPath(dir, this._sccReportFilename());

            // Meta (branch/commit/date/scc version) for the cover + headers.
            const q = async (argv) => { try { return (await cockpit.spawn(argv, { err: 'ignore', directory: root })).trim(); } catch (e) { return ''; } };
            const meta = {
                title: (root.split('/').filter(Boolean).pop() || 'Code'),
                branch: (await q(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])) || 'working tree',
                commit: await q(['git', 'rev-parse', '--short', 'HEAD']),
                date: new Date().toISOString().slice(0, 10),
                root: root,
                sccVersion: ((await q(['sh', '-c', 'scc --version 2>/dev/null'])).match(/[0-9][0-9.]*/) || [''])[0],
                generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
            };
            const scanner = (key, label) => scc.tools[key].ranAt ? { label, summary: scc.tools[key].summary, findings: (scc.tools[key].findings || []).slice(0, 40), count: (scc.tools[key].findings || []).length } : null;
            const data = this._sccReportData(scc.table, scc.cx.files, meta, scc.hot.files, {
                coverage: scc.cov.ranAt ? { total: scc.cov.total, lowest: (scc.cov.files || []).slice(0, 12), path: scc.cov.path } : null,
                todo: scc.todo.ranAt ? { counts: scc.todo.counts, total: (scc.todo.items || []).length, items: (scc.todo.items || []).slice(0, 30) } : null,
                findings: this._sccToolFindingsSummary(scc),
                scanners: {
                    secrets: scanner('secrets', 'Secrets (gitleaks)'),
                    deps: scanner('deps', 'Dependency vulnerabilities (osv-scanner)'),
                    dup: scanner('dup', 'Duplication (jscpd)'),
                    fn: scanner('fn', 'Function complexity (lizard)'),
                },
            });

            // Load the generator (served with the plugin) and run it via stdin.
            const script = await fetch('report/census.py').then(r => { if (!r.ok) throw new Error('report generator not found'); return r.text(); });
            const tmp = (await cockpit.spawn(['mktemp'], { err: 'message' })).trim();
            try {
                await cockpit.file(tmp).replace(JSON.stringify(data));
                const proc = cockpit.spawn(['python3', '-', tmp, outPath], { err: 'message' });
                proc.input(script);
                await proc;
            } finally {
                await cockpit.spawn(['rm', '-f', tmp]).catch(() => {});   // clean up even if python failed
            }

            // Keep the report out of version control when it lands in the repo.
            if (dir === root) await this._sccGitignore(root);
            this.toast('Report saved: ' + outPath, 'success');
            // Offer it in the preview pane.
            try { const st = await FS.statOne(outPath); this.openPreview({ path: outPath, name: this._sccReportFilename(), type: 'f', size: (st && st.size) || 0 }); } catch (e) {}
        } catch (e) {
            this.toast('Report generation failed: ' + (e.message || e), 'danger');
        } finally {
            scc.reporting = false;
        }
    },
    // Append the report filename to <root>/.gitignore if it's a repo and not
    // already ignored. Best-effort — a failure here doesn't fail the report.
    async _sccGitignore(root) {
        try {
            await cockpit.spawn(['git', '-C', root, 'rev-parse', '--is-inside-work-tree'], { err: 'ignore' });
            const path = Util.joinPath(root, '.gitignore');
            let cur = '';
            try { cur = await cockpit.file(path).read() || ''; } catch (e) { cur = ''; }
            const name = this._sccReportFilename();
            if (cur.split('\n').some(l => l.trim() === name)) return;
            const next = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + name + '\n';
            await cockpit.file(path).replace(next);
        } catch (e) { /* not a repo, or unwritable — leave it */ }
    },
};
