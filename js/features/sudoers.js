// Users & sudo management (3.3.0). Create/delete local OS accounts, grant/revoke
// sudo via the distro admin group (wheel/sudo), and enable full passwordless
// sudo (NOPASSWD:ALL) through a visudo-validated /etc/sudoers.d/<user> drop-in.
//
// Design centre of gravity is SAFETY:
//   - usernames are strictly validated before ANY spawn;
//   - every sudoers.d file is `visudo -cf`-validated before it is installed, so
//     a syntactically bad file can never break sudo;
//   - /etc/sudoers is NEVER edited — only drop-in files under /etc/sudoers.d;
//   - you cannot revoke your own sudo or delete your own account, and removing
//     the last admin is warned;
//   - privileged calls pass argv arrays (no `sh -c` with an interpolated
//     username); where a shell is unavoidable (temp+visudo+install) the username
//     is passed as a POSITIONAL argument ($1), never string-interpolated;
//   - passwords go to `chpasswd` on stdin, never on argv or into logs.
//
// Reactive state lives in app.js (`su`); pure helpers + orchestration live here.
window.ExplorerSudoers = {

    // ───────── pure helpers (unit-tested; no `this`, no I/O) ─────────

    // Linux usernames per useradd/NAME_REGEX conventions: start with a lower
    // letter or underscore, then lower letters/digits/underscore/hyphen, max 32.
    _suValidUsername(name) {
        return typeof name === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(name);
    },

    // getent passwd → [{name, uid, gid, gecos, home, shell}]
    _suParsePasswd(text) {
        const out = [];
        for (const line of String(text || '').split('\n')) {
            if (!line) continue;
            const p = line.split(':');
            if (p.length < 7) continue;
            out.push({
                name: p[0], uid: parseInt(p[2], 10), gid: parseInt(p[3], 10),
                gecos: p[4] || '', home: p[5] || '', shell: p[6] || '',
            });
        }
        return out;
    },

    // Human accounts only: 1000 ≤ uid < 65534 (skip system users and `nobody`).
    _suRealUsers(passwd) {
        return (passwd || []).filter(u => Number.isFinite(u.uid) && u.uid >= 1000 && u.uid < 65534);
    },

    // getent group <g> → {name, gid, members:[]} for the first non-empty line.
    _suParseGroup(text) {
        for (const line of String(text || '').split('\n')) {
            if (!line) continue;
            const p = line.split(':');
            if (p.length < 3) continue;
            return { name: p[0], gid: parseInt(p[2], 10), members: (p[3] || '').split(',').filter(Boolean) };
        }
        return null;
    },

    // The set of admin usernames: explicit group members ∪ users whose PRIMARY
    // gid is the admin group's gid (primary-group membership isn't listed in the
    // group line's member field).
    _suAdminSet(group, passwd) {
        const set = new Set();
        if (!group) return set;
        for (const m of group.members) set.add(m);
        if (Number.isFinite(group.gid)) {
            for (const u of (passwd || [])) if (u.gid === group.gid) set.add(u.name);
        }
        return set;
    },

    // Our drop-ins live under an app-owned filename so we never read, overwrite,
    // or delete an admin's own /etc/sudoers.d/<user> file. sudoers.d ignores
    // names containing "." or ending "~"; this one has neither.
    _suManagedBase(name) { return '90-explorer-' + name; },

    _suNopasswdContent(name) {
        return '# Managed by Cockpit Explorer - passwordless sudo for ' + name + '\n' +
            name + ' ALL=(ALL) NOPASSWD:ALL\n';
    },

    // Does this sudoers.d file text grant NOPASSWD to `name`?
    _suHasNopasswd(fileText, name) {
        if (!fileText || !name) return false;
        const esc = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
        return new RegExp('^\\s*' + esc + '\\s+.*NOPASSWD', 'm').test(fileText);
    },

    // Does `sudo -l -U <user>` output show EFFECTIVE passwordless sudo? This is
    // authoritative — it reflects grants from ANY source (/etc/sudoers, any
    // /etc/sudoers.d file, group rules), not just our managed drop-in. We only
    // look inside the "may run the following commands" section so a NOPASSWD
    // mention in the Defaults block can't produce a false positive.
    _suSudoListHasNopasswd(text) {
        if (!text) return false;
        const m = text.search(/may run the following commands/i);
        if (m < 0) return false;   // no rules section → the user has no sudo
        return /NOPASSWD/i.test(text.slice(m));
    },

    // Parse the blob produced by _suReadSudoersDir's shell reader:
    //   <<FILE:name>>\n<content…> repeated. → { name: content }
    _suParseSudoersDir(text) {
        const map = {};
        const parts = String(text || '').split(/<<FILE:([^>]*)>>\n/);
        // parts[0] is preamble (empty); then [name, content, name, content, …]
        for (let i = 1; i < parts.length; i += 2) {
            map[parts[i]] = parts[i + 1] || '';
        }
        return map;
    },

    // Given the parsed sudoers.d map and the real users, which have NOPASSWD via
    // their own /etc/sudoers.d/<user> file?
    _suNopasswdSet(dirMap, realUsers) {
        const set = new Set();
        for (const u of (realUsers || [])) {
            const content = dirMap[this._suManagedBase(u.name)];
            if (content && this._suHasNopasswd(content, u.name)) set.add(u.name);
        }
        return set;
    },

    _suIsSelf(name, me) { return !!me && name === me; },

    // True if `name` is an admin and the only one — revoking/deleting it would
    // leave the box with no sudoer.
    _suIsLastAdmin(name, adminSet) {
        return !!adminSet && adminSet.has(name) && adminSet.size <= 1;
    },

    // ───────── spawn helpers ─────────

    // Unprivileged read (getent, id) — world-readable, no escalation needed.
    _suRead(argv) { return cockpit.spawn(argv, { err: 'message' }); },

    // Privileged op (mutations + reading /etc/sudoers.d). stdin (e.g. a password
    // or a sudoers file body) is sent via .input() so it never touches argv.
    _suRoot(argv, opts) {
        opts = opts || {};
        const proc = cockpit.spawn(argv, { superuser: 'require', err: 'message' });
        if (opts.stdin != null) return proc.input(opts.stdin);
        return proc;
    },

    // Which of %wheel / %sudo is actually GRANTED sudo in the policy text (the
    // concatenation of /etc/sudoers + /etc/sudoers.d/*), preferring an enabled
    // rule over mere group existence. `exists` says which groups are present.
    // Pure — unit tested. Returns null when the policy names neither.
    _suGroupFromPolicy(policyText, exists) {
        const wheelOn = /^\s*%wheel\s+/m.test(policyText || '');
        const sudoOn = /^\s*%sudo\s+/m.test(policyText || '');
        if (wheelOn && exists.wheel) return 'wheel';
        if (sudoOn && exists.sudo) return 'sudo';
        return null;
    },

    async _suDetectAdminGroup() {
        const exists = {};
        for (const g of ['wheel', 'sudo']) {
            try { const t = await this._suRead(['getent', 'group', g]); exists[g] = !!(t && t.trim()); }
            catch (e) { exists[g] = false; }
        }
        // Prefer the group the sudoers policy actually authorizes — on a host
        // where both wheel and sudo exist but only one is granted, picking the
        // ungranted one would label members as admins who cannot really sudo.
        // Reading the policy needs root; if we can't, fall back to existence.
        try {
            // Only include drop-ins sudo actually reads: it SKIPS files whose
            // basename contains '.' or ends with '~'. Concatenating those (e.g. a
            // "old.conf" backup with %wheel) could pick a group sudo doesn't
            // honor. Trailing `true` so an empty /etc/sudoers.d doesn't fail.
            const pol = await this._suRoot(['sh', '-c',
                'cat /etc/sudoers 2>/dev/null; for f in /etc/sudoers.d/*; do [ -f "$f" ] || continue; b=${f##*/}; case "$b" in *.*|*"~") continue;; esac; cat "$f"; done 2>/dev/null; true']);
            const g = this._suGroupFromPolicy(pol, exists);
            if (g) return g;
        } catch (e) { /* not admin — fall back to existence */ }
        if (exists.wheel) return 'wheel';
        if (exists.sudo) return 'sudo';
        return 'wheel';
    },

    // One root call that emits each /etc/sudoers.d file as
    // `<<FILE:name>>\n<content>` for _suParseSudoersDir. Filenames come from the
    // filesystem (not user input); `basename "$f"` is quoted.
    _suReadSudoersDir() {
        const script =
            'cd /etc/sudoers.d 2>/dev/null || exit 0; ' +
            'for f in *; do [ -f "$f" ] || continue; printf "<<FILE:%s>>\\n" "$f"; cat "$f"; printf "\\n"; done';
        return this._suRoot(['sh', '-c', script]);
    },

    // Write a visudo-validated NOPASSWD:ALL drop-in for `name`. The username is a
    // POSITIONAL arg ($1) — never interpolated into the script — and the file
    // body arrives on stdin. If visudo rejects it, nothing is installed.
    _suWriteNopasswd(name) {
        const script =
            'umask 077; tmp="$(mktemp)" || exit 1; cat > "$tmp"; ' +
            'if visudo -cf "$tmp" >/dev/null 2>&1; then ' +
            'install -m 0440 -o root -g root "$tmp" "/etc/sudoers.d/90-explorer-$1"; rc=$?; ' +
            'else echo "visudo validation failed" >&2; rc=2; fi; ' +
            'rm -f "$tmp"; exit $rc';
        return this._suRoot(['sh', '-c', script, 'sh', name], { stdin: this._suNopasswdContent(name) });
    },

    _suRemoveNopasswd(name) {
        return this._suRoot(['sh', '-c', 'rm -f "/etc/sudoers.d/90-explorer-$1"', 'sh', name]);
    },

    // ───────── orchestration (reactive; drives this.su) ─────────

    openUsers() {
        bootstrap.Modal.getOrCreateInstance(this.sudoersModalEl).show();
        this.suLoad();
    },

    async suLoad() {
        const su = this.su;
        su.loading = true; su.error = '';
        try {
            su.me = (await this._suRead(['id', '-un'])).trim();
            if (!su.adminGroup) su.adminGroup = await this._suDetectAdminGroup();
            // `-s files`: LOCAL accounts only. On LDAP/SSSD/NIS hosts a plain
            // `getent passwd` also returns remote identities that useradd/userdel/
            // usermod/chpasswd cannot manage — listing them with those actions
            // would mislead. We only surface accounts these tools can act on.
            const passwd = this._suParsePasswd(await this._suRead(['getent', '-s', 'files', 'passwd']));
            const real = this._suRealUsers(passwd);
            const grp = this._suParseGroup(await this._suRead(['getent', '-s', 'files', 'group', su.adminGroup]));
            const adminSet = this._suAdminSet(grp, passwd);
            const adminGid = grp && Number.isFinite(grp.gid) ? grp.gid : null;

            // NOPASSWD state + whether we can actually escalate. A failure here
            // (no admin rights) degrades gracefully: the list still renders, but
            // NOPASSWD state is unknown and mutations will report the error.
            let nopass = new Set();
            try {
                const dir = this._suParseSudoersDir(await this._suReadSudoersDir());
                nopass = this._suNopasswdSet(dir, real);
                su.canAdmin = true;
            } catch (e) { su.canAdmin = false; }

            // Effective PASSWORDLESS state is authoritative via `sudo -l -U <user>`
            // — it reflects NOPASSWD granted by ANY file, not just our managed
            // drop-in. Needs root; probe each real user in parallel, with LC_ALL=C
            // so the parsed heading isn't localized. Without admin we fall back to
            // managed-drop-in detection. The `sudo` column deliberately stays
            // GROUP membership — that is exactly what Grant/Revoke act on, so a
            // narrow external rule can't misreport someone as a full administrator
            // or break the group-based revoke/last-admin logic.
            const effNopasswd = {};
            if (su.canAdmin) {
                const probes = await Promise.all(real.map(u =>
                    this._suRoot(['env', 'LC_ALL=C', 'sudo', '-l', '-U', u.name])
                        .then(out => [u.name, this._suSudoListHasNopasswd(out)])
                        .catch(() => [u.name, false])));
                for (const [name, np] of probes) effNopasswd[name] = np;
            }

            su.users = real
                .map(u => ({
                    name: u.name, uid: u.uid, home: u.home, shell: u.shell,
                    sudo: adminSet.has(u.name),
                    // Authoritative when we could probe; else our managed drop-in.
                    nopasswd: su.canAdmin ? !!effNopasswd[u.name] : nopass.has(u.name),
                    // Whether OUR /etc/sudoers.d/90-explorer-<user> drop-in grants
                    // it — i.e. whether the toggle can turn it off. Passwordless
                    // from another file is "external" (NOPASSWD*): shown, not ours.
                    nopasswdManaged: nopass.has(u.name),
                    // sudo via PRIMARY group can't be revoked with `gpasswd -d`
                    // (see suRevokeSudo) — flag it so revoke can explain instead.
                    viaPrimary: adminGid != null && u.gid === adminGid,
                    self: u.name === su.me, busy: false,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
            su.adminCount = su.users.filter(u => u.sudo).length;
        } catch (e) {
            su.error = e.message || String(e);
        } finally {
            su.loading = false;
        }
    },

    _suFindUser(name) { return this.su.users.find(u => u.name === name); },

    async suCreateUser() {
        const su = this.su, f = su.form;
        const name = (f.username || '').trim();
        if (!this._suValidUsername(name)) { this.toast('Invalid username — start with a lowercase letter or "_", then letters/digits/_/- (max 32).', 'danger'); return; }
        if (su.users.some(u => u.name === name)) { this.toast(`User "${name}" already exists.`, 'danger'); return; }
        if (!f.password) { this.toast('Set a password for the new user.', 'danger'); return; }
        if (f.nopasswd && !(await this.askConfirm('Passwordless sudo',
            `Create "${name}" with FULL passwordless sudo? They will be able to run any command as root with no password prompt.`, 'Create'))) return;
        su.busy = true;
        let created = false;
        try {
            await this._suRoot(['useradd', '-m', '-s', '/bin/bash', name]);
            created = true;
            await this._suRoot(['chpasswd'], { stdin: name + ':' + f.password + '\n' });
            if (f.sudo || f.nopasswd) await this._suRoot(['usermod', '-aG', su.adminGroup, name]);
            if (f.nopasswd) await this._suWriteNopasswd(name);
            this.toast(`Created user "${name}".`, 'success');
            su.form = { username: '', password: '', sudo: false, nopasswd: false };
        } catch (e) {
            // If useradd succeeded but a later step failed, the account exists —
            // report that honestly instead of implying nothing happened, and
            // leave it for the admin to finish or delete (an automatic rollback
            // would itself be a destructive action).
            this.toast(created
                ? `Created "${name}", but a follow-up step failed (` + (e.message || e) + `). Review the user below.`
                : `Could not create "${name}": ` + (e.message || e), 'danger');
        } finally {
            // Always reload so the list reflects reality — a partially-created
            // account must not stay hidden until a manual refresh.
            try { await this.suLoad(); } catch (e2) { /* keep the error toast above */ }
            su.busy = false;
        }
    },

    async suGrantSudo(name) {
        if (!this._suValidUsername(name)) return;
        if (!(await this.askConfirm('Grant sudo', `Grant sudo to "${name}" (add to the "${this.su.adminGroup}" group)?`, 'Grant'))) return;
        const u = this._suFindUser(name); if (u) u.busy = true;
        try {
            await this._suRoot(['usermod', '-aG', this.su.adminGroup, name]);
            this.toast(`Granted sudo to "${name}".`, 'success');
            await this.suLoad();
        } catch (e) { this.toast(`Could not grant sudo to "${name}": ` + (e.message || e), 'danger'); }
        finally { if (u) u.busy = false; }
    },

    async suRevokeSudo(name) {
        if (!this._suValidUsername(name)) return;
        if (this._suIsSelf(name, this.su.me)) { this.toast("You can't revoke your own sudo from here.", 'danger'); return; }
        const target = this._suFindUser(name);
        if (target && target.viaPrimary) {
            // `gpasswd -d` cannot remove PRIMARY-group membership; changing a
            // user's primary group is invasive, so we stop and explain rather
            // than silently failing.
            this.toast(`"${name}" has sudo through their primary group "${this.su.adminGroup}". Change their primary group manually (e.g. usermod -g <group> ${name}) to revoke it.`, 'danger');
            return;
        }
        const adminSet = new Set(this.su.users.filter(u => u.sudo).map(u => u.name));
        if (this._suIsLastAdmin(name, adminSet) &&
            !(await this.askConfirm('Remove the last admin?', `"${name}" is the only account with sudo. Revoking it leaves no one able to administer this system. Continue?`, 'Revoke anyway'))) return;
        if (!(await this.askConfirm('Revoke sudo', `Revoke sudo from "${name}"? Removes them from "${this.su.adminGroup}" and deletes any /etc/sudoers.d/${name}. The account is kept.`, 'Revoke'))) return;
        const u = this._suFindUser(name); if (u) u.busy = true;
        try {
            // Remove the passwordless drop-in FIRST. If this fails we abort before
            // touching group membership, so a user is never left OUT of the admin
            // group yet still holding a NOPASSWD:ALL rule (still passwordless root).
            await this._suRemoveNopasswd(name);
            await this._suRoot(['gpasswd', '-d', name, this.su.adminGroup]);
            this.toast(`Revoked sudo from "${name}".`, 'success');
            await this.suLoad();
        } catch (e) { this.toast(`Could not revoke sudo from "${name}": ` + (e.message || e), 'danger'); }
        finally { if (u) u.busy = false; }
    },

    async suSetNopasswd(name, on) {
        if (!this._suValidUsername(name)) return;
        if (on && !(await this.askConfirm('Passwordless sudo',
            `Enable FULL passwordless sudo for "${name}"? They will be able to run any command as root with no password prompt. This is a significant reduction in security.`, 'Enable'))) return;
        const u = this._suFindUser(name); if (u) u.busy = true;
        try {
            if (on) {
                if (!(u && u.sudo)) await this._suRoot(['usermod', '-aG', this.su.adminGroup, name]);
                await this._suWriteNopasswd(name);
                this.toast(`Passwordless sudo enabled for "${name}".`, 'success');
            } else {
                // We can only remove OUR managed drop-in. If the user is ALSO
                // passwordless via another file, they still will be after this —
                // the reloaded badge (NOPASSWD*) reflects that — so don't claim
                // "disabled", just report what we removed.
                await this._suRemoveNopasswd(name);
                this.toast(`Removed Explorer's passwordless-sudo rule for "${name}".`, 'success');
            }
            await this.suLoad();
        } catch (e) { this.toast(`Could not change passwordless sudo for "${name}": ` + (e.message || e), 'danger'); }
        finally { if (u) u.busy = false; }
    },

    async suDeleteUser(name) {
        if (!this._suValidUsername(name)) return;
        if (this._suIsSelf(name, this.su.me)) { this.toast("You can't delete your own account from here.", 'danger'); return; }
        const adminSet = new Set(this.su.users.filter(u => u.sudo).map(u => u.name));
        if (this._suIsLastAdmin(name, adminSet) &&
            !(await this.askConfirm('Delete the last admin?', `"${name}" is the only account with sudo. Deleting it leaves no one able to administer this system. Continue?`, 'Delete anyway'))) return;
        const choice = await this.askChoice('Delete account',
            `Permanently delete the account "${name}"? This cannot be undone.`,
            [
                { id: 'keep', label: 'Delete account (keep home)', variant: 'danger' },
                { id: 'purge', label: 'Delete account + home directory', variant: 'danger' },
            ]);
        if (choice !== 'keep' && choice !== 'purge') return;
        const argv = choice === 'purge' ? ['userdel', '-r', name] : ['userdel', name];
        const u = this._suFindUser(name); if (u) u.busy = true;
        try {
            // Remove the managed sudoers drop-in BEFORE deleting the account
            // (userdel never touches /etc/sudoers.d). Doing it first means that if
            // the removal fails we abort before userdel — so we never leave a
            // NOPASSWD:ALL rule for a now-nonexistent username that a future
            // same-named account would silently inherit as passwordless root.
            await this._suRemoveNopasswd(name);
            await this._suRoot(argv);
            this.toast(`Deleted user "${name}"${choice === 'purge' ? ' and home directory' : ''}.`, 'success');
            await this.suLoad();
        } catch (e) { this.toast(`Could not delete "${name}": ` + (e.message || e), 'danger'); }
        finally { if (u) u.busy = false; }
    },

    async suSetPassword(name) {
        if (!this._suValidUsername(name)) return;
        const pw = await this.askPrompt('Set password', `New password for "${name}"`, '', { password: true });
        if (pw == null || pw === '') return;
        const u = this._suFindUser(name); if (u) u.busy = true;
        try {
            await this._suRoot(['chpasswd'], { stdin: name + ':' + pw + '\n' });
            this.toast(`Password updated for "${name}".`, 'success');
        } catch (e) { this.toast(`Could not set password for "${name}": ` + (e.message || e), 'danger'); }
        finally { if (u) u.busy = false; }
    },
};
