// Flow tests for js/features/plugins.js using vm + stub globals (no cockpit/DOM).
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/features/plugins.js', import.meta.url), 'utf8');

// ---- mutable stub state ----
let files = {};                 // path -> string content
let installExit = 0;            // exit code the fake install channel reports
const spawns = [];              // recorded cockpit.spawn argv[0..]
let latestByRepo = {};          // repo -> { tag, version }

const sandbox = {
  window: {}, console,
  TextDecoder: global.TextDecoder,
  document: { getElementById: () => ({ scrollTop: 0, scrollHeight: 0 }) },
  FS: {
    async readText(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); },
    async writeText(p, c) { files[p] = c; },
    async mkdir() {},
    async statOne(p) { if (('dir:' + p) in files) return {}; throw new Error('no ' + p); },
  },
  Util: { shq: s => "'" + String(s).replace(/'/g, "'\\''") + "'", dirname: p => p.replace(/\/[^/]*$/, '') },
  cockpit: {
    async spawn(argv) { spawns.push(argv.join(' ')); if (argv[0] === 'mktemp') return '/tmp/wk\n'; return ''; },
    channel() {
      const l = {};
      return {
        addEventListener(type, cb) {
          l[type] = cb;
          if (type === 'close') { if (l.message) l.message(null, 'installing…\ninstall done.\n');
            cb(null, installExit === 0 ? { 'exit-status': 0 } : { 'exit-status': installExit }); }
        },
        close() {},
      };
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const P = sandbox.window.ExplorerPlugins;

function makeThis(extra = {}) {
  return Object.assign(Object.create(P), {
    homePath: '/home/u',
    pluginUpd: { open: true, checking: false, updating: false, force: false, rows: [], log: '', finished: false },
    toast() {},
    $nextTick(cb) { cb && cb(); },
    _versionNewer(a, b) { const t = s => String(s).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); const x = t(a), y = t(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i]||0)-(y[i]||0); if (d) return d>0; } return false; },
    async _fetchLatestRelease(repo) { return latestByRepo[repo] || null; },
    // stub the cross-mixin downloader (defined in github.js) — return a zip path
    async _downloadReleaseZip(repo, tag, dir) { spawns.push('download ' + repo + ' ' + tag + ' ' + dir); return '/tmp/wk/' + dir + '-x.zip'; },
  }, extra);
}

// ===== updatePlugin: fresh install success =====
(async () => {
  files = {}; installExit = 0; spawns.length = 0;
  const self = makeThis();
  const row = { key: 'iftv', label: 'IF TV', dir: 'inflighttv', repo: 'ismetozalp/iftv',
    installed: false, base: '/usr/share/cockpit', current: null, latest: '1.0.13', tag: 'v1.0.13',
    status: 'notinstalled', busy: false, selected: true, message: '' };
  self.pluginUpd.rows = [row];
  await self.updatePlugin(row);
  assert.strictEqual(row.installed, true, 'installed flips true');
  assert.strictEqual(row.current, '1.0.13');
  assert.strictEqual(row.status, 'uptodate');
  assert.strictEqual(row.selected, false, 'selection cleared after install');
  assert.strictEqual(row.busy, false);
  assert.strictEqual(self.pluginUpd.updating, false);
  assert.strictEqual(self.pluginUpd.finished, true);
  assert.ok(/IF TV/.test(self.pluginUpd.log) && /install done/.test(self.pluginUpd.log), 'log streamed');
  assert.ok(spawns.some(s => /download ismetozalp\/iftv v1.0.13 inflighttv/.test(s)), 'downloaded with dir');
  assert.ok(spawns.some(s => /unzip/.test(s)), 'unzipped');
  assert.ok(spawns.some(s => /rm -rf/.test(s)), 'cleaned work dir');
  const recorded = JSON.parse(files['/home/u/.config/cockpit/explorer/plugin-versions.json']);
  assert.strictEqual(recorded.iftv, '1.0.13', 'version recorded for VERSION-less plugin');
  console.log('flow: install-success OK');
})()

// ===== updatePlugin: install failure =====
.then(async () => {
  files = {}; installExit = 1; spawns.length = 0;
  const self = makeThis();
  const row = { key: 'ctop', label: 'Cockpit Top', dir: 'ctop', repo: 'ismetozalp/ctop',
    installed: true, base: '/usr/share/cockpit', current: '1.1.3', latest: '1.1.4', tag: 'v1.1.4',
    status: 'update', busy: false, selected: false, message: '' };
  self.pluginUpd.rows = [row];
  await self.updatePlugin(row);
  assert.strictEqual(row.status, 'error', 'status error on non-zero install');
  assert.ok(/install exit 1/.test(row.message), 'message carries exit: ' + row.message);
  assert.ok(/ERROR/.test(self.pluginUpd.log), 'error logged');
  assert.strictEqual(self.pluginUpd.finished, false, 'finished stays false on failure');
  console.log('flow: install-failure OK');
})

// ===== installSelectedPlugins: only notinstalled+selected+tag =====
.then(async () => {
  files = {}; installExit = 0;
  const self = makeThis();
  const mk = (o) => Object.assign({ installed: false, base: '/usr/share/cockpit', current: null, latest: '1.0.0', tag: 'v1.0.0', busy: false, selected: false, message: '' }, o);
  const a = mk({ key: 'iftv', label: 'IF TV', dir: 'inflighttv', repo: 'r/iftv', status: 'notinstalled', selected: true });
  const b = mk({ key: 'ctop', label: 'Cockpit Top', dir: 'ctop', repo: 'r/ctop', status: 'notinstalled', selected: false });
  const c = mk({ key: 'explorer', label: 'Explorer', dir: 'explorer', repo: 'r/explorer', status: 'uptodate', installed: true, selected: true });
  self.pluginUpd.rows = [a, b, c];
  await self.installSelectedPlugins();
  assert.strictEqual(a.installed, true, 'selected not-installed → installed');
  assert.strictEqual(b.installed, false, 'unselected → untouched');
  assert.strictEqual(c.status, 'uptodate', 'already-installed row not part of install-selected');
  console.log('flow: install-selected OK');
})

// ===== updateAllPlugins: eligibility (update always; uptodate/unknown only with force) =====
.then(async () => {
  files = {}; installExit = 0;
  const self = makeThis();
  const mk = (o) => Object.assign({ installed: true, base: '/usr/share/cockpit', current: '1.0.0', latest: '1.0.1', tag: 'v1.0.1', busy: false, selected: false, message: '' }, o);
  const upd = mk({ key: 'explorer', label: 'Explorer', dir: 'explorer', repo: 'r/e', status: 'update' });
  const utd = mk({ key: 'ctop', label: 'Cockpit Top', dir: 'ctop', repo: 'r/c', status: 'uptodate', current: '1.0.1' });
  self.pluginUpd.rows = [upd, utd];
  self.pluginUpd.force = false;
  await self.updateAllPlugins();
  assert.strictEqual(upd.current, '1.0.1', 'update row updated');   // status already 1.0.1 latest
  assert.strictEqual(utd.busy, false);
  // With force, the up-to-date row is reinstalled too (current stays latest, finished true)
  self.pluginUpd.force = true; self.pluginUpd.finished = false;
  await self.updateAllPlugins();
  assert.strictEqual(self.pluginUpd.finished, true, 'force reinstall ran');
  console.log('flow: update-all eligibility OK');
})

// ===== checkAllPlugins: computes statuses from fake FS + release stub =====
.then(async () => {
  const self = makeThis();
  // explorer installed & updateable; ctop installed & uptodate; iftv installed but NO VERSION → unknown; manifest NOT installed
  files = {
    'dir:/usr/share/cockpit/explorer': '1', '/usr/share/cockpit/explorer/VERSION': '2.2.6\n',
    'dir:/usr/share/cockpit/ctop': '1', '/usr/share/cockpit/ctop/VERSION': '1.1.4\n',
    'dir:/usr/share/cockpit/inflighttv': '1',   // no VERSION file
    // manifest dir absent → notinstalled
    '/home/u/.config/cockpit/explorer/settings.yml': 'updateRepo: ismetozalp/explorer\n',
    // NON-default repo in the JSON settings — proves _readPluginRepo actually
    // reads+parses the file (JSON.parse path) rather than silently defaulting.
    '/home/u/.config/cockpit/inflighttv/settings.json': JSON.stringify({ updateRepo: 'forkuser/iftv' }),
  };
  latestByRepo = {
    'ismetozalp/explorer': { tag: 'v2.2.8', version: '2.2.8' },
    'ismetozalp/ctop': { tag: 'v1.1.4', version: '1.1.4' },
    'forkuser/iftv': { tag: 'v9.9.9', version: '9.9.9' },   // only reached if the fork repo was parsed from settings
    'ismetozalp/manifest': { tag: 'v2.0.0', version: '2.0.0' },
  };
  self.pluginUpd.rows = self._pluginDescriptors().map(d => ({ key: d.key, label: d.label, dir: d.dir, repo: d.defaultRepo, installed: false, base: '/usr/share/cockpit', current: null, latest: null, tag: null, status: 'checking', busy: false, selected: false, message: '' }));
  await self.checkAllPlugins();
  const R = k => self.pluginUpd.rows.find(r => r.key === k);
  assert.strictEqual(R('explorer').status, 'update');
  assert.strictEqual(R('explorer').current, '2.2.6');
  assert.strictEqual(R('explorer').latest, '2.2.8');
  assert.strictEqual(R('explorer').repo, 'ismetozalp/explorer');
  assert.strictEqual(R('ctop').status, 'uptodate');
  assert.strictEqual(R('iftv').status, 'unknown', 'installed but no VERSION → unknown');
  assert.strictEqual(R('iftv').repo, 'forkuser/iftv', 'repo parsed from JSON settings, not defaulted');
  assert.strictEqual(R('iftv').latest, '9.9.9', 'latest fetched for the parsed fork repo');
  assert.strictEqual(R('manifest').status, 'notinstalled');
  assert.strictEqual(R('manifest').repo, 'ismetozalp/manifest');  // static default (no settings read)
  assert.strictEqual(self.pluginUpd.checking, false);
  console.log('flow: checkAll status matrix OK');
  console.log('plugins-flow: OK');
})
.catch(e => { console.error('plugins-flow FAILED:', e); process.exit(1); });
