// Unit tests for the pure helpers in js/features/plugins.js.
// Loads the mixin into a vm sandbox (no cockpit/DOM needed) and calls the
// pure methods with a stub `this`.
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/features/plugins.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const P = sandbox.window.ExplorerPlugins;
assert.ok(P, 'window.ExplorerPlugins should be defined');

// stub `this` with the one cross-mixin dep the pure helpers use
const self = Object.assign(Object.create(P), {
  _versionNewer(a, b) {
    const t = s => String(s).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const x = t(a), y = t(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i]||0)-(y[i]||0); if (d) return d>0; }
    return false;
  },
});

// _pluginDescriptors: exactly the six known plugins, in order
const ds = self._pluginDescriptors();
assert.strictEqual(ds.length, 6);
// (`Array.from` rather than `.map`, and toString-tag rather than `instanceof`,
// because the descriptors come from a vm sandbox: cross-realm arrays/regexes
// don't share a [[Prototype]] with this realm's Array/RegExp, so `.map`'s
// result and `instanceof` would spuriously disagree with same-realm literals.)
assert.deepStrictEqual(Array.from(ds, d => d.key), ['explorer', 'ctop', 'iftv', 'manifest', 'hangar', 'pilot']);
assert.deepStrictEqual(Array.from(ds, d => d.label), ['Explorer', 'Cockpit Top', 'IF TV', 'Manifest', 'Hangar', 'Pilot']);
assert.deepStrictEqual(Array.from(ds, d => d.dir), ['explorer', 'ctop', 'inflighttv', 'manifest', 'hangar', 'pilot']);

// Descriptor invariants: repo shape, asset regex, settings shape
for (const d of ds) {
    assert.ok(/^ismetozalp\/[a-z]+$/.test(d.defaultRepo), `${d.key} default repo shape: ${d.defaultRepo}`);
    assert.ok(Object.prototype.toString.call(d.assetRe) === '[object RegExp]', `${d.key} assetRe is a RegExp`);
    // ctop and hangar keep no home-relative settings file → static default repo.
    if (d.settings === null) { assert.ok(['ctop', 'hangar'].includes(d.key), `${d.key} may be settings-less`); }
    else {
        assert.ok(['yaml', 'json'].includes(d.settings.fmt), `${d.key} fmt`);
        assert.ok(typeof d.settings.rel === 'string' && d.settings.rel.includes('.config/cockpit/'), `${d.key} rel`);
        assert.ok(typeof d.settings.repoKey === 'string' && d.settings.repoKey.length, `${d.key} repoKey`);
    }
}
assert.strictEqual(ds.find(d => d.key === 'iftv').settings.fmt, 'json');
assert.strictEqual(ds.find(d => d.key === 'manifest').settings.repoKey, 'update.repo');
assert.strictEqual(ds.find(d => d.key === 'explorer').settings.repoKey, 'updateRepo');

// assetRe cross-matrix: each regex matches ITS zip and rejects the others'
const zip = { explorer: 'explorer-2.2.7.zip', ctop: 'ctop-1.1.4.zip', iftv: 'inflighttv-1.0.13.zip', manifest: 'manifest-2.0.0.zip', hangar: 'hangar-1.0.0.zip', pilot: 'pilot-1.0.0.zip' };
for (const d of ds) {
    assert.ok(d.assetRe.test(zip[d.key]), `${d.key} matches ${zip[d.key]}`);
    for (const other of Object.keys(zip)) if (other !== d.key)
        assert.ok(!d.assetRe.test(zip[other]), `${d.key} regex must reject ${zip[other]}`);
    assert.ok(!d.assetRe.test(d.dir + '.zip'), `${d.key} regex needs the -version part`);
    assert.ok(!d.assetRe.test(d.dir + '-1.0.0.tar.gz'), `${d.key} regex is zip-only`);
}

// _getByPath: dotted lookup, missing paths, non-object roots
assert.strictEqual(self._getByPath({ update: { repo: 'a/b' } }, 'update.repo'), 'a/b');
assert.strictEqual(self._getByPath({ updateRepo: 'x/y' }, 'updateRepo'), 'x/y');
assert.strictEqual(self._getByPath({ a: { b: { c: 5 } } }, 'a.b.c'), 5);
assert.strictEqual(self._getByPath({ update: {} }, 'update.repo'), undefined);
assert.strictEqual(self._getByPath({}, 'update.repo'), undefined);
assert.strictEqual(self._getByPath(null, 'update.repo'), undefined);
assert.strictEqual(self._getByPath({ a: 1 }, ''), undefined);

// _resolvePluginRepo: for ALL four, using objects shaped like the real files
const D = k => ds.find(d => d.key === k);
assert.strictEqual(self._resolvePluginRepo(D('explorer'), { updateRepo: 'ismetozalp/explorer', updateCheckOnStart: true }), 'ismetozalp/explorer');
assert.strictEqual(self._resolvePluginRepo(D('explorer'), { updateRepo: 'fork/explorer' }), 'fork/explorer');
assert.strictEqual(self._resolvePluginRepo(D('iftv'), { updateRepo: 'ismetozalp/iftv', theme: 'x' }), 'ismetozalp/iftv');
assert.strictEqual(self._resolvePluginRepo(D('manifest'), { theme: 'gruvbox', update: { repo: 'ismetozalp/manifest', checkOnStartup: true } }), 'ismetozalp/manifest');
assert.strictEqual(self._resolvePluginRepo(D('manifest'), { update: { repo: 'me/mine' } }), 'me/mine');
// empties / wrong types / missing → default
assert.strictEqual(self._resolvePluginRepo(D('manifest'), { update: { repo: '  ' } }), 'ismetozalp/manifest');
assert.strictEqual(self._resolvePluginRepo(D('iftv'), { updateRepo: 42 }), 'ismetozalp/iftv');
assert.strictEqual(self._resolvePluginRepo(D('explorer'), {}), 'ismetozalp/explorer');
assert.strictEqual(self._resolvePluginRepo(D('explorer'), null), 'ismetozalp/explorer');
// pilot reads update.repo (nested JSON); hangar has no home-relative settings → always default
assert.strictEqual(self._resolvePluginRepo(D('pilot'), { update: { repo: 'ismetozalp/pilot', checkOnStartup: true } }), 'ismetozalp/pilot');
assert.strictEqual(self._resolvePluginRepo(D('pilot'), { update: { repo: 'fork/pilot' } }), 'fork/pilot');
assert.strictEqual(self._resolvePluginRepo(D('pilot'), { update: { repo: '' } }), 'ismetozalp/pilot');
assert.strictEqual(self._resolvePluginRepo(D('hangar'), { updateRepo: 'fork/hangar' }), 'ismetozalp/hangar'); // settings-less → default

// _pluginStatus: unknown/error/update/uptodate incl. v-prefix + multi-digit
assert.strictEqual(self._pluginStatus(null, '1.0.0'), 'unknown');
assert.strictEqual(self._pluginStatus('', '1.0.0'), 'unknown');
assert.strictEqual(self._pluginStatus('1.0.0', null), 'error');
assert.strictEqual(self._pluginStatus('1.0.0', '1.0.1'), 'update');
assert.strictEqual(self._pluginStatus('1.9.0', '1.10.0'), 'update');      // numeric, not lexical
assert.strictEqual(self._pluginStatus('2.2.7', 'v2.3.0'), 'update');      // v-prefix tolerated
assert.strictEqual(self._pluginStatus('1.0.1', '1.0.1'), 'uptodate');
assert.strictEqual(self._pluginStatus('2.0.0', '1.9.9'), 'uptodate');     // installed ahead

// _pluginEligible: status/force/tag/installed matrix
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'update'   }, false), true);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'uptodate' }, false), false);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'uptodate' }, true),  true);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'unknown'  }, false), false);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'unknown'  }, true),  true);
assert.strictEqual(self._pluginEligible({ installed: false, tag: 'v1', status: 'update'   }, true),  false); // not-installed never "update"
assert.strictEqual(self._pluginEligible({ installed: true,  tag: null, status: 'update'   }, true),  false); // no target tag
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'error'    }, true),  false);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'notinstalled' }, true), false);
assert.strictEqual(self._pluginEligible({ installed: true,  tag: 'v1', status: 'checking' }, true),  false);

console.log('plugins-unit: OK');
