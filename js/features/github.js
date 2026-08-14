// GitHub integration — repo cache, cached-repos toolbar, PR panel, update/
// self-update, checkout & cache management, commit browser, current-repo
// actions, publish. Extracted from app.js (2.0 modularization). Methods only;
// gh/repoCache reactive state + gh auth/init stay in app.js.
window.ExplorerGithub = {
    // ── Repo cache model ─────────────────────────────────────────────────
    // repoCache[ownerRepo] is a list of { path, title } — one per local copy.
    repoCheckouts(ownerRepo) {
        const v = this.repoCache[ownerRepo];
        if (!v) return [];
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') return [{ path: v, title: ownerRepo.split('/').pop() }];
        if (v.path) return [v];
        return [];
    },
    // Primary checkout path (first copy) — back-compat for branch ops / "is cached".
    repoCheckout(ownerRepo) {
        const list = this.repoCheckouts(ownerRepo);
        return list.length ? list[0].path : null;
    },
    isCheckoutCached(ownerRepo, path) {
        return this.repoCheckouts(ownerRepo).some(e => e.path === path);
    },
    // True when `path` is AT or INSIDE a registered checkout for this repo
    // (so a subfolder of a registered repo counts as cached, not "unregistered").
    pathInCachedRepo(ownerRepo, path) {
        if (!ownerRepo || !path) return false;
        return this.repoCheckouts(ownerRepo).some(e =>
            e.path && (path === e.path || path.startsWith(e.path + '/')));
    },
    repoTitleOf(ownerRepo, path) {
        const e = this.repoCheckouts(ownerRepo).find(x => x.path === path);
        return (e && e.title) || this._defaultRepoTitle(ownerRepo, path);
    },
    _defaultRepoTitle(ownerRepo, path) {
        const repo = ownerRepo.split('/').pop();
        // First copy → just the repo name; extra copies → disambiguate by folder.
        if (this.repoCheckouts(ownerRepo).length === 0) return repo;
        const base = (path || '').split('/').filter(Boolean).pop();
        return base ? `${repo} (${base})` : repo;
    },
    async _addRepoCheckout(ownerRepo, path, title) {
        if (!ownerRepo || !path) return;
        const list = this.repoCheckouts(ownerRepo).slice();
        const existing = list.find(e => e.path === path);
        if (existing) {
            if (title) existing.title = title;
        } else {
            list.push({ path, title: title || this._defaultRepoTitle(ownerRepo, path) });
        }
        this.repoCache[ownerRepo] = list;
        await this._saveRepoCache();
    },
    async _removeRepoCheckout(ownerRepo, path) {
        const list = this.repoCheckouts(ownerRepo).filter(e => e.path !== path);
        if (list.length) this.repoCache[ownerRepo] = list;
        else delete this.repoCache[ownerRepo];
        await this._saveRepoCache();
    },
    async setRepoTitle(ownerRepo, path) {
        const cur = this.repoCheckouts(ownerRepo).find(e => e.path === path);
        const title = await this.askPrompt('Repository title',
            'Title for ' + path, (cur && cur.title) || this._defaultRepoTitle(ownerRepo, path));
        if (title === null || title === '') return;
        const list = this.repoCheckouts(ownerRepo).map(e => e.path === path ? { path: e.path, title } : e);
        this.repoCache[ownerRepo] = list;
        await this._saveRepoCache();
    },

    // Add the active tab's git work-tree to the repo cache. Requires
    // tab.gitInfo.remote.ownerRepo (detected from `git config remote.origin.url`).
    async registerCurrentTab(tab) {
        const owner = tab.gitInfo?.remote?.ownerRepo;
        if (!owner) {
            this.toast('No GitHub remote detected (need an origin URL like github.com/<owner>/<repo>).', 'danger');
            return;
        }
        // Register the repository's top-level directory (where .git lives),
        // not whatever subfolder the tab happens to be sitting in.
        let repoPath = tab.path;
        try {
            const root = await GIT.topLevel(tab.path);
            if (root) repoPath = root;
        } catch (e) {}
        if (this.isCheckoutCached(owner, repoPath)) {
            this.toast(`${owner} already registered at ${repoPath}`);
            return;
        }
        await this._addRepoCheckout(owner, repoPath);
        this.toast(`Registered ${owner} → ${repoPath}`);
    },

    // Is a path inside any registered checkout?
    insideAnyRepoCache(p) {
        for (const list of Object.values(this.repoCache || {})) {
            for (const e of (Array.isArray(list) ? list : [])) {
                const cachePath = e && e.path;
                if (!cachePath) continue;
                if (p === cachePath || p.startsWith(cachePath + '/')) return cachePath;
            }
        }
        return null;
    },

    // ── Cached repos toolbar ───────────────────────────────────────────────
    // One row per local copy: { key, path, title }.
    cachedRepoList() {
        const out = [];
        for (const [key, list] of Object.entries(this.repoCache || {})) {
            for (const e of this.repoCheckouts(key)) {
                out.push({ key, path: e.path, title: e.title || this._defaultRepoTitle(key, e.path) });
            }
        }
        out.sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key));
        return out;
    },
    navigateToCachedRepo(tab, path) {
        if (!path) return;
        // If there's no current tab, open in a new one.
        if (!tab) { this.newTab(path); return; }
        this.navigate(tab, path);
    },
    openCachedRepoInNewTab(path) {
        if (!path) return;
        this.newTab(path);
    },

    async _refreshAllGitInfo() {
        // Refresh both the tab (pane A) and pane B if present.
        const panes = [];
        for (const tab of this.tabs) {
            if (tab.kind !== 'dir') continue;
            panes.push(tab);
            if (tab.dual && tab.paneB) panes.push(tab.paneB);
        }
        for (const pane of panes) {
            try {
                if (await GIT.isWorkTree(pane.path)) {
                    pane.gitInfo = await GIT.status(pane.path);
                } else {
                    pane.gitInfo = null;
                }
            } catch (e) { pane.gitInfo = null; }
            pane.gitChecked = true;
        }
    },

    // ─── GITHUB PANEL ────────────────────────────────────────────────────────
    async openGithubPanel(tab) {
        bootstrap.Modal.getOrCreateInstance(this.ghModalEl).show();
        await this._refreshGhState();
        // The token field only renders once gh.state resolves to 'notauthed',
        // which happens after shown.bs.modal already fired — focus it now that
        // it exists (no-op if the panel opened already-authenticated or closed).
        this.$nextTick(() => this._focusFirstField(this.ghModalEl));
    },

    async _refreshGhState() {
        this.gh.state = 'init';
        this.gh.authError = '';
        try {
            if (!(await GIT.ghAvailable())) {
                const strat = await GIT.chooseInstallStrategy();
                this.gh.installFamily = strat.family;
                this.gh.state = 'notinstalled';
                return;
            }
            let status = await GIT.ghAuthStatus();
            if (!status.authed) {
                // gh has no stored credential (session cleared / hosts.yml lost).
                // If the user saved their token, re-authenticate automatically
                // instead of prompting again.
                if (await this._tryAutoGhLogin()) status = await GIT.ghAuthStatus();
            }
            if (!status.authed) { this.gh.state = 'notauthed'; return; }
            // Fetch user info
            try {
                const me = await GIT.ghMe();
                this.gh.user = me.login;
            } catch (e) { this.gh.user = status.user; }
            try {
                this.gh.scopes = await GIT.ghTokenScopes();
                this.gh.scopeWarning = this.gh.scopes.some(s => /^(admin:|delete_repo|workflow)/.test(s));
            } catch (e) { this.gh.scopes = []; this.gh.scopeWarning = false; }
            this.gh.state = 'authed';
            // Configure git to authenticate github.com via gh, so plain
            // fetch/pull/push work on HTTPS clones (once per session).
            if (!this._ghGitConfigured) {
                this._ghGitConfigured = true;
                GIT.ghSetupGit().catch(() => {});
            }
            this.ghReloadRepos();
        } catch (e) {
            // Never leave the panel stuck on the blank "checking" state.
            this.gh.state = 'notauthed';
            this.gh.authError = e.message || String(e);
        }
    },

    // ───── Update check / self-update from GitHub releases ─────────────────
    // Normalise the configured update source to "owner/repo".
    _updateRepo() {
        let r = String(this.settings.updateRepo || ExRT.const.DEFAULT_SETTINGS.updateRepo).trim();
        const m = r.match(/github\.com[\/:]([^\/]+\/[^\/#?]+)/i);
        if (m) r = m[1];
        return r.replace(/\.git$/i, '').replace(/\/+$/, '');
    },
    _versionTuple(v) { return String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); },
    _versionNewer(a, b) {
        const x = this._versionTuple(a), y = this._versionTuple(b);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d) return d > 0;
        }
        return false;
    },
    // Read the latest release of the configured repo (gh if available, else curl).
    async _fetchLatestRelease(repo) {
        const ghOk = await GIT.ghAvailable().catch(() => false);
        if (ghOk) {
            try {
                const out = await cockpit.spawn(['gh', 'api', 'repos/' + repo + '/releases/latest'], { err: 'message' });
                const j = JSON.parse(out);
                if (j && j.tag_name) return { tag: j.tag_name, version: String(j.tag_name).replace(/^v/i, '') };
            } catch (e) { /* fall through to anonymous curl */ }
        }
        try {
            const out = await cockpit.spawn(['sh', '-c', 'curl -fsSL ' + Util.shq('https://api.github.com/repos/' + repo + '/releases/latest')], { err: 'message' });
            const j = JSON.parse(out);
            if (j && j.tag_name) return { tag: j.tag_name, version: String(j.tag_name).replace(/^v/i, '') };
        } catch (e) {}
        return null;
    },
    // Check for a newer release. manual=true ⇒ chatty (toasts for every outcome).
    async checkForUpdate(manual) {
        if (this.updateState.checking) return;
        const repo = this._updateRepo();
        if (!this.pluginVersion) { if (manual) this.toast('Current version is unknown; cannot compare.', 'warning'); return; }
        this.updateState.checking = true;
        if (manual) this.toast('Checking ' + repo + ' for updates…');
        let rel = null;
        try { rel = await this._fetchLatestRelease(repo); }
        catch (e) { this.updateState.checking = false; if (manual) this.toast('Update check failed: ' + (e.message || e), 'danger'); return; }
        this.updateState.checking = false;
        if (!rel || !rel.version) { if (manual) this.toast('No releases found at ' + repo + '.', 'warning'); return; }
        if (this._versionNewer(rel.version, this.pluginVersion)) {
            this.updateState.available = rel;
            this.startSelfUpdate(rel);                       // start the self-update (asks for confirmation)
        } else {
            this.updateState.available = null;
            if (manual) this.toast('You are up to date (v' + this.pluginVersion + ').', 'success');
        }
    },
    // Open the update dialog (download/install + the "delete settings" option).
    startSelfUpdate(info) {
        info = info || this.updateState.available;
        if (!info) { this.toast('No update available.', 'warning'); return; }
        this.updateState.available = info;
        this.updateState.deleteSettings = false;   // opt-in, defaults to off
        bootstrap.Modal.getOrCreateInstance(this.updateModalEl).show();
    },
    // Confirmed from the dialog: download the zip, optionally delete the
    // settings file, then run the built-in self-update on it.
    async confirmSelfUpdate() {
        const info = this.updateState.available;
        if (!info) return;
        const deleteSettings = !!this.updateState.deleteSettings;
        try { bootstrap.Modal.getOrCreateInstance(this.updateModalEl).hide(); } catch (e) {}
        const repo = this._updateRepo();
        const op = this._beginOp('Downloading explorer ' + info.version);
        let zip;
        try { zip = await this._downloadReleaseZip(repo, info.tag); this._endOp(op, 'done'); }
        catch (e) { this._failOp(op, e); this.toast('Download failed: ' + (e.message || e), 'danger'); return; }
        if (deleteSettings) {
            // Stop any pending write and wipe the persisted settings so the
            // updated plugin starts from defaults.
            if (this._saveSettingsTimer) { clearTimeout(this._saveSettingsTimer); this._saveSettingsTimer = null; }
            this._suppressSettingsSave = true;
            try {
                await cockpit.spawn(['rm', '-f', this._settingsPath()], { err: 'message' });
                this.toast('Settings file deleted — Explorer will start from defaults.', 'info');
            } catch (e) {
                this.toast('Could not delete settings file: ' + (e.message || e), 'warning');
            }
        }
        this._runSelfUpdateInstall(zip, info.version);
    },
    async _downloadReleaseZip(repo, tag, dir = 'explorer') {
        const glob = dir + '-*.zip';
        const assetRe = new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-.*\\.zip$', 'i');
        const tmp = (await cockpit.spawn(['mktemp', '-d'], { err: 'message' })).trim();
        const ghOk = await GIT.ghAvailable().catch(() => false);
        if (ghOk) {
            await cockpit.spawn(['env', 'GH_PROMPT_DISABLED=1', 'gh', 'release', 'download', tag, '-R', repo,
                '--pattern', glob, '--dir', tmp, '--clobber'], { err: 'message' });
        } else {
            const meta = await cockpit.spawn(['sh', '-c', 'curl -fsSL ' + Util.shq('https://api.github.com/repos/' + repo + '/releases/tags/' + tag)], { err: 'message' });
            const j = JSON.parse(meta);
            const asset = (j.assets || []).find(a => assetRe.test(a.name));
            if (!asset) throw new Error('release ' + tag + ' has no ' + glob + ' asset');
            await cockpit.spawn(['sh', '-c', 'curl -fsSL -o ' + Util.shq(tmp + '/' + asset.name) + ' ' + Util.shq(asset.browser_download_url)], { err: 'message' });
        }
        const found = (await cockpit.spawn(['sh', '-c', 'ls -1 ' + Util.shq(tmp) + '/' + glob + ' 2>/dev/null | head -1'], { err: 'message' })).trim();
        if (!found) throw new Error('no ' + glob + ' was downloaded');
        return found;
    },
    // Run the built-in "explorer-self-update" action against a downloaded zip.
    _runSelfUpdateInstall(zipPath, version) {
        const name = zipPath.split('/').pop();
        const ctx = {
            path: zipPath, name, dir: Util.dirname(zipPath),
            base: name.replace(/\.zip$/, ''), ext: 'zip',
            oldVersion: this.pluginVersion || '(unknown)', newVersion: version,
            home: this.homePath,
        };
        const action = (this.customActions.builtin || []).find(a => a.id === 'explorer-self-update');
        if (action) {
            this._runActionCmd(action, Util.fillTemplate(action.command, ctx), [{ path: zipPath, name }]);
        } else {
            const cmd = 'set -e; TMP=$(mktemp -d); unzip -oq ' + Util.shq(zipPath) + ' -d "$TMP"; ' +
                'make -C "$TMP/explorer" install; rm -rf "$TMP"; ' +
                '(sleep 2; systemctl restart cockpit || systemctl restart cockpit.socket) >/dev/null 2>&1 &';
            this._runActionCmd({ label: 'Self-update to ' + version, privilege: 'require', output: 'pane' }, cmd, [{ path: zipPath, name }]);
        }
    },

    async installGh() {
        this.gh.installing = true;
        const strat = await GIT.chooseInstallStrategy();
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = 'Install GitHub CLI (' + strat.family + ')';
        tab.outputCommand = strat.cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        // Re-acquire the REACTIVE proxy from this.tabs — mutating the raw
        // `tab` ref (especially outputLines.push) bypasses Alpine's reactivity
        // and the output pane would never update.
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;
        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', strat.cmd],
            superuser: 'require',
            err: 'out',
        });
        rtab.outputChannel = channel;
        channel.addEventListener('message', (ev, d) => {
            this._feedOutput(rtab, typeof d === 'string' ? d : new TextDecoder().decode(d));
        });
        channel.addEventListener('close', async (ev, props) => {
            this._flushOutput(rtab);
            rtab.outputStatus = props.problem ? ('error: ' + (props.message || props.problem))
                                              : ('done (exit ' + (props['exit-status'] ?? 0) + ')');
            rtab.outputChannel = null;
            this.gh.installing = false;
            // Re-check state
            this._refreshGhState();
        });
    },

    async ghLogin() {
        if (!this.gh.tokenInput) return;
        this.gh.loggingIn = true;
        this.gh.authError = '';
        try {
            const token = this.gh.tokenInput;
            await GIT.ghAuthLogin(token);
            // Persist (or forget) the token per the checkbox, so a future gh
            // logout doesn't force the user to paste it again — see
            // _tryAutoGhLogin(), called from _refreshGhState()/init.
            if (this.gh.saveToken) {
                try {
                    await this._saveGhToken(token);
                    this.toast('Signed in — token saved to ' + this._ghTokenPath(), 'success');
                } catch (e) {
                    this.toast('Signed in, but saving the token failed: ' + (e.message || e), 'warning');
                }
            } else {
                await this._clearGhToken();   // opted out → drop any earlier copy
            }
            this.gh.tokenInput = '';
            await this._refreshGhState();
        } catch (e) {
            this.gh.authError = e.message || String(e);
        } finally {
            this.gh.loggingIn = false;
        }
    },

    // Where Explorer keeps the user's saved gh token (their own home dir, 0600).
    _ghTokenPath() { return this.homePath + '/.config/cockpit/explorer/gh-token'; },
    // Shown in the sign-in dialog so the user knows exactly where it lands.
    ghTokenPathDisplay() { return this.homePath ? this._ghTokenPath() : '~/.config/cockpit/explorer/gh-token'; },

    async _saveGhToken(token) {
        const path = this._ghTokenPath();
        await FS.mkdir(Util.dirname(path));
        // Create the secret with a tight umask so it is 0600 from the first
        // byte (never momentarily world-readable). Token goes in on stdin, not
        // argv; the path is a positional arg, so no shell-quoting needed.
        const proc = cockpit.spawn(['sh', '-c', 'umask 077; cat > "$1"', 'sh', path], { err: 'message' });
        proc.input(token);
        await proc;
        try { await FS.chmod(path, '600'); } catch (e) {}   // belt-and-suspenders if it pre-existed
    },

    async _readGhToken() {
        try { return (await FS.readText(this._ghTokenPath()) || '').trim(); }
        catch (e) { return ''; }
    },

    async _clearGhToken() {
        try { await cockpit.spawn(['rm', '-f', this._ghTokenPath()], { err: 'message' }); }
        catch (e) {}
    },

    // If gh has no stored credential but the user saved a token, silently
    // re-authenticate gh with it. Returns true iff gh ends up authed.
    async _tryAutoGhLogin() {
        const token = await this._readGhToken();
        if (!token) return false;
        try {
            await GIT.ghAuthLogin(token);
            return (await GIT.ghAuthStatus()).authed;
        } catch (e) { return false; }
    },

    // Does this error look like GitHub rejecting our credentials (vs. a network
    // or not-found error)? Used to decide whether to attempt a re-login.
    _isGhAuthError(e) {
        const m = ((e && (e.message || e.toString())) || '').toLowerCase();
        return /http 401|bad credentials|requires authentication|authentication failed|\b401\b/.test(m);
    },

    // Run a gh API operation with automatic recovery from an expired/revoked
    // token: on an auth failure, silently re-login from the saved token and
    // retry once; if that fails too, surface the sign-in form for a new token.
    async _withGhAuth(fn) {
        try {
            return await fn();
        } catch (e) {
            if (!this._isGhAuthError(e)) throw e;
            // gh's stored token was rejected by the API. Re-auth from the saved
            // copy and retry once.
            if (await this._tryAutoGhLogin()) return await fn();
            // No saved token, or the saved one is also rejected → ask the user
            // for a fresh token.
            await this._promptGhReauth();
            throw new Error('GitHub token expired or invalid — please sign in again.');
        }
    },

    // Flip the GitHub panel back to the sign-in form so the user can enter a
    // new token (the saved one is no longer accepted).
    async _promptGhReauth() {
        this.gh.state = 'notauthed';
        this.gh.authError = 'Your saved GitHub token was rejected (expired or revoked). Enter a new token to continue.';
        this._ghGitConfigured = false;   // re-run gh auth setup-git after the next successful sign-in
        try {
            if (this.ghModalEl && !this.ghModalEl.classList.contains('show')) {
                bootstrap.Modal.getOrCreateInstance(this.ghModalEl).show();
            }
        } catch (e) {}
        this.toast('GitHub token expired — please sign in again.', 'warning');
    },

    async ghReloadRepos() {
        this.gh.loadingRepos = true;
        try {
            this.gh.repos = await this._withGhAuth(() => GIT.ghRepoList(200));
        } catch (e) {
            this.toast('Could not list repos: ' + e.message, 'danger');
        } finally { this.gh.loadingRepos = false; }
    },

    filteredRepos() {
        const q = (this.gh.search || '').toLowerCase().trim();
        if (!q) return this.gh.repos;
        return this.gh.repos.filter(r =>
            r.nameWithOwner.toLowerCase().includes(q) ||
            (r.description || '').toLowerCase().includes(q));
    },

    filteredBranches() {
        const q = (this.gh.branchSearch || '').toLowerCase().trim();
        if (!q) return this.gh.branches;
        return this.gh.branches.filter(b => (b.name || '').toLowerCase().includes(q));
    },

    async selectRepo(repo) {
        this.gh.selectedRepo = repo.nameWithOwner;
        this.gh.tab = 'branches';
        this.gh.branches = [];
        this.gh.branchSearch = '';
        this.gh.prs = [];
        this.gh.localCopies = [];
        this.gh.loadingBranches = true;
        this._loadRepoLocalCopies(repo.nameWithOwner);
        try {
            this.gh.branches = await this._withGhAuth(() => GIT.ghBranches(repo.nameWithOwner));
        } catch (e) {
            this.toast('Branches failed: ' + e.message, 'danger');
        } finally { this.gh.loadingBranches = false; }
    },

    // Resolve each registered local copy's current branch so the Branches tab
    // can list copies under the branch they're checked out to.
    async _loadRepoLocalCopies(ownerRepo) {
        const copies = this.repoCheckouts(ownerRepo).map(c => ({
            path: c.path,
            title: c.title || this._defaultRepoTitle(ownerRepo, c.path),
            branch: '',
        }));
        this.gh.localCopies = copies;
        for (const c of copies) {
            try { c.branch = (await GIT.currentBranch(c.path)) || ''; }
            catch (e) { c.branch = ''; }
            // Re-assign to trigger reactivity on the array element.
            this.gh.localCopies = this.gh.localCopies.map(x => x.path === c.path ? { ...x, branch: c.branch } : x);
        }
    },

    // Local copies currently checked out to a given branch name.
    copiesForBranch(branchName) {
        return (this.gh.localCopies || []).filter(c => c.branch === branchName);
    },

    async ghLoadPrs() {
        this.gh.tab = 'prs';
        if (this.gh.prs.length) return;
        this.gh.loadingPrs = true;
        try { this.gh.prs = await this._withGhAuth(() => GIT.ghPullRequests(this.gh.selectedRepo)); }
        catch (e) { this.toast('PRs failed: ' + e.message, 'danger'); }
        finally { this.gh.loadingPrs = false; }
    },

    // ─── Checkout & cache management ─────────────────────────────────────────
    async ensureRepoCache(ownerRepo, suggestDir, branch) {
        // Use the first still-valid local copy, dropping any stale entries.
        for (const e of this.repoCheckouts(ownerRepo)) {
            if (await GIT.isWorkTree(e.path)) {
                const remote = await GIT.getRemote(e.path);
                if (remote.ownerRepo === ownerRepo) return e.path;
            }
            await this._removeRepoCheckout(ownerRepo, e.path);
        }
        // None valid — clone a fresh copy.
        const def = (suggestDir || this.activeTab()?.path || this.homePath);
        const where = await this.askDirectory(
            'Choose the parent directory for the clone (a "' + ownerRepo.split('/').pop() + '" subfolder will be created)',
            def);
        if (!where) return null;
        const op = this._beginOp('Clone ' + ownerRepo);
        try {
            const target = await GIT.clone(ownerRepo, where, branch);
            await this._addRepoCheckout(ownerRepo, target);
            this._endOp(op, 'done');
            return target;
        } catch (e) { this._failOp(op, e); return null; }
    },

    // Clone an ADDITIONAL local copy even when one is already cached.
    async checkoutNewCopy(ownerRepo, branch) {
        ownerRepo = ownerRepo || this.gh.selectedRepo;
        if (!ownerRepo) return;
        const def = this.activeTab()?.path || this.homePath;
        const target = await this.askDirectory(
            'Choose (or create with "+ Folder") the folder to clone ' + ownerRepo + ' into — it should be empty',
            def);
        if (!target) return;
        const op = this._beginOp('Clone ' + ownerRepo + ' (new copy)');
        op.indeterminate = true;
        op.statusText = 'Starting…';
        try {
            await GIT.cloneIntoStream(ownerRepo, target, branch, (line) => {
                const m = line.match(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/);
                if (m) {
                    op.indeterminate = false;
                    op.progress = parseInt(m[2], 10);
                    op.statusText = m[1] + ' ' + m[2] + '%';
                } else if (/^(Cloning into|remote:|From )/.test(line)) {
                    op.statusText = line.slice(0, 80);
                }
            });
            op.progress = 100;
            await this._addRepoCheckout(ownerRepo, target);
            this._endOp(op, 'done');
            this.toast('Checked out new copy at ' + target);
            this.openCheckoutInTab(ownerRepo, target);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Clone failed (the target folder may not be empty): ' + (e.message || e), 'danger');
        }
    },

    async openCheckoutInTab(ownerRepo, path) {
        const target = path || this.repoCheckout(ownerRepo);
        if (!target) return;
        const existing = this.tabs.find(t => t.kind === 'dir' && t.path === target);
        if (existing) { this.activeTabId = existing.id; }
        else { this.newTab(target); }
        bootstrap.Modal.getOrCreateInstance(this.ghModalEl).hide();
    },

    async cloneRepo(ownerRepo) {
        const path = await this.ensureRepoCache(ownerRepo);
        if (path) this.openCheckoutInTab(ownerRepo, path);
    },

    async registerExistingClone(ownerRepo) {
        const where = await this.askDirectory('Choose the existing local clone folder for ' + ownerRepo, this.activeTab()?.path || this.homePath);
        if (!where) return;
        if (!(await GIT.isWorkTree(where))) {
            this.toast('Not a git work-tree: ' + where, 'danger'); return;
        }
        const remote = await GIT.getRemote(where);
        if (remote.ownerRepo !== ownerRepo) {
            const ok = await this.askConfirm('Mismatch', `That repo's remote is ${remote.ownerRepo}, not ${ownerRepo}. Register anyway?`, 'Register');
            if (!ok) return;
        }
        await this._addRepoCheckout(ownerRepo, where);
        this.toast('Registered ' + where);
    },

    async changeCheckoutPath(ownerRepo, path) {
        if (path) await this._removeRepoCheckout(ownerRepo, path);
        return this.cloneRepo(ownerRepo);
    },

    async forgetCheckout(ownerRepo, path) {
        const target = path || this.repoCheckout(ownerRepo);
        if (!target) return;
        const choice = await this.askChoice('Forget local checkout',
            `What should happen to this copy?\n\n  ${target}\n\n• "Forget only" removes it from the cache but leaves the files on disk.\n• "Delete files & forget" also permanently deletes the folder.`,
            [
                { id: 'cancel', label: 'Cancel', variant: 'outline-secondary' },
                { id: 'forget', label: 'Forget only', variant: 'primary' },
                { id: 'delete', label: 'Delete files & forget', variant: 'danger' },
            ]);
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'delete') {
            const op = this._beginOp('Delete ' + target);
            try {
                await FS.remove([target]);
                this._endOp(op, 'done');
            } catch (e) {
                try { await FS.remove([target], { admin: true }); this._endOp(op, 'done'); }
                catch (e2) { this._failOp(op, e2); this.toast('Delete failed: ' + (e2.message || e2), 'danger'); return; }
            }
        }
        await this._removeRepoCheckout(ownerRepo, target);
        this.toast(choice === 'delete' ? 'Deleted and unregistered ' + target : 'Unregistered ' + target);
        if (choice === 'delete') this._refreshAllGitInfo();
    },

    // Token-authed fetch from the canonical GitHub repo (works even when the
    // clone's own HTTPS remote can't read credentials non-interactively).
    // GIT_TERMINAL_PROMPT=0 ⇒ git errors out instead of hanging if it ever
    // needs to prompt for credentials.
    async _gitFetchAuthed(cache, ownerRepo, refspec) {
        const token = await GIT.ghToken();
        const args = ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', cache];
        let url = 'origin';
        if (token && ownerRepo) {
            url = 'https://github.com/' + ownerRepo + '.git';
            args.push('-c', 'http.extraheader=Authorization: Basic ' + btoa('x-access-token:' + token));
        }
        args.push('fetch', '--prune', url);
        if (refspec) args.push(refspec);
        await cockpit.spawn(args, { err: 'message' });
    },

    // Token-authed push to the canonical GitHub repo.
    async _gitPushAuthed(cache, ownerRepo, branch) {
        const token = await GIT.ghToken();
        const args = ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', cache];
        let url = 'origin';
        if (token && ownerRepo) {
            url = 'https://github.com/' + ownerRepo + '.git';
            args.push('-c', 'http.extraheader=Authorization: Basic ' + btoa('x-access-token:' + token));
        }
        args.push('push', url, (branch || 'HEAD'));
        await cockpit.spawn(args, { err: 'message' });
        // Pushing to an explicit URL doesn't move the local origin/<branch>
        // tracking ref, so sync it (push succeeded ⇒ origin matches local).
        if (branch) {
            try { await cockpit.spawn(['git', '-C', cache, 'update-ref', 'refs/remotes/origin/' + branch, branch], { err: 'message' }); } catch (e) {}
        }
    },

    _repoOwnerForTab(tab) {
        return (tab && tab.gitInfo && tab.gitInfo.remote && tab.gitInfo.remote.ownerRepo) || null;
    },

    async updateCheckout(ownerRepo, path) {
        const cache = path || this.repoCheckout(ownerRepo);
        if (!cache) return;
        const op = this._beginOp('Update ' + ownerRepo);
        try {
            await this._gitFetchAuthed(cache, ownerRepo, '+refs/heads/*:refs/remotes/origin/*');
            await GIT.pullFfLocal(cache);
            this._endOp(op, 'done');
            this.toast('Updated ' + ownerRepo);
            this._refreshAllGitInfo();
            if (this.gh.selectedRepo === ownerRepo) this._loadRepoLocalCopies(ownerRepo);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Update failed (may have diverged): ' + (e.message || e), 'danger');
        }
    },

    async checkoutBranch(b) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = await this.ensureRepoCache(ownerRepo, undefined, b.name);
        if (!cache) return;
        // Make sure we're on this branch (handles case where cache was created on default)
        const cur = await GIT.currentBranch(cache);
        if (cur !== b.name) {
            try { await GIT.checkoutBranch(cache, b.name); }
            catch (e) { this.toast('checkout failed: ' + e.message, 'danger'); return; }
        }
        this.openCheckoutInTab(ownerRepo);
    },

    async checkoutPr(pr) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = await this.ensureRepoCache(ownerRepo);
        if (!cache) return;
        const op = this._beginOp('Checkout PR #' + pr.number);
        try {
            await cockpit.spawn(['gh', 'pr', 'checkout', String(pr.number), '--repo', ownerRepo], { directory: cache, err: 'message' });
            this._endOp(op, 'done');
            this.openCheckoutInTab(ownerRepo);
        } catch (e) { this._failOp(op, e); }
    },

    async updateBranch(b) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = this.repoCheckout(ownerRepo);
        if (!cache) { this.toast('No local checkout — clone first.', 'danger'); return; }
        const op = this._beginOp('Update branch ' + b.name);
        try {
            const cur = await GIT.currentBranch(cache);
            if (cur === b.name) {
                await this._gitFetchAuthed(cache, ownerRepo, '+refs/heads/*:refs/remotes/origin/*');
                await GIT.pullFfLocal(cache);
            } else {
                // Fast-forward the (non-checked-out) local branch from the remote.
                await this._gitFetchAuthed(cache, ownerRepo, b.name + ':' + b.name);
            }
            this._endOp(op, 'done');
            this.toast('Updated branch ' + b.name);
            this._refreshAllGitInfo();
            this._loadRepoLocalCopies(ownerRepo);
        } catch (e) { this._failOp(op, e); this.toast('Update failed (may have diverged).', 'danger'); }
    },

    async createBranchFrom(fromBranch) {
        const newName = await this.askPrompt('Create branch',
            `New branch name (from "${fromBranch}")`, '');
        if (!newName) return;
        const ownerRepo = this.gh.selectedRepo;
        // Find sha from existing branches list
        const b = this.gh.branches.find(x => x.name === fromBranch);
        if (!b || !b.commit?.sha) { this.toast('No SHA known for ' + fromBranch, 'danger'); return; }
        const op = this._beginOp(`Create remote branch ${newName} from ${fromBranch}`);
        try {
            await GIT.ghCreateBranch(ownerRepo, newName, b.commit.sha);
            this._endOp(op, 'done');
            this.toast('Created ' + newName);
            this.selectRepo({ nameWithOwner: ownerRepo });
        } catch (e) { this._failOp(op, e); }
    },

    async askDeleteRemoteBranch(branchName) {
        const ownerRepo = this.gh.selectedRepo;
        const ok = await this.askTypeConfirm('Delete branch',
            `Delete remote branch "${branchName}" on ${ownerRepo}? This cannot be undone.`,
            branchName);
        if (!ok) return;
        const op = this._beginOp(`Delete remote branch ${branchName}`);
        try {
            await GIT.ghDeleteRemoteBranch(ownerRepo, branchName);
            this._endOp(op, 'done');
            this.toast('Deleted ' + branchName);
            this.selectRepo({ nameWithOwner: ownerRepo });
        } catch (e) { this._failOp(op, e); }
    },

    // ─── Type-to-confirm ─────────────────────────────────────────────────────
    askTypeConfirm(title, message, phrase) {
        return new Promise(resolve => {
            this.typeConfirm = { title, message, phrase, typed: '', resolve };
            bootstrap.Modal.getOrCreateInstance(this.typeConfirmModalEl).show();
        });
    },
    resolveTypeConfirm(ok) {
        const r = this.typeConfirm.resolve;
        this.typeConfirm.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.typeConfirmModalEl).hide();
        if (r) r(ok);
    },

    // ─── COMMIT BROWSER ──────────────────────────────────────────────────────
    async browseCommits(branchName) {
        const ownerRepo = this.gh.selectedRepo;
        // Show the commit LIST straight from the GitHub API — no local clone
        // needed. A clone is only required (and prompted for) when the user
        // drills into a commit's files/diff.
        this.commitBrowser = {
            repo: ownerRepo, branch: branchName, cachePath: null,
            commits: [], loadingCommits: true,
            selectedCommit: null, files: [], selectedFile: null, fileDiff: '',
        };
        bootstrap.Modal.getOrCreateInstance(this.commitBrowserModalEl).show();
        try {
            const raw = await GIT.ghBranchCommits(ownerRepo, branchName, 100);
            this.commitBrowser.commits = (raw || []).map(c => ({
                hash: c.sha,
                short: (c.sha || '').slice(0, 7),
                author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
                email: (c.commit && c.commit.author && c.commit.author.email) || '',
                date: (c.commit && c.commit.author && c.commit.author.date) || '',
                subject: ((c.commit && c.commit.message) || '').split('\n')[0],
            }));
        } catch (e) {
            this.toast('Log failed: ' + (e.message || e), 'danger');
        } finally {
            this.commitBrowser.loadingCommits = false;
        }
    },

    // Ensure a local clone exists for diff/file operations in the commit browser.
    async _ensureCommitClone() {
        if (this.commitBrowser.cachePath) return this.commitBrowser.cachePath;
        const cache = await this.ensureRepoCache(this.commitBrowser.repo, undefined, this.commitBrowser.branch);
        if (cache) {
            const b = this.commitBrowser.branch;
            try { await this._gitFetchAuthed(cache, this.commitBrowser.repo, '+refs/heads/' + b + ':refs/remotes/origin/' + b); } catch (e) {}
            this.commitBrowser.cachePath = cache;
        }
        return cache;
    },

    // Make sure a specific commit object is present locally; fetch it on demand.
    // A cached clone may be a checkout of a different branch (e.g. master) and
    // its own remote auth may not work non-interactively, so we also fall back
    // to fetching the object straight from GitHub using the gh token.
    async _ensureCommitObject(cache, sha) {
        const has = async () => {
            try { await cockpit.spawn(['git', '-C', cache, 'cat-file', '-e', sha + '^{commit}'], { err: 'message' }); return true; }
            catch (e) { return false; }
        };
        if (await has()) return true;
        const branch = this.commitBrowser.branch;
        // 1) Try the clone's own remote (works if SSH/credential-helper auth is set up).
        for (const args of [['fetch', 'origin', sha], ['fetch', 'origin', branch], ['fetch', '--all']]) {
            try { await cockpit.spawn(['git', '-C', cache, ...args], { err: 'message' }); } catch (e) {}
            if (await has()) return true;
        }
        // 2) Fall back to an explicitly gh-token-authenticated HTTPS fetch from
        //    the repo, which doesn't depend on the clone's configured remote.
        try {
            const token = await GIT.ghToken();
            const ownerRepo = this.commitBrowser.repo;
            if (token && ownerRepo) {
                const url = 'https://github.com/' + ownerRepo + '.git';
                const hdr = 'http.extraheader=Authorization: Basic ' + btoa('x-access-token:' + token);
                for (const ref of [branch, sha]) {
                    try { await cockpit.spawn(['git', '-C', cache, '-c', hdr, 'fetch', '--no-tags', url, ref], { err: 'message' }); } catch (e) {}
                    if (await has()) return true;
                }
            }
        } catch (e) {}
        return await has();
    },

    async selectCommit(c) {
        this.commitBrowser.selectedCommit = c;
        this.commitBrowser.files = [];
        this.commitBrowser.selectedFile = null;
        this.commitBrowser.fileDiff = '';
        this._clearCommitDiff();
        const cache = await this._ensureCommitClone();
        if (!cache) return; // user declined to clone
        const op = this._beginOp('Fetch commit ' + c.short);
        try {
            const ok = await this._ensureCommitObject(cache, c.hash);
            if (!ok) {
                this._failOp(op, new Error('commit not found in local clone'));
                this.toast('Could not fetch commit ' + c.short + ' into the local clone.', 'danger');
                return;
            }
            this.commitBrowser.files = await GIT.showCommitFiles(cache, c.hash);
            this._endOp(op, 'done');
        } catch (e) {
            this._failOp(op, e);
            this.toast('Show failed: ' + (e.message || e), 'danger');
        }
    },

    async selectCommitFile(f) {
        this.commitBrowser.selectedFile = f;
        const cb = this.commitBrowser;
        try {
            cb.fileDiff = await GIT.fileDiff(cb.cachePath, cb.selectedCommit.hash, f.path);
            await this._ensureScript('js/diff2html-ui.min.js', 'Diff2HtmlUI');
            this.renderDiff();
        } catch (e) {
            this.toast('Diff failed: ' + e.message, 'danger');
        }
    },

    renderDiff() {
        const cb = this.commitBrowser;
        const container = document.getElementById('cbDiffContainer');
        if (!container || !cb.fileDiff) return;
        if (!window.Diff2HtmlUI) return;
        container.innerHTML = '';
        const ui = new window.Diff2HtmlUI(container, cb.fileDiff, {
            drawFileList: false,
            matching: 'lines',
            outputFormat: this.settings.diffView === 'line' ? 'line-by-line' : 'side-by-side',
            highlight: false,
        });
        ui.draw();
    },
    // diff2html renders into #cbDiffContainer imperatively, so resetting the
    // reactive fileDiff alone leaves the rendered DOM behind — wipe it too.
    _clearCommitDiff() {
        const c = document.getElementById('cbDiffContainer');
        if (c) c.innerHTML = '';
    },
    _onCommitBrowserClosed() {
        this._clearCommitDiff();
        this.commitBrowser = {
            repo: '', branch: '', cachePath: null,
            commits: [], loadingCommits: false,
            selectedCommit: null, files: [], selectedFile: null, fileDiff: '',
        };
    },

    async viewFileAtCommit(f) {
        const cb = this.commitBrowser;
        try {
            const content = await GIT.fileAtCommit(cb.cachePath, cb.selectedCommit.hash, f.path);
            await this.openReadOnly(`${f.path} @ ${cb.selectedCommit.short}`, content, this._monacoLang(f.path));
        } catch (e) { this.toast('Show failed: ' + e.message, 'danger'); }
    },

    // ─── Current-repo toolbar actions (Fetch / Pull / Push / Commit) ────────
    async loadRepoBranches(tab) {
        if (!tab || !tab.path) return;
        const ownerRepo = tab.gitInfo?.remote?.ownerRepo || null;
        const here = tab.path;
        const buildCopies = () => (ownerRepo ? this.repoCheckouts(ownerRepo) : []).map(c => ({
            path: c.path,
            title: c.title || this._defaultRepoTitle(ownerRepo, c.path),
            current: here === c.path || here.startsWith(c.path + '/'),
        }));
        this.branchSwitcher = { path: here, current: tab.gitInfo?.branch || '', locals: [], remotes: [], copies: buildCopies(), ownerRepo, loading: true };
        try {
            const r = await GIT.branchList(tab.path);
            this.branchSwitcher = { path: here, current: r.current, locals: r.locals, remotes: r.remotes, copies: buildCopies(), ownerRepo, loading: false };
        } catch (e) {
            this.branchSwitcher.loading = false;
            this.toast('Could not list branches: ' + (e.message || e), 'danger');
        }
    },

    async switchRepoBranch(tab, branch, isRemote) {
        if (!tab || !tab.path) return;
        // For a remote-only branch (origin/foo), check out the bare name so git
        // creates a local tracking branch.
        const target = isRemote ? branch.replace(/^[^/]+\//, '') : branch;
        if (!isRemote && branch === (tab.gitInfo?.branch || '')) return; // already on it
        const op = this._beginOp('Switch to branch ' + target);
        try {
            await GIT.checkoutBranch(tab.path, target);
            this._endOp(op, 'done');
            this.toast('Switched to ' + target);
            await this._refreshAllGitInfo();
            this.reload(tab);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Checkout failed (uncommitted changes may block it): ' + (e.message || e), 'danger');
        }
    },

    async repoFetch(tab) {
        const op = this._beginOp('Fetch ' + tab.gitInfo.branch);
        try { await this._gitFetchAuthed(tab.path, this._repoOwnerForTab(tab), '+refs/heads/*:refs/remotes/origin/*'); this._endOp(op, 'done'); this._refreshAllGitInfo(); }
        catch (e) { this._failOp(op, e); }
    },

    async repoPull(tab) {
        const op = this._beginOp('Pull ' + tab.gitInfo.branch);
        try {
            await this._gitFetchAuthed(tab.path, this._repoOwnerForTab(tab), '+refs/heads/*:refs/remotes/origin/*');
            await GIT.pullFfLocal(tab.path);
            this._endOp(op, 'done'); this._refreshAllGitInfo(); this.reload(tab);
        }
        catch (e) { this._failOp(op, e); this.toast('Pull failed (may have diverged).', 'danger'); }
    },

    async repoStageCommit(tab, alsoPush) {
        const msg = await this.askCommitMsg(tab.gitInfo.dirtyCount, alsoPush);
        if (!msg) return;
        const op = this._beginOp((alsoPush ? 'Commit & push' : 'Commit') + ' on ' + tab.gitInfo.branch);
        try {
            await GIT.stageAll(tab.path);
            await GIT.commit(tab.path, msg);
            this._endOp(op, 'done');
            this._refreshAllGitInfo();
            if (alsoPush) await this.repoPush(tab);
        } catch (e) { this._failOp(op, e); }
    },

    // Discard ALL uncommitted changes: reset tracked files to HEAD and remove
    // untracked (non-ignored) files/dirs. Only meaningful when the tree is dirty.
    async repoRollback(tab) {
        const info = tab.gitInfo;
        if (!info || !info.dirty) return;
        const n = info.dirtyCount || 0;
        const ok = await this.askConfirm('Roll back all changes',
            'Discard ALL uncommitted changes in:\n' + tab.path + '\n\n' +
            'This resets tracked files to the last commit (' + (info.branch || 'HEAD') + ') and deletes new/untracked files' +
            (n ? (' — ' + n + ' change(s) affected') : '') + '.\n\nThis cannot be undone.',
            'Discard everything');
        if (!ok) return;
        const op = this._beginOp('Roll back ' + (info.branch || 'changes'));
        try {
            await cockpit.spawn(['git', '-C', tab.path, 'reset', '--hard', 'HEAD'], { err: 'message' });
            await cockpit.spawn(['git', '-C', tab.path, 'clean', '-fd'], { err: 'message' });
            this._endOp(op, 'done');
            this._refreshAllGitInfo();
            this.reload(tab);
            this.toast('Rolled back all changes.', 'success');
        } catch (e) { this._failOp(op, e); this.toast('Rollback failed: ' + (e.message || e), 'danger'); }
    },

    askCommitMsg(fileCount, push) {
        return new Promise(resolve => {
            this.commitMsg = { message: '', fileCount, push, resolve };
            bootstrap.Modal.getOrCreateInstance(this.commitMsgModalEl).show();
        });
    },
    resolveCommitMsg(msg) {
        const r = this.commitMsg.resolve;
        this.commitMsg.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.commitMsgModalEl).hide();
        if (r) r(msg);
    },

    async repoPush(tab) {
        // Pre-check: fetch, then look for divergence
        const op = this._beginOp('Push ' + tab.gitInfo.branch + ' — checking remote');
        const owner = this._repoOwnerForTab(tab);
        try {
            await this._gitFetchAuthed(tab.path, owner, '+refs/heads/*:refs/remotes/origin/*');
            const st = await GIT.status(tab.path);
            this._endOp(op, 'done'); // pre-check finished (always — was previously only ended on divergence, which left it hung)
            if (st && st.behind > 0) {
                const choice = await this.askPushConflict(tab, st);
                if (choice === 'cancel' || choice === 'keep') return;
                if (choice === 'discard') {
                    const opd = this._beginOp('Discard local changes on ' + st.branch);
                    try {
                        await cockpit.spawn(['git', '-C', tab.path, 'reset', '--hard', 'origin/' + st.branch], { err: 'message' });
                        this._endOp(opd, 'done');
                        this._refreshAllGitInfo();
                        this.reload(tab);
                    } catch (e) { this._failOp(opd, e); }
                    return;
                }
            }
            // Pre-check OK — push
            const op2 = this._beginOp('Push ' + tab.gitInfo.branch + ' to origin');
            try {
                await this._gitPushAuthed(tab.path, owner, tab.gitInfo.branch);
                this._endOp(op2, 'done');
                this._refreshAllGitInfo();
            } catch (e) { this._failOp(op2, e); }
        } catch (e) {
            this._failOp(op, e);
        }
    },

    askPushConflict(tab, st) {
        return new Promise(resolve => {
            this.pushConflict = { tab, behind: st.behind, ahead: st.ahead, dirtyCount: st.dirtyCount, resolve };
            bootstrap.Modal.getOrCreateInstance(this.pushConflictModalEl).show();
        });
    },
    resolvePushConflict(choice) {
        const r = this.pushConflict.resolve;
        this.pushConflict.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.pushConflictModalEl).hide();
        if (r) r(choice);
    },

    // ─── PUBLISH PLAIN FOLDER TO GITHUB ──────────────────────────────────────
    async openPublishDialog(tab) {
        // Need gh installed + authed first
        if (!(await GIT.ghAvailable())) {
            this.toast('Install the GitHub CLI first (GH button).', 'danger');
            this.openGithubPanel(tab);
            return;
        }
        const auth = await GIT.ghAuthStatus();
        if (!auth.authed) {
            this.toast('Sign in to GitHub first (GH button).', 'danger');
            this.openGithubPanel(tab);
            return;
        }
        if (!this.gh.user) {
            try { this.gh.user = (await GIT.ghMe()).login; } catch (e) { this.gh.user = auth.user; }
        }

        // Reset state
        this.publish.folder = tab.path;
        this.publish.name = Util.basename(tab.path) || '';
        this.publish.nameError = '';
        this.publish.owner = this.gh.user;
        this.publish.visibility = 'private';
        this.publish.description = '';
        this.publish.commitMessage = 'Initial commit';
        this.publish.gitignore = '';
        this.publish.license = '';
        this.publish.error = '';
        this.publish.busy = false;
        this.publish.empty = (tab.files.length === 0);
        this.publish.orgs = [];
        this.validatePublishName();

        // Pre-flight scope check
        const scopes = await GIT.ghTokenScopes();
        if (!scopes.length) {
            this.publish.scopeUnknown = true;
            this.publish.scopeBlocked = false;
        } else {
            this.publish.scopeUnknown = false;
            this.publish.scopeBlocked = !scopes.includes('repo') && !scopes.includes('public_repo');
        }

        bootstrap.Modal.getOrCreateInstance(this.publishModalEl).show();

        // Load orgs in the background (needs read:org on classic tokens)
        GIT.ghOrgs().then(orgs => { this.publish.orgs = orgs; });
    },

    validatePublishName() {
        const n = this.publish.name || '';
        if (!n) { this.publish.nameError = 'Name is required.'; return; }
        if (n.length > 100) { this.publish.nameError = 'Too long (max 100).'; return; }
        if (!/^[A-Za-z0-9._-]+$/.test(n)) { this.publish.nameError = 'Only letters, digits, . _ - allowed.'; return; }
        if (n === '.' || n === '..') { this.publish.nameError = 'Invalid name.'; return; }
        this.publish.nameError = '';
    },

    async doPublish() {
        this.validatePublishName();
        if (this.publish.nameError || this.publish.scopeBlocked) return;
        this.publish.busy = true;
        this.publish.error = '';
        const folder = this.publish.folder;
        const ownerRepo = `${this.publish.owner}/${this.publish.name}`;
        const op = this._beginOp('Publish ' + ownerRepo);
        try {
            await GIT.publishToGitHub(folder, {
                owner: this.publish.owner,
                name: this.publish.name,
                visibility: this.publish.visibility,
                description: this.publish.description,
                commitMessage: this.publish.commitMessage,
                gitignore: this.publish.gitignore,
                license: this.publish.license,
            });
            // Register as a cached checkout
            await this._addRepoCheckout(ownerRepo, folder);
            this._endOp(op, 'done');
            this.toast('Published ' + ownerRepo);
            bootstrap.Modal.getOrCreateInstance(this.publishModalEl).hide();
            // Refresh git info so the tab shows as a repo, and reload listing
            await this._refreshAllGitInfo();
            const tab = this.tabs.find(t => t.path === folder && t.kind === 'dir');
            if (tab) this.reload(tab);
        } catch (e) {
            this._failOp(op, e);
            this.publish.error = e.message || String(e);
        } finally {
            this.publish.busy = false;
        }
    },

    // Date formatting for github panel
    formatRel(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60) return Math.round(diff) + 's ago';
        if (diff < 3600) return Math.round(diff / 60) + 'm ago';
        if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
        if (diff < 30 * 86400) return Math.round(diff / 86400) + 'd ago';
        return d.toISOString().slice(0, 10);
    },
};
