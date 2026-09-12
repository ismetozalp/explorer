// AI CLI tabs — run `claude` / `codex` in Explorer's integrated terminal with a
// live git working-tree diff beside it. Sessions are ordinary TERMINAL RECORDS
// in tab.terminals[] (so _findTermById / selectTerminal / closeTerminal / mount /
// reconnect all work unchanged) decorated with agent fields. The CLI is launched
// by SENDING it to the PTY after mount (term.initCommand → channel.send), so the
// working directory goes through the engine's `directory:` option (no shell `cd`,
// no injection) and a real shell remains after the CLI exits.
//
// Reactive session/browser state lives in app.js; pure helpers + orchestration
// live here. Diff-poll timers live in a plain Map (off the reactive proxy).
(function () {
    const _aiTimers = new Map();   // sessionId -> setTimeout handle

    window.ExplorerAgent = {

        // ───────── pure helpers (unit-tested; no this/I-O) ─────────

        _aiValidDir(d) { return typeof d === 'string' && d.startsWith('/'); },
        _aiValidTmux(n) { return typeof n === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(n); },
        _aiValidUuid(id) { return typeof id === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id); },

        // The command to type into the PTY. Returns null on an invalid resume id
        // so the caller can error instead of silently starting a NEW session.
        _aiCliCommand(tool, resumeId) {
            const t = tool === 'codex' ? 'codex' : 'claude';
            if (resumeId != null && resumeId !== '') {
                if (!this._aiValidUuid(resumeId)) return null;
                return t === 'codex' ? ('codex resume ' + resumeId) : ('claude --resume ' + resumeId);
            }
            return t;
        },

        _aiNextLabel(sessions, tool) {
            const n = (sessions || []).filter(s => s.tool === tool).length + 1;
            return n > 1 ? (tool + ' ' + n) : tool;
        },

        _aiDiffArgv(dir, mode) {
            if (mode === 'staged') return ['git', '-C', dir, 'diff', '--staged'];
            if (mode === 'unstaged') return ['git', '-C', dir, 'diff'];
            return ['git', '-C', dir, 'diff', 'HEAD'];   // 'all'
        },

        // Parse a unified diff into a changed-files strip.
        _aiDiffFiles(diffText) {
            const files = []; let cur = null;
            for (const line of String(diffText || '').split('\n')) {
                if (line.startsWith('diff --git ')) {
                    const m = / b\/(.+)$/.exec(line);
                    cur = { file: m ? m[1] : (line.slice(11) || '?'), added: 0, removed: 0 };
                    files.push(cur); continue;
                }
                if (!cur) continue;
                if (line.startsWith('+++') || line.startsWith('---')) continue;
                if (line[0] === '+') cur.added++;
                else if (line[0] === '-') cur.removed++;
            }
            return files;
        },

        _aiHashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); },
        _aiDiffChanged(session, text) {
            const h = this._aiHashStr(text);
            if (session.diff.hash === h) return false;
            session.diff.hash = h; return true;
        },

        // ───────── I/O probes ─────────

        async _aiDirExists(dir) { try { await cockpit.spawn(['sh', '-c', 'test -d "$1"', 'sh', dir]); return true; } catch (e) { return false; } },
        async _aiTmuxExists(name) { try { await cockpit.spawn(['tmux', 'has-session', '-t', name]); return true; } catch (e) { return false; } },

        async aiDetect() {
            // Use an INTERACTIVE bash so ~/.bashrc runs and ~/.local/bin (where
            // these CLIs usually live) is on PATH — matching what the AI terminal
            // itself will resolve. Cockpit's default spawn PATH is minimal and
            // would miss them.
            const has = async (bin) => { try { const o = await cockpit.spawn(['bash', '-ic', 'command -v "$1" 2>/dev/null', 'bash', bin], { err: 'message' }); return !!(o && o.trim()); } catch (e) { return false; } };
            this.ai.have = { claude: await has('claude'), codex: await has('codex') };
        },

        // ───────── orchestration ─────────

        aiActiveSession(tab) { return tab && tab.terminals ? tab.terminals.find(t => t.id === tab.activeTermId) : null; },

        openAgentTab(tool, dir, opts) {
            opts = opts || {};
            dir = this._aiValidDir(dir) ? dir : ((this.currentPane() && this.currentPane().path) || this.homePath || '/');
            const tab = { id: Util.uid(), kind: 'agent', title: '✦ ' + tool, path: dir, terminals: [], activeTermId: null };
            this.tabs.push(tab);
            this.activeTabId = tab.id;
            this.$nextTick(() => this.aiAddSession(tab, tool, { dir, resumeId: opts.resumeId || null }));
            return tab;
        },

        async aiAddSession(tab, tool, opts) {
            opts = opts || {};
            tab = (tab && this.tabs.find(t => t.id === tab.id)) || tab;
            let dir = opts.dir || (this.currentPane() && this.currentPane().path) || this.homePath || '/';
            if (!this._aiValidDir(dir)) dir = this.homePath || '/';
            const resumeId = opts.resumeId || null;

            if (resumeId) {
                if (!this._aiValidUuid(resumeId)) { this.toast('Invalid session id — cannot resume.', 'danger'); return; }
                if (!(await this._aiDirExists(dir))) {
                    this.toast('That project folder no longer exists — opening in the current folder.', 'warning');
                    dir = (this.currentPane() && this.currentPane().path) || this.homePath || '/';
                }
            }
            const cli = this._aiCliCommand(tool, resumeId);
            if (cli == null) { this.toast('Invalid session id — cannot resume.', 'danger'); return; }

            let tmuxName = null, sendInit = true;
            if (this.settings.aiLaunch === 'tmux') {
                const leaf = dir.split('/').filter(Boolean).pop() || 'session';
                const def = this._aiLastTmuxName || (tool + '-' + leaf);
                tmuxName = await this.askPrompt('tmux session', 'tmux session name (attaches if it exists, else creates)', def, {});
                if (tmuxName == null) return;                 // cancelled
                tmuxName = String(tmuxName).trim();
                if (!this._aiValidTmux(tmuxName)) { this.toast('Invalid tmux name — use letters, digits, _ . - only.', 'danger'); return; }
                this._aiLastTmuxName = tmuxName;
                // Attaching to an existing tmux session ignores the launch command,
                // so only send the CLI when we are CREATING the session.
                sendInit = !(await this._aiTmuxExists(tmuxName));
            }

            const label = this._aiNextLabel(tab.terminals, tool);
            const term = this.addTerminalToTab(tab, dir, { tmux: tmuxName || undefined, mount: false });
            if (!term) return;
            term.isAgent = true; term.tool = tool; term.resumeId = resumeId; term.launch = this.settings.aiLaunch; term.label = label;
            term.diff = { text: '', mode: 'all', repo: true, files: [], hash: '', note: '' };
            if (sendInit) term.initCommand = cli;
            tab.activeTermId = term.id;
            this.$nextTick(() => { this._mountTerminal(term.id, dir); this.aiStartDiffPoll(tab, term); });
            return term;
        },

        aiSelectSession(tab, id) {
            this.selectTerminal(tab, id);
            for (const s of (tab.terminals || [])) this.aiStopDiffPoll(s);
            const s = (tab.terminals || []).find(t => t.id === id);
            if (s) this.aiStartDiffPoll(tab, s);
        },

        aiCloseSession(tab, id) {
            const s = (tab.terminals || []).find(t => t.id === id);
            if (s) this.aiStopDiffPoll(s);
            this.closeTerminal(tab, id);                       // closes the agent tab when the last session goes (see terminal.js)
            const a = (tab.terminals || []).find(t => t.id === tab.activeTermId);
            if (a) this.aiStartDiffPoll(tab, a);
        },

        aiRenameSession(tab, id) {
            const s = (tab.terminals || []).find(t => t.id === id);
            if (!s) return;
            this.askPrompt('Rename session', 'Label', s.label, {}).then(v => { if (v != null && String(v).trim()) s.label = String(v).trim(); });
        },

        // ───────── live diff pane ─────────

        async aiRefreshDiff(session) {
            try {
                await cockpit.spawn(['git', '-C', session.dir, 'rev-parse', '--is-inside-work-tree'], { err: 'message' });
                session.diff.repo = true;
                let out = '', note = '';
                try {
                    out = await cockpit.spawn(this._aiDiffArgv(session.dir, session.diff.mode), { err: 'message' });
                } catch (e) {
                    // Unborn HEAD (a repo with no commits): `diff HEAD` fails but the
                    // repo IS valid — fall back to the unstaged working diff.
                    note = 'no commits yet';
                    out = await cockpit.spawn(['git', '-C', session.dir, 'diff'], { err: 'message' }).catch(() => '');
                }
                session.diff.note = note;
                if (this._aiDiffChanged(session, out)) { session.diff.text = out; session.diff.files = this._aiDiffFiles(out); }
            } catch (e) {
                session.diff.repo = false; session.diff.text = ''; session.diff.files = []; session.diff.note = '';
            }
        },

        aiSetDiffMode(session, mode) { if (!session) return; session.diff.mode = mode; session.diff.hash = ''; this.aiRefreshDiff(session); },

        aiStartDiffPoll(tab, session) {
            if (!session) return;
            this.aiStopDiffPoll(session);
            const tick = async () => {
                const at = this.activeTab && this.activeTab();
                const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
                if (!at || at.id !== tab.id || tab.activeTermId !== session.id || hidden) { _aiTimers.delete(session.id); return; }
                await this.aiRefreshDiff(session);
                if (!session.diff.repo) { _aiTimers.delete(session.id); return; }   // stop the loop for a non-repo dir
                _aiTimers.set(session.id, setTimeout(tick, 1500));
            };
            _aiTimers.set(session.id, setTimeout(tick, 250));
        },
        aiStopDiffPoll(session) { if (!session) return; const t = _aiTimers.get(session.id); if (t) { clearTimeout(t); _aiTimers.delete(session.id); } },

        // Restart the active agent session's poll (called on tab activate + when
        // the page becomes visible again).
        aiResumePollForActive() {
            const tab = this.activeTab && this.activeTab();
            if (!tab || tab.kind !== 'agent') return;
            const s = this.aiActiveSession(tab);
            if (s && s.diff && s.diff.repo !== false) this.aiStartDiffPoll(tab, s);
        },

        // ───────── session browser (resume) ─────────

        async openAgentSessions() {
            bootstrap.Modal.getOrCreateInstance(this.agentSessionsModalEl).show();
            this.agentBrowser.loading = true; this.agentBrowser.rows = [];
            try {
                if (!this._aiHome) this._aiHome = (await cockpit.spawn(['sh', '-c', 'echo $HOME'])).trim();
                this.agentBrowser.rows = await this.scanAiSessions(this.settings, this._aiHome);
            } catch (e) { this.toast('Could not read AI sessions: ' + (e.message || e), 'danger'); }
            finally { this.agentBrowser.loading = false; }
        },

        aiFilteredSessions() {
            const b = this.agentBrowser, q = (b.q || '').toLowerCase();
            return (b.rows || []).filter(r => (b.filter === 'all' || r.tool === b.filter) &&
                (!q || ((r.cwd || '') + ' ' + (r.title || '')).toLowerCase().includes(q)));
        },

        aiRelTime(epoch) {
            const s = Math.max(0, Math.floor(Date.now() / 1000 - (epoch || 0)));
            if (s < 60) return s + 's ago';
            if (s < 3600) return Math.floor(s / 60) + 'm ago';
            if (s < 86400) return Math.floor(s / 3600) + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        },

        aiResume(row) {
            try { bootstrap.Modal.getOrCreateInstance(this.agentSessionsModalEl).hide(); } catch (e) {}
            this.openAgentTab(row.tool, row.cwd, { resumeId: row.id });
        },
    };
})();
