# Split terminal panes vs tmux panes + clearer terminal/header chrome

**Date:** 2026-07-03
**Status:** Approved design, pending implementation
**Component:** Explorer Cockpit plugin — integrated terminal & directory toolbar
(`js/app.js`, `index.html`, `css/explorer.css`)
**Version:** 1.1.4

## Problem

A terminal main-tab (`kind:'terminal'`) holds a stack of sub-terminals shown as
sub-tabs, with a `+` button. A sub-terminal is either a **plain** shell or is
**attached to a tmux session** (`term.tmux === '<name>'`). Today:

1. **The `+` button ignores the tab's nature.** It always calls
   `addTerminalToTab(tab, tab.path)`, which opens a **plain** terminal — even
   inside a tmux tab. There is no way to get "another tmux session" from within a
   tmux tab; you get a bare shell instead.
2. **tmux and plain terminals are only weakly distinguishable.** The tab title
   uses `▤` for both plain (`▤ Terminal`) and tmux (`▤ <name>`); sub-tabs use
   `⧉` for tmux and a bare path for plain. There is no colour cue, so a tmux tab
   and a terminal tab look almost identical.
3. **The directory toolbar nav glyphs (`← → ↑ ⌂ ⟳`) are hard to read.** They are
   small `btn-group-sm` monochrome glyphs with tight padding.

## Goal

- **Completely split** the two kinds: a terminal tab is a container of *plain
  terminals*; a tmux tab is a container of *tmux sessions*. The `+` button does
  the right thing for its kind.
- Make the two kinds obvious at a glance — distinct icon **and** an accent
  colour on the pane header (the sub-tab bar) and active sub-tab.
- Enlarge the directory toolbar nav buttons so the glyphs are legible.

## Design

### 1. Explicit tab kind — `termKind` (`js/app.js`)

Terminal-kind tabs gain a `termKind` field: `'plain'` | `'tmux'`.

- `_buildTab(dir, 'terminal')` sets `termKind: 'plain'` by default.
- The tmux entry points set `termKind: 'tmux'` (see §3).
- A tolerant accessor covers older persisted tabs that predate the field:

  ```js
  termKindOf(tab) {
      if (!tab || tab.kind !== 'terminal') return '';
      if (tab.termKind) return tab.termKind;
      // legacy: inferred from the old single-session marker or any tmux sub-term
      return (tab.tmux || (tab.terminals || []).some(t => t.tmux)) ? 'tmux' : 'plain';
  }
  ```

`termKind` — not the old single `tab.tmux` marker — becomes the source of truth,
so one tmux tab can now hold **many** session sub-tabs.

### 2. `+` button branches on kind (`index.html`, `js/app.js`)

Sub-tab bar `+` button changes from a fixed handler to a dispatcher, with a
kind-aware tooltip:

```html
<button class="term-subtab-add" @click="addPaneToTab(tab)"
        :title="termKindOf(tab) === 'tmux' ? 'New tmux session' : 'New terminal here'">+</button>
```

New methods in `js/app.js`:

```js
// Dispatcher for the sub-tab-bar "+" button.
addPaneToTab(tab) {
    if (this.termKindOf(tab) === 'tmux') return this.newTmuxSessionInTab(tab);
    return this.addTerminalToTab(tab, tab.path);   // plain: unchanged
}

// Prompt for a session name and add it as a sub-tab in this tmux tab.
async newTmuxSessionInTab(tab) {
    const name = await this.askPrompt('New tmux session',
        'Session name (letters, digits, - or _)', '');
    const clean = (name || '').trim();
    if (!clean) return;                                  // cancelled/empty
    if (/[\s.:]/.test(clean)) {
        this.toast('Session name can\'t contain spaces, "." or ":"', 'warning');
        return;
    }
    this.addTmuxSessionToTab(tab, clean);
}

// Add (or focus) a tmux session sub-tab inside an existing tmux tab.
addTmuxSessionToTab(tab, name, opts) {
    const existing = (tab.terminals || []).find(t => t.tmux === name);
    if (existing) { this.selectTerminal(tab, existing.id); return existing; }
    return this.addTerminalToTab(tab, tab.path, Object.assign({ tmux: name }, opts || {}));
}
```

The `+` button on a tmux pane opens the **same session-name prompt** as the
header tmux manager's **New tmux session** button (identical `askPrompt` title,
placeholder, and validation) — the only difference is that `+` adds the session
as a sub-tab in the current tab, whereas the header button routes through
`openTmuxSession`. The name-validation rule is factored out of the existing
`newTmuxSession()` so both call sites share it verbatim.

### 3. One tmux container tab; the manager routes into it (`js/app.js`)

Today `openTmuxSession` opens **one main tab per session**. It now routes every
session into a single tmux container tab as sub-tabs, consistent with `+`.

```js
_tmuxTab() {
    return this.tabs.find(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux');
}
_findTmuxSubtab(name) {
    for (const tab of this.tabs) {
        if (tab.kind !== 'terminal') continue;
        const term = (tab.terminals || []).find(t => t.tmux === name);
        if (term) return { tab, term };
    }
    return null;
}

openTmuxSession(name) {
    this.tmux.open = false;
    if (!name) return;
    const hit = this._findTmuxSubtab(name);
    if (hit) {                                    // already open → focus it
        this.activateTab(hit.tab.id);
        this.selectTerminal(hit.tab, hit.term.id);
        return;
    }
    const container = this._tmuxTab();
    if (container) {                              // add into the existing tmux tab
        this.activateTab(container.id);
        this.addTmuxSessionToTab(container, name);
        return;
    }
    this.newTmuxTerminalTab(name);               // first session → create the tab
}
```

- `newTmuxTerminalTab(name, opts)` sets `raw.termKind = 'tmux'` (in addition to
  attaching the first session). It no longer needs the tab-level `raw.tmux`
  marker for identity; `termKind` + per-terminal `.tmux` carry it.
- `_findTmuxTab`/`isTmuxSessionOpen` are updated (or replaced by
  `_findTmuxSubtab`/`_tmuxTab`) so the tmux manager's "session is open" state and
  `killTmuxSession` still resolve the right tab + sub-terminal.
- `killTmuxSession(name)` closes just that session's sub-terminal
  (`closeTerminal(tab, term.id)`); when it was the last one, `closeTerminal`
  already closes the whole tab.

### 4. Labels — distinct icons (`js/app.js`)

| | Main-tab title | Sub-tab label |
|---|---|---|
| Plain terminal | `❯ Terminal` | `❯ <cwd>` |
| tmux | `⧉ <active session>` (fallback `⧉ tmux`) | `⧉ <session>` |

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
}

termLabel(t) {
    if (!t) return '';
    return t.tmux ? ('⧉ ' + t.tmux) : ('❯ ' + this.shortenTermPath(t.dir));
}
```

### 5. Coloured pane headers (`index.html`, `css/explorer.css`)

The `term-stack` wrapper gains a kind class so the sub-tab bar (the pane header)
and active sub-tab can be tinted:

```html
<div class="term-stack" :class="'term-stack--' + termKindOf(tab)">
```

CSS defines a per-kind accent (theme-aware) and applies it as a left border +
subtle tint on `.term-tabbar`, and as the active-sub-tab indicator:

- Plain → **blue** accent (`#3b82f6`, dark `#60a5fa`).
- tmux → **green** accent (`#16a34a`, dark `#22c55e`).

```css
.term-stack--plain { --term-accent: #3b82f6; }
.term-stack--tmux  { --term-accent: #16a34a; }
@media (prefers-color-scheme: dark) {
    .term-stack--plain { --term-accent: #60a5fa; }
    .term-stack--tmux  { --term-accent: #22c55e; }
}
.term-tabbar {
    border-left: 3px solid var(--term-accent);
    background: color-mix(in srgb, var(--term-accent) 8%, transparent);
}
.term-subtab.active {
    box-shadow: inset 0 -2px 0 var(--term-accent);
}
.term-subtab-label { /* icon inherits accent via currentColor where practical */ }
```

(Exact selectors/values tuned during implementation to match existing
`explorer.css` variables; `color-mix` is already safe for the plugin's target
browsers, with a plain `background` fallback if needed.)

### 6. Larger directory-toolbar nav buttons (`index.html`, `css/explorer.css`)

Add a class to the nav button group so only these five buttons grow (the Split
button and others are untouched):

```html
<div class="btn-group btn-group-sm me-2 toolbar-nav">  <!-- ← → ↑ ⌂ ⟳ -->
```

```css
.toolbar-nav .btn {
    font-size: 1.15rem;      /* was ~0.875rem via btn-sm */
    line-height: 1;
    padding: 0.15rem 0.55rem;
    font-weight: 600;
}
```

Glyphs are unchanged (`← → ↑ ⌂ ⟳`); only size/weight/padding change, so layout
and behaviour are identical.

### 7. Persistence (`js/app.js`)

Multiple tmux sessions now live under one tab, so save/restore must handle a
list, not one-session-per-tab.

- **Save** (`_persistTabs`, ~line 633): collect **all** `.tmux` session names
  across the tmux container tab's terminals, in sub-tab order, into the flat
  `tmuxTabs` list (deduped):

  ```js
  const tmuxTabs = this.tabs
      .filter(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux')
      .flatMap(t => (t.terminals || []).filter(x => x.tmux).map(x => x.tmux));
  ```

- **Restore** (`_restoreTmuxTabs`, ~line 5404): prune dead sessions (unchanged),
  then group the live ones into a **single** container tab — first live name via
  `newTmuxTerminalTab(name, {activate:false})`, each subsequent live name via
  `addTmuxSessionToTab(container, name, {mount:false})`.

### 8. Version & docs

- `VERSION` → `1.1.4`.
- `CHANGELOG.md` → new `## 1.1.4` section covering the split `+`, grouped tmux
  sub-tabs, icon/colour differentiation, and larger nav buttons.
- `README.md` → short update to the terminal/tmux section noting the split `+`
  behaviour and the icon/colour cue.

## Scope / non-goals

- No change to the PTY channel, terminal data flow, or clipboard-image paste
  (1.1.3) — those paths are untouched.
- No change to the tmux **session manager** UI itself beyond routing its
  `openTmuxSession` into the container tab; the toolbar button, list, refresh,
  kill, and `.tmux.conf` editor are unchanged.
- No splitting of a single xterm into tmux-style side-by-side panes — "pane"
  here means a sub-tab, matching the existing model.
- Plain-terminal `+` behaviour is unchanged (still `addTerminalToTab`).

## Files touched

- `js/app.js` — `_buildTab` (`termKind`); `termKindOf`; `addPaneToTab`,
  `newTmuxSessionInTab`, `addTmuxSessionToTab`; `_tmuxTab`/`_findTmuxSubtab` and
  updated `openTmuxSession`/`_findTmuxTab`/`isTmuxSessionOpen`/`killTmuxSession`/
  `newTmuxTerminalTab`; `tabLabel`/`termLabel`; `_persistTabs`/`_restoreTmuxTabs`;
  shared session-name validation.
- `index.html` — `+` button handler + tooltip; `term-stack` kind class;
  `toolbar-nav` class on the nav button group.
- `css/explorer.css` — per-kind accent variables and pane-header/active-sub-tab
  colouring; `.toolbar-nav` button sizing.
- `VERSION`, `CHANGELOG.md`, `README.md`.
