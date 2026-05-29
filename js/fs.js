// fs.js — filesystem operations layered on cockpit.spawn / cockpit.file
// All functions return Promises and accept an optional opts.admin flag.
'use strict';

window.FS = (function () {
    const SP = Util.shq;

    function spawnOpts(opts) {
        const o = { err: 'message' };
        if (opts && opts.admin) o.superuser = 'require';
        else if (opts && opts.adminTry) o.superuser = 'try';
        if (opts && opts.binary) o.binary = 'raw';
        if (opts && opts.directory) o.directory = opts.directory;
        return o;
    }

    /**
     * List a directory. Returns array of file objects:
     * { name, path, type ('f','d','l','s','p','b','c','?'),
     *   perms, owner, group, size, mtime, symlinkTarget }
     *
     * Uses `find -maxdepth 1` with -printf and NUL record separators so
     * funky filenames (with newlines/tabs) survive parsing.
     */
    async function listDir(path, opts) {
        opts = opts || {};
        // Field sep: octal \037 = 0x1F (unit separator).
        // Record sep: octal \036 = 0x1E (record separator).
        // GNU find -printf supports \NNN officially; \xHH is not in the
        // documented escape grammar so we avoid it.
        const FSEP = '\\037';
        const RSEP = '\\036';
        const fmt = `%y${FSEP}%M${FSEP}%u${FSEP}%g${FSEP}%s${FSEP}%T@${FSEP}%l${FSEP}%P${RSEP}`;
        const cmd = ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', fmt];
        try {
            const data = await cockpit.spawn(cmd, spawnOpts(opts));
            const out = [];
            const records = data.split('\x1e');
            for (const rec of records) {
                if (!rec) continue;
                const parts = rec.split('\x1f');
                if (parts.length < 8) continue;
                const [type, perms, owner, group, size, mtime, symlink, name] = parts;
                if (!name) continue;
                out.push({
                    name: name,
                    path: Util.joinPath(path, name),
                    type: type || '?',
                    perms: perms || '',
                    owner: owner || '',
                    group: group || '',
                    size: parseInt(size, 10) || 0,
                    mtime: parseFloat(mtime) || 0,
                    symlinkTarget: symlink || null,
                });
            }
            return out;
        } catch (e) {
            const err = new Error(e.message || String(e));
            err.problem = e.problem;
            err.exit_status = e.exit_status;
            err.permissionDenied = /permission denied|EACCES/i.test(e.message || '');
            throw err;
        }
    }

    // Stat a single entry; returns same shape as listDir entry, or null.
    async function statOne(path, opts) {
        try {
            const parent = Util.dirname(path);
            const name = Util.basename(path);
            const FSEP = '\\037';
            const fmt = `%y${FSEP}%M${FSEP}%u${FSEP}%g${FSEP}%s${FSEP}%T@${FSEP}%l${FSEP}%f`;
            const out = await cockpit.spawn(
                ['find', path, '-maxdepth', '0', '-printf', fmt],
                spawnOpts(opts)
            );
            const parts = out.split('\x1f');
            if (parts.length < 8) return null;
            return {
                name: parts[7] || name,
                path,
                type: parts[0] || '?',
                perms: parts[1] || '',
                owner: parts[2] || '',
                group: parts[3] || '',
                size: parseInt(parts[4], 10) || 0,
                mtime: parseFloat(parts[5]) || 0,
                symlinkTarget: parts[6] || null,
            };
        } catch (e) {
            return null;
        }
    }

    async function homeDir() {
        try {
            const out = await cockpit.spawn(['sh', '-c', 'echo "$HOME"']);
            return out.trim() || '/root';
        } catch (e) { return '/root'; }
    }

    async function readlinkResolved(path) {
        // Resolve symlink to absolute final target
        try {
            const out = await cockpit.spawn(['readlink', '-f', path]);
            return out.trim();
        } catch (e) { return null; }
    }

    function readText(path, opts) {
        opts = opts || {};
        const fopts = { syntax: undefined };
        if (opts.admin) fopts.superuser = 'require';
        else if (opts.adminTry) fopts.superuser = 'try';
        return cockpit.file(path, fopts).read();
    }

    function writeText(path, content, opts) {
        opts = opts || {};
        const fopts = {};
        if (opts.admin) fopts.superuser = 'require';
        else if (opts.adminTry) fopts.superuser = 'try';
        return cockpit.file(path, fopts).replace(content);
    }

    // Read a file as a Blob (binary). Uses base64 via cat | base64 since
    // cockpit.file()'s binary support is limited in older versions.
    async function readBinaryAsBlob(path, opts) {
        try {
            const b64 = await cockpit.spawn(['base64', '-w', '0', path], spawnOpts(opts));
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new Blob([arr]);
        } catch (e) {
            const err = new Error(e.message || String(e));
            err.permissionDenied = /permission denied|EACCES/i.test(e.message || '');
            throw err;
        }
    }

    async function mkdir(path, opts) {
        return cockpit.spawn(['mkdir', '-p', path], spawnOpts(opts));
    }
    async function touch(path, opts) {
        return cockpit.spawn(['touch', path], spawnOpts(opts));
    }
    async function rename(from, to, opts) {
        return cockpit.spawn(['mv', '-T', '--', from, to], spawnOpts(opts));
    }
    async function move(srcs, destDir, opts) {
        return cockpit.spawn(['mv', '--', ...srcs, destDir], spawnOpts(opts));
    }
    async function copy(srcs, destDir, opts) {
        return cockpit.spawn(['cp', '-a', '--', ...srcs, destDir], spawnOpts(opts));
    }
    // Copy a single source to an explicit target path (rename-on-copy).
    // -T treats the target as a normal name, not a directory to copy into.
    async function copyTo(src, target, opts) {
        return cockpit.spawn(['cp', '-a', '-T', '--', src, target], spawnOpts(opts));
    }
    async function remove(paths, opts) {
        return cockpit.spawn(['rm', '-rf', '--', ...paths], spawnOpts(opts));
    }
    async function chmod(path, octal, opts) {
        return cockpit.spawn(['chmod', octal, path], spawnOpts(opts));
    }
    async function chown(path, ownerGroup, opts) {
        return cockpit.spawn(['chown', ownerGroup, path], spawnOpts(opts));
    }

    /**
     * Compress paths into an archive. `format`: zip | tar | tar.gz | tar.bz2 | tar.xz
     * paths must share a parent directory (we cd to it and reference basenames).
     */
    async function compress(paths, archivePath, format, opts) {
        opts = opts || {};
        if (!paths.length) throw new Error('No paths to compress');
        const parent = Util.dirname(paths[0]);
        const names = paths.map(p => Util.basename(p));
        let cmd;
        if (format === 'zip') {
            cmd = ['zip', '-r', '--', archivePath, ...names];
        } else {
            const tarFlag = {
                'tar':     '-cf',
                'tar.gz':  '-czf',
                'tar.bz2': '-cjf',
                'tar.xz':  '-cJf'
            }[format];
            if (!tarFlag) throw new Error('Unsupported format: ' + format);
            cmd = ['tar', tarFlag, archivePath, '--', ...names];
        }
        const spawn = spawnOpts(opts);
        spawn.directory = parent;
        return cockpit.spawn(cmd, spawn);
    }

    async function extract(archivePath, destDir, opts) {
        opts = opts || {};
        await mkdir(destDir, opts);
        const fmt = Util.archiveFormat(archivePath);
        let cmd;
        switch (fmt) {
            case 'zip':
                cmd = ['unzip', '-o', archivePath, '-d', destDir]; break;
            case 'tar':
                cmd = ['tar', '-xf', archivePath, '-C', destDir]; break;
            case 'tar.gz':
                cmd = ['tar', '-xzf', archivePath, '-C', destDir]; break;
            case 'tar.bz2':
                cmd = ['tar', '-xjf', archivePath, '-C', destDir]; break;
            case 'tar.xz':
                cmd = ['tar', '-xJf', archivePath, '-C', destDir]; break;
            case 'gz':
                cmd = ['sh', '-c', `gunzip -kc ${SP(archivePath)} > ${SP(Util.joinPath(destDir, Util.basename(archivePath).replace(/\.gz$/i, '')))}`]; break;
            case 'bz2':
                cmd = ['sh', '-c', `bunzip2 -kc ${SP(archivePath)} > ${SP(Util.joinPath(destDir, Util.basename(archivePath).replace(/\.bz2$/i, '')))}`]; break;
            case 'xz':
                cmd = ['sh', '-c', `unxz -kc ${SP(archivePath)} > ${SP(Util.joinPath(destDir, Util.basename(archivePath).replace(/\.xz$/i, '')))}`]; break;
            default:
                throw new Error('Unsupported archive: ' + fmt);
        }
        return cockpit.spawn(cmd, spawnOpts(opts));
    }

    // Search ------------------------------------------------------------------
    //
    // Filename match (recursive or not) via `find ... -iname` / `-name`.
    // Returns same shape as listDir entries.
    // List every entry under `root` (optionally recursive) with full
    // metadata, for client-side filtering (regex or substring). Used by
    // filename search so the matching semantics are exactly JS RegExp's.
    async function listForSearch(root, recursive, opts) {
        const FSEP = '\\037';
        const fmt = `%y${FSEP}%M${FSEP}%u${FSEP}%g${FSEP}%s${FSEP}%T@${FSEP}%l${FSEP}%p${FSEP}%f\\036`;
        const cmd = ['find', root,
                     ...(recursive ? [] : ['-maxdepth', '1']),
                     '-mindepth', '1',
                     '-printf', fmt];
        const data = await cockpit.spawn(cmd, spawnOpts(opts));
        const out = [];
        for (const rec of data.split('\x1e')) {
            if (!rec) continue;
            const parts = rec.split('\x1f');
            if (parts.length < 9) continue;
            out.push({
                name: parts[8],
                path: parts[7],
                type: parts[0] || '?',
                perms: parts[1] || '',
                owner: parts[2] || '',
                group: parts[3] || '',
                size: parseInt(parts[4], 10) || 0,
                mtime: parseFloat(parts[5]) || 0,
                symlinkTarget: parts[6] || null,
            });
        }
        return out;
    }

    async function searchFilename(root, query, recursive, caseInsensitive, opts) {
        const FSEP = '\\037';
        const fmt = `%y${FSEP}%M${FSEP}%u${FSEP}%g${FSEP}%s${FSEP}%T@${FSEP}%l${FSEP}%p${FSEP}%f\\036`;
        const flag = caseInsensitive ? '-iname' : '-name';
        const pattern = '*' + query.replace(/([*?\[\]])/g, '\\$1') + '*';
        const cmd = ['find', root,
                     ...(recursive ? [] : ['-maxdepth', '1']),
                     '-mindepth', '1',
                     flag, pattern,
                     '-printf', fmt];
        const data = await cockpit.spawn(cmd, spawnOpts(opts));
        const out = [];
        for (const rec of data.split('\x1e')) {
            if (!rec) continue;
            const parts = rec.split('\x1f');
            if (parts.length < 9) continue;
            out.push({
                name: parts[8],
                path: parts[7],
                type: parts[0] || '?',
                perms: parts[1] || '',
                owner: parts[2] || '',
                group: parts[3] || '',
                size: parseInt(parts[4], 10) || 0,
                mtime: parseFloat(parts[5]) || 0,
                symlinkTarget: parts[6] || null,
            });
        }
        return out;
    }

    /**
     * Content search. Enumerates candidate files with `find` at the requested
     * depth (so non-recursive works — plain `grep DIR` without -r errors with
     * "Is a directory"), then greps them in batches. `regex` selects -E vs -F,
     * `caseInsensitive` adds -i (matching JS RegExp 'i' semantics).
     */
    async function searchContent(root, query, recursive, caseInsensitive, regex, opts) {
        // 1. Enumerate candidate files at the requested depth.
        const findCmd = ['find', root,
                         ...(recursive ? [] : ['-maxdepth', '1']),
                         '-mindepth', '1', '-type', 'f', '-print0'];
        let fileData;
        try {
            fileData = await cockpit.spawn(findCmd, spawnOpts(opts));
        } catch (e) {
            if (e.exit_status === 1) return [];
            throw e;
        }
        const files = fileData.split('\0').filter(Boolean);
        if (files.length === 0) return [];

        // 2. grep the candidate files. Batch to stay well under ARG_MAX.
        const flags = ['-l', '-Z'];
        if (caseInsensitive) flags.push('-i');
        flags.push(regex ? '-E' : '-F'); // extended regex vs literal string

        const matched = [];
        const BATCH = 500;
        for (let i = 0; i < files.length; i += BATCH) {
            const batch = files.slice(i, i + BATCH);
            const args = ['grep', ...flags, '--', query, ...batch];
            try {
                const data = await cockpit.spawn(args, spawnOpts(opts));
                for (const p of data.split('\0').filter(Boolean)) matched.push(p);
            } catch (e) {
                if (e.exit_status === 1) continue; // no matches in this batch
                throw e;
            }
        }

        const out = [];
        for (const p of matched) {
            const s = await statOne(p, opts);
            if (s) out.push(s);
        }
        return out;
    }

    return {
        listDir, statOne, homeDir, readlinkResolved,
        readText, writeText, readBinaryAsBlob,
        mkdir, touch, rename, move, copy, copyTo, remove,
        chmod, chown,
        compress, extract,
        searchFilename, searchContent, listForSearch,
        spawnOpts,
        hasRsync, duSum, dfAvail, sameFilesystem,
    };

    // ─── Capability + pre-flight helpers ────────────────────────────────────
    async function hasRsync() {
        try { await cockpit.spawn(['rsync', '--version'], { err: 'ignore' }); return true; }
        catch (e) { return false; }
    }
    async function duSum(path, opts) {
        try {
            const out = await cockpit.spawn(['du', '-sb', '--', path], spawnOpts(opts));
            const m = out.match(/^(\d+)/);
            return m ? parseInt(m[1], 10) : 0;
        } catch (e) { return 0; }
    }
    async function dfAvail(path, opts) {
        try {
            const out = await cockpit.spawn(['df', '-B1', '--output=avail', '--', path], spawnOpts(opts));
            const lines = out.trim().split('\n');
            return parseInt(lines[lines.length - 1].trim(), 10) || 0;
        } catch (e) { return 0; }
    }
    async function sameFilesystem(p1, p2, opts) {
        try {
            const a = (await cockpit.spawn(['stat', '-c', '%d', p1], spawnOpts(opts))).trim();
            const b = (await cockpit.spawn(['stat', '-c', '%d', p2], spawnOpts(opts))).trim();
            return !!a && a === b;
        } catch (e) { return false; }
    }
})();
