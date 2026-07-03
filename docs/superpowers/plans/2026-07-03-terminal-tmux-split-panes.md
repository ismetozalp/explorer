# Split Terminal vs tmux Panes + Clearer Chrome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal `+` button kind-aware (plain tabs → new shell, tmux tabs → new tmux session), group all tmux sessions as sub-tabs under one tab, differentiate the two kinds with distinct icons + accent colours, and enlarge the directory-toolbar nav glyphs.

**Architecture:** Terminal tabs gain an explicit `termKind` (`'plain'` | `'tmux'`) that becomes the source of truth (replacing the old single `tab.tmux` marker). The sub-tab-bar `+` dispatches on it; the tmux session manager routes every session into a single tmux container tab. Icons live in the existing `tabLabel`/`termLabel` methods; colours are pure CSS keyed off a `term-stack--<kind>` class. Nav-button sizing is pure CSS on a new `toolbar-nav` class.

**Tech Stack:** Vanilla JS + Alpine.js, xterm.js, Cockpit channels, Bootstrap 5 (all vendored). No build step, no test runner.

## Global Constraints

- **Version is 1.1.4** for this release (bump `VERSION` only in Task 7; never mid-plan).
- **No new dependencies.** Everything ships vendored already; add none.
- **Follow existing `js/app.js` style:** methods are properties on the Alpine component object (`name(args) { … },`), 4-space indent, `this.toast(msg, level)` for feedback, `Util.*`/`FS.*`/`cockpit.*` helpers.
- **`termKind` is the source of truth** for terminal-tab kind. Never reintroduce reliance on the old tab-level `tab.tmux` marker for identity.
- **The `+` on a tmux pane uses the SAME prompt + validation** as the header "New tmux session" button (shared `_promptTmuxName()`).
- **Theme:** the app themes via the `[data-bs-theme="dark"]` attribute (see `css/explorer.css:999`), NOT `prefers-color-scheme`. Use `[data-bs-theme="dark"]` for dark overrides.
- **No test runner exists.** The automated gate for every JS change is `node --check js/app.js`. Functional verification is a manual browser checklist.

### Verification loop (used by every task)

1. Automated syntax gate: `node --check js/app.js` (must print nothing / exit 0). CSS/HTML-only tasks skip this.
2. Deploy: `sudo make install` (copies the repo to `/usr/share/cockpit/explorer`).
3. In the browser, open **Tools → Explorer** and hard-reload (Ctrl+Shift+R). No Cockpit restart needed — `manifest.json` is unchanged.
4. Perform the task's manual checklist and confirm the expected observations.

---

### Task 1: `termKind` field, accessor, and icon labels

**Files:**
- Modify: `js/app.js` — tab object in `_buildTab` (~line 430); add `termKindOf` before `tabLabel` (~line 562); update `tabLabel` (562–567) and `termLabel` (570–573).

**Interfaces:**
- Consumes: `Util.basename`, `this.shortenTermPath(dir)`, `tab.kind`, `tab.terminals`, `tab.activeTermId`.
- Produces:
  - tab field `termKind: 'plain' | 'tmux'` (default `'plain'`)
  - `termKindOf(tab) → 'plain' | 'tmux' | ''`
  - updated `tabLabel(tab)`, `termLabel(t)` with `❯` (plain) / `⧉` (tmux) icons

- [ ] **Step 1: Add the `termKind` field**

In `_buildTab`'s tab object, immediately after `activeTermId: null,` (line 430):

```js
            terminals: [],          // [{ id, dir, label }]
            activeTermId: null,
            termKind: 'plain',      // terminal tabs: 'plain' | 'tmux' (source of truth)
```

- [ ] **Step 2: Add the `termKindOf` accessor**

Immediately before `tabLabel(tab) {` (line 562), add:

```js
    // Terminal tabs are either a stack of plain shells ('plain') or a group of
    // tmux sessions ('tmux'). termKind is the source of truth; fall back to
    // inferring it for tabs persisted before the field existed.
    termKindOf(tab) {
        if (!tab || tab.kind !== 'terminal') return '';
        if (tab.termKind) return tab.termKind;
        return (tab.tmux || (tab.terminals || []).some(t => t.tmux)) ? 'tmux' : 'plain';
    },

```

- [ ] **Step 3: Update `tabLabel` for the new icons**

Replace the whole `tabLabel(tab) { … }` method (lines 562–567) with:

```js
    tabLabel(tab) {
        if (tab.kind === 'output') return '▶ ' + (tab.outputActionLabel || 'output');
        if (tab.kind === 'terminal') {
            if (this.termKindOf(tab) === 'tmux') {
                const act = (tab.terminals || []).find(t => t.id === tab.activeTermId);
                return '⧉ ' + ((act && act.tmux) || 'tmux');
            }
            return '❯ Terminal';
        }
        if (tab.path === '/') return '/';
        return Util.basename(tab.path) || tab.path;
    },
```

- [ ] **Step 4: Update `termLabel` for the new plain icon**

Replace the whole `termLabel(t) { … }` method (lines 570–573) with:

```js
    termLabel(t) {
        if (!t) return '';
        return t.tmux ? ('⧉ ' + t.tmux) : ('❯ ' + this.shortenTermPath(t.dir));
    },
```

- [ ] **Step 5: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 6: Deploy + manual check**

Deploy (`sudo make install`) and hard-reload. Then:
- Open a plain terminal tab (`+▤` or right-click → *Open in new terminal tab*). Main-tab title reads **`❯ Terminal`**; its sub-tab reads **`❯ <cwd>`**.
- Open a tmux session from the header **▤ tmux** manager. Its main-tab title reads **`⧉ <session>`**; its sub-tab reads **`⧉ <session>`**.
- Existing directory tabs are unaffected.

- [ ] **Step 7: Commit**

```bash
git add js/app.js
git commit -m "feat(terminal): add termKind + ❯/⧉ tab icons"
```

---

### Task 2: Kind-aware `+` button (plain shell vs tmux session)

**Files:**
- Modify: `js/app.js` — refactor `newTmuxSession` (~5340) to share a prompt helper; add `addPaneToTab`, `newTmuxSessionInTab`, `addTmuxSessionToTab` near `addTerminalToTab` (~5202).
- Modify: `index.html` — sub-tab-bar `+` button (line 441).

**Interfaces:**
- Consumes: `this.termKindOf(tab)` (Task 1), `this.addTerminalToTab(tab, dir, opts)`, `this.selectTerminal(tab, id)`, `this.askPrompt`, `this.toast`, `this.openTmuxSession` (existing).
- Produces:
  - `async _promptTmuxName() → string | null` (clean name or null; toasts on invalid)
  - `addPaneToTab(tab) → void`
  - `async newTmuxSessionInTab(tab) → void`
  - `addTmuxSessionToTab(tab, name, opts?) → term` (adds or focuses a tmux sub-tab)

- [ ] **Step 1: Extract the shared tmux-name prompt**

Replace the whole `async newTmuxSession() { … }` method (lines 5340–5350) with these two methods:

```js
    // Shared "New tmux session" prompt + validation, used by both the header
    // manager and the sub-tab-bar "+". Returns a clean name, or null if
    // cancelled/invalid (an invalid name toasts before returning null).
    async _promptTmuxName() {
        const name = await this.askPrompt('New tmux session', 'Session name (letters, digits, - or _)', '');
        const clean = (name || '').trim();
        if (!clean) return null;
        if (/[\s.:]/.test(clean)) {
            this.toast('Session name can\'t contain spaces, "." or ":"', 'warning');
            return null;
        }
        return clean;
    },

    async newTmuxSession() {
        this.tmux.open = false;
        const name = await this._promptTmuxName();
        if (name) this.openTmuxSession(name);
    },
```

- [ ] **Step 2: Add the `+` dispatcher and tmux-in-tab helpers**

Immediately after the `openIntegratedTerminal(tab, path) { … }` method (ends ~line 5217), add:

```js
    // Sub-tab-bar "+" dispatcher: plain tabs get a new shell; tmux tabs get a
    // new tmux session (same prompt as the header manager).
    addPaneToTab(tab) {
        if (this.termKindOf(tab) === 'tmux') return this.newTmuxSessionInTab(tab);
        return this.addTerminalToTab(tab, tab.path);
    },

    async newTmuxSessionInTab(tab) {
        const name = await this._promptTmuxName();
        if (name) this.addTmuxSessionToTab(tab, name);
    },

    // Add (or focus) a tmux session as a sub-tab inside an existing tmux tab.
    addTmuxSessionToTab(tab, name, opts) {
        const existing = (tab.terminals || []).find(t => t.tmux === name);
        if (existing) { this.selectTerminal(tab, existing.id); return existing; }
        return this.addTerminalToTab(tab, tab.path, Object.assign({ tmux: name }, opts || {}));
    },
```

- [ ] **Step 3: Wire the `+` button to the dispatcher**

In `index.html`, replace the sub-tab-add button (line 441):

```html
                    <button class="term-subtab-add" @click="addTerminalToTab(tab, tab.path)" title="New terminal here">+</button>
```

with:

```html
                    <button class="term-subtab-add" @click="addPaneToTab(tab)"
                            :title="termKindOf(tab) === 'tmux' ? 'New tmux session' : 'New terminal here'">+</button>
```

- [ ] **Step 4: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 5: Deploy + manual check**

- In a **plain** terminal tab, click `+` → a new plain shell sub-tab opens in the current folder (tooltip reads "New terminal here").
- Open a tmux session from the header manager, then in that **tmux** tab click `+` → the same "New tmux session" prompt appears (tooltip reads "New tmux session"). Enter `build` → a `⧉ build` sub-tab opens and is focused.
- Click `+` again and enter `build` (already open) → it focuses the existing `⧉ build` sub-tab, no duplicate.
- Enter an invalid name `a b` → toast "Session name can't contain spaces…", nothing opens.

- [ ] **Step 6: Commit**

```bash
git add js/app.js index.html
git commit -m "feat(terminal): + button opens a tmux session in tmux tabs"
```

---

### Task 3: One tmux container tab; manager routes into it

**Files:**
- Modify: `js/app.js` — replace `_findTmuxTab`/`isTmuxSessionOpen` (5319–5322); rewrite `openTmuxSession` (5327–5338); set `termKind` in `newTmuxTerminalTab` (5373–5374); update `killTmuxSession`'s tab lookup (5360–5364); update the one `_findTmuxTab` call in `_restoreTmuxTabs` (5416).

**Interfaces:**
- Consumes: `this.termKindOf` (Task 1), `this.addTmuxSessionToTab` (Task 2), `this.activateTab`, `this.selectTerminal`, `this.closeTerminal`, `this.newTmuxTerminalTab`.
- Produces:
  - `_tmuxTab() → tab | undefined` (the single tmux container tab)
  - `_findTmuxSubtab(name) → { tab, term } | null`
  - `isTmuxSessionOpen(name) → boolean` (now via `_findTmuxSubtab`)
  - `openTmuxSession(name)` routes into the container tab
  - `newTmuxTerminalTab` sets `raw.termKind = 'tmux'`

- [ ] **Step 1: Replace the tmux-tab lookups**

Replace `_findTmuxTab` + `isTmuxSessionOpen` (lines 5319–5322):

```js
    _findTmuxTab(name) {
        return this.tabs.find(t => t.kind === 'terminal' && (t.terminals || []).some(x => x.tmux === name));
    },
    isTmuxSessionOpen(name) { return !!this._findTmuxTab(name); },
```

with:

```js
    // The single tmux container tab — every tmux session lives here as a sub-tab.
    _tmuxTab() {
        return this.tabs.find(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux');
    },
    // Locate an open session's tab + sub-terminal by session name.
    _findTmuxSubtab(name) {
        for (const tab of this.tabs) {
            if (tab.kind !== 'terminal') continue;
            const term = (tab.terminals || []).find(t => t.tmux === name);
            if (term) return { tab, term };
        }
        return null;
    },
    isTmuxSessionOpen(name) { return !!this._findTmuxSubtab(name); },
```

- [ ] **Step 2: Route `openTmuxSession` into the container tab**

Replace the whole `openTmuxSession(name) { … }` method (lines 5327–5338) with:

```js
    // Open a tmux session as a sub-tab of the single tmux container tab:
    // focus it if already open, else add it to the existing tmux tab, else
    // create the tmux tab with it as the first session.
    openTmuxSession(name) {
        this.tmux.open = false;
        if (!name) return;
        const hit = this._findTmuxSubtab(name);
        if (hit) {
            this.activateTab(hit.tab.id);
            this.selectTerminal(hit.tab, hit.term.id);
            return;
        }
        const container = this._tmuxTab();
        if (container) {
            this.activateTab(container.id);
            this.addTmuxSessionToTab(container, name);
            return;
        }
        this.newTmuxTerminalTab(name);
    },
```

- [ ] **Step 3: Mark the container tab as `termKind: 'tmux'`**

In `newTmuxTerminalTab` (lines 5373–5374), replace:

```js
        const raw = this._buildTab(dir, 'terminal');
        raw.tmux = name;                               // tab-level marker (label, persistence)
```

with:

```js
        const raw = this._buildTab(dir, 'terminal');
        raw.termKind = 'tmux';                          // kind marker (label, persistence, "+")
```

- [ ] **Step 4: Update `killTmuxSession`'s tab lookup**

In `killTmuxSession` (lines 5360–5364), replace:

```js
        const tab = this._findTmuxTab(name);
        if (tab) {
            const term = (tab.terminals || []).find(x => x.tmux === name);
            if (term) this.closeTerminal(tab, term.id);
        }
```

with:

```js
        const hit = this._findTmuxSubtab(name);
        if (hit) this.closeTerminal(hit.tab, hit.term.id);
```

- [ ] **Step 5: Fix the remaining `_findTmuxTab` reference**

In `_restoreTmuxTabs` (line 5416), replace `this._findTmuxTab(name)` with `this._findTmuxSubtab(name)` (removes the last caller of the now-deleted method):

```js
                if (!this._findTmuxSubtab(name)) this.newTmuxTerminalTab(name, { activate: false });
```

- [ ] **Step 6: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0. (Also confirm no stragglers: `grep -n "_findTmuxTab" js/app.js` prints nothing.)

- [ ] **Step 7: Deploy + manual check**

- Header **▤ tmux** → open session `a` → new tab titled `⧉ a`.
- Header manager → open session `b` → it is added as a **sub-tab in the same tab** and focused (no second main tab).
- Header manager → open `a` again → focuses the existing `⧉ a` sub-tab (no duplicate, no new tab).
- Kill session `b` from the manager → the `⧉ b` sub-tab closes, `⧉ a` remains.
- Kill session `a` → the whole tmux tab closes.

- [ ] **Step 8: Commit**

```bash
git add js/app.js
git commit -m "feat(tmux): group all sessions as sub-tabs of one tmux tab"
```

---

### Task 4: Persist & restore grouped tmux sessions

**Files:**
- Modify: `js/app.js` — `tmuxTabs` builder in `_persistTabs` (633–636); rewrite `_restoreTmuxTabs` (5404–5425).

**Interfaces:**
- Consumes: `this.termKindOf` (Task 1), `this.addTmuxSessionToTab` (Task 2), `this._tmuxTab`/`this._findTmuxSubtab` (Task 3), `this.newTmuxTerminalTab`, `this._listTmuxSessions`, `this._persistTabs`.
- Produces: `tmuxTabs` saved as a flat, deduped list of all session names across the container tab; `_restoreTmuxTabs` regroups live sessions into one container tab.

- [ ] **Step 1: Save all session names from the container tab**

In `_persistTabs`, replace the `tmuxTabs` builder (lines 633–636):

```js
                const tmuxTabs = this.tabs
                    .filter(t => t.kind === 'terminal')
                    .map(t => t.tmux || ((t.terminals || []).find(x => x.tmux) || {}).tmux)
                    .filter(Boolean);
```

with:

```js
                // All tmux session names across the tmux container tab, in
                // sub-tab order, so the whole group is restored next launch.
                const tmuxTabs = Array.from(new Set(this.tabs
                    .filter(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux')
                    .flatMap(t => (t.terminals || []).filter(x => x.tmux).map(x => x.tmux))));
```

- [ ] **Step 2: Restore live sessions into one container tab**

Replace the whole `async _restoreTmuxTabs() { … }` method (lines 5404–5425) with:

```js
    async _restoreTmuxTabs() {
        const names = this._savedTmuxTabs || [];
        this._savedTmuxTabs = null;
        if (!names.length || !this.tmux.available) return;
        let live = [];
        // If we can't query tmux (transient error), leave the saved list
        // untouched and try again next load rather than wrongly pruning.
        try { live = await this._listTmuxSessions(); } catch (e) { return; }
        const liveNames = new Set(live.map(s => s.name));
        let pruned = false;
        let container = this._tmuxTab();
        for (const name of names) {
            if (!liveNames.has(name)) { pruned = true; continue; }  // gone → drop
            if (this._findTmuxSubtab(name)) continue;               // already open
            if (!container) {
                container = this.newTmuxTerminalTab(name, { activate: false });
            } else {
                this.addTmuxSessionToTab(container, name, { mount: false });
            }
        }
        // Rewrite tabs.yml so dead sessions fall out (rebuilt from open tabs).
        if (pruned) this._persistTabs();
    },
```

- [ ] **Step 3: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 4: Deploy + manual check**

- Open two tmux sessions (`a`, `b`) so they are grouped as sub-tabs under one `⧉` tab.
- Hard-reload the page → the tmux tab returns with **both** `⧉ a` and `⧉ b` sub-tabs in one tab (not two tabs).
- From a shell, `tmux kill-session -t b`, then reload → only `⧉ a` is restored; `b` is dropped from `tabs.yml`.

- [ ] **Step 5: Commit**

```bash
git add js/app.js
git commit -m "feat(tmux): persist & restore all sessions into one grouped tab"
```

---

### Task 5: Coloured pane headers + kind class

**Files:**
- Modify: `index.html` — `term-stack` wrapper (line 429).
- Modify: `css/explorer.css` — append accent rules after the terminal block (after line ~1016).

**Interfaces:**
- Consumes: `this.termKindOf(tab)` (Task 1); existing `.term-tabbar`, `.term-subtab.active` rules.
- Produces: `.term-stack--plain` / `.term-stack--tmux` accent styling (blue / green, theme-aware).

- [ ] **Step 1: Add the kind class to the term-stack**

In `index.html`, replace the term-stack opening tag (line 429):

```html
                <div class="term-stack">
```

with:

```html
                <div class="term-stack" :class="'term-stack--' + termKindOf(tab)">
```

- [ ] **Step 2: Append the accent CSS**

Append to the end of `css/explorer.css`:

```css
/* v1.1.4 — differentiate plain-terminal vs tmux panes by accent colour.
   Scoped to the kind class so the base .term-tabbar / .term-subtab rules are
   left intact; only a left border + active-sub-tab underline are added. */
.term-stack--plain { --term-accent: #3b82f6; }
.term-stack--tmux  { --term-accent: #16a34a; }
[data-bs-theme="dark"] .term-stack--plain { --term-accent: #60a5fa; }
[data-bs-theme="dark"] .term-stack--tmux  { --term-accent: #22c55e; }

.term-stack--plain > .term-tabbar,
.term-stack--tmux  > .term-tabbar {
    border-left: 3px solid var(--term-accent);
}
.term-stack--plain .term-subtab.active,
.term-stack--tmux  .term-subtab.active {
    box-shadow: inset 0 -2px 0 var(--term-accent);
    border-color: var(--term-accent);
}
```

- [ ] **Step 3: Deploy + manual check** (no `node --check`; CSS/HTML only)

- A plain terminal tab's sub-tab bar shows a **blue** left edge; its active sub-tab has a blue underline.
- A tmux tab's sub-tab bar shows a **green** left edge; its active sub-tab has a green underline.
- Toggle Cockpit dark mode → accents brighten (lighter blue/green) and stay legible.

- [ ] **Step 4: Commit**

```bash
git add index.html css/explorer.css
git commit -m "feat(terminal): colour-code plain vs tmux pane headers"
```

---

### Task 6: Larger, clearer directory-toolbar nav buttons

**Files:**
- Modify: `index.html` — nav button group (line 97).
- Modify: `css/explorer.css` — append `.toolbar-nav` rule.

**Interfaces:**
- Consumes: existing Bootstrap `.btn`/`.btn-group-sm`.
- Produces: `.toolbar-nav` sizing (larger glyphs) applied only to the `← → ↑ ⌂ ⟳` group.

- [ ] **Step 1: Tag the nav button group**

In `index.html`, replace the nav group opening tag (line 97):

```html
            <div class="btn-group btn-group-sm me-2">
```

with:

```html
            <div class="btn-group btn-group-sm me-2 toolbar-nav">
```

- [ ] **Step 2: Append the sizing CSS**

Append to the end of `css/explorer.css`:

```css
/* v1.1.4 — enlarge the directory toolbar nav glyphs (← → ↑ ⌂ ⟳) so they're
   legible; layout and behaviour are unchanged. */
.toolbar-nav .btn {
    font-size: 1.15rem;
    line-height: 1;
    padding: 0.15rem 0.55rem;
    font-weight: 600;
}
```

- [ ] **Step 3: Deploy + manual check** (no `node --check`; CSS/HTML only)

- The Back/Forward/Up/Home/Reload glyphs in a directory tab's toolbar are visibly larger and bolder.
- Buttons still work; Back/Forward still grey out (disabled) at history ends.
- The Split button to their right is unchanged in size.

- [ ] **Step 4: Commit**

```bash
git add index.html css/explorer.css
git commit -m "feat(ui): enlarge directory toolbar nav glyphs"
```

---

### Task 7: Version bump, changelog, README

**Files:**
- Modify: `VERSION`; `CHANGELOG.md` (new `## 1.1.4` at top of the entries); `README.md` (terminal section, lines ~470–493).

**Interfaces:** none (docs/version only).

- [ ] **Step 1: Bump VERSION**

Set the entire contents of `VERSION` to:

```
1.1.4
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, insert immediately after the `All notable changes…` intro line and before `## 1.1.3`:

```markdown
## 1.1.4

- **Terminal & tmux panes are now fully separated.** A terminal tab is a
  container of plain shells; a tmux tab is a container of tmux sessions. The
  `+` button does the right thing for its tab: in a plain terminal it opens
  another shell, and in a tmux tab it opens a **new tmux session** (asking for
  the session name with the same prompt as the header **New tmux session**
  button).

- **All tmux sessions are grouped under one tab.** Opening a session from the
  tmux manager now adds it as a sub-tab of the single tmux tab (or focuses it
  if already open) instead of scattering sessions across separate main tabs.
  The whole group is remembered and restored together on reload; sessions that
  died meanwhile are dropped.

- **Clear icons and colours per kind.** Plain terminals are marked `❯` with a
  **blue** pane-header accent; tmux panes are marked `⧉` with a **green**
  accent, on both the main-tab title and each sub-tab — so the two are obvious
  at a glance (light and dark themes).

- **Bigger directory toolbar buttons.** The Back / Forward / Up / Home / Reload
  glyphs are larger and bolder so they're easy to read.

```

- [ ] **Step 3: Update the README terminal section**

In `README.md`, replace the `+`-behaviour bullet (lines 472–473):

```markdown
- The `+` in the terminal's own tab bar spawns another shell in the
  current folder.
```

with:

```markdown
- The `+` in the terminal's own tab bar is kind-aware: in a plain terminal
  tab it spawns another shell in the current folder; in a **tmux** tab it
  opens a **new tmux session** (asking for the name, just like the header
  **New tmux session** button) and adds it as a sub-tab.
```

Then replace the icon description paragraph (lines 490–493):

```markdown
A full-tab terminal shows up in the main tab bar simply as **▤ Terminal**
(it doesn't borrow a directory name), so it's easy to tell apart from
your directory tabs. A terminal tab bound to a tmux session instead shows
**▤ &lt;session&gt;**, and its sub-tab is labelled **⧉ &lt;session&gt;**.
```

with:

```markdown
A full-tab terminal shows up in the main tab bar as **❯ Terminal** with a
**blue** pane-header accent, so it's easy to tell apart from your directory
tabs. A tmux tab instead shows **⧉ &lt;active session&gt;** with a **green**
accent, and each session it holds is a sub-tab labelled **⧉ &lt;session&gt;**.
```

- [ ] **Step 4: Deploy + manual check**

- `cat VERSION` → `1.1.4`.
- The Explorer **About**/version display (if shown) reads 1.1.4 after reload.
- Skim the rendered CHANGELOG/README for the new copy.

- [ ] **Step 5: Commit**

```bash
git add VERSION CHANGELOG.md README.md
git commit -m "docs: 1.1.4 — split terminal/tmux panes, icons, bigger nav"
```

---

## Notes for the implementer

- **Task order matters:** Task 1 defines `termKindOf` used everywhere; Task 2 adds `addTmuxSessionToTab` used by Tasks 3–4; Task 3 adds `_tmuxTab`/`_findTmuxSubtab` used by Task 4. Do them in order.
- **`_findTmuxTab` is fully removed by Task 3.** After Task 3, `grep -n "_findTmuxTab" js/app.js` must print nothing.
- **Backwards compatibility:** `termKindOf` infers the kind for any tab persisted before `termKind` existed (via the legacy `tab.tmux` marker or a tmux sub-terminal), so an in-flight restore from an older `tabs.yml` still colours and routes correctly.
- **Do not** bump `VERSION` before Task 7.
