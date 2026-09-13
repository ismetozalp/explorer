// AI session registry parsing + enumeration for the Resume browser.
// Reads the CLIs' OWN stores (fast, authoritative) rather than scanning $HOME:
//   Claude: <claudeDir>/<encoded-cwd>/<uuid>.jsonl  (records at top level: cwd,
//           sessionId, message.{role,content})
//   Codex : <codexDir>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (records are
//           {timestamp,type,payload}; cwd at payload.cwd on session_meta/
//           turn_context; first user text in a response_item payload.role==user
//           whose payload.content is [{type:'input_text'|'text', text}])
// Pure helpers are unit-tested; the two spawns (list, then bounded head reads)
// are the only I/O. Bounded: at most SCAN_CAP files get their heads read.
window.ExplorerAgentSessions = {

    // ── pure helpers ──

    _aiExpandHome(p, home) {
        if (typeof p !== 'string' || !p) return p;
        if (p === '~') return home || p;
        if (p.startsWith('~/')) return (home || '') + p.slice(1);
        return p;
    },

    // Only COMPLETE lines: if the head doesn't end in a newline its last element
    // is a byte-truncated partial — drop it so we never parse invalid JSON.
    _aiCompleteLines(headText) {
        const text = String(headText || '');
        const lines = text.split('\n');
        if (text && text[text.length - 1] !== '\n') lines.pop();
        return lines.filter(l => l.trim());
    },

    _aiUserTextFromEntry(o) {
        // Claude: {type:'user'|…, message:{role:'user', content: string|[{text}]}}
        let content = null;
        if (o.message && (o.message.role === 'user' || o.type === 'user')) content = o.message.content;
        // Codex: {type:'response_item', payload:{role:'user', content:[{type,text}]}}
        else if (o.type === 'response_item' && o.payload && o.payload.role === 'user') content = o.payload.content;
        else if (o.type === 'event_msg' && o.payload && typeof o.payload.message === 'string') content = o.payload.message;
        if (content == null) return '';
        if (Array.isArray(content)) content = content.map(c => (c && (c.text || c.input_text)) || '').join(' ');
        if (typeof content !== 'string') return '';
        const t = content.trim();
        // Skip meta/command wrappers (<recommended_plugins>, <command-name>, …).
        if (!t || t[0] === '<') return '';
        return t.replace(/\s+/g, ' ').slice(0, 120);
    },

    _aiCwdFromEntry(o) {
        if (typeof o.cwd === 'string' && o.cwd) return o.cwd;
        if (o.payload && typeof o.payload.cwd === 'string' && o.payload.cwd) return o.payload.cwd;
        return '';
    },

    _aiIdFromEntry(o) {
        // Claude: top-level sessionId (equals the filename). Codex: payload.id is
        // the rollout/thread id `codex resume` takes (and it matches the
        // filename) — NOT payload.session_id, which is the PARENT thread id.
        if (typeof o.sessionId === 'string' && o.sessionId) return o.sessionId;
        if (o.payload) {
            if (typeof o.payload.id === 'string' && o.payload.id) return o.payload.id;
            if (typeof o.payload.session_id === 'string' && o.payload.session_id) return o.payload.session_id;
        }
        return '';
    },

    // head → {id, cwd, title}. `id` falls back to fallbackId (filename uuid).
    _aiParseHead(headText, fallbackId) {
        let id = '', cwd = '', title = '';
        for (const line of this._aiCompleteLines(headText)) {
            let o; try { o = JSON.parse(line); } catch (e) { continue; }
            if (!id) id = this._aiIdFromEntry(o);
            if (!cwd) cwd = this._aiCwdFromEntry(o);
            if (!title) title = this._aiUserTextFromEntry(o);
            if (id && cwd && title) break;
        }
        return { id: id || fallbackId, cwd, title };
    },

    _aiParseCodexName(filename) {
        const m = /rollout-[0-9T:-]+-([0-9a-fA-F]{8}-[0-9a-fA-F-]{4,})\.jsonl$/.exec(filename || '');
        return m ? { id: m[1] } : null;
    },

    _aiSortSessions(list) {
        return (list || []).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    },

    // Phase-1 listing "<mtime>\t<path>\n" → [{mtime, path, tool}] (unsorted).
    _aiParseMtimeListing(text, tool) {
        const out = [];
        for (const line of String(text || '').split('\n')) {
            if (!line.trim()) continue;
            const i = line.indexOf('\t');
            if (i < 0) continue;
            out.push({ mtime: Math.floor(parseFloat(line.slice(0, i)) || 0), path: line.slice(i + 1), tool });
        }
        return out;
    },

    // ── I/O ──

    _aiListMtimes(dir, maxDepth, tool, perDir) {
        // Phase 1 is just "<mtime>\t<path>" text (cheap even for thousands of
        // files). It is bounded PER PARENT DIRECTORY, not globally: a single busy
        // project can never crowd others out of the listing, so every project
        // appears. (find | sort -rn gives newest-first; awk keeps the newest
        // `perDir` per directory and counts each directory independently.)
        const cap = Math.max(1, Math.floor(perDir) || 100000);
        const script = 'd="$1"; [ -d "$d" ] || exit 0; ' +
            'find "$d" -maxdepth ' + maxDepth + ' -type f -name "*.jsonl" -printf "%T@\\t%p\\n" 2>/dev/null | sort -rn | ' +
            'awk -F"\\t" \'{ p=$2; sub(/\\/[^/]*$/,"",p); if(++c[p]<=' + cap + ') print }\'';
        return cockpit.spawn(['sh', '-c', script, 'sh', dir], { err: 'message' })
            .then(t => this._aiParseMtimeListing(t, tool)).catch(() => []);
    },

    // Read one file's head as the first 200 COMPLETE lines (line-bounded via
    // `head -n`, so an oversized first record — e.g. Claude's initial prompt —
    // isn't discarded), with a 1 MB ceiling for a pathological single huge line.
    _aiReadHead(path) {
        return cockpit.spawn(['sh', '-c', 'head -n 200 "$1" 2>/dev/null | head -c 1048576', 'sh', path], { err: 'message' })
            .then(head => ({ head })).catch(() => ({ head: '' }));
    },

    _aiBase(path) { return (path.split('/').pop() || '').replace(/\.jsonl$/, ''); },

    _aiDirOf(path) { return path.slice(0, path.lastIndexOf('/')); },

    _aiIsUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || ''); },

    // A working dir under an OS temp root (scratchpads, throwaway sessions) is
    // noise in the Resume browser — exclude it.
    _aiIsTempPath(p) {
        if (typeof p !== 'string' || !p) return false;
        const roots = ['/tmp', '/var/tmp', '/dev/shm', '/private/tmp', '/private/var/tmp'];
        return roots.some(r => p === r || p.startsWith(r + '/'));
    },

    // Fallback for a Claude project directory whose head carries no cwd: its
    // folder NAME is the encoded cwd (leading "/" dropped, "/" and "_" → "-"), so
    // a temp root shows up as a "tmp-" / "var-tmp-" / "dev-shm-" prefix.
    _aiEncodedDirIsTemp(dirName) {
        return /^-?(tmp|var-tmp|dev-shm|private-tmp|private-var-tmp)(-|$)/.test(dirName || '');
    },

    // Clamp a user-supplied max-depth to a sane 1..12 integer (fallback default).
    _aiMaxDepth(v, def) {
        const n = Math.floor(Number(v));
        if (!Number.isFinite(n) || n < 1) return def;
        return Math.min(n, 12);
    },

    // Group a flat file list by parent directory → Map(dir → files[]).
    _aiGroupByDir(list) {
        const m = new Map();
        for (const f of (list || [])) {
            const d = this._aiDirOf(f.path);
            if (!m.has(d)) m.set(d, []);
            m.get(d).push(f);
        }
        return m;
    },

    // Claude keeps ONE encoded directory PER PROJECT (per working dir): every
    // transcript in a directory shares that project's cwd — that is Claude's own
    // grouping. So we read a single head per directory (its newest session) for
    // the folder's cwd + a representative title, and stamp every transcript in
    // the folder with it. This is ~one spawn per project (a dozen), not one per
    // transcript (thousands). The rare cost: two working dirs whose paths differ
    // only by "/" vs "_" encode to the same folder name and share one cwd — the
    // ambiguity is upstream in Claude's own encoding, and `--resume <id>` still
    // restores the correct conversation regardless of the launch directory.
    async _aiReadClaudeRows(list, BATCH) {
        // Only top-level "<uuid>.jsonl" transcripts are resumable sessions. A deep
        // scan (aiClaudeMaxDepth ≥ 4) also reaches Claude's own
        // "<uuid>/subagents/agent-*.jsonl" — those have non-UUID ids `openAgentTab`
        // rejects, and would inflate counts and be deletable; drop them.
        const sessions = (list || []).filter(f => this._aiIsUuid(this._aiBase(f.path)));
        const dirs = [...this._aiGroupByDir(sessions).entries()];
        const rows = [];
        const CWD_TRIES = 5;   // per dir: if the newest head has no cwd, look at a few older ones
        for (let i = 0; i < dirs.length; i += BATCH) {
            const batch = dirs.slice(i, i + BATCH);
            const parsed = await Promise.all(batch.map(async ([, files]) => {
                const sorted = this._aiSortSessions(files);
                const newest = sorted[0];
                // Title/id come from the newest transcript. The project cwd also
                // comes from it — but if the newest is empty/cwd-less, fall back to
                // older transcripts so the whole project isn't mis-filed under
                // "(unknown folder)" and resumed from the wrong directory.
                const first = this._aiParseHead((await this._aiReadHead(newest.path)).head, this._aiBase(newest.path));
                let cwd = first.cwd;
                for (let k = 1; k < sorted.length && !cwd && k < CWD_TRIES; k++) {
                    cwd = this._aiParseHead((await this._aiReadHead(sorted[k].path)).head, '').cwd;
                }
                return { files, newestPath: newest.path, p: { id: first.id, cwd, title: first.title } };
            }));
            for (const e of parsed) {
                // Skip a whole project living under an OS temp root (by its
                // recorded cwd, or — if the head had none — its encoded folder name).
                const dirName = this._aiDirOf(e.newestPath).split('/').pop() || '';
                if (this._aiIsTempPath(e.p.cwd) || (!e.p.cwd && this._aiEncodedDirIsTemp(dirName))) continue;
                for (const f of e.files) {
                    rows.push({
                        tool: 'claude', id: this._aiBase(f.path), cwd: e.p.cwd,
                        title: f.path === e.newestPath ? e.p.title : '',   // the read (newest) session carries the title
                        mtime: f.mtime, path: f.path,
                    });
                }
            }
        }
        return rows;
    },

    // Codex stores transcripts by DATE (YYYY/MM/DD), so a directory tells us
    // nothing about the project — every session's cwd/title/resume-id must come
    // from its OWN head. Registries are modest, so we read the newest HEAD_CAP.
    // Sessions past that cap are NOT emitted: a metadata-less row has no cwd, so
    // every such row would collapse into one synthetic "(unknown folder)" group
    // whose "Delete all" would erase transcripts from unrelated projects. HEAD_CAP
    // is generous (thousands); dropping only the very oldest beyond it is far
    // safer than surfacing an ungroupable, destructively-deletable pile.
    async _aiReadCodexRows(list, BATCH, HEAD_CAP) {
        const head = this._aiSortSessions(list).slice(0, HEAD_CAP);
        const rows = [];
        for (let i = 0; i < head.length; i += BATCH) {
            const batch = head.slice(i, i + BATCH);
            const heads = await Promise.all(batch.map(f => this._aiReadHead(f.path)));
            batch.forEach((f, j) => {
                const fb = (this._aiParseCodexName(f.path.split('/').pop() || '') || {}).id || this._aiBase(f.path);
                const p = this._aiParseHead(heads[j].head, fb);
                if (this._aiIsTempPath(p.cwd)) return;      // drop throwaway temp-dir sessions
                rows.push({ tool: 'codex', id: p.id, cwd: p.cwd, title: p.title, mtime: f.mtime, path: f.path });
            });
        }
        return rows;
    },

    // Public: enumerate every session with metadata. The listing is bounded
    // per-directory so every project appears with an accurate count; head reads
    // stay proportional to the number of PROJECTS (Claude) plus codex sessions —
    // a few dozen spawns, not thousands.
    async scanAiSessions(settings, home) {
        const BATCH = 16, CODEX_HEAD_CAP = 2000, PER_DIR = 5000;
        const cDir = this._aiExpandHome((settings && settings.aiClaudeSessionsDir) || '~/.claude/projects', home);
        const xDir = this._aiExpandHome((settings && settings.aiCodexSessionsDir) || '~/.codex/sessions', home);
        const cDepth = this._aiMaxDepth(settings && settings.aiClaudeMaxDepth, 2);
        const xDepth = this._aiMaxDepth(settings && settings.aiCodexMaxDepth, 5);
        const [cList, xList] = await Promise.all([
            this._aiListMtimes(cDir, cDepth, 'claude', PER_DIR),
            this._aiListMtimes(xDir, xDepth, 'codex', PER_DIR),
        ]);
        const [cRows, xRows] = await Promise.all([
            this._aiReadClaudeRows(cList, BATCH),
            this._aiReadCodexRows(xList, BATCH, CODEX_HEAD_CAP),
        ]);
        return this._aiSortSessions(cRows.concat(xRows));
    },
};
