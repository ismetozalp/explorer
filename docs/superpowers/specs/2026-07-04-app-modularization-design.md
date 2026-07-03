# Modularize `js/app.js` via global method mixins

**Date:** 2026-07-04
**Status:** Approved design, pending implementation
**Component:** Explorer Cockpit plugin — the Alpine component (`js/app.js`), `index.html`
**Target:** 1.2

## Problem

`js/app.js` is **7,188 lines** — a single `Alpine.data('explorer', () => ({ … }))`
object holding all reactive state plus every method for every feature (tabs,
files, preview/editor, upload, custom actions, mounts, GRUB, terminals/tmux,
GitHub, …). It is hard to navigate, review, and edit reliably. The plugin has
**no build step**: scripts are plain `<script src>` tags, and stateless helpers
already live in their own global-object files (`utils.js` → `Util`, `fs.js` →
`FS`, `git.js` → `GIT`).

## Goal

Split `app.js` into per-feature files **without introducing a build step**,
matching the existing global-object convention, so each feature is a focused
file that can be understood and edited on its own. Reduce `app.js` from ~7,200
to ~3,000 lines (core shell + composition), with the rest in feature modules.

## Mechanism — global method mixins

The component's methods use `this` (the Alpine instance). Because `this` is bound
by Alpine at call time, methods can live in any plain object and be **spread**
into the component. Each feature file defines one global object of *methods only*:

```js
// js/features/github.js
window.ExplorerGithub = {
    ghLogin() { /* uses this.gh, this.toast(), ExRT… */ },
    ghLoadPrs() { … },
    // …
};
```

`app.js` composes them:

```js
Alpine.data('explorer', () => ({
    ...CORE_STATE,                 // ALL reactive state stays here (central, compact)
    ...window.ExplorerGithub,
    ...window.ExplorerMounts,
    ...window.ExplorerGrub,
    ...window.ExplorerActions,
    ...window.ExplorerTerminal,
    ...window.ExplorerUpload,
    ...window.ExplorerEditor,
    ...coreMethods,                // remaining core methods, inline
}));
```

**Design decisions:**

- **State stays centralized** in `app.js`'s returned object. Mixins contain only
  methods, which reference `this.<state>`. This keeps Alpine reactivity in one
  obvious place and avoids fragmenting the state graph.
- **Non-reactive, file-private runtime state moves to `js/runtime.js`**, exposed
  as a single global `window.ExRT` (see below). This is the one piece that
  *cannot* be spread and *cannot* rely on cross-`<script>` lexical scope, so it
  gets an explicit, first-loaded home.
- **Load order** in `index.html`: `runtime.js` → `features/*.js` → `app.js`.
  Because state lives in `app.js` and the registries live in `ExRT` (a `window`
  property, definitively shared), **mixin load order among features does not
  matter**.

### `js/runtime.js` — the shared non-reactive namespace

`app.js` currently defines, *outside* the component, a set of module-private
registries and constants (the "reactivity firewall" instances + config). These
must be relocated to a shared, first-loaded module so every mixin can reach them:

| Current (app.js top) | Moves to |
|---|---|
| `_opCallbacks` Map + `_setOpCallback`/`_getOpCallback`/`_clearOpCallbacks` | `ExRT.ops` |
| `_termInstances` Map + `_setTermInstance`/`_getTermInstance`/`_deleteTermInstance` | `ExRT.term` |
| `_fileEditor`, `_winModels` Map | `ExRT.editor` |
| `_actionsEditor`, `_actionsEditorModel` | `ExRT.actionsEditor` |
| `_quillEditor` | `ExRT.quill` |
| `DEFAULT_SETTINGS`, `USER_ACTIONS_PATH_SUFFIX`, `SYSTEM_ACTIONS_PATH`, `USER_SCRIPTS_DIR_SUFFIX`, `SYSTEM_SCRIPTS_DIR`, `PROMPT_START/MSG_START/PROMPT_END`, `DISPLAY_TYPES`, `LS_KEY_*` | `ExRT.const` |

`window.ExRT` is a plain global object set in `runtime.js` (loaded first). Moved
code that referenced a bare name (e.g. `_getTermInstance(id)`,
`DEFAULT_SETTINGS`) is rewritten to the `ExRT` path (e.g. `ExRT.term.get(id)`,
`ExRT.const.DEFAULT_SETTINGS`), or a per-file `const { … } = window.ExRT` /
`const C = window.ExRT.const` shorthand at the top of the feature file. Mutable
singletons (`_fileEditor`, `_actionsEditor`, `_quillEditor`, currently reassigned
with `let`) become **properties** on `ExRT` (`ExRT.editor.file = …`) so
reassignment is visible across files.

## Module map

| File | Global | app.js banner sections (approx line ranges to move) | ~lines |
|---|---|---|---|
| `js/runtime.js` | `window.ExRT` | the pre-component privates + constants (app.js ~6–78) | ~120 |
| `js/features/grub.js` | `ExplorerGrub` | GRUB editor (~4176–4414) | ~240 |
| `js/features/mounts.js` | `ExplorerMounts` | Mounts/fstab + SMB/CIFS + NFS (~3249–4175) | ~925 |
| `js/features/github.js` | `ExplorerGithub` | github state-init, repo cache, run command, github panel, update/self-update, checkout, commit browser, repo actions, publish (~5012–5080, ~5949–6083, ~6084–6130, ~6131–7188) | ~1,250 |
| `js/features/actions.js` | `ExplorerActions` | custom actions + form/JSON editing + monaco actions editor + global actions (~2512–3125) + interactive scripts (~4513–4830) | ~930 |
| `js/features/terminal.js` | `ExplorerTerminal` | integrated terminals + tmux + path popover (~5189–5948) | ~760 |
| `js/features/upload.js` | `ExplorerUpload` | upload + drag&drop + archive (~2015–2511) | ~500 |
| `js/features/editor.js` | `ExplorerEditor` | preview + editor + window management (~1350–1776) | ~430 |
| `js/app.js` (remains) | composer | core state, init, tabs, panes, nav, selection, sorting, context menu, file ops, permissions, search, download, streaming output, operations tray, dialogs, dir picker, toasts, settings, keyboard | ~3,000 |

(Line ranges are the current banners; the implementation plan pins exact
start/end lines per step, since they shift as earlier steps land.)

## Collision guard (replaces the missing test runner)

A spread silently overwrites a duplicate key, so a method accidentally left in
`app.js` *and* a mixin — or defined in two mixins — would fail silently. A Node
script **`tools/check-mixins.js`** parses `app.js` + every `js/features/*.js`,
extracts top-level method/property names from each object literal, and **exits
non-zero listing any key defined in more than one place**. It runs in every
step's verification. (Optionally, `app.js` `console.warn`s on overlap at
startup as a dev aid.)

## Verification per step (no test runner)

1. `node --check js/features/<new>.js` and `node --check js/app.js` → exit 0.
2. `node tools/check-mixins.js` → no duplicate keys.
3. `grep` proves each moved method name no longer appears as a definition in
   `app.js` (moved, not copied).
4. Manual browser smoke test of **only that feature** (owner: user), after
   `sudo make install` + hard reload.

Each step is a single, revertable commit.

## Extraction order (safest → riskiest)

1. **`runtime.js`** — move the pre-component privates + constants; rewrite their
   references throughout `app.js`. No behavior change. (Prerequisite for all.)
2. **`grub.js`** — smallest, most self-contained; proves the mixin pattern end
   to end.
3. **`mounts.js`** — large but self-contained.
4. **`github.js`** — large, cohesive; already leans on `GIT`.
5. **`actions.js`** — custom actions + interactive scripts (share `ExRT.const`
   paths + `ExRT.actionsEditor`).
6. **`terminal.js`** — owns `ExRT.term`; xterm/tmux.
7. **Phase 2 (optional):** `upload.js`, `editor.js`.

Stop whenever satisfied — every landed step leaves a working, smaller `app.js`.

## Scope / non-goals

- **No behavior change.** Pure code relocation; every method keeps its body,
  name, and `this` semantics. No refactoring of logic, no API changes.
- **No build step / bundler / ES modules.** Plain `<script>` + globals only.
- **State is not fragmented.** All reactive fields remain in `app.js`.
- **No renaming** of public methods (templates in `index.html` call them by
  name; renames would be a separate change).
- **VERSION** is bumped to `1.2` only when the chosen set of modules has landed
  and been smoke-tested (never mid-extraction).

## Files touched

- New: `js/runtime.js`, `js/features/*.js`, `tools/check-mixins.js`.
- Modified: `js/app.js` (methods removed → mixins; composer spread; references
  rewritten to `ExRT`), `index.html` (new `<script>` tags in load order),
  `VERSION`, `CHANGELOG.md`.
