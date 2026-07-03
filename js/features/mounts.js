// Mounts panel — /etc/fstab editor, SMB/CIFS and NFS network shares.
// Extracted from app.js (2.0 modularization). Methods only; this.mounts
// state stays in app.js.
window.ExplorerMounts = {
    async _hasFindmnt() {
        try {
            const out = await cockpit.spawn(['sh', '-c', 'command -v findmnt 2>/dev/null'], { err: 'ignore' });
            return !!(out || '').trim();
        } catch (e) { return false; }
    },

    // List currently-mounted targets (mount points). Prefers findmnt; falls
    // back to /proc/self/mounts so the mounted/unmounted indicator still works
    // on minimal systems without util-linux's findmnt.
    async _listMounted() {
        if (this.mounts.findmnt) {
            try {
                const out = await cockpit.spawn(['findmnt', '-rno', 'TARGET'], { err: 'message' });
                return out.split('\n').map(s => s.trim()).filter(Boolean);
            } catch (e) { /* fall through */ }
        }
        try {
            const out = await cockpit.spawn(['sh', '-c', 'cat /proc/self/mounts'], { err: 'message' });
            // field 2 is the mount point; octal escapes (e.g. \040 for space)
            return out.split('\n').map(l => l.split(' ')[1]).filter(Boolean)
                .map(s => s.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\'));
        } catch (e) { return []; }
    },

    // Parse /etc/fstab into structured rows. Comment and blank lines are
    // buffered onto the next entry's `_lead` (and any trailing ones into
    // `trailer`) so the file round-trips faithfully on save.
    _parseFstab(text) {
        const lines = (text || '').split('\n');
        const rows = [];
        let lead = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) { lead.push(line); continue; }
            const parts = trimmed.split(/\s+/);
            rows.push({
                spec: parts[0] || '',
                file: parts[1] || '',
                vfstype: parts[2] || '',
                mntops: parts[3] || 'defaults',
                freq: parts[4] !== undefined ? parts[4] : '0',
                passno: parts[5] !== undefined ? parts[5] : '0',
                _lead: lead,
                mounted: null,
            });
            lead = [];
        }
        return { rows, trailer: lead };
    },

    _serializeFstab() {
        const out = [];
        for (const r of this.mounts.rows) {
            for (const l of (r._lead || [])) out.push(l);
            const freq = (String(r.freq == null ? '0' : r.freq).trim()) || '0';
            const passno = (String(r.passno == null ? '0' : r.passno).trim()) || '0';
            out.push([
                (r.spec || '').trim(),
                (r.file || '').trim(),
                (r.vfstype || '').trim(),
                ((r.mntops || '').trim() || 'defaults'),
                freq, passno,
            ].join('\t'));
        }
        for (const l of (this.mounts.trailer || [])) out.push(l);
        // Collapse trailing blank lines; guarantee exactly one final newline.
        return out.join('\n').replace(/\n*$/, '') + '\n';
    },

    _validateFstabRows(rows) {
        const errs = [];
        rows.forEach((r, i) => {
            const n = i + 1;
            const spec = (r.spec || '').trim(), file = (r.file || '').trim(), vt = (r.vfstype || '').trim();
            const freq = String(r.freq == null ? '' : r.freq).trim();
            const passno = String(r.passno == null ? '' : r.passno).trim();
            if (!spec || !file || !vt) { errs.push(`Row ${n}: device, mount point and type are required`); return; }
            if (vt !== 'swap' && file !== 'none' && !file.startsWith('/')) errs.push(`Row ${n}: mount point should be an absolute path`);
            if (freq && !/^\d+$/.test(freq)) errs.push(`Row ${n}: dump must be a number`);
            if (passno && !/^\d+$/.test(passno)) errs.push(`Row ${n}: pass must be a number`);
        });
        return errs;
    },

    async _refreshMountedState() {
        const targets = await this._listMounted();
        for (const r of this.mounts.rows) {
            const f = (r.file || '').trim(), vt = (r.vfstype || '').trim();
            r.mounted = (vt === 'swap' || f === 'none' || !f) ? null : targets.includes(f);
        }
    },

    async openMounts() {
        this.mounts.findmnt = await this._hasFindmnt();
        this.mounts.rawMode = false;
        this.mounts.view = 'fstab';
        this.mounts.mountResults = [];
        this.mounts.adhoc.open = false;
        this.mounts.live.rows = [];
        await this.loadFstab();
        bootstrap.Modal.getOrCreateInstance(this.mountsModalEl).show();
        // Populate field suggestions in the background (non-blocking).
        this._loadMountSuggestions();
    },

    switchMountsView(v) {
        this.mounts.view = v;
        if (v === 'live' && !this.mounts.live.rows.length && !this.mounts.live.loading) this.loadLiveMounts();
        if (v === 'net') this._initCifsTab();
    },

    // ── SMB/CIFS ───────────────────────────────────────────────────────────
    async _hasMountCifs() {
        try {
            const o = await cockpit.spawn(['sh', '-c', 'command -v mount.cifs 2>/dev/null'], { err: 'ignore' });
            return !!(o || '').trim();
        } catch (e) { return false; }
    },

    async _initCifsTab() {
        if (this.cifs.available === null) this.cifs.available = await this._hasMountCifs();
        this.cifs.disco.hosts = []; this.cifs.disco.shares = []; this.cifs.disco.error = '';
        if (this.cifs.disco.hasSmbclient === null) this.cifs.disco.hasSmbclient = await this._hasBin('smbclient');
        if (this.cifs.disco.hasSmbclient === false && !this.cifs.disco.smbInstall) {
            this.cifs.disco.smbInstall = await this._installCmdFor('smb');
        }
        // NFS
        if (this.nfs.available === null) this.nfs.available = await this._hasBin('mount.nfs');
        if (this.nfs.hasShowmount === null) this.nfs.hasShowmount = await this._hasBin('showmount');
        if (this.nfs.available === false && !this.nfs.install) this.nfs.install = await this._installCmdFor('nfs');
        this.nfs.exports = []; this.nfs.add.error = '';
        await this.refreshCifsCreds();
    },

    // Suggest the distro-appropriate install command for a tool by reading
    // /etc/os-release (ID + ID_LIKE). role 'smb' -> smbclient/samba-client,
    // role 'nfs' -> nfs-common/nfs-utils.
    async _installCmdFor(role) {
        let id = '', like = '';
        try {
            const txt = await FS.readText('/etc/os-release');
            const get = k => { const m = (txt || '').match(new RegExp('^' + k + '=("?)(.*?)\\1$', 'm')); return m ? m[2] : ''; };
            id = (get('ID') || '').toLowerCase();
            like = (get('ID_LIKE') || '').toLowerCase();
        } catch (e) { /* fall through to generic */ }
        const tokens = new Set([id, ...like.split(/\s+/).filter(Boolean)]);
        const has = (...names) => names.some(n => tokens.has(n));
        const pick = (deb, rh, suse, arch, alpine, gentoo, generic) =>
            has('debian', 'ubuntu') ? deb
                : has('fedora', 'rhel', 'centos') ? rh
                    : has('suse', 'opensuse', 'sles') ? suse
                        : has('arch') ? arch
                            : has('alpine') ? alpine
                                : has('gentoo') ? gentoo
                                    : generic;
        if (role === 'nfs') {
            return pick('sudo apt install nfs-common', 'sudo dnf install nfs-utils',
                'sudo zypper install nfs-client', 'sudo pacman -S nfs-utils',
                'sudo apk add nfs-utils', 'sudo emerge net-fs/nfs-utils',
                'install the nfs-utils / nfs-common package for your distribution');
        }
        return pick('sudo apt install smbclient', 'sudo dnf install samba-client',
            'sudo zypper install samba-client', 'sudo pacman -S smbclient',
            'sudo apk add samba-client', 'sudo emerge net-fs/samba',
            'install the "smbclient" (a.k.a. samba-client) package for your distribution');
    },

    // ── NFS ────────────────────────────────────────────────────────────────
    async browseExports() {
        const n = this.nfs;
        const host = (n.add.host || '').trim();
        if (!host) { n.add.error = 'Enter a server first.'; this.toast(n.add.error, 'warning'); return; }
        if (n.hasShowmount === null) n.hasShowmount = await this._hasBin('showmount');
        if (!n.hasShowmount) { n.add.error = 'showmount not found (install nfs-utils / nfs-common) — type the export manually.'; this.toast(n.add.error, 'danger'); return; }
        n.browsing = true; n.add.error = ''; n.exports = [];
        try {
            const out = await cockpit.spawn(['timeout', '8', 'showmount', '-e', host], { err: 'message' });
            n.exports = this._parseExports(out);
            if (n.exports.length) {
                this.toast(`Found ${n.exports.length} export${n.exports.length === 1 ? '' : 's'}: ${n.exports.join(', ')}`, 'success');
            } else {
                n.add.error = "No exports listed (server may be NFSv4-only, which showmount can't enumerate).";
                this.toast(n.add.error, 'warning');
            }
        } catch (e) {
            n.add.error = 'Browse failed: ' + ((e.message || String(e)).split('\n')[0]);
            this.toast(n.add.error, 'danger');
        } finally {
            n.browsing = false;
        }
    },

    _parseExports(out) {
        const list = [];
        (out || '').split('\n').forEach(line => {
            const t = line.trim();
            if (!t || /^Export list for/i.test(t)) return;
            const path = t.split(/\s+/)[0];
            if (path && path.startsWith('/')) list.push(path);
        });
        return Array.from(new Set(list));
    },

    async addNfsShare() {
        const a = this.nfs.add;
        a.error = '';
        const host = (a.host || '').trim().replace(/[:/]+$/, '');
        const exp = (a.export || '').trim();
        const mp = (a.mountpoint || '').trim();
        if (!host) { a.error = 'Server is required.'; return; }
        if (!exp || !exp.startsWith('/')) { a.error = 'Export must be an absolute path (e.g. /export/share).'; return; }
        if (!mp || !mp.startsWith('/')) { a.error = 'Mount point must be an absolute path.'; return; }
        a.busy = true;
        try {
            const opts = [];
            if (a.ro) opts.push('ro');
            if (a.netdev) opts.push('_netdev');
            if (a.nofail) opts.push('nofail');
            if (a.automount) opts.push('x-systemd.automount');
            if ((a.vers || '').trim()) opts.push(`vers=${a.vers.trim()}`);
            this.mounts.rows.push({
                spec: `${host}:${exp}`, file: mp, vfstype: 'nfs',
                mntops: (opts.join(',') || 'defaults'), freq: '0', passno: '0', _lead: [], mounted: false,
            });
            a.host = ''; a.export = ''; a.mountpoint = '';
            this.mounts.rawMode = false;
            this.mounts.view = 'fstab';
            await this.saveFstab();
        } catch (e) {
            a.error = e.message || String(e);
        } finally {
            a.busy = false;
        }
    },

    async copyTextToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
            }
            this.toast('Copied to clipboard.', 'success');
        } catch (e) {
            this.toast('Copy failed — select and copy manually.', 'warning');
        }
    },

    async _hasBin(name) {
        try {
            const o = await cockpit.spawn(['sh', '-c', `command -v ${name} 2>/dev/null`], { err: 'ignore' });
            return !!(o || '').trim();
        } catch (e) { return false; }
    },

    // Discover SMB hosts via mDNS (avahi). Bounded with `timeout` so it can't
    // hang the UI; degrades to manual entry when avahi-browse is absent.
    // Merge a host into the results map, enriching a bare-IP entry if a real
    // name later resolves for the same address.
    _addHostTo(found, host, addr, label) {
        const key = addr || host;
        if (!key) return;
        if (!found.has(key)) { found.set(key, { host: host || addr, addr, label }); return; }
        const cur = found.get(key);
        if ((!cur.host || cur.host === cur.addr) && host && host !== addr) { cur.host = host; cur.label = label; }
    },

    async discoverHosts() {
        const d = this.cifs.disco;
        if (d.hasAvahi === null) d.hasAvahi = await this._hasBin('avahi-browse');
        if (d.hasNmblookup === null) d.hasNmblookup = await this._hasBin('nmblookup');
        d.scanning = true; d.error = '';
        const found = new Map();
        try {
            // mDNS / Bonjour
            if (d.hasAvahi) {
                try {
                    const out = await cockpit.spawn(['sh', '-c', 'timeout 5 avahi-browse -rtp _smb._tcp 2>/dev/null'], { err: 'message' });
                    out.split('\n').forEach(line => {
                        if (!line.startsWith('=')) return;        // resolved records only
                        const f = line.split(';');                // =;iface;proto;name;type;domain;hostname;addr;port;txt
                        const name = f[3] || '', hostname = f[6] || '', addr = f[7] || '';
                        const host = hostname.replace(/\.local\.?$/i, '') || addr;
                        if (!host && !addr) return;
                        this._addHostTo(found, host, addr, `${name || host || addr}${addr ? ' · ' + addr : ''}`);
                    });
                } catch (e) { /* ignore, try NetBIOS */ }
            }
            // NetBIOS broadcast — works without a master browser when hosts
            // answer the wildcard query (many consumer NAS boxes don't).
            if (d.hasNmblookup) {
                try {
                    const out = await cockpit.spawn(['timeout', '5', 'nmblookup', '*'], { err: 'message' });
                    const ips = [];
                    out.split('\n').forEach(line => {
                        const m = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s/);
                        if (m) ips.push(m[1]);
                    });
                    const uniqueIps = Array.from(new Set(ips)).slice(0, 32);
                    const names = await Promise.all(uniqueIps.map(async ip => {
                        try {
                            const a = await cockpit.spawn(['timeout', '2', 'nmblookup', '-A', ip], { err: 'message' });
                            return this._parseNbName(a);
                        } catch (e) { return ''; }
                    }));
                    uniqueIps.forEach((ip, i) => this._addHostTo(found, names[i] || ip, ip, `${names[i] || ip} · ${ip} (NetBIOS)`));
                } catch (e) { /* ignore NetBIOS errors */ }
            }
            d.hosts = Array.from(found.values());

            // Nothing from the broadcast methods? Offer a directed subnet sweep
            // (reliable even when the broadcast is suppressed / no master browser).
            if (!d.hosts.length && (d.hasNmblookup || true)) {
                const def = await this._localSubnetCidr();
                const cidr = await this.askPrompt('Scan a subnet for SMB hosts?',
                    'Nothing answered mDNS or the NetBIOS broadcast. Enter a subnet (CIDR) to scan directly, or Cancel to type the host manually.',
                    def);
                if (cidr && cidr.trim()) {
                    await this._sweepSubnet(cidr.trim(), found);
                    d.hosts = Array.from(found.values());
                }
            }

            if (d.hosts.length) {
                this.toast(`Found ${d.hosts.length} SMB host${d.hosts.length === 1 ? '' : 's'}.`, 'success');
            } else if (!d.error) {
                d.error = (!d.hasAvahi && !d.hasNmblookup)
                    ? 'No discovery tools found — install avahi-utils (mDNS) and/or samba/nmblookup (NetBIOS), or type the host manually.'
                    : 'No SMB hosts found — type the host manually.';
                this.toast(d.error, 'info');
            }
        } catch (e) {
            d.error = 'Discovery failed: ' + ((e.message || String(e)).split('\n')[0]);
            this.toast(d.error, 'danger');
        } finally {
            d.scanning = false; d.sweeping = false;
        }
    },

    // Default CIDR for the sweep prompt: the host's own global IPv4 + prefix,
    // reduced to its network address (e.g. 192.168.0.79/24 -> 192.168.0.0/24).
    async _localSubnetCidr() {
        try {
            const out = await cockpit.spawn(['sh', '-c', 'ip -4 -o addr show scope global 2>/dev/null'], { err: 'message' });
            const m = out.match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/);
            if (m) {
                const o = m[1].split('.').map(Number), p = parseInt(m[2], 10);
                const ipNum = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
                const mask = p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0;
                const net = (ipNum & mask) >>> 0;
                return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${p}`;
            }
        } catch (e) { /* fall through */ }
        return '192.168.0.0/24';
    },

    // Expand a CIDR (/23../30 only, to stay bounded) into its usable host IPs.
    _cidrHosts(cidr) {
        const m = (cidr || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
        if (!m) return { error: 'Enter a subnet like 192.168.0.0/24.' };
        const o = m[1].split('.').map(Number), p = parseInt(m[2], 10);
        if (o.some(x => x > 255)) return { error: 'Invalid IPv4 address.' };
        if (p < 23 || p > 30) return { error: 'Use a prefix between /23 and /30 to keep the scan bounded.' };
        const ipNum = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
        const mask = (0xFFFFFFFF << (32 - p)) >>> 0;
        const net = (ipNum & mask) >>> 0;
        const bcast = (net | (~mask >>> 0)) >>> 0;
        const hosts = [];
        for (let n = net + 1; n < bcast; n++) hosts.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
        return { hosts };
    },

    // Bounded-concurrency async map.
    async _pool(items, limit, worker) {
        const out = new Array(items.length); let i = 0;
        const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
            while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
        });
        await Promise.all(runners);
        return out;
    },

    // Probe one IP for SMB: directed NetBIOS name query (the method proven to
    // work even when the broadcast doesn't) plus a TCP/445 check, run together
    // so each host costs ~1s. Returns {ip,name} or null.
    async _probeSmbHost(ip, hasNb) {
        let nbName = '', open445 = false;
        const tasks = [];
        if (hasNb) tasks.push((async () => {
            try { const a = await cockpit.spawn(['timeout', '1', 'nmblookup', '-A', ip], { err: 'message' }); nbName = this._parseNbName(a); } catch (e) {}
        })());
        tasks.push((async () => {
            try { await cockpit.spawn(['timeout', '1', 'bash', '-c', `exec 3<>/dev/tcp/${ip}/445`], { err: 'message' }); open445 = true; } catch (e) {}
        })());
        await Promise.all(tasks);
        if (nbName) return { ip, name: nbName };
        if (open445) return { ip, name: '' };
        return null;
    },

    async _sweepSubnet(cidr, found) {
        const d = this.cifs.disco;
        const parsed = this._cidrHosts(cidr);
        if (parsed.error) { d.error = parsed.error; this.toast(parsed.error, 'warning'); return; }
        const hasNb = (d.hasNmblookup !== null) ? d.hasNmblookup : await this._hasBin('nmblookup');
        d.sweeping = true; d.sweepTotal = parsed.hosts.length; d.sweepDone = 0;
        try {
            const results = await this._pool(parsed.hosts, 32, async (ip) => {
                const r = await this._probeSmbHost(ip, hasNb);
                d.sweepDone++;
                return r;
            });
            results.filter(Boolean).forEach(r => this._addHostTo(found, r.name || r.ip, r.ip, `${r.name || r.ip} · ${r.ip} (scan)`));
        } finally {
            d.sweeping = false;
        }
    },

    // Pick the UNIQUE workstation name (the <00> entry that is not <GROUP>)
    // out of an `nmblookup -A <ip>` name table.
    _parseNbName(out) {
        for (const line of (out || '').split('\n')) {
            const m = line.match(/^\s+(\S.*?)\s+<00>\s+-\s+(<GROUP>\s+)?[A-Z]\s+<ACTIVE>/);
            if (m && !m[2]) {
                const name = m[1].trim();
                if (name && !/__MSBROWSE__|^\.\./.test(name)) return name;
            }
        }
        return '';
    },

    // List shares on the current host with smbclient. Guest by default; if a
    // saved credential is selected, browse with it (read root-only via the
    // bridge so the secret never hits argv).
    async browseShares() {
        const d = this.cifs.disco;
        const host = (this.cifs.add.host || '').trim().replace(/^[\\/]+/, '');
        if (!host) { d.error = 'Enter or pick a host first.'; this.toast(d.error, 'warning'); return; }
        if (d.hasSmbclient === null) d.hasSmbclient = await this._hasBin('smbclient');
        if (!d.hasSmbclient) { d.error = 'smbclient not found (install smbclient / samba-client) — type the share manually.'; this.toast(d.error, 'danger'); return; }
        d.browsing = true; d.error = ''; d.shares = [];
        try {
            let out;
            const credName = (this.cifs.add.credMode === 'existing') ? (this.cifs.add.credName || '').trim() : '';
            if (credName) {
                out = await cockpit.spawn(['timeout', '8', 'smbclient', '-L', host, '-A', `/etc/cifs-creds/${credName}`], FS.spawnOpts({ admin: true }));
            } else {
                out = await cockpit.spawn(['timeout', '8', 'smbclient', '-L', host, '-N'], { err: 'message' });
            }
            d.shares = this._parseSmbShares(out);
            if (d.shares.length) {
                this.toast(`Found ${d.shares.length} share${d.shares.length === 1 ? '' : 's'}: ${d.shares.join(', ')}`, 'success');
            } else {
                d.error = 'No shares found (or none visible with these credentials).';
                this.toast(d.error, 'warning');
            }
        } catch (e) {
            const msg = (e.message || String(e));
            if (/NT_STATUS_ACCESS_DENIED|NT_STATUS_LOGON_FAILURE|NT_STATUS_NO_LOGON_SERVERS/i.test(msg)) {
                d.error = 'Access denied browsing shares — choose a saved credential (Saved) and Browse again.';
            } else {
                d.error = 'Browse failed: ' + msg.split('\n')[0];
            }
            this.toast(d.error, 'danger');
        } finally {
            d.browsing = false;
        }
    },

    _parseSmbShares(out) {
        const shares = []; let inSection = false;
        (out || '').split('\n').forEach(line => {
            if (/^\s*Sharename\s+Type/i.test(line)) { inSection = true; return; }
            if (!inSection) return;
            if (/^\s*---/.test(line)) return;
            if (!line.trim()) { inSection = false; return; }
            const m = line.match(/^\s+(\S.*?)\s+(Disk|Printer|IPC)\b/);
            if (m && m[2] === 'Disk') { const name = m[1].trim(); if (!name.endsWith('$')) shares.push(name); }
        });
        return Array.from(new Set(shares));
    },

    async refreshCifsCreds() {
        this.cifs.loadingCreds = true;
        try {
            // The store is root-only (0700), so listing needs the bridge.
            const out = await cockpit.spawn(['sh', '-c', 'ls -1 /etc/cifs-creds 2>/dev/null'], FS.spawnOpts({ admin: true }));
            this.cifs.creds = out.split('\n').map(s => s.trim()).filter(Boolean).sort();
        } catch (e) {
            this.cifs.creds = [];
        } finally {
            this.cifs.loadingCreds = false;
        }
    },

    _validCredName(n) { return /^[A-Za-z0-9._-]+$/.test(n || ''); },

    // Write a credentials file. The secret travels in the file body via the
    // file channel (cockpit.file().replace) — never on a command line, never
    // echoed, never logged. Dir is root:root 0700, file 0600.
    async _writeCifsCred(name, c) {
        await cockpit.spawn(['sh', '-c',
            'mkdir -p /etc/cifs-creds && chmod 700 /etc/cifs-creds && chown root:root /etc/cifs-creds'],
            FS.spawnOpts({ admin: true }));
        let content = `username=${c.username || ''}\n`;
        if (c.password) content += `password=${c.password}\n`;
        if (c.domain) content += `domain=${c.domain}\n`;
        const path = `/etc/cifs-creds/${name}`;
        await FS.writeText(path, content, { admin: true });
        await cockpit.spawn(['chmod', '600', path], FS.spawnOpts({ admin: true }));
    },

    async deleteCifsCred(name) {
        const ok = await this.askConfirm('Delete credentials',
            `Delete saved credentials "${name}"? Shares using it will fail to mount.`, 'Delete');
        if (!ok) return;
        try {
            await cockpit.spawn(['rm', '-f', `/etc/cifs-creds/${name}`], FS.spawnOpts({ admin: true }));
            this.toast(`Deleted credentials "${name}".`, 'success');
        } catch (e) {
            this.toast('Delete failed: ' + (e.message || e), 'danger');
        }
        await this.refreshCifsCreds();
    },

    async addCifsShare() {
        const a = this.cifs.add;
        a.error = '';
        const host = (a.host || '').trim().replace(/^[\/\\]+/, '');
        const share = (a.share || '').trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
        const mp = (a.mountpoint || '').trim();
        if (!host || !share) { a.error = 'Host and share are required.'; return; }
        if (!mp || !mp.startsWith('/')) { a.error = 'Mount point must be an absolute path.'; return; }
        const credName = (a.credName || '').trim();
        if (a.credMode === 'new') {
            if (!this._validCredName(credName)) { a.error = 'Credential name: letters, digits, dot, dash, underscore only.'; return; }
            if (!a.username) { a.error = 'Username is required for new credentials.'; return; }
        } else if (a.credMode === 'existing') {
            if (!credName) { a.error = 'Pick a saved credential, or choose New / Guest.'; return; }
        }
        a.busy = true;
        try {
            if (a.credMode === 'new') {
                await this._writeCifsCred(credName, { username: a.username, password: a.password, domain: a.domain });
                await this.refreshCifsCreds();
            }
            const opts = [];
            if (a.credMode === 'guest') opts.push('guest');
            else opts.push(`credentials=/etc/cifs-creds/${credName}`);
            if (a.ro) opts.push('ro');
            if (a.netdev) opts.push('_netdev');
            if (a.nofail) opts.push('nofail');
            if (a.automount) opts.push('x-systemd.automount');
            if ((a.vers || '').trim()) opts.push(`vers=${a.vers.trim()}`);
            if ((a.uid || '').trim()) opts.push(`uid=${a.uid.trim()}`);
            if ((a.gid || '').trim()) opts.push(`gid=${a.gid.trim()}`);
            opts.push('iocharset=utf8');
            this.mounts.rows.push({
                spec: `//${host}/${share}`, file: mp, vfstype: 'cifs',
                mntops: opts.join(','), freq: '0', passno: '0', _lead: [], mounted: false,
            });
            // Clear the volatile fields; keep credMode + creds list.
            a.host = ''; a.share = ''; a.mountpoint = '';
            a.username = ''; a.password = ''; a.domain = '';
            if (a.credMode === 'new') a.credName = '';
            this.mounts.rawMode = false;
            this.mounts.view = 'fstab';
            // Persist straight away: writes /etc/fstab (with backup) and
            // mounts the new entry. Result/errors surface in the fstab view.
            await this.saveFstab();
        } catch (e) {
            a.error = e.message || String(e);
        } finally {
            a.busy = false;
        }
    },

    async loadLiveMounts() {
        this.mounts.live.loading = true;
        this.mounts.live.error = '';
        const unhex = s => (s || '').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        const unoct = s => (s || '').replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
        try {
            const rows = [];
            if (this.mounts.findmnt) {
                // -r raw output hex-escapes unsafe chars, so fields are
                // space-separated and the first three never contain spaces.
                const out = await cockpit.spawn(['findmnt', '-rno', 'TARGET,SOURCE,FSTYPE,OPTIONS'], { err: 'message' });
                out.split('\n').forEach(line => {
                    if (!line.trim()) return;
                    const p = line.split(' ');
                    if (p.length < 3) return;
                    rows.push({ target: unhex(p[0]), source: unhex(p[1]), fstype: p[2] || '', options: unhex(p.slice(3).join(' ')) });
                });
            } else {
                const out = await cockpit.spawn(['sh', '-c', 'cat /proc/self/mounts'], { err: 'message' });
                out.split('\n').forEach(line => {
                    if (!line.trim()) return;
                    const f = line.split(' ');
                    if (f.length < 4) return;
                    rows.push({ source: unoct(f[0]), target: unoct(f[1]), fstype: f[2] || '', options: unoct(f[3]) });
                });
            }
            rows.sort((a, b) => (a.target || '').localeCompare(b.target || ''));
            this.mounts.live.rows = rows;
        } catch (e) {
            this.mounts.live.error = e.message || String(e);
            this.mounts.live.rows = [];
        } finally {
            this.mounts.live.loading = false;
        }
    },

    // Pseudo / system mounts that must not be unmounted or remounted from here.
    _isProtectedMount(row) {
        const t = row.target || '';
        const f = (row.fstype || '').toLowerCase();
        const pseudo = ['proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2',
            'securityfs', 'pstore', 'bpf', 'tracefs', 'debugfs', 'mqueue',
            'hugetlbfs', 'configfs', 'fusectl', 'autofs', 'efivarfs',
            'binfmt_misc', 'rpc_pipefs', 'nsfs', 'selinuxfs'];
        if (t === '/') return true;
        if (t === '/proc' || t.startsWith('/proc/')) return true;
        if (t === '/sys' || t.startsWith('/sys/')) return true;
        if (t === '/dev' || t.startsWith('/dev/')) return true;
        if (t === '/run' || t.startsWith('/run/')) return true;
        return pseudo.includes(f);
    },

    async remountTarget(row) {
        if (this._isProtectedMount(row)) return;
        this.mounts.busyTarget = row.target;
        try {
            await cockpit.spawn(['mount', '-o', 'remount', row.target], FS.spawnOpts({ admin: true }));
            this.toast(`Remounted ${row.target}.`, 'success');
        } catch (e) {
            this.toast('Remount failed: ' + (e.message || e), 'danger');
        } finally {
            this.mounts.busyTarget = '';
            await this.loadLiveMounts();
        }
    },

    async unmountTarget(row) {
        if (this._isProtectedMount(row)) return;
        const ok = await this.askConfirm('Unmount', `Unmount ${row.target}?`, 'Unmount');
        if (!ok) return;
        this.mounts.busyTarget = row.target;
        try {
            await cockpit.spawn(['umount', row.target], FS.spawnOpts({ admin: true }));
            this.toast(`Unmounted ${row.target}.`, 'success');
        } catch (e) {
            const msg = e.message || String(e);
            if (/busy|in use|target is busy/i.test(msg)) {
                const lazy = await this.askConfirm('Target busy',
                    `${row.target} is busy. Lazy-unmount (detach now, clean up when free)?`, 'Lazy unmount');
                if (lazy) {
                    try {
                        await cockpit.spawn(['umount', '-l', row.target], FS.spawnOpts({ admin: true }));
                        this.toast(`Lazy-unmounted ${row.target}.`, 'success');
                    } catch (e2) {
                        this.toast('Unmount failed: ' + (e2.message || e2), 'danger');
                    }
                }
            } else {
                this.toast('Unmount failed: ' + msg, 'danger');
            }
        } finally {
            this.mounts.busyTarget = '';
            await this.loadLiveMounts();
            if (!this.mounts.rawMode) await this._refreshMountedState();
        }
    },

    async mountAdhoc() {
        const dev = (this.mounts.adhoc.device || '').trim();
        const mp = (this.mounts.adhoc.mountpoint || '').trim();
        const fst = (this.mounts.adhoc.fstype || '').trim();
        const opts = (this.mounts.adhoc.options || '').trim();
        if (!dev || !mp) { this.toast('Device and mount point are required.', 'warning'); return; }
        if (!mp.startsWith('/')) { this.toast('Mount point must be an absolute path.', 'warning'); return; }
        this.mounts.adhoc.busy = true;
        try {
            const args = ['mount'];
            if (fst) args.push('-t', fst);
            if (opts) args.push('-o', opts);
            args.push(dev, mp);
            const cmd = `mkdir -p ${Util.shq(mp)} && ${args.map(a => Util.shq(a)).join(' ')}`;
            await cockpit.spawn(['sh', '-c', cmd], FS.spawnOpts({ admin: true }));
            this.toast(`Mounted ${dev} at ${mp}.`, 'success');
            this.mounts.adhoc.device = ''; this.mounts.adhoc.mountpoint = '';
            this.mounts.adhoc.fstype = ''; this.mounts.adhoc.options = '';
            this.mounts.adhoc.open = false;
            await this.loadLiveMounts();
            if (!this.mounts.rawMode) await this._refreshMountedState();
        } catch (e) {
            this.toast('Mount failed: ' + (e.message || e), 'danger');
        } finally {
            this.mounts.adhoc.busy = false;
        }
    },

    // Mount a declared-but-unmounted fstab entry now (the ○ indicator button).
    async mountFstabRow(r) {
        const file = (r.file || '').trim();
        if (!file) return;
        try {
            await cockpit.spawn(['sh', '-c', `mkdir -p ${Util.shq(file)} && mount ${Util.shq(file)}`], FS.spawnOpts({ admin: true }));
            this.toast(`Mounted ${file}.`, 'success');
        } catch (e) {
            this.toast('Mount failed: ' + (e.message || e), 'danger');
        }
        await this._refreshMountedState();
        if (this.mounts.view === 'live') await this.loadLiveMounts();
    },

    // Scan the live system to populate the field datalists. Each scan is
    // best-effort and degrades to an empty/curated list if its tool is absent.
    async _loadMountSuggestions() {
        try {
            const [dev, mps, fst] = await Promise.all([
                this._scanBlockDevices(), this._scanMountpoints(), this._scanFstypes(),
            ]);
            this.mounts.suggest.devices = dev.devices;
            this.mounts.suggest.bySpec = dev.bySpec;
            this.mounts.suggest.mountpoints = mps;
            this.mounts.suggest.fstypes = fst;
        } catch (e) { /* suggestions are optional */ }
    },

    async _scanBlockDevices() {
        const devices = [], bySpec = {}, seen = new Set();
        const add = (value, label, fstype) => {
            if (!value || seen.has(value)) return;
            seen.add(value);
            devices.push({ value, label });
            bySpec[value] = { fstype: fstype || '' };
        };
        let out = '';
        try {
            out = await cockpit.spawn(
                ['lsblk', '-P', '-o', 'NAME,UUID,LABEL,FSTYPE,SIZE,TYPE,MOUNTPOINT'],
                { err: 'message' });
        } catch (e) {
            // Fallback: blkid -o export (key=value blocks separated by blank lines)
            try {
                const b = await cockpit.spawn(['sh', '-c', 'blkid -o export 2>/dev/null'], { err: 'message' });
                for (const blk of b.split(/\n\s*\n/)) {
                    const m = {};
                    blk.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1); });
                    if (!m.UUID && !m.LABEL) continue;
                    const dev = m.DEVNAME || '', fst = m.TYPE || '';
                    if (m.UUID) add(`UUID=${m.UUID}`, `${dev}${fst ? ' · ' + fst : ''}${m.LABEL ? ' · "' + m.LABEL + '"' : ''}`, fst);
                    if (m.LABEL) add(`LABEL=${m.LABEL}`, `${dev}${fst ? ' · ' + fst : ''}`, fst);
                    if (dev && fst) add(dev, `${fst}`, fst);
                }
            } catch (e2) { /* no enumeration available */ }
            return { devices, bySpec };
        }
        const re = /(\w+)="([^"]*)"/g;
        out.split('\n').forEach(line => {
            if (!line.trim()) return;
            const m = {}; let mm; re.lastIndex = 0;
            while ((mm = re.exec(line)) !== null) m[mm[1]] = mm[2];
            const name = m.NAME || '';
            if (!name) return;
            const type = m.TYPE || '';
            if (type === 'loop' || type === 'rom') return;
            const dev = name.startsWith('/dev/') ? name : '/dev/' + name;
            const fst = m.FSTYPE || '';
            const tail = `${fst ? ' · ' + fst : ''}${m.SIZE ? ' · ' + m.SIZE : ''}${m.MOUNTPOINT ? ' · @' + m.MOUNTPOINT : ''}`;
            if (m.UUID) add(`UUID=${m.UUID}`, `${dev}${tail}${m.LABEL ? ' · "' + m.LABEL + '"' : ''}`, fst);
            if (m.LABEL) add(`LABEL=${m.LABEL}`, `${dev}${fst ? ' · ' + fst : ''}`, fst);
            if (fst) add(dev, `${fst}${m.SIZE ? ' · ' + m.SIZE : ''}`, fst);
        });
        return { devices, bySpec };
    },

    async _scanMountpoints() {
        const set = new Set(['/mnt', '/media', '/srv', '/data', '/boot', '/boot/efi', '/opt', '/home']);
        try {
            const out = await cockpit.spawn(
                ['sh', '-c', 'find /mnt /media -mindepth 1 -maxdepth 1 -type d 2>/dev/null'],
                { err: 'message' });
            out.split('\n').map(s => s.trim()).filter(Boolean).forEach(p => set.add(p));
        } catch (e) { /* none */ }
        return Array.from(set).sort();
    },

    async _scanFstypes() {
        const curated = ['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'vfat', 'exfat',
            'ntfs', 'ntfs-3g', 'f2fs', 'swap', 'tmpfs', 'nfs', 'nfs4', 'cifs',
            'iso9660', 'udf', 'auto', 'bind', 'overlay', 'zfs'];
        const set = new Set(curated);
        try {
            const txt = await FS.readText('/proc/filesystems');
            (txt || '').split('\n').forEach(l => { const t = l.trim().split(/\s+/).pop(); if (t) set.add(t); });
        } catch (e) { /* curated only */ }
        const extras = Array.from(set).filter(t => !curated.includes(t)).sort();
        return curated.concat(extras);
    },

    // When a device is chosen from the suggestion list, fill in its filesystem
    // type if the Type column is still empty.
    onSpecChanged(r) {
        const info = this.mounts.suggest.bySpec[(r.spec || '').trim()];
        if (info && info.fstype && !(r.vfstype || '').trim()) r.vfstype = info.fstype;
    },

    async loadFstab() {
        this.mounts.loading = true;
        this.mounts.error = '';
        this.mounts.mountResults = [];
        try {
            let text = '';
            try { text = await FS.readText('/etc/fstab', { adminTry: true }); } catch (e) { text = ''; }
            this.mounts.raw = text;
            const parsed = this._parseFstab(text);
            this.mounts.rows = parsed.rows;
            this.mounts.trailer = parsed.trailer;
            this.mounts.rawEdited = this._serializeFstab();
            await this._refreshMountedState();
        } catch (e) {
            this.mounts.error = e.message || String(e);
        } finally {
            this.mounts.loading = false;
        }
    },

    addFstabRow() {
        this.mounts.rows.push({ spec: '', file: '', vfstype: '', mntops: 'defaults', freq: '0', passno: '0', _lead: [], mounted: null });
    },

    removeFstabRow(i) { this.mounts.rows.splice(i, 1); },

    toggleFstabRaw() {
        if (!this.mounts.rawMode) {
            this.mounts.rawEdited = this._serializeFstab();
            this.mounts.rawMode = true;
        } else {
            const parsed = this._parseFstab(this.mounts.rawEdited);
            this.mounts.rows = parsed.rows;
            this.mounts.trailer = parsed.trailer;
            this.mounts.rawMode = false;
            this._refreshMountedState();
        }
    },

    async saveFstab() {
        // Resolve the rows to validate/serialize from the active view.
        let rows;
        if (this.mounts.rawMode) {
            const parsed = this._parseFstab(this.mounts.rawEdited);
            rows = parsed.rows;
        } else {
            rows = this.mounts.rows;
        }
        const errs = this._validateFstabRows(rows);
        if (errs.length) {
            this.mounts.error = errs.join('   •   ');
            this.toast('Fix the highlighted issues before saving.', 'warning');
            return;
        }
        this.mounts.error = '';

        let text;
        if (this.mounts.rawMode) {
            text = this.mounts.rawEdited;
            if (!text.endsWith('\n')) text += '\n';
        } else {
            text = this._serializeFstab();
        }

        this.mounts.saving = true;
        this.mounts.mountResults = [];
        const op = this._beginOp('Save /etc/fstab');
        op.indeterminate = true;
        try {
            op.statusText = 'Backing up to /etc/fstab.bak';
            await cockpit.spawn(['sh', '-c', 'cp -a /etc/fstab /etc/fstab.bak 2>/dev/null || true'], FS.spawnOpts({ admin: true }));

            op.statusText = 'Writing /etc/fstab';
            await FS.writeText('/etc/fstab', text, { admin: true });

            if (this.mounts.mountAfter) {
                op.statusText = 'Reloading systemd';
                try { await cockpit.spawn(['systemctl', 'daemon-reload'], FS.spawnOpts({ admin: true })); } catch (e) { /* non-systemd or transient */ }

                const mounted = await this._listMounted();
                const results = [];
                for (const r of rows) {
                    const file = (r.file || '').trim();
                    const vt = (r.vfstype || '').trim();
                    if (!file || file === 'none' || vt === 'swap') continue;
                    if (mounted.includes(file)) continue; // already mounted
                    op.statusText = 'Mounting ' + file;
                    try {
                        await cockpit.spawn(['sh', '-c', `mkdir -p ${Util.shq(file)} && mount ${Util.shq(file)}`], FS.spawnOpts({ admin: true }));
                        results.push({ file, ok: true });
                    } catch (e) {
                        results.push({ file, ok: false, err: (e.message || String(e)).trim() });
                    }
                }
                this.mounts.mountResults = results;
                const failed = results.filter(r => !r.ok);
                if (failed.length) this.toast(`Saved. ${failed.length} mount(s) failed — see results.`, 'warning');
                else if (results.length) this.toast(`Saved and mounted ${results.length} entr${results.length === 1 ? 'y' : 'ies'}.`, 'success');
                else this.toast('Saved. No new mounts needed.', 'success');
            } else {
                this.toast('Saved /etc/fstab.', 'success');
            }
            this._endOp(op, 'done');
            await this.loadFstab();
        } catch (e) {
            this._failOp(op, e);
            this.mounts.error = e.message || String(e);
            this.toast('Failed to save /etc/fstab: ' + (e.message || e), 'danger');
        } finally {
            this.mounts.saving = false;
        }
    },
};
