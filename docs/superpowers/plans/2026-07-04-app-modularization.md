# app.js Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 7,188-line `js/app.js` Alpine component into per-feature global-mixin files, with no behavior change and no build step.

**Architecture:** Non-reactive privates + constants move to a first-loaded `js/runtime.js` (`window.ExRT`). Each feature's *methods* move verbatim into a `window.ExplorerX = { … }` file under `js/features/`; `app.js` keeps all reactive state and spreads the mixins into `Alpine.data`. A `tools/check-mixins.js` guard fails on duplicate keys (there is no test runner).

**Tech Stack:** Vanilla JS + Alpine.js, plain `<script>` tags (no bundler), Node for `--check`/guard only.

## Global Constraints

- **No behavior change.** Method bodies move **verbatim** — same name, same body, same `this`. No logic edits, no renames (templates call methods by name).
- **No build step / ES modules / new deps.** Plain `<script>` + globals only.
- **All reactive state stays in `app.js`.** Mixins are methods-only.
- **`this` is preserved.** Moved methods still use `this.<state>`; Alpine binds it.
- **Non-reactive registries live on `window.ExRT`** (set in `runtime.js`, loaded first). Mutable singletons are `ExRT` properties, not `let`.
- **Load order in `index.html`:** `runtime.js` → `js/features/*.js` → `app.js`.
- **VERSION → `2.0.0`** only in the final task, after smoke testing — never mid-extraction.
- **No test runner.** Per-task automated gate: `node --check` on every touched `.js` + `node tools/check-mixins.js`. Functional check is a manual browser smoke test (owner: user).

### Verification loop (every code task)

1. `node --check js/<changed>.js` and `node --check js/app.js` → exit 0, no output.
2. `node tools/check-mixins.js` → prints `OK` / exit 0 (no duplicate keys).
3. `grep -nE "^\s*<movedMethodName>\s*\(" js/app.js` for 2–3 moved methods → **no** matches (they moved, not copied).
4. Deploy `sudo make install` + hard-reload; smoke-test **only** the moved feature. (User.)

### The move recipe (used by every feature task)

To move a feature whose methods span a contiguous banner block in `app.js`:

1. **Locate** the block by its banner comment (grep the banner text — line numbers shift as tasks land).
2. **Create** `js/features/<name>.js`:
   ```js
   // <Feature> — extracted from app.js (2.0 modularization). Methods only;
   // reactive state stays in app.js, non-reactive registries live on window.ExRT.
   window.Explorer<Name> = {
       // ← paste the moved methods here, verbatim, keeping trailing commas
   };
   ```
   Method definitions in the object literal are `name(args) { … },` — exactly how
   they already appear inside `app.js`, so they paste in unchanged.
3. **Delete** the moved block from `app.js` (leave the banner comment as a
   one-line pointer, e.g. `// <Feature> methods → js/features/<name>.js`).
4. **Rewrite references** in the moved code per the ExRT table (Task 2) — only if
   the moved code used a relocated private (`_getTermInstance`, `DEFAULT_SETTINGS`, …).
5. **Add the spread** `...window.Explorer<Name>,` to the `Alpine.data` composer.
6. **Add** `<script src="js/features/<name>.js"></script>` before `app.js`.
7. Run the verification loop. Commit.

---

### Task 1: `tools/check-mixins.js` duplicate-key guard

**Files:**
- Create: `tools/check-mixins.js`

**Interfaces:**
- Produces: a CLI that exits non-zero and lists any method/property key defined in more than one of `js/app.js` + `js/features/*.js`.

- [ ] **Step 1: Write the guard**

Create `tools/check-mixins.js`:

```js
#!/usr/bin/env node
// Fails if any top-level object-literal key is defined in more than one of the
// component sources (app.js + js/features/*.js). A spread silently overwrites
// duplicates, so this is the safety net that replaces a test runner.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['js/app.js'];
const featDir = path.join(root, 'js/features');
if (fs.existsSync(featDir)) {
    for (const f of fs.readdirSync(featDir)) if (f.endsWith('.js')) files.push('js/features/' + f);
}

// Collect top-level `name(...) {` / `name: value` keys at 4-space indent (the
// component's own members are indented one level inside the object literal).
const seen = new Map(); // key -> [file,...]
const KEY = /^    (?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/;
for (const rel of files) {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const line of txt.split('\n')) {
        const m = KEY.exec(line);
        if (!m) continue;
        const k = m[1];
        if (!seen.has(k)) seen.set(k, []);
        const arr = seen.get(k);
        if (!arr.includes(rel)) arr.push(rel);
    }
}

const dups = [...seen].filter(([, fl]) => fl.length > 1);
if (dups.length) {
    console.error('Duplicate component keys (a spread would silently overwrite):');
    for (const [k, fl] of dups) console.error(`  ${k}: ${fl.join(', ')}`);
    process.exit(1);
}
console.log(`OK — ${seen.size} unique keys across ${files.length} file(s)`);
```

- [ ] **Step 2: Run it (baseline)**

Run: `node tools/check-mixins.js`
Expected: `OK — <N> unique keys across 1 file(s)` (only `app.js` exists yet), exit 0.

> Note: the `    ` (4-space) indent matcher assumes the component members sit at
> one indent level inside `Alpine.data('explorer', () => ({ … }))`, which they do.
> If Step 2 reports a surprising key count (e.g. 0), the indent differs — adjust
> the leading-space count in `KEY` to match `app.js` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add tools/check-mixins.js
git commit -m "tools: duplicate-key guard for the mixin split"
```

---

### Task 2: `js/runtime.js` — shared non-reactive namespace (`window.ExRT`)

**Files:**
- Create: `js/runtime.js`
- Modify: `js/app.js` (remove the pre-component privates/constants; rewrite their references)
- Modify: `index.html` (add the `<script>` before `app.js`)

**Interfaces:**
- Produces `window.ExRT` with:
  - `ExRT.const` — `{ DEFAULT_SETTINGS, USER_ACTIONS_PATH_SUFFIX, SYSTEM_ACTIONS_PATH, USER_SCRIPTS_DIR_SUFFIX, SYSTEM_SCRIPTS_DIR, PROMPT_START, MSG_START, PROMPT_END, DISPLAY_TYPES, LS_KEY_TABS, LS_KEY_SETTINGS }`
  - `ExRT.ops` — `{ cbs: Map, set(opId,key,fn), get(opId,key), clear(opId) }`
  - `ExRT.term` — `{ map: Map, set(id,val), get(id), del(id) }`
  - `ExRT.editor` — `{ file: null, models: Map }` (Monaco file editor + per-window models)
  - `ExRT.actionsEditor` — `{ editor: null, model: null }`
  - `ExRT.quill` — `{ editor: null }`

- [ ] **Step 1: Inventory the exact block to move**

Run: `awk 'NR>1 && /Alpine\.data\(/{exit} {print NR": "$0}' js/app.js | grep -nE "const |let |function |new Map"`
Expected: the constants (`DEFAULT_SETTINGS` … `LS_KEY_SETTINGS`), `_opCallbacks`+3 fns, `_termInstances`+3 fns, `_fileEditor`, `_winModels`, `_actionsEditor`/`_actionsEditorModel`, `_quillEditor` — all between `document.addEventListener('alpine:init'` and `Alpine.data(`.

- [ ] **Step 2: Create `js/runtime.js`**

```js
// Shared, non-reactive runtime for the Explorer component (2.0 modularization).
// Loaded before every feature file and app.js. Holds config constants and the
// "reactivity firewall" instance registries that must NOT live in reactive
// state and cannot be spread into the component. All feature mixins read/write
// these through window.ExRT.
window.ExRT = {
    const: {
        DEFAULT_SETTINGS: {
            // ← paste the current DEFAULT_SETTINGS object literal verbatim
        },
        USER_ACTIONS_PATH_SUFFIX: '/.config/cockpit/explorer/actions.json',
        SYSTEM_ACTIONS_PATH: '/etc/cockpit/explorer/actions.json',
        USER_SCRIPTS_DIR_SUFFIX: '/.config/cockpit/explorer/scripts',
        SYSTEM_SCRIPTS_DIR: '/etc/cockpit/explorer/scripts',
        PROMPT_START: '===EXPLORER-PROMPT===',
        MSG_START: '===EXPLORER-MESSAGE===',
        PROMPT_END: '===EXPLORER-END===',
        DISPLAY_TYPES: ['message', 'info', 'note', 'notify', 'progress', 'status', 'log'],
        LS_KEY_TABS: 'explorer:tabs',
        LS_KEY_SETTINGS: 'explorer:settings',
    },
    ops: {
        cbs: new Map(),
        set(opId, key, fn) { if (!this.cbs.has(opId)) this.cbs.set(opId, {}); this.cbs.get(opId)[key] = fn; },
        get(opId, key) { const o = this.cbs.get(opId); return o && o[key]; },
        clear(opId) { this.cbs.delete(opId); },
    },
    term: {
        map: new Map(),
        set(id, val) { this.map.set(id, val); },
        get(id) { return this.map.get(id); },
        del(id) { /* paste the current _deleteTermInstance body, using this.map */ },
    },
    editor: { file: null, models: new Map() },
    actionsEditor: { editor: null, model: null },
    quill: { editor: null },
};
```

> Copy the real bodies of `_setOpCallback/_getOpCallback/_clearOpCallbacks`,
> `_setTermInstance/_getTermInstance/_deleteTermInstance` and the real
> `DEFAULT_SETTINGS` from `app.js` — the skeleton above shows only the shape.

- [ ] **Step 3: Delete the moved block from `app.js`**

Remove the `const DEFAULT_SETTINGS = … ` through the `let _quillEditor = null;`
lines (everything the Step-1 inventory listed) from the top of `app.js`, inside
the `alpine:init` callback but above `Alpine.data(`.

- [ ] **Step 4: Rewrite the references in `app.js`**

Apply these replacements across `js/app.js` (they are the only readers today):

| Old (bare) | New |
|---|---|
| `DEFAULT_SETTINGS` | `ExRT.const.DEFAULT_SETTINGS` |
| `USER_ACTIONS_PATH_SUFFIX` | `ExRT.const.USER_ACTIONS_PATH_SUFFIX` |
| `SYSTEM_ACTIONS_PATH` | `ExRT.const.SYSTEM_ACTIONS_PATH` |
| `USER_SCRIPTS_DIR_SUFFIX` | `ExRT.const.USER_SCRIPTS_DIR_SUFFIX` |
| `SYSTEM_SCRIPTS_DIR` | `ExRT.const.SYSTEM_SCRIPTS_DIR` |
| `PROMPT_START` / `MSG_START` / `PROMPT_END` | `ExRT.const.PROMPT_START` / … |
| `DISPLAY_TYPES` | `ExRT.const.DISPLAY_TYPES` |
| `LS_KEY_TABS` / `LS_KEY_SETTINGS` | `ExRT.const.LS_KEY_TABS` / … |
| `_setOpCallback(a,b,c)` | `ExRT.ops.set(a,b,c)` |
| `_getOpCallback(a,b)` | `ExRT.ops.get(a,b)` |
| `_clearOpCallbacks(a)` | `ExRT.ops.clear(a)` |
| `_setTermInstance(a,b)` | `ExRT.term.set(a,b)` |
| `_getTermInstance(a)` | `ExRT.term.get(a)` |
| `_deleteTermInstance(a)` | `ExRT.term.del(a)` |
| `_fileEditor` (read/assign) | `ExRT.editor.file` |
| `_winModels` | `ExRT.editor.models` |
| `_actionsEditor` | `ExRT.actionsEditor.editor` |
| `_actionsEditorModel` | `ExRT.actionsEditor.model` |
| `_quillEditor` | `ExRT.quill.editor` |

Confirm none remain: `grep -nE "\b_(setOpCallback|getOpCallback|clearOpCallbacks|setTermInstance|getTermInstance|deleteTermInstance|opCallbacks|termInstances|fileEditor|winModels|actionsEditor|actionsEditorModel|quillEditor)\b|\bDEFAULT_SETTINGS\b|\bDISPLAY_TYPES\b" js/app.js` → **no** matches (all now `ExRT.…`).

- [ ] **Step 5: Add the script tag**

In `index.html`, immediately after `<script src="js/git.js"></script>` (line ~2101), add:

```html
<script src="js/runtime.js"></script>
```

- [ ] **Step 6: Verify**

```bash
node --check js/runtime.js && node --check js/app.js && node tools/check-mixins.js
```
Expected: all exit 0; guard prints `OK`.

- [ ] **Step 7: Commit**

```bash
git add js/runtime.js js/app.js index.html
git commit -m "refactor: extract non-reactive runtime + constants to js/runtime.js (ExRT)"
```

- [ ] **Step 8: Smoke test (user)**

Load Explorer; confirm it starts, settings load, a terminal opens, an editor opens, a custom action runs. This one task touches the shared registries, so it is the highest-value manual check.

---

### Task 3: `js/features/grub.js` — GRUB editor (proves the pattern)

**Files:**
- Create: `js/features/grub.js` (`window.ExplorerGrub`)
- Modify: `js/app.js` (remove GRUB methods; add spread)
- Modify: `index.html` (add script tag)

**Interfaces:**
- Consumes from earlier tasks: `window.ExRT` (Task 2). GRUB code uses `this.grub`
  state (stays in app.js), `this.toast`, `FS`, `cockpit`, `Util` — none relocated,
  so likely **no** ExRT rewrites needed here (verify in Step 3).

- [ ] **Step 1: Locate the block**

Run: `grep -nE "GRUB editor|_regenGrub|loadGrub|saveGrub|grub\." js/app.js | head`
The section runs from the banner `// ───── GRUB editor ` to just before the next
banner (`// ───── Dialogs`). Confirm its start/end lines.

- [ ] **Step 2: Move the methods (recipe)**

Follow the **move recipe** (top of plan): cut every `name(args) { … },` between the
GRUB banner and the next banner into `js/features/grub.js` wrapped as:

```js
// GRUB boot-loader editor — extracted from app.js (2.0). Methods only.
window.ExplorerGrub = {
    // ← moved GRUB methods, verbatim
};
```

Replace the moved block in `app.js` with a pointer comment:
`// GRUB editor methods → js/features/grub.js`.

- [ ] **Step 3: Rewrite relocated refs (only if present)**

Run inside the new file: `grep -nE "\b_(getTermInstance|fileEditor|opCallbacks)|DEFAULT_SETTINGS" js/features/grub.js`
If any match, rewrite to the `ExRT.…` path per Task 2's table. (GRUB is not
expected to use any; this step is the check.)

- [ ] **Step 4: Add spread + script tag**

In `app.js`, in the `Alpine.data('explorer', () => ({ … }))` return object, add
near the other feature spreads (create the block if first):

```js
        ...window.ExplorerGrub,
```

In `index.html`, after `<script src="js/runtime.js"></script>`, add:

```html
<script src="js/features/grub.js"></script>
```

- [ ] **Step 5: Verify**

```bash
node --check js/features/grub.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(loadGrub|saveGrub)\s*\(" js/app.js   # expect: no matches
```
Expected: checks exit 0; guard `OK`; grep empty.

- [ ] **Step 6: Commit**

```bash
git add js/features/grub.js js/app.js index.html
git commit -m "refactor: move GRUB editor to js/features/grub.js"
```

- [ ] **Step 7: Smoke test (user):** open **⏻ GRUB**, edit + (optionally) regenerate.

---

### Task 4: `js/features/mounts.js` — Mounts / fstab / SMB / NFS

**Files:** Create `js/features/mounts.js` (`window.ExplorerMounts`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT`. Uses `this.mounts` state (stays), `FS`, `cockpit`, `Util`, `this.toast`, `this.askConfirm`.

- [ ] **Step 1: Locate** — banner `// ───── Mounts / fstab editor ` through the end of the NFS section, just before `// ───── GRUB editor `. Confirm start/end lines (`grep -n "Mounts / fstab\|SMB/CIFS\|// ── NFS\|GRUB editor" js/app.js`).

- [ ] **Step 2: Move the methods** into `js/features/mounts.js`:

```js
// Mounts panel — fstab editor, SMB/CIFS and NFS. Extracted from app.js (2.0).
window.ExplorerMounts = {
    // ← moved methods, verbatim
};
```
Leave a pointer comment in `app.js`.

- [ ] **Step 3: Rewrite relocated refs (only if present)** — `grep -nE "DEFAULT_SETTINGS|_getTermInstance|_fileEditor" js/features/mounts.js`; rewrite any hit per Task 2's table.

- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerMounts,` in the composer; `<script src="js/features/mounts.js"></script>` after `grub.js` in `index.html`.

- [ ] **Step 5: Verify**

```bash
node --check js/features/mounts.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(loadFstab|saveFstab)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit**

```bash
git add js/features/mounts.js js/app.js index.html
git commit -m "refactor: move Mounts (fstab/SMB/NFS) to js/features/mounts.js"
```

- [ ] **Step 7: Smoke test (user):** open **⛁ Mounts**, all three tabs; save fstab (or cancel).

---

### Task 5: `js/features/github.js` — GitHub + repo cache + run command

**Files:** Create `js/features/github.js` (`window.ExplorerGithub`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT`, `GIT` (git.js), `this.gh`/`this.repoCache`/`this.runCmd` state (stays), `this.toast`, `FS`, `cockpit`.

- [ ] **Step 1: Locate the (multiple) blocks.** GitHub spans several banners — move all of them into one file:
  - `// ─── github state ` init block (`_refreshGhState`, `_tryAutoGhLogin`, `_withGhAuth`, `ghLogin`, …)
  - `// ── Repo cache model ` + `// ── Cached repos toolbar `
  - `// ─── RUN COMMAND `
  - `// ─── GITHUB PANEL `, `// ───── Update check / self-update `, `// ─── Checkout & cache management `, `// ─── Type-to-confirm `, `// ─── COMMIT BROWSER `, `// ─── Current-repo toolbar actions `, `// ─── PUBLISH PLAIN FOLDER TO GITHUB `

  Run `grep -nE "github state|Repo cache model|Cached repos|RUN COMMAND|GITHUB PANEL|Update check|Checkout & cache|Type-to-confirm|COMMIT BROWSER|Current-repo toolbar|PUBLISH PLAIN" js/app.js` to get the exact ranges.

- [ ] **Step 2: Move the methods** from every listed block into `js/features/github.js`:

```js
// GitHub integration — auth, repo cache, run command, PR panel, update/
// self-update, checkout, commit browser, repo actions, publish. From app.js (2.0).
window.ExplorerGithub = {
    // ← moved methods, verbatim (in original order)
};
```
Leave pointer comments at each vacated banner. **Do not move** the `gh:`,
`repoCache:`, `runCmd:` **state** objects — those stay in `app.js`'s state.

- [ ] **Step 3: Rewrite relocated refs (only if present)** — `grep -nE "DEFAULT_SETTINGS|_getTermInstance|_opCallbacks|_setOpCallback|_getOpCallback" js/features/github.js`; rewrite any hit (self-update/output uses op callbacks → `ExRT.ops.*`).

- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerGithub,`; `<script src="js/features/github.js"></script>`.

- [ ] **Step 5: Verify**

```bash
node --check js/features/github.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(ghLoadPrs|checkForUpdate|openCommitBrowser)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit**

```bash
git add js/features/github.js js/app.js index.html
git commit -m "refactor: move GitHub integration to js/features/github.js"
```

- [ ] **Step 7: Smoke test (user):** open the GitHub panel, list repos/PRs, run a repo action (Fetch), open the commit browser.

---

### Task 6: `js/features/actions.js` — custom actions + interactive scripts

**Files:** Create `js/features/actions.js` (`window.ExplorerActions`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT` (`ExRT.const.*` for the action/script paths + prompt markers; `ExRT.actionsEditor.*` for the Monaco actions editor). Uses `this.customActions`/`this.actionsMgr` state (stays), `FS`, `cockpit`, `Util`, dialogs.

- [ ] **Step 1: Locate** — the `// ───── Custom actions ` block through `// ── Global (file-independent) actions ` (ends before `// ── Streaming-output helpers `), **plus** the two `// ───── Interactive scripts ` blocks. `grep -nE "Custom actions|Per-action Form|Monaco-backed code editor|Global \(file-independent\)|Interactive scripts" js/app.js`.

- [ ] **Step 2: Move the methods** into `js/features/actions.js`:

```js
// Custom actions (form/JSON editing, Monaco actions editor, global actions) and
// the interactive Script Prompt Protocol. Extracted from app.js (2.0).
window.ExplorerActions = {
    // ← moved methods, verbatim
};
```
Pointer comments at vacated banners. Keep `customActions`/`actionsMgr` **state** in `app.js`.

- [ ] **Step 3: Rewrite relocated refs** — this feature DOES use relocated names. Rewrite in the new file: `USER_ACTIONS_PATH_SUFFIX/SYSTEM_ACTIONS_PATH/USER_SCRIPTS_DIR_SUFFIX/SYSTEM_SCRIPTS_DIR` → `ExRT.const.…`; `PROMPT_START/MSG_START/PROMPT_END/DISPLAY_TYPES` → `ExRT.const.…`; `_actionsEditor`/`_actionsEditorModel` → `ExRT.actionsEditor.editor`/`.model`. Confirm: `grep -nE "\b(USER_ACTIONS_PATH_SUFFIX|PROMPT_START|_actionsEditor)\b" js/features/actions.js` → all now `ExRT.…` (no bare names).

- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerActions,`; `<script src="js/features/actions.js"></script>`.

- [ ] **Step 5: Verify**

```bash
node --check js/features/actions.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(runCustomAction|reloadActions|openActionsManager)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit**

```bash
git add js/features/actions.js js/app.js index.html
git commit -m "refactor: move custom actions + interactive scripts to js/features/actions.js"
```

- [ ] **Step 7: Smoke test (user):** open **⚙ Actions** (form + JSON/YAML), run a custom action, run an interactive script, **↻ Reload actions**.

---

### Task 7: `js/features/terminal.js` — integrated terminals + tmux

**Files:** Create `js/features/terminal.js` (`window.ExplorerTerminal`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT` (`ExRT.term.*` for xterm/PTY instances). Uses `this.tmux`/`this.shells`/terminal tab state (stays), `Terminal`/`FitAddon` globals, `cockpit`, `this.toast`, `this._copyToClipboard` (stays in app.js).

- [ ] **Step 1: Locate** — `// ──────── Integrated terminals ` through `// ── Sub-tab path hover popover ` end, i.e. up to just before `// ── Repo cache model `. Includes the tmux session manager. `grep -nE "Integrated terminals|tmux session manager|Sub-tab path hover" js/app.js`.

- [ ] **Step 2: Move the methods** into `js/features/terminal.js`:

```js
// Integrated terminals (xterm.js + Cockpit PTY), the tmux session manager, and
// the sub-tab path popover. Extracted from app.js (2.0).
window.ExplorerTerminal = {
    // ← moved methods, verbatim
};
```
Pointer comments at vacated banners. Keep `tmux`/`shells`/terminal state in `app.js`.

- [ ] **Step 3: Rewrite relocated refs** — this feature uses `ExRT.term`. Rewrite `_getTermInstance/_setTermInstance/_deleteTermInstance` → `ExRT.term.get/set/del`. Confirm: `grep -nE "\b_(get|set|delete)TermInstance\b|\b_termInstances\b" js/features/terminal.js` → none (all `ExRT.term.…`).

- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerTerminal,`; `<script src="js/features/terminal.js"></script>`.

- [ ] **Step 5: Verify**

```bash
node --check js/features/terminal.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(addTerminalToTab|openTmuxSession)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit**

```bash
git add js/features/terminal.js js/app.js index.html
git commit -m "refactor: move integrated terminals + tmux to js/features/terminal.js"
```

- [ ] **Step 7: Smoke test (user):** open a terminal tab, split terminal, open/attach a tmux session via the manager and via `+`, copy from a terminal, restore on reload.

---

### Task 8 (phase 2, optional): `js/features/upload.js`

**Files:** Create `js/features/upload.js` (`window.ExplorerUpload`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT` (`ExRT.ops.*` for upload progress ops). Uses upload/DnD state (stays), `FS`, `cockpit`.

- [ ] **Step 1: Locate** — `// ───── Upload ` + `// ───── Drag & drop ` + `// ───── Archive ` (contiguous, ~2015–2511). `grep -nE "// ───── Upload|Drag & drop|// ───── Archive" js/app.js`.
- [ ] **Step 2: Move the methods** into `js/features/upload.js` as `window.ExplorerUpload = { … }` (verbatim); pointer comments left behind.
- [ ] **Step 3: Rewrite relocated refs** — `grep -nE "_setOpCallback|_getOpCallback|_clearOpCallbacks|DEFAULT_SETTINGS" js/features/upload.js`; rewrite hits → `ExRT.ops.*` / `ExRT.const.*`.
- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerUpload,`; `<script src="js/features/upload.js"></script>`.
- [ ] **Step 5: Verify**

```bash
node --check js/features/upload.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(_doUpload|extractHere)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit** — `git commit -m "refactor: move upload/drag-drop/archive to js/features/upload.js"`.
- [ ] **Step 7: Smoke test (user):** drag-drop a file and a folder; extract an archive; upload via button.

---

### Task 9 (phase 2, optional): `js/features/editor.js` — preview + editor + windows

**Files:** Create `js/features/editor.js` (`window.ExplorerEditor`); modify `app.js`, `index.html`.

**Interfaces:** Consumes `window.ExRT` (`ExRT.editor.file`/`.models`, `ExRT.quill.editor`). Uses window/preview/editor state (stays), Monaco/Quill globals, `FS`.

- [ ] **Step 1: Locate** — `// ───── Preview `, `// ───── Editor (Monaco + Quill WYSIWYG) `, `// ── Window management core `, `// ── Close / minimize windows ` (~1350–1776). `grep -nE "// ───── Preview|Editor \(Monaco|Window management core|Close / minimize" js/app.js`.
- [ ] **Step 2: Move the methods** into `js/features/editor.js` as `window.ExplorerEditor = { … }` (verbatim); pointer comments.
- [ ] **Step 3: Rewrite relocated refs** — rewrite `_fileEditor`→`ExRT.editor.file`, `_winModels`→`ExRT.editor.models`, `_quillEditor`→`ExRT.quill.editor`. Confirm none bare remain in the new file.
- [ ] **Step 4: Add spread + script tag** — `...window.ExplorerEditor,`; `<script src="js/features/editor.js"></script>`.
- [ ] **Step 5: Verify**

```bash
node --check js/features/editor.js && node --check js/app.js && node tools/check-mixins.js
grep -nE "^\s*(openEditor|openPreview|closeActiveWindow)\s*\(" js/app.js   # expect: no matches
```

- [ ] **Step 6: Commit** — `git commit -m "refactor: move preview/editor/windows to js/features/editor.js"`.
- [ ] **Step 7: Smoke test (user):** preview a text/image/pdf; edit + save a file (Monaco); WYSIWYG edit a markdown file; Esc closes windows.

---

### Task 10: Version + changelog

**Files:** Modify `VERSION`, `CHANGELOG.md`.

- [ ] **Step 1: Bump** `VERSION` to:

```
2.0.0
```

- [ ] **Step 2: Changelog** — insert at the top of the entries:

```markdown
## 2.0.0

- **Internal: `app.js` split into per-feature modules.** The 7k-line component
  is now composed from `js/runtime.js` (shared non-reactive registries +
  constants) and `js/features/*.js` (grub, mounts, github, actions, terminal[,
  upload, editor]) via global method mixins spread into `Alpine.data`. No
  behavior change; no build step. A `tools/check-mixins.js` guard fails the
  build on duplicate method keys.
```

- [ ] **Step 3: Verify** — `cat VERSION` → `2.0.0`; `node tools/check-mixins.js` → `OK`.

- [ ] **Step 4: Commit** — `git add VERSION CHANGELOG.md && git commit -m "2.0.0 — app.js modularized into feature mixins"`.

---

## Notes for the implementer

- **Order is mandatory:** Task 1 (guard) and Task 2 (`runtime.js`) come first —
  every later task depends on `ExRT` and the guard. Then grub → mounts → github
  → actions → terminal → (upload, editor). Each is one revertable commit.
- **Verbatim moves only.** If you feel tempted to "improve" a method while moving
  it, don't — that turns a mechanical, reviewable diff into a risky one. Behavior
  changes are a separate PR.
- **The guard is the safety net.** `node tools/check-mixins.js` must print `OK`
  after every task; a duplicate key means a method was copied, not moved.
- **Line numbers drift.** Always re-locate a section by its banner comment
  (grep), never by the line numbers quoted in the spec.
- **Smoke tests are the user's.** There is no runtime test here; each task ends
  with a specific manual check the user performs before the next task lands.
