'use strict';
// Quick actions (actions.js): validation, allow rules, rate limiter, spawn argument arrays. Nothing is ever spawned:
// the runner is a fake. Run: node host/test/actions.test.js
const assert = require('assert');
const A = require('../src/actions');

const exists = () => true;
const slot = { id: 's', viewOnly: false };
const ON = { allowActions: true, allowControl: true, actionsEnabled: null, launchers: [] };

(async () => {
  // ---- id format
  for (const id of ['lock', 'sleep', 'cancel-shutdown', 'a1b2c3d4']) assert.strictEqual(A.validId(id), true, id);
  for (const id of ['', 'LOCK', 'lock;calc', 'lock calc', '../x', 'a'.repeat(25), null, undefined, 5, {}, ['lock'], 'lock\n', 'lö']) {
    assert.strictEqual(A.validId(id), false, String(id));
  }

  // ---- built-ins: fixed argument lists, shell:false, absolute System32 path
  const expect = {
    lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
    sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
    restart: ['shutdown.exe', ['/r', '/t', '15', '/c', 'Glidr Screen']],
    shutdown: ['shutdown.exe', ['/s', '/t', '15', '/c', 'Glidr Screen']],
    'cancel-shutdown': ['shutdown.exe', ['/a']],
  };
  for (const [id, [exe, args]] of Object.entries(expect)) {
    const sp = A.buildSpawn(id, ON);
    assert.ok(/^[A-Za-z]:\\.*\\System32\\/i.test(sp.file) && sp.file.toLowerCase().endsWith('\\' + exe), sp.file);
    assert.deepStrictEqual(sp.args, args, id);
    assert.strictEqual(sp.opts.shell, false);
    assert.strictEqual(sp.opts.windowsHide, true);
  }
  assert.strictEqual(A.buildSpawn('format-c', ON), null);
  assert.strictEqual(A.buildSpawn('deadbeef', ON), null); // not a stored launcher

  // ---- defaults: master switch off lists nothing; on lists lock and sleep only
  assert.deepStrictEqual(A.phoneList({ ...ON, allowActions: false }), []);
  assert.deepStrictEqual(A.phoneList({ ...ON, allowActions: undefined }), []);
  assert.deepStrictEqual(A.phoneList(ON).map((x) => x.id), ['lock', 'sleep']);
  assert.deepStrictEqual(A.phoneList(ON).map((x) => x.danger), [false, false]);
  assert.deepStrictEqual(Object.keys(A.phoneList(ON)[0]).sort(), ['danger', 'id', 'label']); // never a path or args

  // ---- per-action enabling; cancel-shutdown follows restart / shutdown and cannot be set directly
  let en = A.setEnabled(ON, 'restart', true);
  assert.deepStrictEqual(en.sort(), ['lock', 'restart', 'sleep']);
  const cfgR = { ...ON, actionsEnabled: en };
  assert.deepStrictEqual(A.phoneList(cfgR).map((x) => x.id), ['lock', 'sleep', 'restart', 'cancel-shutdown']);
  assert.strictEqual(A.phoneList(cfgR).find((x) => x.id === 'restart').danger, true);
  assert.strictEqual(A.setEnabled(ON, 'cancel-shutdown', true), null);
  assert.strictEqual(A.setEnabled(ON, 'nope', true), null);
  assert.strictEqual(A.setEnabled(ON, 'lock', 'yes'), null);
  en = A.setEnabled(cfgR, 'lock', false);
  assert.ok(!en.includes('lock') && !en.includes('cancel-shutdown'));
  assert.deepStrictEqual(A.phoneList({ ...ON, actionsEnabled: ['restart', 'ghost', 5, 'cancel-shutdown'] }).map((x) => x.id), ['restart', 'cancel-shutdown']);
  assert.deepStrictEqual(A.phoneList({ ...ON, actionsEnabled: [] }), []); // explicit empty list = nothing on

  // ---- launcher validation: files
  const ok = A.validateLauncher({ label: ' Notes ', path: 'C:\\Program Files\\Notes\\notes.exe', args: ['--open', 'a b'] }, { exists });
  assert.deepStrictEqual(ok, { ok: true, launcher: { label: 'Notes', path: 'C:\\Program Files\\Notes\\notes.exe', args: ['--open', 'a b'] } });
  const bad = (i, e) => assert.deepStrictEqual(A.validateLauncher(i, { exists }), { ok: false, error: e }, JSON.stringify(i));
  bad({ label: '', path: 'C:\\a.exe' }, 'label');
  bad({ label: 'x'.repeat(41), path: 'C:\\a.exe' }, 'label');
  bad({ label: 'a\u0001b', path: 'C:\\a.exe' }, 'label'); // control characters are refused
  bad({ label: 'a\u202eb', path: 'C:\\a.exe' }, 'label'); // so are bidi overrides
  assert.strictEqual(A.validateLauncher({ label: 'a\nb', path: 'C:\\a.exe' }, { exists }).launcher.label, 'a b'); // whitespace runs collapse
  bad({ label: 'x', path: 'notepad.exe' }, 'path'); // relative
  bad({ label: 'x', path: '\\\\server\\share\\a.exe' }, 'path'); // UNC
  bad({ label: 'x', path: '\\\\?\\C:\\a.exe' }, 'path'); // device path
  bad({ label: 'x', path: 'C:\\a.txt' }, 'path'); // wrong extension
  bad({ label: 'x', path: 'C:\\a.exe:stream' }, 'path');
  bad({ label: 'x', path: 'C:\\a.exe\u0000.txt' }, 'path');
  bad({ label: 'x', path: 'C:\\a.exe', args: new Array(17).fill('a') }, 'args');
  bad({ label: 'x', path: 'C:\\a.exe', args: ['x'.repeat(513)] }, 'args');
  bad({ label: 'x', path: 'C:\\a.exe', args: [1] }, 'args');
  bad({ label: 'x', path: 'C:\\a.exe', args: { a: 1 } }, 'args');
  bad(null, 'invalid');
  assert.deepStrictEqual(A.validateLauncher({ label: 'x', path: 'C:\\a.exe' }, { exists: () => false }), { ok: false, error: 'path' }); // must exist
  assert.deepStrictEqual(A.validateLauncher({ label: 'x', path: 'C:\\a.exe' }, { exists: () => { throw new Error('EACCES'); } }), { ok: false, error: 'path' });
  assert.deepStrictEqual(A.validateLauncher({ label: 'x', path: 'C:\\a.exe', args: 'one\ntwo\r\n\nthree' }, { exists }).launcher.args, ['one', 'two', 'three']);

  // ---- launcher validation: URLs are https only
  const url = (p) => A.validateLauncher({ label: 'u', path: p, args: ['ignored'] }, { exists });
  assert.deepStrictEqual(url('https://example.com/a?b=1&c=2'), { ok: true, launcher: { label: 'u', path: 'https://example.com/a?b=1&c=2', args: [] } });
  for (const p of ['http://example.com', 'ftp://example.com', 'file:///C:/a.exe', 'javascript:alert(1)', 'https://', 'https://user:pw@example.com',
    'https://exa mple.com', 'https://example.com/\nx', 'HTTPS:/example.com', 'https:example.com', 'data:text/html,hi']) {
    assert.strictEqual(url(p).ok, false, p);
  }
  assert.strictEqual(url('https://example.com/' + 'a'.repeat(2000)).ok, false);

  // ---- batch files: cmd.exe parses its own command line, so only plain arguments and paths are accepted
  assert.strictEqual(A.validateLauncher({ label: 'b', path: 'C:\\tools\\go.bat', args: ['fast', '--x=1'] }, { exists }).ok, false); // '=' is not plain
  assert.strictEqual(A.validateLauncher({ label: 'b', path: 'C:\\tools\\go.bat', args: ['fast', 'C:\\x\\y.txt'] }, { exists }).ok, true);
  for (const a of ['a&calc', 'a|b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a b', '"x"', '$(x)', 'a;b']) {
    assert.strictEqual(A.validateLauncher({ label: 'b', path: 'C:\\tools\\go.cmd', args: [a] }, { exists }).ok, false, a);
  }
  assert.strictEqual(A.validateLauncher({ label: 'b', path: 'C:\\to&ols\\go.bat' }, { exists }).ok, false);
  assert.strictEqual(A.validateLauncher({ label: 'b', path: 'C:\\to ols\\go.bat' }, { exists }).ok, true);

  // ---- spawn arrays: metacharacters stay ONE argument, never a shell
  const evil = ['a & calc', '"; rm -rf /', '$(whoami)', '`id`', '%COMSPEC%', 'x | y', 'line1\nline2', '--k=v;v', '', ' '];
  const lcfg = { launchers: [{ id: '0a1b2c3d', label: 'L', path: 'C:\\Tools & More\\a;b (x86)\\run$me.exe', args: evil }] };
  const sp = A.buildSpawn('0a1b2c3d', lcfg);
  assert.strictEqual(sp.file, 'C:\\Tools & More\\a;b (x86)\\run$me.exe');
  assert.deepStrictEqual(sp.args, evil); // same strings, same count, untouched
  assert.strictEqual(sp.opts.shell, false);
  assert.strictEqual(sp.opts.windowsHide, false);
  assert.ok(Array.isArray(sp.args));
  // the validated launcher path with metacharacters survives add -> store -> spawn unchanged
  const added = A.addLauncher([], { label: 'm', path: 'C:\\A & B\\p;q.exe', args: ['x & y', '$(z)'] }, { exists });
  assert.strictEqual(added.ok, true);
  assert.ok(/^[0-9a-f]{8}$/.test(added.id));
  const sp2 = A.buildSpawn(added.id, { launchers: added.launchers });
  assert.deepStrictEqual([sp2.file, sp2.args], ['C:\\A & B\\p;q.exe', ['x & y', '$(z)']]);
  // url launcher: explorer.exe with exactly one argument
  const u = A.addLauncher([], { label: 'w', path: 'https://example.com/?a=1&b=2' }, { exists });
  const sp3 = A.buildSpawn(u.id, { launchers: u.launchers });
  assert.ok(sp3.file.toLowerCase().endsWith('\\explorer.exe'));
  assert.deepStrictEqual(sp3.args, ['https://example.com/?a=1&b=2']);
  // .lnk: explorer.exe, path as the single argument
  const lk = A.addLauncher([], { label: 'k', path: 'C:\\Users\\me\\Desktop\\Game & Co.lnk' }, { exists });
  const sp4 = A.buildSpawn(lk.id, { launchers: lk.launchers });
  assert.ok(sp4.file.toLowerCase().endsWith('\\explorer.exe'));
  assert.deepStrictEqual(sp4.args, ['C:\\Users\\me\\Desktop\\Game & Co.lnk']);
  // .bat: cmd.exe /d /c <path> <args>, the path as one element
  const bt = A.addLauncher([], { label: 'b', path: 'C:\\my tools\\go.bat', args: ['fast'] }, { exists });
  const sp5 = A.buildSpawn(bt.id, { launchers: bt.launchers });
  assert.ok(sp5.file.toLowerCase().endsWith('\\system32\\cmd.exe'));
  assert.deepStrictEqual(sp5.args, ['/d', '/c', 'C:\\my tools\\go.bat', 'fast']);
  // a hand-edited settings file cannot slip an unsafe batch / relative / UNC / non-https entry past buildSpawn
  const tampered = [
    { id: '11111111', label: 't', path: 'C:\\x.bat', args: ['a&calc'] }, { id: '22222222', label: 't', path: 'calc.exe', args: [] },
    { id: '33333333', label: 't', path: '\\\\evil\\share\\a.exe', args: [] }, { id: '44444444', label: 't', path: 'http://example.com', args: [] },
    { id: '55555555', label: 't', path: 'C:\\x.txt', args: [] }, { id: '66666666', label: 't', path: 'https://u:p@example.com', args: [] },
  ];
  for (const t of tampered) assert.strictEqual(A.buildSpawn(t.id, { launchers: tampered }), null, t.path);

  // ---- launcher list management: ids generated here (8 hex), max 12, unique, removable
  let list = [];
  const seenIds = new Set();
  for (let i = 0; i < 12; i++) {
    const r = A.addLauncher(list, { label: 'L' + i, path: 'https://example.com/' + i }, { exists });
    assert.strictEqual(r.ok, true);
    assert.ok(/^[0-9a-f]{8}$/.test(r.id) && !seenIds.has(r.id));
    seenIds.add(r.id); list = r.launchers;
  }
  assert.deepStrictEqual(A.addLauncher(list, { label: 'one more', path: 'https://example.com' }, { exists }), { ok: false, error: 'full' });
  assert.strictEqual(A.removeLauncher(list, [...seenIds][0]).length, 11);
  assert.strictEqual(A.removeLauncher(list, 'zzzzzzzz').length, 12);
  // the caller cannot choose the id
  const forced = A.addLauncher([], { id: 'deadbeef', label: 'f', path: 'https://example.com' }, { exists });
  assert.notStrictEqual(forced.id, 'deadbeef');
  const collide = A.addLauncher([{ id: 'aaaaaaaa', label: 'x', path: 'https://example.com', args: [] }], { label: 'y', path: 'https://example.org' },
    { exists, rand: (() => { let n = 0; return () => Buffer.from(n++ === 0 ? 'aaaaaaaa' : 'bbbbbbbb', 'hex'); })() });
  assert.strictEqual(collide.id, 'bbbbbbbb');
  // new launchers are off until switched on individually
  assert.strictEqual(A.phoneList({ ...ON, launchers: added.launchers }).some((x) => x.id === added.id), false);
  const onL = { ...ON, launchers: added.launchers, actionsEnabled: A.setEnabled({ ...ON, launchers: added.launchers }, added.id, true) };
  assert.strictEqual(A.phoneList(onL).find((x) => x.id === added.id).label, 'm');
  // sanitize drops malformed stored entries and caps at 12
  assert.deepStrictEqual(A.sanitizeLaunchers('x'), []);
  assert.deepStrictEqual(A.sanitizeLaunchers([{ id: 'BAD', label: 'x', path: 'p', args: [] }, { id: 'aaaaaaaa', label: 'x', path: 'p', args: 'no' }, null, 5]), []);
  assert.strictEqual(A.sanitizeLaunchers(Array.from({ length: 30 }, (_, i) => ({ id: i.toString(16).padStart(8, '0'), label: 'x', path: 'p', args: [] }))).length, 12);
  assert.strictEqual(A.sanitizeLaunchers([{ id: 'aaaaaaaa', label: 'x', path: 'p', args: [] }, { id: 'aaaaaaaa', label: 'y', path: 'q', args: [] }]).length, 1);

  // ---- rate limiter: one per 2 s, six per minute
  let now = 1_000_000;
  const lim = new A.RateLimiter(() => now);
  assert.strictEqual(lim.take(), true);
  now += 1999; assert.strictEqual(lim.take(), false); // too soon (the refused attempt is not recorded)
  now += 1; assert.strictEqual(lim.take(), true); // exactly 2 s after the first
  for (let i = 0; i < 4; i++) { now += 2000; assert.strictEqual(lim.take(), true, 'take ' + i); } // 6 in 10 s
  now += 2000; assert.strictEqual(lim.take(), false); // 7th inside the minute
  now = 1_000_000 + 60_000 - 1; assert.strictEqual(lim.take(), false);
  now = 1_000_000 + 60_000; assert.strictEqual(lim.take(), true); // first one has aged out (2nd..6th still inside: only 5 + this = 6)
  now += 2000; assert.strictEqual(lim.take(), true);

  // ---- handle(): the decision order, with a fake runner
  const ran = [];
  const logs = [];
  const mk = (over = {}) => ({
    cfg: { ...ON }, slot: { ...slot }, limiter: new A.RateLimiter(() => now), run: async (sp) => { ran.push(sp); }, log: (l) => logs.push(l), ...over,
  });
  const go = (msg, over) => A.handle(msg, mk(over));
  ran.length = 0;

  // malformed -> ignored (null), nothing runs
  for (const m of [null, undefined, 'lock', 5, {}, { id: 5 }, { id: '' }, { id: 'lock; calc' }, { id: 'LOCK' }, { id: ['lock'] }, { id: 'a'.repeat(40) }]) {
    assert.strictEqual(await go(m), null, JSON.stringify(m));
  }
  // unknown but well formed -> answered, nothing runs
  assert.deepStrictEqual(await go({ id: 'format-c' }), { id: 'format-c', ok: false, reason: 'unknown' });
  assert.deepStrictEqual(await go({ id: 'deadbeef' }), { id: 'deadbeef', ok: false, reason: 'unknown' });
  // master switch off
  assert.deepStrictEqual(await go({ id: 'lock' }, { cfg: { ...ON, allowActions: false } }), { id: 'lock', ok: false, reason: 'disabled' });
  assert.deepStrictEqual(await go({ id: 'lock' }, { cfg: { ...ON, allowActions: 'true' } }), { id: 'lock', ok: false, reason: 'disabled' }); // strictly true
  // individually disabled
  assert.deepStrictEqual(await go({ id: 'restart', confirm: true }), { id: 'restart', ok: false, reason: 'disabled' });
  assert.deepStrictEqual(await go({ id: 'shutdown', confirm: true }), { id: 'shutdown', ok: false, reason: 'disabled' });
  assert.deepStrictEqual(await go({ id: 'cancel-shutdown' }), { id: 'cancel-shutdown', ok: false, reason: 'disabled' });
  // view-only slot, global control off, no slot
  assert.deepStrictEqual(await go({ id: 'lock' }, { slot: { viewOnly: true } }), { id: 'lock', ok: false, reason: 'view-only' });
  assert.deepStrictEqual(await go({ id: 'lock' }, { cfg: { ...ON, allowControl: false } }), { id: 'lock', ok: false, reason: 'view-only' });
  assert.deepStrictEqual(await go({ id: 'lock' }, { slot: undefined }), { id: 'lock', ok: false, reason: 'view-only' });
  assert.strictEqual(ran.length, 0, 'nothing ran for any refusal so far');

  // danger needs confirm === true exactly; a refusal does not use up the rate limit
  const dcfg = { ...ON, actionsEnabled: ['restart', 'shutdown'] };
  const dl = new A.RateLimiter(() => now);
  for (const c of [undefined, false, 'true', 1, null]) {
    assert.deepStrictEqual(await go({ id: 'restart', confirm: c }, { cfg: dcfg, limiter: dl }), { id: 'restart', ok: false, reason: 'confirm' });
  }
  assert.strictEqual(ran.length, 0);
  assert.deepStrictEqual(await go({ id: 'restart', confirm: true }, { cfg: dcfg, limiter: dl }), { id: 'restart', ok: true });
  assert.strictEqual(ran.length, 1);
  assert.deepStrictEqual(ran[0].args, ['/r', '/t', '15', '/c', 'Glidr Screen']);
  now += 2000;
  assert.deepStrictEqual(await go({ id: 'cancel-shutdown' }, { cfg: dcfg, limiter: dl }), { id: 'cancel-shutdown', ok: true }); // no confirm needed
  assert.deepStrictEqual(ran[1].args, ['/a']);
  // a non-danger action ignores confirm
  now += 2000;
  assert.deepStrictEqual(await go({ id: 'lock', confirm: false }, { limiter: new A.RateLimiter(() => now) }), { id: 'lock', ok: true });
  assert.deepStrictEqual(ran[2].args, ['user32.dll,LockWorkStation']);

  // rate limit through handle(): second within 2 s -> rate, nothing runs
  ran.length = 0;
  const rl = new A.RateLimiter(() => now);
  assert.deepStrictEqual(await go({ id: 'lock' }, { limiter: rl }), { id: 'lock', ok: true });
  now += 500;
  assert.deepStrictEqual(await go({ id: 'sleep' }, { limiter: rl }), { id: 'sleep', ok: false, reason: 'rate' });
  assert.strictEqual(ran.length, 1);
  now += 1500;
  assert.deepStrictEqual(await go({ id: 'sleep' }, { limiter: rl }), { id: 'sleep', ok: true });

  // runner failure -> failed (never throws); a runner that throws synchronously too
  const f1 = await go({ id: 'lock' }, { limiter: new A.RateLimiter(() => now), run: async () => { throw new Error('ENOENT C:\\secret\\path.exe'); } });
  assert.deepStrictEqual(f1, { id: 'lock', ok: false, reason: 'failed' });
  const f2 = await go({ id: 'lock' }, { limiter: new A.RateLimiter(() => now), run: () => { throw new Error('x'); } });
  assert.deepStrictEqual(f2, { id: 'lock', ok: false, reason: 'failed' });
  // launcher through handle(): runs only when enabled
  const lcfg2 = { ...ON, launchers: added.launchers };
  assert.deepStrictEqual(await go({ id: added.id }, { cfg: lcfg2 }), { id: added.id, ok: false, reason: 'disabled' });
  ran.length = 0;
  assert.deepStrictEqual(await go({ id: added.id }, { cfg: onL }), { id: added.id, ok: true });
  assert.deepStrictEqual([ran[0].file, ran[0].args], ['C:\\A & B\\p;q.exe', ['x & y', '$(z)']]);
  // log lines carry the id and the outcome only, never a path or an argument
  const all = logs.join('\n');
  assert.ok(/action lock: ok/.test(all) && /action restart: confirm/.test(all));
  assert.ok(!/A & B|x & y|secret|\$\(z\)|\\/.test(all), all);

  // ---- spawnRunner: shell is never used, resolves on 'spawn', rejects on 'error', does not wait for exit
  const { EventEmitter } = require('events');
  const calls = [];
  const fake = (file, args, opts) => { const c = new EventEmitter(); c.unref = () => { c.unrefd = true; }; calls.push({ file, args, opts, c }); setImmediate(() => c.emit('spawn')); return c; };
  await A.spawnRunner(fake)({ file: 'f.exe', args: ['a b'], opts: { shell: false } });
  assert.strictEqual(calls[0].opts.shell, false); assert.strictEqual(calls[0].c.unrefd, true);
  await assert.rejects(A.spawnRunner((f, a, o) => { const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; })({ file: 'x', args: [], opts: {} }));
  await assert.rejects(A.spawnRunner(() => { throw new Error('EINVAL'); })({ file: 'x', args: [], opts: {} }));

  console.log('actions tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
