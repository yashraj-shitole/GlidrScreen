'use strict';
// Phone -> PC file transfer (src/files.js): name sanitising, offer policy, streaming to disk with a SHA-256 check,
// unique names, cleanup of partial files. Uses a real temporary folder. Run: node host/test/files.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const files = require('../src/files');

const { sanitizeName, uniqueName, rejectReason, FileReceiver, REJECT } = files;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until [fn] is truthy (polling), up to [ms]: a loaded machine must not turn a timeout test into a flake. */
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(10); };
const ctx = (o = {}) => ({ allowFiles: true, allowControl: true, viewOnly: false, busy: false, ...o });
const offer = (o = {}) => ({ t: 'file-offer', id: 'a1b2c3d4', name: 'photo.jpg', size: 10, ...o });

(async () => {
  // ---- sanitizeName
  assert.strictEqual(sanitizeName('photo.jpg'), 'photo.jpg');
  assert.strictEqual(sanitizeName('C:\\Users\\x\\secret\\a.txt'), 'a.txt', 'windows path stripped');
  assert.strictEqual(sanitizeName('/etc/passwd'), 'passwd', 'posix path stripped');
  assert.strictEqual(sanitizeName('../../evil.exe'), 'evil.exe');
  assert.strictEqual(sanitizeName('..\\..\\evil.exe'), 'evil.exe');
  assert.strictEqual(sanitizeName('..'), 'file');
  assert.strictEqual(sanitizeName('.'), 'file');
  assert.strictEqual(sanitizeName(''), 'file');
  assert.strictEqual(sanitizeName('   '), 'file');
  assert.strictEqual(sanitizeName('dir/'), 'file', 'only a directory part');
  assert.strictEqual(sanitizeName(null), 'file');
  assert.strictEqual(sanitizeName(42), 'file');
  assert.strictEqual(sanitizeName('a\u0000b\u001f.txt'), 'ab.txt', 'control characters');
  assert.strictEqual(sanitizeName('re:port?*<>|".txt'), 'report.txt', 'characters Windows rejects');
  assert.strictEqual(sanitizeName('name. . .'), 'name', 'trailing dots and spaces');
  assert.strictEqual(sanitizeName('name.txt  '), 'name.txt');
  assert.strictEqual(sanitizeName('.hidden'), 'hidden', 'no leading dot');
  for (const n of ['CON', 'con', 'NUL', 'PRN', 'AUX', 'COM1', 'com9', 'LPT1', 'CON.txt', 'nul.tar.gz', 'COM1 .txt']) {
    const out = sanitizeName(n);
    assert.ok(out.startsWith('_') && out.length === n.length + 1, `reserved ${n} -> ${out}`);
  }
  assert.strictEqual(sanitizeName('console.txt'), 'console.txt', 'not reserved');
  assert.strictEqual(sanitizeName('COM10.txt'), 'COM10.txt');
  assert.strictEqual(sanitizeName('x\u202etxt.exe'), 'xtxt.exe', 'bidi override removed');
  const long = sanitizeName('a'.repeat(300) + '.pdf');
  assert.ok(long.length <= 120 && long.endsWith('.pdf'), 'long name keeps its extension');
  assert.strictEqual(sanitizeName('b'.repeat(300)).length, 120);
  assert.strictEqual(Array.from(sanitizeName('\u{1F600}'.repeat(200))).length, 120, 'counted in characters, never cut mid-pair');
  assert.strictEqual(sanitizeName('fotó ä.jpg'), 'fotó ä.jpg', 'unicode kept');

  // ---- uniqueName
  assert.strictEqual(uniqueName('a.txt', () => false), 'a.txt');
  assert.strictEqual(uniqueName('a.txt', (n) => n === 'a.txt'), 'a (2).txt');
  assert.strictEqual(uniqueName('a.txt', (n) => ['a.txt', 'a (2).txt'].includes(n)), 'a (3).txt');
  assert.strictEqual(uniqueName('noext', (n) => n === 'noext'), 'noext (2)');
  assert.strictEqual(uniqueName('arch.tar.gz', (n) => n === 'arch.tar.gz'), 'arch.tar (2).gz');

  // ---- rejectReason
  assert.strictEqual(rejectReason(offer(), ctx()), null);
  assert.strictEqual(rejectReason(offer(), ctx({ allowFiles: false })), REJECT.DISABLED);
  assert.strictEqual(rejectReason(offer(), ctx({ allowFiles: undefined })), REJECT.DISABLED, 'host passes an explicit boolean');
  assert.strictEqual(rejectReason(offer(), ctx({ allowControl: false })), REJECT.DISABLED);
  assert.strictEqual(rejectReason(offer(), ctx({ viewOnly: true })), REJECT.VIEW_ONLY);
  assert.strictEqual(rejectReason(offer(), ctx({ busy: true })), REJECT.BUSY);
  assert.strictEqual(rejectReason(offer({ size: 200 * 1024 * 1024 }), ctx()), null, 'exactly the cap is fine');
  assert.strictEqual(rejectReason(offer({ size: 200 * 1024 * 1024 + 1 }), ctx()), REJECT.TOO_BIG);
  assert.strictEqual(rejectReason(offer({ size: 1e15 }), ctx({ busy: true })), REJECT.TOO_BIG, 'too big wins over busy');
  assert.strictEqual(rejectReason(offer({ size: 0 }), ctx()), null, 'empty file');
  for (const bad of [{ size: -1 }, { size: 1.5 }, { size: '5' }, { size: NaN }, { name: 5 }, { name: undefined }, { id: 'xyz' }, { id: 'A1B2C3D4' }, { id: undefined }]) {
    assert.strictEqual(rejectReason(offer(bad), ctx()), REJECT.BAD_NAME, JSON.stringify(bad));
  }
  assert.strictEqual(rejectReason(null, ctx()), REJECT.BAD_NAME);
  assert.strictEqual(rejectReason(offer({ viewOnly: false }), ctx({ viewOnly: true, allowFiles: false })), REJECT.DISABLED, 'switched off wins over view only');

  // ---- receiver
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-files-'));
  const dir = path.join(root, 'Downloads', 'Glidr'); // does not exist yet: must be created
  const sent = [];
  const saved = [];
  const logs = [];
  const mk = (o = {}) => new FileReceiver({
    dir: () => dir, send: (m) => sent.push(m), onSaved: (i) => saved.push(i), log: (m) => logs.push(m), ...o,
  });
  const policy = { allowFiles: true, allowControl: true, viewOnly: false };
  const reset = () => { sent.length = 0; saved.length = 0; };
  const listing = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
  const frames = (r, id, data, chunk = 16384, tamper) => {
    r.onText(JSON.stringify({ t: 'begin', id }));
    for (let i = 0; i < data.length; i += chunk) r.onBinary(new Uint8Array(data.subarray(i, i + chunk)));
    r.onText(JSON.stringify({ t: 'end', id, sha256: tamper || sha(data) }));
  };

  // a normal transfer, several chunks, folder created, saved under a sanitised name
  {
    reset();
    const r = mk();
    const data = crypto.randomBytes(50_000);
    assert.strictEqual(r.offer(offer({ name: '..\\..\\Pic.JPG', size: data.length }), policy), null);
    assert.deepStrictEqual(sent, [{ t: 'file-accept', id: 'a1b2c3d4' }]);
    assert.ok(r.busy);
    frames(r, 'a1b2c3d4', data);
    await r.idle();
    assert.strictEqual(sent[1].t, 'file-done'); assert.strictEqual(sent[1].ok, true); assert.strictEqual(sent[1].name, 'Pic.JPG');
    assert.deepStrictEqual(saved, [{ name: 'Pic.JPG', size: data.length }]);
    assert.ok(fs.readFileSync(path.join(dir, 'Pic.JPG')).equals(data), 'bytes identical');
    assert.deepStrictEqual(listing(), ['Pic.JPG'], 'no temp file left, nothing outside the folder');
    assert.ok(!r.busy);
  }
  // same name again: "(2)", then "(3)"; uppercase hex hash accepted
  {
    reset();
    const r = mk();
    for (const want of ['Pic (2).JPG', 'Pic (3).JPG']) {
      const data = crypto.randomBytes(100);
      r.offer(offer({ name: 'Pic.JPG', size: 100 }), policy);
      frames(r, 'a1b2c3d4', data, 16384, sha(data).toUpperCase());
      await r.idle();
      assert.strictEqual(sent.pop().name, want);
      sent.length = 0;
    }
    assert.deepStrictEqual(listing(), ['Pic (2).JPG', 'Pic (3).JPG', 'Pic.JPG']);
  }
  // an empty file
  {
    reset();
    const r = mk();
    r.offer(offer({ name: 'empty.txt', size: 0 }), policy);
    frames(r, 'a1b2c3d4', Buffer.alloc(0));
    await r.idle();
    assert.strictEqual(sent[1].ok, true);
    assert.strictEqual(fs.statSync(path.join(dir, 'empty.txt')).size, 0);
  }
  // reserved name is renamed, never a device
  {
    reset();
    const r = mk();
    r.offer(offer({ name: 'NUL', size: 3 }), policy);
    frames(r, 'a1b2c3d4', Buffer.from('abc'));
    await r.idle();
    assert.strictEqual(sent[1].name, '_NUL');
    assert.ok(fs.existsSync(path.join(dir, '_NUL')));
  }
  // checksum mismatch: partial deleted, nothing saved, ok:false
  {
    reset();
    const before = listing();
    const r = mk();
    const data = crypto.randomBytes(2000);
    r.offer(offer({ size: data.length }), policy);
    frames(r, 'a1b2c3d4', data, 16384, sha(Buffer.from('other')));
    await r.idle();
    assert.deepStrictEqual(sent[1], { t: 'file-done', id: 'a1b2c3d4', ok: false, name: '' });
    assert.deepStrictEqual(saved, []);
    assert.deepStrictEqual(listing(), before, 'partial file removed');
  }
  // size mismatch (short) and too much data
  {
    reset();
    const before = listing();
    const r = mk();
    r.offer(offer({ size: 100 }), policy);
    frames(r, 'a1b2c3d4', Buffer.alloc(60, 1));
    await r.idle();
    assert.strictEqual(sent[1].ok, false);
    assert.deepStrictEqual(listing(), before);
    reset();
    r.offer(offer({ size: 10 }), policy);
    r.onText(JSON.stringify({ t: 'begin', id: 'a1b2c3d4' }));
    r.onBinary(new Uint8Array(11));
    await r.idle();
    assert.strictEqual(sent[1].ok, false, 'more bytes than offered');
    assert.deepStrictEqual(listing(), before);
    assert.ok(!r.busy);
  }
  // rejections: nothing created, busy covers the second offer, the first transfer is untouched
  {
    reset();
    const r = mk();
    assert.strictEqual(r.offer(offer({ size: 201 * 1024 * 1024 }), policy), 'too-big');
    assert.deepStrictEqual(sent.pop(), { t: 'file-reject', id: 'a1b2c3d4', reason: 'too-big' });
    assert.strictEqual(r.offer(offer(), { ...policy, allowFiles: false }), 'disabled');
    assert.strictEqual(r.offer(offer(), { ...policy, allowControl: false }), 'disabled');
    assert.strictEqual(r.offer(offer(), { ...policy, viewOnly: true }), 'view-only');
    assert.strictEqual(r.offer(offer({ name: 7 }), policy), 'bad-name');
    assert.ok(!r.busy, 'rejections never start a transfer');
    sent.length = 0;
    assert.strictEqual(r.offer(offer({ id: '11111111', size: 3 }), policy), null);
    assert.strictEqual(r.offer(offer({ id: '22222222', size: 3 }), policy), 'busy');
    assert.deepStrictEqual(sent.pop(), { t: 'file-reject', id: '22222222', reason: 'busy' });
    // frames for another id are ignored
    r.onText(JSON.stringify({ t: 'begin', id: '22222222' }));
    r.onBinary(new Uint8Array(3));
    frames(r, '11111111', Buffer.from('xyz'));
    await r.idle();
    assert.strictEqual(sent.find((m) => m.t === 'file-done').ok, true);
    // after it finished, a new offer is accepted again
    sent.length = 0;
    assert.strictEqual(r.offer(offer({ id: '33333333', size: 1 }), policy), null);
    r.abort('x', false);
    await r.idle();
  }
  // data before begin, junk frames, never throws
  {
    reset();
    const r = mk();
    r.onBinary(new Uint8Array(5)); r.onText('not json'); r.onText('{"t":"end","id":"zz"}'); r.onText('null');
    r.offer(offer({ size: 5 }), policy);
    r.onBinary(new Uint8Array(5)); // before begin: ignored
    r.onText(JSON.stringify({ t: 'end', id: 'a1b2c3d4', sha256: sha(Buffer.alloc(5)) })); // end before begin: ignored
    assert.ok(r.busy);
    r.abort('cleanup', false);
    await r.idle();
    assert.deepStrictEqual(sent.map((m) => m.t), ['file-accept'], 'silent abort says nothing');
  }
  // abort mid-transfer deletes the partial file; abort with notify tells the phone
  {
    reset();
    const before = listing();
    const r = mk();
    r.offer(offer({ name: 'inflight.bin', size: 40000 }), policy);
    r.onText(JSON.stringify({ t: 'begin', id: 'a1b2c3d4' }));
    r.onBinary(new Uint8Array(16384));
    await sleep(30);
    assert.ok(listing().some((n) => n.endsWith('.glidr-part')), 'streamed to a temp name while receiving');
    assert.ok(!listing().includes('inflight.bin'), 'final name does not exist before the check passes');
    r.abort('session ended', false);
    await r.idle();
    assert.deepStrictEqual(listing(), before);
    assert.deepStrictEqual(sent.map((m) => m.t), ['file-accept'], 'no file-done when the session is gone');
    reset();
    r.offer(offer({ size: 5 }), policy);
    r.onText(JSON.stringify({ t: 'begin', id: 'a1b2c3d4' }));
    r.abort('control switched off', true);
    await r.idle();
    assert.deepStrictEqual(sent[1], { t: 'file-done', id: 'a1b2c3d4', ok: false, name: '' });
    assert.deepStrictEqual(listing(), before);
  }
  // the phone cancels mid-transfer
  {
    reset();
    const before = listing();
    const r = mk();
    r.offer(offer({ name: 'cancelme.bin', size: 40000 }), policy);
    r.onText(JSON.stringify({ t: 'begin', id: 'a1b2c3d4' }));
    r.onBinary(new Uint8Array(16384));
    r.onText(JSON.stringify({ t: 'cancel', id: 'a1b2c3d4' }));
    await r.idle();
    assert.deepStrictEqual(sent[1], { t: 'file-done', id: 'a1b2c3d4', ok: false, name: '' });
    assert.deepStrictEqual(listing(), before);
    assert.ok(!r.busy);
  }
  // timeouts: never started, and stalled
  {
    reset();
    const before = listing();
    const r = mk({ beginTimeoutMs: 40, idleTimeoutMs: 40 });
    r.offer(offer({ size: 5 }), policy);
    await until(() => sent[1]);
    assert.ok(!r.busy);
    assert.strictEqual(sent[1].ok, false);
    reset();
    r.offer(offer({ size: 100 }), policy);
    r.onText(JSON.stringify({ t: 'begin', id: 'a1b2c3d4' }));
    r.onBinary(new Uint8Array(10));
    await until(() => sent[1]);
    assert.ok(!r.busy);
    assert.strictEqual(sent[1].ok, false);
    assert.deepStrictEqual(listing(), before);
  }
  // a folder that cannot be created fails cleanly
  {
    reset();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const r = mk({ dir: () => path.join(blocker, 'Glidr') });
    r.offer(offer({ size: 1 }), policy);
    frames(r, 'a1b2c3d4', Buffer.from('a'));
    await r.idle();
    assert.strictEqual(sent[1].ok, false);
    assert.ok(!r.busy);
  }
  // big, many-chunk transfer streamed in order (2 MB)
  {
    reset();
    const r = mk();
    const data = crypto.randomBytes(2 * 1024 * 1024 + 123);
    r.offer(offer({ name: 'big.bin', size: data.length }), policy);
    frames(r, 'a1b2c3d4', data);
    await r.idle();
    assert.strictEqual(sent[1].ok, true);
    assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(data));
  }
  // logs never carry names or hashes
  assert.ok(logs.every((l) => !/photo|Pic|big|NUL|[0-9a-f]{40}/i.test(l)), logs.join('\n'));

  // stale temp fragments are cleaned, real files and fresh fragments are not
  {
    const { cleanStaleParts, PART_SUFFIX } = require('../src/files');
    const d = path.join(root, 'clean');
    fs.mkdirSync(d, { recursive: true });
    const old = path.join(d, 'old' + PART_SUFFIX), fresh = path.join(d, 'fresh' + PART_SUFFIX), keep = path.join(d, 'keep.txt');
    for (const p of [old, fresh, keep]) fs.writeFileSync(p, 'x');
    const longAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(keep, longAgo, longAgo); // an old normal file must survive
    assert.strictEqual(await cleanStaleParts(d), 1);
    assert.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(keep));
    assert.strictEqual(await cleanStaleParts(path.join(root, 'does-not-exist')), 0);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok files');
})().catch((e) => { console.error(e); process.exit(1); });
