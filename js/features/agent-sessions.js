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

    _aiListMtimes(dir, maxDepth, tool) {
        // Cap the listing IN THE SHELL (newest first, top 400) so a registry with
        // thousands of sessions doesn't transfer/sort an unbounded result in the
        // browser before the 200-session scan cap is even applied.
        const script = 'd="$1"; [ -d "$d" ] || exit 0; ' +
            'find "$d" -maxdepth ' + maxDepth + ' -type f -name "*.jsonl" -printf "%T@\\t%p\\n" 2>/dev/null | sort -rn | head -n 400';
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

    // Public: enumerate up to SCAN_CAP most-recent sessions with metadata.
    async scanAiSessions(settings, home) {
        const SCAN_CAP = 200, BATCH = 16;
        const cDir = this._aiExpandHome((settings && settings.aiClaudeSessionsDir) || '~/.claude/projects', home);
        const xDir = this._aiExpandHome((settings && settings.aiCodexSessionsDir) || '~/.codex/sessions', home);
        const [cList, xList] = await Promise.all([
            this._aiListMtimes(cDir, 2, 'claude'),
            this._aiListMtimes(xDir, 5, 'codex'),
        ]);
        const picked = this._aiSortSessions(cList.concat(xList)).slice(0, SCAN_CAP);
        const rows = [];
        for (let i = 0; i < picked.length; i += BATCH) {
            const batch = picked.slice(i, i + BATCH);
            const heads = await Promise.all(batch.map(f => this._aiReadHead(f.path)));
            batch.forEach((f, j) => {
                const base = (f.path.split('/').pop() || '').replace(/\.jsonl$/, '');
                const fallbackId = f.tool === 'codex'
                    ? ((this._aiParseCodexName(f.path.split('/').pop() || '') || {}).id || base)
                    : base;
                const p = this._aiParseHead(heads[j].head, fallbackId);
                rows.push({
                    tool: f.tool, id: p.id, cwd: p.cwd, title: p.title, mtime: f.mtime, path: f.path,
                    label: p.title || p.cwd || base,
                });
            });
        }
        return this._aiSortSessions(rows);
    },
};
