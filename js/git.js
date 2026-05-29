// git.js — gh CLI + local git wrappers. All run as the current user
// (NEVER with superuser:'require') so per-user gh credential isolation works.
'use strict';

window.GIT = (function () {

    // ─── gh availability / install ──────────────────────────────────────────
    async function ghAvailable() {
        try { await cockpit.spawn(['gh', '--version'], { err: 'ignore' }); return true; }
        catch (e) { return false; }
    }

    async function detectDistro() {
        try {
            const out = await cockpit.spawn(['sh', '-c', '. /etc/os-release && echo "$ID|$ID_LIKE"']);
            const [id, idLike] = out.trim().split('|');
            return { id: id || '', idLike: idLike || '' };
        } catch (e) { return { id: '', idLike: '' }; }
    }

    // Returns the install command array suitable for ['sh','-c', <string>]
    // and a 'family' label for UI display.
    async function chooseInstallStrategy() {
        const { id, idLike } = await detectDistro();
        const fam = (s) => (s + ' ').toLowerCase();
        const all = (fam(id) + fam(idLike));
        if (/(fedora|rhel|centos|rocky|alma|amzn)/.test(all))
            return { family: 'rhel', cmd: 'dnf install -y gh || yum install -y gh' };
        if (/(debian|ubuntu|mint|raspbian)/.test(all))
            return { family: 'debian',
                cmd: 'set -e; ' +
                     '(type curl >/dev/null 2>&1 || apt-get install -y curl); ' +
                     'mkdir -p -m 755 /etc/apt/keyrings && ' +
                     'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && ' +
                     'chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg && ' +
                     'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && ' +
                     'apt-get update && apt-get install -y gh' };
        if (/arch|manjaro|endeavour/.test(all))
            return { family: 'arch', cmd: 'pacman -S --noconfirm github-cli' };
        if (/opensuse|suse|sles/.test(all))
            return { family: 'suse', cmd: 'zypper install -y gh' };
        // fallback: static binary
        return { family: 'static',
            cmd: 'set -e; ' +
                 'ARCH=$(uname -m); case "$ARCH" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; *) echo "Unsupported arch: $ARCH"; exit 1;; esac; ' +
                 'VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -oP "\\"tag_name\\":\\s*\\"v?\\K[^\\"]+" | head -1); ' +
                 'cd /tmp && curl -fsSLO "https://github.com/cli/cli/releases/download/v${VER}/gh_${VER}_linux_${A}.tar.gz" && ' +
                 'tar xzf "gh_${VER}_linux_${A}.tar.gz" && ' +
                 'install -m 0755 "gh_${VER}_linux_${A}/bin/gh" /usr/local/bin/gh && ' +
                 'rm -rf "gh_${VER}_linux_${A}"*' };
    }

    // ─── gh auth ────────────────────────────────────────────────────────────
    async function ghAuthStatus() {
        try {
            const out = await cockpit.spawn(['gh', 'auth', 'status'], { err: 'message' });
            // Parse "Logged in to github.com account <name>" out of the status message.
            const m = (out || '').match(/account\s+(\S+)/i) || (out || '').match(/Logged in to \S+ as (\S+)/i);
            return { authed: true, user: m ? m[1] : '' };
        } catch (e) { return { authed: false, user: '' }; }
    }

    async function ghAuthLogin(token) {
        // Pipe the token to gh auth login --with-token (so the token never lands in argv).
        const proc = cockpit.spawn(['gh', 'auth', 'login', '--with-token'], { err: 'message' });
        // input(data) without the `stream` flag closes stdin (sends EOF) after
        // writing — passing `true` would keep stdin open and gh would hang
        // forever waiting for more input.
        proc.input(token);
        return await proc;
    }

    async function ghMe() {
        const j = await cockpit.spawn(['gh', 'api', 'user'], { err: 'message' });
        return JSON.parse(j);
    }

    // Inspect the scopes carried by the active token. Returns array of scopes.
    async function ghTokenScopes() {
        try {
            // gh api --include emits headers; X-OAuth-Scopes lists granted scopes.
            const out = await cockpit.spawn(['gh', 'api', '--include', '-X', 'GET', '/user'], { err: 'message' });
            const m = out.match(/^X-Oauth-Scopes:\s*([^\r\n]+)/im);
            if (!m) return [];
            return m[1].split(',').map(s => s.trim()).filter(Boolean);
        } catch (e) { return []; }
    }

    // The gh OAuth token (for authenticating raw git transport when a clone's
    // own remote auth isn't usable non-interactively).
    async function ghToken() {
        try { return (await cockpit.spawn(['gh', 'auth', 'token'], { err: 'message' })).trim(); }
        catch (e) { return ''; }
    }

    // Configure git to authenticate github.com via gh's credential helper, so
    // plain fetch/pull/push work non-interactively on HTTPS remotes.
    async function ghSetupGit() {
        try { await cockpit.spawn(['gh', 'auth', 'setup-git'], { err: 'message' }); return true; }
        catch (e) { return false; }
    }

    // ─── gh repos / branches / commits / prs ────────────────────────────────
    async function ghRepoList(limit) {
        // `gh repo list` (no owner arg) only returns repos the user OWNS — it
        // omits organization repos. The REST /user/repos endpoint returns every
        // repo the user can access: owned + collaborator + organization member.
        const out = await cockpit.spawn(
            ['gh', 'api', '--paginate',
             '-H', 'Accept: application/vnd.github+json',
             '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated'],
            { err: 'message' });
        // gh merges paginated JSON arrays into a single array.
        let arr;
        try { arr = JSON.parse(out); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        const mapped = arr.map(r => ({
            nameWithOwner: r.full_name,
            description: r.description,
            defaultBranchRef: r.default_branch ? { name: r.default_branch } : null,
            visibility: (r.visibility ? r.visibility.toUpperCase() : (r.private ? 'PRIVATE' : 'PUBLIC')),
            updatedAt: r.updated_at || r.pushed_at,
            primaryLanguage: r.language ? { name: r.language } : null,
            isFork: !!r.fork,
            sshUrl: r.ssh_url,
            url: r.html_url,
        }));
        return mapped.slice(0, limit || 300);
    }

    async function ghBranches(repo) {
        const out = await cockpit.spawn(
            ['gh', 'api', '--paginate', `/repos/${repo}/branches?per_page=100`],
            { err: 'message' });
        // --paginate concatenates JSON arrays sometimes as ][ joined; safe-parse with split.
        return safeJsonArray(out);
    }

    async function ghBranchCommits(repo, branch, limit) {
        const out = await cockpit.spawn(
            ['gh', 'api', `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit||20}`],
            { err: 'message' });
        return JSON.parse(out);
    }

    async function ghPullRequests(repo) {
        const out = await cockpit.spawn(
            ['gh', 'pr', 'list', '--repo', repo, '--state', 'open',
             '--json', 'number,title,author,headRefName,baseRefName,url,isDraft', '--limit', '50'],
            { err: 'message' });
        return JSON.parse(out);
    }

    async function ghDeleteRemoteBranch(repo, branch) {
        return cockpit.spawn(['gh', 'api', '-X', 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`],
            { err: 'message' });
    }

    async function ghCreateBranch(repo, newBranch, fromSha) {
        return cockpit.spawn(
            ['gh', 'api', '-X', 'POST', `/repos/${repo}/git/refs`,
             '-f', `ref=refs/heads/${newBranch}`,
             '-f', `sha=${fromSha}`],
            { err: 'message' });
    }

    function safeJsonArray(out) {
        out = (out || '').trim();
        if (!out) return [];
        if (out.startsWith('[')) {
            // Handle concatenated arrays from --paginate
            try { return JSON.parse(out); } catch (e) {}
            const merged = [];
            for (const chunk of out.split(/\]\s*\[/)) {
                const fixed = chunk.startsWith('[') ? chunk : '[' + chunk;
                const closed = fixed.endsWith(']') ? fixed : fixed + ']';
                try { for (const x of JSON.parse(closed)) merged.push(x); } catch (e) {}
            }
            return merged;
        }
        try { const o = JSON.parse(out); return Array.isArray(o) ? o : [o]; } catch (e) { return []; }
    }

    // ─── local git operations ───────────────────────────────────────────────
    function gitC(path, args, opts) {
        return cockpit.spawn(['git', '-C', path, ...args], { err: 'message', ...(opts || {}) });
    }

    async function isWorkTree(path) {
        try {
            const out = await gitC(path, ['rev-parse', '--is-inside-work-tree']);
            return out.trim() === 'true';
        } catch (e) { return false; }
    }

    async function topLevel(path) {
        try { return (await gitC(path, ['rev-parse', '--show-toplevel'])).trim(); }
        catch (e) { return null; }
    }

    async function currentBranch(path) {
        try { return (await gitC(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
        catch (e) { return null; }
    }

    async function status(path) {
        try {
            const porcelain = await gitC(path, ['status', '--porcelain=v1', '-uall']);
            const lines = porcelain.split('\n').filter(Boolean);
            const dirty = lines.length > 0;
            const branch = await currentBranch(path);
            let ahead = 0, behind = 0, remoteBranch = null;
            try {
                const ab = await gitC(path, ['rev-list', '--left-right', '--count', `@{upstream}...HEAD`]);
                const m = ab.trim().split(/\s+/);
                behind = parseInt(m[0], 10) || 0;
                ahead  = parseInt(m[1], 10) || 0;
                remoteBranch = (await gitC(path, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim();
            } catch (e) { /* no upstream */ }
            const remote = await getRemote(path);
            return { branch, dirty, dirtyCount: lines.length, ahead, behind, remoteBranch, remote, statusLines: lines };
        } catch (e) { return null; }
    }

    async function getRemote(path) {
        try {
            const url = (await gitC(path, ['config', '--get', 'remote.origin.url'])).trim();
            // Normalize to owner/repo
            const m = url.match(/(?:[:/])([^:/]+)\/([^/]+?)(?:\.git)?\/?$/);
            return { url, ownerRepo: m ? `${m[1]}/${m[2]}` : null };
        } catch (e) { return { url: null, ownerRepo: null }; }
    }

    async function fetch(path) { return gitC(path, ['fetch', '--all', '--prune']); }
    async function pullFf(path) { return gitC(path, ['pull', '--ff-only']); }
    // Fast-forward the current branch to its upstream using already-fetched
    // objects (no network) — pair with a token-authed fetch.
    async function pullFfLocal(path) { return gitC(path, ['merge', '--ff-only', '@{u}']); }
    async function pushBranch(path, branch) { return gitC(path, ['push', 'origin', branch || 'HEAD']); }
    async function stageAll(path) { return gitC(path, ['add', '-A']); }
    async function commit(path, message) { return gitC(path, ['commit', '-m', message]); }
    async function checkoutBranch(path, branch) { return gitC(path, ['checkout', branch]); }
    // List local + remote branches of a work-tree, plus the current branch.
    async function branchList(path) {
        const current = (await gitC(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        let locals = [];
        try {
            const out = await gitC(path, ['branch', '--format=%(refname:short)']);
            locals = out.split('\n').map(s => s.trim()).filter(Boolean);
        } catch (e) {}
        let remotes = [];
        try {
            const out = await gitC(path, ['branch', '-r', '--format=%(refname:short)']);
            remotes = out.split('\n').map(s => s.trim())
                .filter(b => b && !b.endsWith('/HEAD'));
        } catch (e) {}
        // Remote branches that have no matching local branch (so they can be
        // checked out as new tracking branches).
        const localSet = new Set(locals);
        const remoteOnly = remotes.filter(r => {
            const bare = r.replace(/^[^/]+\//, '');
            return !localSet.has(bare);
        });
        return { current, locals, remotes: remoteOnly };
    }
    async function createLocalBranch(path, name, fromBranch) {
        if (fromBranch) return gitC(path, ['checkout', '-b', name, fromBranch]);
        return gitC(path, ['checkout', '-b', name]);
    }
    async function deleteLocalBranch(path, name) {
        return gitC(path, ['branch', '-D', name]);
    }
    async function listLocalBranches(path) {
        try {
            const out = await gitC(path, ['branch', '--format=%(refname:short)|%(objectname:short)|%(upstream:short)']);
            return out.split('\n').filter(Boolean).map(line => {
                const [name, sha, upstream] = line.split('|');
                return { name, sha, upstream: upstream || null };
            });
        } catch (e) { return []; }
    }

    // Clone <repo> from gh credentials into <destDir>/<repo-name>
    // Optional branch defaults to default branch.
    async function clone(repoFullName, destParent, branch) {
        const repoName = repoFullName.split('/').pop();
        const target = (destParent.endsWith('/') ? destParent : destParent + '/') + repoName;
        // Use gh repo clone which honors gh auth
        const args = ['gh', 'repo', 'clone', repoFullName, target];
        if (branch) args.push('--', '--branch', branch);
        await cockpit.spawn(args, { err: 'message' });
        return target;
    }

    // Clone directly INTO the given directory (no <reponame> subfolder).
    // git requires targetDir to be empty or non-existent.
    async function cloneInto(repoFullName, targetDir, branch) {
        const args = ['gh', 'repo', 'clone', repoFullName, targetDir];
        if (branch) args.push('--', '--branch', branch);
        await cockpit.spawn(args, { err: 'message' });
        return targetDir;
    }

    // Same as cloneInto, but streams git's --progress output line-by-line via
    // onLine(line) so the caller can show real progress. Returns targetDir.
    function cloneIntoStream(repoFullName, targetDir, branch, onLine) {
        const gitFlags = ['--progress'];
        if (branch) gitFlags.push('--branch', branch);
        const args = ['gh', 'repo', 'clone', repoFullName, targetDir, '--', ...gitFlags];
        return new Promise((resolve, reject) => {
            let channel;
            try { channel = cockpit.channel({ payload: 'stream', spawn: args, err: 'out' }); }
            catch (e) { reject(e); return; }
            let buf = '';
            let allText = '';
            const emit = (raw) => { const line = raw.trim(); if (line && onLine) { try { onLine(line); } catch (e) {} } };
            channel.addEventListener('message', (ev, data) => {
                const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
                allText += text;
                buf += text;
                // git rewrites progress lines with \r; treat \r and \n as breaks.
                const parts = buf.split(/[\r\n]/);
                buf = parts.pop() || '';
                for (const p of parts) emit(p);
            });
            channel.addEventListener('close', (ev, options) => {
                if (buf) emit(buf);
                const failed = options && (options.problem || (options.exit_status && options.exit_status !== 0));
                if (failed) {
                    const lastLine = allText.trim().split('\n').filter(Boolean).pop();
                    reject(new Error(lastLine || options.problem || ('exit ' + options.exit_status)));
                } else {
                    resolve(targetDir);
                }
            });
        });
    }

    async function logCommits(path, branch, limit) {
        const sep = '\x1e';
        const fs  = '\x1f';
        const format = ['%H','%h','%an','%ae','%aI','%s'].join(fs) + sep;
        const args = ['log', `--pretty=format:${format}`, '-n', String(limit || 50)];
        if (branch) args.push(branch);
        const out = await gitC(path, args);
        return out.split('\x1e').filter(Boolean).map(rec => {
            const [hash, short, an, ae, date, subject] = rec.split('\x1f');
            return { hash, short, author: an, email: ae, date, subject };
        });
    }

    async function showCommitFiles(path, sha) {
        // git show --numstat --format='' <sha>  → "added  deleted  filename"
        const out = await gitC(path, ['show', '--numstat', '--format=', sha]);
        return out.split('\n').filter(Boolean).map(line => {
            const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
            if (!m) return null;
            return { added: m[1] === '-' ? null : parseInt(m[1], 10),
                     deleted: m[2] === '-' ? null : parseInt(m[2], 10),
                     path: m[3] };
        }).filter(Boolean);
    }

    async function fileDiff(path, sha, filePath) {
        // diff between sha~1 and sha for one file
        try {
            return await gitC(path, ['diff', `${sha}~1`, sha, '--', filePath]);
        } catch (e) {
            // first commit: diff against empty tree
            const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
            return await gitC(path, ['diff', empty, sha, '--', filePath]);
        }
    }

    async function fileAtCommit(path, sha, filePath) {
        return await gitC(path, ['show', `${sha}:${filePath}`]);
    }

    // ─── publish a plain folder to GitHub ────────────────────────────────────
    async function ghOrgs() {
        try {
            const out = await cockpit.spawn(['gh', 'api', 'user/orgs', '--jq', '.[].login'], { err: 'message' });
            return out.split('\n').map(s => s.trim()).filter(Boolean);
        } catch (e) { return []; }
    }

    // opts: { owner, name, visibility ('public'|'private'), description,
    //         commitMessage, gitignore (template name|''), license (key|'') }
    // Runs entirely as the user (no elevation). Returns 'owner/name'.
    async function publishToGitHub(folder, opts) {
        const J = Util.joinPath, W = (p, c) => FS.writeText(p, c);
        await gitC(folder, ['init']);
        await gitC(folder, ['branch', '-M', 'main']);

        // Optional .gitignore from GitHub template
        if (opts.gitignore) {
            try {
                const content = await cockpit.spawn(
                    ['gh', 'api', `/gitignore/templates/${opts.gitignore}`, '--jq', '.source'],
                    { err: 'message' });
                await W(J(folder, '.gitignore'), content);
            } catch (e) { /* skip on failure */ }
        }
        // Optional LICENSE from GitHub license API
        if (opts.license) {
            try {
                const body = await cockpit.spawn(
                    ['gh', 'api', `/licenses/${opts.license}`, '--jq', '.body'],
                    { err: 'message' });
                await W(J(folder, 'LICENSE'), body);
            } catch (e) { /* skip on failure */ }
        }

        await gitC(folder, ['add', '-A']);

        // If nothing is staged (empty folder), seed a README so there's a commit.
        let nothingStaged = false;
        try { await gitC(folder, ['diff', '--cached', '--quiet']); nothingStaged = true; }
        catch (e) { nothingStaged = false; }
        if (nothingStaged) {
            await W(J(folder, 'README.md'), `# ${opts.name}\n\n${opts.description || ''}\n`);
            await gitC(folder, ['add', '-A']);
        }

        await gitC(folder, ['commit', '-m', opts.commitMessage || 'Initial commit']);

        const full = `${opts.owner}/${opts.name}`;
        const args = ['repo', 'create', full,
                      opts.visibility === 'public' ? '--public' : '--private',
                      '--source=.', '--remote=origin', '--push'];
        if (opts.description) { args.push('--description', opts.description); }
        await cockpit.spawn(['gh', ...args], { directory: folder, err: 'message' });
        return full;
    }

    return {
        ghAvailable, detectDistro, chooseInstallStrategy,
        ghAuthStatus, ghAuthLogin, ghMe, ghTokenScopes, ghToken, ghSetupGit, ghOrgs,
        ghRepoList, ghBranches, ghBranchCommits, ghPullRequests,
        ghDeleteRemoteBranch, ghCreateBranch, publishToGitHub,
        isWorkTree, topLevel, currentBranch, status, getRemote, branchList,
        fetch, pullFf, pullFfLocal, pushBranch, stageAll, commit, checkoutBranch,
        createLocalBranch, deleteLocalBranch, listLocalBranches,
        clone, cloneInto, cloneIntoStream, logCommits, showCommitFiles, fileDiff, fileAtCommit,
    };
})();
