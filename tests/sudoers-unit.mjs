// Unit tests for the pure helpers in js/features/sudoers.js — username
// validation, getent passwd/group parsing, admin-set computation, sudoers.d
// content + NOPASSWD detection, and the self / last-admin safety guards. No
// browser, no cockpit: the mixin is vm-loaded and its pure methods called
// directly. The filename is passed so node's --experimental-test-coverage
// attributes these lines to js/features/sudoers.js.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {} };
vm.runInNewContext(
    fs.readFileSync(new URL('../js/features/sudoers.js', import.meta.url), 'utf8'),
    sandbox,
    { filename: new URL('../js/features/sudoers.js', import.meta.url).pathname });
const S = sandbox.window.ExplorerSudoers;
assert.ok(S, 'ExplorerSudoers mixin defined');

// Values built inside the vm carry the sandbox realm's prototypes, so
// deepStrictEqual against test-realm literals fails on the prototype check.
// Rehome them to plain test-realm structures first.
const plain = x => JSON.parse(JSON.stringify(x));

// ── username validation (the first line of defence against injection) ──
for (const ok of ['ismet', 'a', 'user_1', 'foo-bar', '_svc', 'a'.repeat(32)]) {
    assert.ok(S._suValidUsername(ok), `"${ok}" should be valid`);
}
for (const bad of ['', 'Ismet', '1user', '-user', 'user name', 'user;rm', 'a'.repeat(33),
    'user$x', 'root/x', 'a.b', 'usér', null, undefined, 42]) {
    assert.ok(!S._suValidUsername(bad), `${JSON.stringify(bad)} should be invalid`);
}

// ── getent passwd parsing + real-user filter ──
const passwdText = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'ismet:x:1000:1000:Ismet:/home/ismet:/bin/bash',
    'alice:x:1001:1001:Alice,,,:/home/alice:/bin/bash',
    'nobody:x:65534:65534:Nobody:/:/usr/sbin/nologin',
    'malformed-line-without-fields',
].join('\n');
const passwd = S._suParsePasswd(passwdText);
assert.strictEqual(passwd.length, 5, 'malformed line skipped, 5 valid rows');
assert.deepStrictEqual(plain(passwd[2]), { name: 'ismet', uid: 1000, gid: 1000, gecos: 'Ismet', home: '/home/ismet', shell: '/bin/bash' });
const real = S._suRealUsers(passwd);
assert.deepStrictEqual(plain(real.map(u => u.name)), ['ismet', 'alice'], 'real users = uid 1000..65533 only (root/daemon/nobody excluded)');

// ── group parsing + admin set (explicit members ∪ primary-gid members) ──
const grp = S._suParseGroup('wheel:x:10:ismet,carol\n');
assert.deepStrictEqual(plain(grp), { name: 'wheel', gid: 10, members: ['ismet', 'carol'] });
assert.strictEqual(S._suParseGroup(''), null, 'empty group text → null');
// bob has wheel as PRIMARY gid (10) but isn't in the member list; must still count.
const passwd2 = S._suParsePasswd([
    'ismet:x:1000:1000:Ismet:/home/ismet:/bin/bash',
    'carol:x:1002:1002:Carol:/home/carol:/bin/bash',
    'bob:x:1003:10:Bob:/home/bob:/bin/bash',
].join('\n'));
const admins = S._suAdminSet(grp, passwd2);
assert.deepStrictEqual([...admins].sort(), ['bob', 'carol', 'ismet'], 'admin set unions members and primary-gid users');
assert.strictEqual(S._suAdminSet(null, passwd2).size, 0, 'no group → empty admin set');

// ── sudoers.d content + NOPASSWD detection ──
assert.strictEqual(S._suManagedBase('ismet'), '90-explorer-ismet');
assert.strictEqual(S._suNopasswdContent('ismet'),
    '# Managed by Cockpit Explorer - passwordless sudo for ismet\nismet ALL=(ALL) NOPASSWD:ALL\n');
assert.ok(S._suHasNopasswd('ismet ALL=(ALL) NOPASSWD:ALL\n', 'ismet'));
assert.ok(S._suHasNopasswd('  alice   ALL=(ALL) NOPASSWD: /bin/systemctl\n', 'alice'));
assert.ok(!S._suHasNopasswd('ismet ALL=(ALL) ALL\n', 'ismet'), 'plain sudo (no NOPASSWD) → false');
assert.ok(!S._suHasNopasswd('bob ALL=(ALL) NOPASSWD:ALL\n', 'alice'), 'wrong user → false');
assert.ok(!S._suHasNopasswd('', 'ismet'));

// ── sudoers.d directory blob parsing + nopasswd set ──
const dirBlob =
    '<<FILE:90-explorer-ismet>>\n# Managed by Cockpit Explorer - passwordless sudo for ismet\nismet ALL=(ALL) NOPASSWD:ALL\n\n' +
    '<<FILE:alice>>\nalice ALL=(ALL) NOPASSWD:ALL\n\n' +   // admin's OWN file, not ours
    '<<FILE:90-cloud-init-users>>\n# cloud stuff\n\n';
const dirMap = S._suParseSudoersDir(dirBlob);
assert.deepStrictEqual([...Object.keys(dirMap)].sort(), ['90-cloud-init-users', '90-explorer-ismet', 'alice']);
assert.ok(/NOPASSWD/.test(dirMap['90-explorer-ismet']));
const npSet = S._suNopasswdSet(dirMap, [{ name: 'ismet' }, { name: 'alice' }, { name: 'carol' }]);
// Only OUR managed drop-in counts. alice has NOPASSWD via her own admin-owned
// /etc/sudoers.d/alice — we neither manage nor claim to toggle that.
assert.deepStrictEqual([...npSet], ['ismet'], 'only the app-managed 90-explorer-<user> drop-in is counted');

// ── safety guards ──
assert.ok(S._suIsSelf('ismet', 'ismet'));
assert.ok(!S._suIsSelf('alice', 'ismet'));
assert.ok(!S._suIsSelf('ismet', ''));
const oneAdmin = new Set(['ismet']);
const twoAdmins = new Set(['ismet', 'alice']);
assert.ok(S._suIsLastAdmin('ismet', oneAdmin), 'sole admin → last admin');
assert.ok(!S._suIsLastAdmin('ismet', twoAdmins), 'two admins → not last');
assert.ok(!S._suIsLastAdmin('bob', oneAdmin), 'non-admin → not last admin');

// ── admin-group-from-policy (prefer the group sudoers actually grants) ──
const bothExist = { wheel: true, sudo: true };
assert.strictEqual(S._suGroupFromPolicy('%wheel\tALL=(ALL)\tALL\n', bothExist), 'wheel');
assert.strictEqual(S._suGroupFromPolicy('%sudo ALL=(ALL:ALL) ALL\n', bothExist), 'sudo', 'only %sudo granted → sudo even though wheel exists');
assert.strictEqual(S._suGroupFromPolicy('# %wheel ALL=(ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n', bothExist), 'sudo', 'commented %wheel is not a grant');
assert.strictEqual(S._suGroupFromPolicy('Defaults env_reset\n', bothExist), null, 'neither group granted → null');
assert.strictEqual(S._suGroupFromPolicy('%wheel ALL=(ALL) ALL\n', { wheel: false, sudo: true }), null, 'granted group must also exist');
assert.strictEqual(S._suGroupFromPolicy('', bothExist), null);

// ── effective passwordless/sudo from `sudo -l -U <user>` (authoritative) ──
const sudoListNopasswd =
    'Matching Defaults entries for ismet on host:\n    !visiblepw, env_reset\n\n' +
    'User ismet may run the following commands on host:\n    (ALL) ALL\n    (ALL) NOPASSWD: ALL\n';
const sudoListPlain =
    'User bob may run the following commands on host:\n    (ALL) ALL\n';
const sudoListNone = 'User carol is not allowed to run sudo on host.\n';
assert.ok(S._suSudoListHasNopasswd(sudoListNopasswd), 'NOPASSWD grant detected');
assert.ok(!S._suSudoListHasNopasswd(sudoListPlain), 'plain (ALL) ALL is not passwordless');
assert.ok(!S._suSudoListHasNopasswd(sudoListNone), 'no-sudo user is not passwordless');
assert.ok(!S._suSudoListHasNopasswd(''), 'empty → false');
// A NOPASSWD mention only in the Defaults block must not count.
assert.ok(!S._suSudoListHasNopasswd('Matching Defaults entries for x: NOPASSWD_note\n\nUser x is not allowed to run sudo on host.\n'),
    'NOPASSWD outside the rules section is ignored');

console.log('sudoers-unit: OK');
