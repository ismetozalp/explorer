// utils.js — formatting & helpers (no Cockpit / DOM dependencies)
'use strict';

window.Util = (function () {

    function humanSize(bytes) {
        if (bytes == null || isNaN(bytes)) return '';
        if (bytes < 1024) return bytes + ' B';
        const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
        let v = bytes / 1024;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 10 ? 0 : 1) + ' ' + units[i];
    }

    function formatDate(epochSec) {
        if (!epochSec) return '';
        const d = new Date(epochSec * 1000);
        if (isNaN(d.getTime())) return '';
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const HH = String(d.getHours()).padStart(2, '0');
        const MM = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
    }

    function joinPath(base, name) {
        if (!base || base === '/') return '/' + name;
        if (base.endsWith('/')) return base + name;
        return base + '/' + name;
    }

    function dirname(p) {
        if (!p || p === '/') return '/';
        const trimmed = p.replace(/\/+$/, '');
        const idx = trimmed.lastIndexOf('/');
        if (idx <= 0) return '/';
        return trimmed.slice(0, idx);
    }

    function basename(p) {
        if (!p || p === '/') return '/';
        const trimmed = p.replace(/\/+$/, '');
        const idx = trimmed.lastIndexOf('/');
        return idx < 0 ? trimmed : trimmed.slice(idx + 1);
    }

    function normalizePath(p) {
        if (!p) return '/';
        if (!p.startsWith('/')) return p; // relative — caller must resolve
        const parts = p.split('/').filter(Boolean);
        const stack = [];
        for (const part of parts) {
            if (part === '.') continue;
            if (part === '..') { stack.pop(); continue; }
            stack.push(part);
        }
        return '/' + stack.join('/');
    }

    // Pathologically careful POSIX shell quoting (single-quote-wrap).
    function shq(s) {
        if (s == null) return "''";
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    // Returns segments for breadcrumbs: [{label, path}].
    // Does NOT include the root '/' (the breadcrumb template renders that
    // separately so we don't end up with '/ / home / ismet').
    function pathSegments(p) {
        if (!p || p === '/') return [];
        const parts = p.split('/').filter(Boolean);
        const segs = [];
        let cur = '';
        for (const part of parts) {
            cur += '/' + part;
            segs.push({ label: part, path: cur });
        }
        return segs;
    }

    // Map extension/MIME to a Prism language tag
    function langFromExt(name) {
        const lower = (name || '').toLowerCase();
        const ext = lower.includes('.') ? lower.split('.').pop() : '';
        const base = lower.split('/').pop();
        const map = {
            'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
            'ts': 'typescript', 'tsx': 'typescript', 'jsx': 'javascript',
            'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust',
            'java': 'java', 'kt': 'kotlin', 'swift': 'swift',
            'c': 'c', 'h': 'c', 'cpp': 'cpp', 'cc': 'cpp', 'hpp': 'cpp', 'cxx': 'cpp',
            'cs': 'csharp', 'php': 'php', 'pl': 'perl', 'lua': 'lua',
            'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
            'html': 'markup', 'htm': 'markup', 'xml': 'markup', 'svg': 'markup',
            'css': 'css', 'scss': 'scss', 'sass': 'scss',
            'json': 'json', 'yml': 'yaml', 'yaml': 'yaml', 'toml': 'toml',
            'md': 'markdown', 'markdown': 'markdown',
            'sql': 'sql', 'ini': 'ini', 'conf': 'ini', 'cfg': 'ini',
            'log': 'log', 'diff': 'diff', 'patch': 'diff',
            'dockerfile': 'docker',
            'makefile': 'makefile', 'mk': 'makefile',
            'nginx': 'nginx', 'proto': 'protobuf',
            'ps1': 'powershell',
        };
        if (map[ext]) return map[ext];
        if (base === 'dockerfile') return 'docker';
        if (base === 'makefile') return 'makefile';
        if (/^\.?nginx/.test(base)) return 'nginx';
        return 'plain';
    }

    // Extensions that are binary / not editable as text. Images, media,
    // PDFs and archives are detected separately (isImage/isVideo/…); this
    // list is the remaining binary blobs we never want to treat as text.
    const BINARY_EXTS = new Set([
        'exe','dll','so','o','a','lib','bin','dat','class','jar','war','ear',
        'pyc','pyo','pyd','wasm','obj','dylib','ko','elf','out',
        'db','sqlite','sqlite3','mdb','accdb','dbf','frm','myd','myi',
        'woff','woff2','ttf','otf','eot',
        'iso','img','dmg','vmdk','vdi','qcow2',
        'deb','rpm','pkg','msi','apk','appimage','snap','flatpak',
        'doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp',
        'psd','ai','sketch','fig','blend','dwg','xcf',
    ]);

    function isBinaryExt(file) {
        const n = ((file && file.name) || '').toLowerCase();
        const ext = n.includes('.') ? n.split('.').pop() : '';
        return BINARY_EXTS.has(ext);
    }

    // Heuristic: is this file editable/previewable AS TEXT? Permissive —
    // anything that isn't a recognised binary/media/archive type qualifies,
    // so dotfiles (.bashrc), extensionless files (Makefile) and unknown
    // configs all get Edit/Preview. A content sniff (looksBinary) is used at
    // open time to catch true binaries that slip through by name alone.
    function isTextLike(file) {
        if (!file || file.type !== 'f') return false;
        if (isImage(file) || isPdf(file) || isVideo(file) || isAudio(file) || isArchive(file)) return false;
        if (isBinaryExt(file)) return false;
        return true;
    }

    // Content-based binary detection (run on the bytes we actually read).
    // cockpit.file().read() decodes as UTF-8, so binary data shows up as NUL
    // bytes, U+FFFD replacement chars, and C0 control characters.
    function looksBinary(str) {
        if (!str) return false;
        const sample = str.length > 8192 ? str.slice(0, 8192) : str;
        let bad = 0;
        for (let i = 0; i < sample.length; i++) {
            const c = sample.charCodeAt(i);
            if (c === 0) return true;                          // NUL → definitely binary
            if (c === 0xFFFD) bad++;                           // UTF-8 replacement
            else if (c < 9 || (c > 13 && c < 32)) bad++;       // C0 controls except \t \n \r
        }
        return sample.length > 0 && (bad / sample.length) > 0.15;
    }

    function isImage(file) {
        const ext = (file.name || '').toLowerCase().split('.').pop();
        return ['png','jpg','jpeg','gif','webp','bmp','ico','avif','svg'].includes(ext);
    }

    function isPdf(file) { return (file.name || '').toLowerCase().endsWith('.pdf'); }
    function isVideo(file) {
        const ext = (file.name || '').toLowerCase().split('.').pop();
        return ['mp4','webm','ogv','mkv','mov'].includes(ext);
    }
    function isAudio(file) {
        const ext = (file.name || '').toLowerCase().split('.').pop();
        return ['mp3','wav','ogg','flac','m4a','aac','opus'].includes(ext);
    }

    function archiveFormat(name) {
        const n = (name || '').toLowerCase();
        if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
        if (n.endsWith('.tar.bz2') || n.endsWith('.tbz2') || n.endsWith('.tbz')) return 'tar.bz2';
        if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'tar.xz';
        if (n.endsWith('.tar.zst') || n.endsWith('.tzst')) return 'tar.zst';
        if (n.endsWith('.tar')) return 'tar';
        if (n.endsWith('.zip')) return 'zip';
        if (n.endsWith('.gz')) return 'gz';
        if (n.endsWith('.bz2')) return 'bz2';
        if (n.endsWith('.xz')) return 'xz';
        if (n.endsWith('.7z')) return '7z';
        if (n.endsWith('.rar')) return 'rar';
        return null;
    }

    function isArchive(file) { return file && file.type === 'f' && archiveFormat(file.name) !== null; }

    function fileIcon(file) {
        if (!file) return '';
        if (file.type === 'd') return '📁';
        if (file.symlinkTarget) return '🔗';
        if (file.type === 'l') return '🔗';
        if (isImage(file)) return '🖼';
        if (isPdf(file)) return '📕';
        if (isVideo(file)) return '🎞';
        if (isAudio(file)) return '🎵';
        if (isArchive(file)) return '🗜';
        if (isTextLike(file)) return '📄';
        if (file.perms && file.perms.includes('x')) return '⚙';
        return '📄';
    }

    function typeLabel(file) {
        if (!file) return '';
        if (file.type === 'd') return 'Directory';
        if (file.symlinkTarget || file.type === 'l') return 'Symlink';
        if (isArchive(file)) return 'Archive (' + archiveFormat(file.name) + ')';
        if (isImage(file)) return 'Image';
        if (isPdf(file)) return 'PDF';
        if (isVideo(file)) return 'Video';
        if (isAudio(file)) return 'Audio';
        if (isTextLike(file)) return 'Text';
        return 'File';
    }

    // UUID-ish unique id
    function uid() {
        return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    // Substitute placeholders for custom action commands.
    function fillTemplate(tmpl, ctx) {
        // ctx: { path, paths (array), dir, name, base, ext }
        return tmpl.replace(/\{(\w+)\}/g, (m, key) => {
            if (key === 'paths') return ctx.paths.map(shq).join(' ');
            const v = ctx[key];
            if (v == null) return m;
            return shq(v);
        });
    }

    // Like fillTemplate but for human-readable text (no shell quoting). Used
    // for custom-action confirmation messages.
    function fillText(tmpl, ctx) {
        return (tmpl || '').replace(/\{(\w+)\}/g, (m, key) => {
            if (key === 'paths') return (ctx.paths || []).join(' ');
            const v = ctx[key];
            return v == null ? m : String(v);
        });
    }

    return {
        humanSize, formatDate, joinPath, dirname, basename, normalizePath, shq, pathSegments,
        langFromExt, isTextLike, looksBinary, isImage, isPdf, isVideo, isAudio, isArchive, archiveFormat,
        fileIcon, typeLabel, uid, fillTemplate, fillText
    };
})();
