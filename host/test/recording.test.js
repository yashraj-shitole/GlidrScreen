'use strict';
// recording.js: file names, never overwriting, segments, the size limit, small leftovers, backpressure, write errors,
// and that nothing is logged beyond error codes. File system and clock are fakes. Run: node host/test/recording.test.js
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const R = require('../src/recording');

const DIR = path.resolve('C:\\Users\\x\\Videos\\Glidr');
const T = new Date(2026, 4, 28, 14, 15, 3).getTime(); // local time, so the test does not depend on the time zone

function fakeFs({ taken = [], failMkdir = null, failOpen = null } = {}) {
  const files = new Map(); // path -> {chunks, ended}
  taken.forEach((p) => files.set(p, { chunks: [], ended: true, pre: true }));
  const fs = {
    files, dirs: [], lengths: new Map(),
    mkdirSync(d) { if (failMkdir) { const e = new Error('x'); e.code = failMkdir; throw e; } fs.dirs.push(d); },
    openSync(p) {
      if (failOpen) { const e = new Error('x'); e.code = failOpen; throw e; }
      if (files.has(p)) { const e = new Error('exists'); e.code = 'EEXIST'; throw e; }
      files.set(p, { chunks: [], ended: false });
      return 7;
    },
    createWriteStream(p) {
      const f = files.get(p);
      const s = new EventEmitter();
      s.writableLength = 0;
      s.write = (b) => { f.chunks.push(Buffer.from(b)); return true; };
      s.end = (cb) => setImmediate(() => { f.ended = true; if (cb) cb(); s.emit('close'); });
      s.destroy = () => {};
      f.stream = s;
      return s;
    },
    unlinkSync(p) { files.delete(p); },
  };
  return fs;
}
const size = (f) => f.chunks.reduce((n, c) => n + c.length, 0);
const names = (fs) => [...fs.files.keys()].map((p) => path.basename(p)).sort();
const kb = (n = 2) => Buffer.alloc(n * 1024, 1);

const keepAlive = setInterval(() => {}, 1000); // the recorder's flush guard is an unref'd timer
(async () => {
  // ---- names
  assert.strictEqual(R.stamp(T), '20260528-141503');
  assert.strictEqual(R.safePhoneName('My Phone'), 'My_Phone');
  assert.strictEqual(R.safePhoneName('..\\..\\evil/name'), 'name');
  assert.strictEqual(R.safePhoneName('a<b>c:d"e|f?g*h'), 'abcdefgh');
  assert.strictEqual(R.safePhoneName('CON'), '_CON');
  assert.strictEqual(R.safePhoneName('nul.txt'), '_nul_txt');
  assert.strictEqual(R.safePhoneName(''), 'Phone');
  assert.strictEqual(R.safePhoneName(null), 'Phone');
  assert.strictEqual(R.safePhoneName('...'), 'Phone');
  assert.strictEqual(R.safePhoneName('Yash\u202Eraj'), 'Yashraj', 'bidi override removed');
  assert.ok(Array.from(R.safePhoneName('x'.repeat(300))).length <= 40);
  assert.ok(Array.from(R.safePhoneName('😀'.repeat(100))).length <= 40);
  assert.strictEqual(R.recordingStem('Pixel 8', T), 'Glidr-Pixel_8-20260528-141503');
  assert.strictEqual(R.segmentName('S', 1), 'S.webm');
  assert.strictEqual(R.segmentName('S', 2), 'S-2.webm');
  assert.strictEqual(R.recordingsDirIn('C:\\Users\\x\\Videos'), path.join('C:\\Users\\x\\Videos', 'Glidr'));

  // ---- a normal recording: folder created, one file with the right name, bytes in order, flushed on stop
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    assert.strictEqual(r.start('Pixel 8'), true);
    assert.deepStrictEqual(fs.dirs, [DIR]);
    assert.strictEqual(r.write(Buffer.from('aa'.repeat(600))), 'ok');
    assert.strictEqual(r.write(new Uint8Array(600).fill(98)), 'ok');
    assert.strictEqual(r.write(new Uint8Array(600).fill(99).buffer), 'ok', 'ArrayBuffer accepted');
    assert.strictEqual(r.write('text'), 'ignored');
    assert.strictEqual(r.write(new Uint8Array(0)), 'ignored');
    assert.strictEqual(r.active, true);
    const res = await r.stop();
    assert.deepStrictEqual(res, { saved: true, files: 1 });
    assert.deepStrictEqual(names(fs), ['Glidr-Pixel_8-20260528-141503.webm']);
    const f = [...fs.files.values()][0];
    assert.strictEqual(f.ended, true, 'flushed and closed');
    assert.strictEqual(size(f), 1200 + 600 + 600);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.write(kb()), 'ignored', 'nothing is written after stop');
    assert.deepStrictEqual(await r.stop(), { saved: true, files: 1 }, 'stopping twice is harmless');
  }
  // ---- every path stays inside the folder, whatever the phone is called
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('..\\..\\Windows\\System32\\evil');
    r.write(kb());
    await r.stop();
    for (const p of fs.files.keys()) assert.strictEqual(path.dirname(p), DIR);
    assert.deepStrictEqual(names(fs), ['Glidr-evil-20260528-141503.webm']);
  }
  // ---- never overwrites: a taken name gets the next free suffix
  {
    const base = path.join(DIR, 'Glidr-P-20260528-141503.webm');
    const fs = fakeFs({ taken: [base, path.join(DIR, 'Glidr-P-20260528-141503-2.webm')] });
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('P');
    r.write(kb());
    await r.stop();
    assert.ok(fs.files.has(path.join(DIR, 'Glidr-P-20260528-141503-3.webm')));
    assert.strictEqual(fs.files.get(base).chunks.length, 0, 'the existing file was not touched');
  }
  // ---- a file under 1 KB is deleted; one of exactly 1 KB is kept
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('P');
    r.write(Buffer.alloc(1023, 1));
    assert.deepStrictEqual(await r.stop(), { saved: false, files: 0 });
    assert.strictEqual(fs.files.size, 0, 'tiny file removed');
    const fs2 = fakeFs();
    const r2 = new R.SessionRecorder({ dir: DIR, fs: fs2, clock: () => T });
    r2.start('P');
    r2.write(Buffer.alloc(1024, 1));
    assert.deepStrictEqual(await r2.stop(), { saved: true, files: 1 });
    // nothing written at all
    const fs3 = fakeFs();
    const r3 = new R.SessionRecorder({ dir: DIR, fs: fs3, clock: () => T });
    r3.start('P');
    assert.deepStrictEqual(await r3.stop(), { saved: false, files: 0 });
    assert.strictEqual(fs3.files.size, 0);
  }
  // ---- segments: a higher segment number rolls to "-2", a late chunk of the old one is dropped, both files are kept
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('P');
    assert.strictEqual(r.write(kb(), 1), 'ok');
    assert.strictEqual(r.write(kb(), 2), 'ok');
    assert.strictEqual(r.write(kb(), 1), 'dropped', 'stale chunk');
    assert.strictEqual(r.write(kb(), 2), 'ok');
    assert.deepStrictEqual(await r.stop(), { saved: true, files: 2 });
    assert.deepStrictEqual(names(fs), ['Glidr-P-20260528-141503-2.webm', 'Glidr-P-20260528-141503.webm']);
    assert.strictEqual(size(fs.files.get(path.join(DIR, 'Glidr-P-20260528-141503.webm'))), 2048);
    assert.strictEqual(size(fs.files.get(path.join(DIR, 'Glidr-P-20260528-141503-2.webm'))), 4096);
    for (const f of fs.files.values()) assert.strictEqual(f.ended, true);
  }
  // ---- a tiny first segment disappears when the picture switched straight away
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('P');
    r.write(Buffer.alloc(10), 1);
    r.write(kb(), 2);
    assert.deepStrictEqual(await r.stop(), { saved: true, files: 1 });
    assert.deepStrictEqual(names(fs), ['Glidr-P-20260528-141503-2.webm']);
  }
  // ---- the size limit ends the recording cleanly and reports it
  {
    const fs = fakeFs();
    const stopped = [];
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T, maxBytes: 5000, onStopped: (why) => stopped.push(why) });
    r.start('P');
    assert.strictEqual(r.write(kb(2)), 'ok'); // 2048
    assert.strictEqual(r.write(kb(2)), 'ok'); // 4096
    assert.strictEqual(r.write(kb(2)), 'stopped'); // would be 6144 > 5000
    assert.deepStrictEqual(stopped, ['limit']);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.write(kb()), 'ignored');
    assert.deepStrictEqual(await r.stop(), { saved: true, files: 1 });
    assert.strictEqual(size([...fs.files.values()][0]), 4096, 'the file holds what was accepted before the limit');
    assert.strictEqual(R.MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024);
  }
  // ---- backpressure: a stream that is far behind makes chunks drop instead of piling up
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T, maxQueue: 10_000 });
    r.start('P');
    assert.strictEqual(r.write(kb()), 'ok');
    [...fs.files.values()][0].stream.writableLength = 9_000;
    assert.strictEqual(r.write(kb()), 'dropped');
    assert.strictEqual(r.dropped, 1);
    [...fs.files.values()][0].stream.writableLength = 0;
    assert.strictEqual(r.write(kb()), 'ok');
    assert.strictEqual(size([...fs.files.values()][0]), 4096);
    await r.stop();
  }
  // ---- a disk error ends it, logs a code and nothing else
  {
    const fs = fakeFs();
    const logs = []; const stopped = [];
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T, log: (m) => logs.push(m), onStopped: (w) => stopped.push(w) });
    r.start('Secret Phone');
    r.write(kb());
    const e = new Error('disk full at ' + DIR); e.code = 'ENOSPC';
    [...fs.files.values()][0].stream.emit('error', e);
    assert.deepStrictEqual(stopped, ['error']);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.write(kb()), 'ignored');
    await r.stop();
    assert.ok(logs.length >= 1 && logs.every((m) => /ENOSPC/.test(m)));
    assert.ok(logs.every((m) => !/Secret|Videos|Glidr/.test(m)), 'no name or path in the log');
  }
  // ---- cannot create the folder / the file: start() says no, with a code only
  for (const opt of [{ failMkdir: 'EACCES' }, { failOpen: 'EPERM' }]) {
    const logs = [];
    const r = new R.SessionRecorder({ dir: DIR, fs: fakeFs(opt), clock: () => T, log: (m) => logs.push(m) });
    assert.strictEqual(r.start('Secret Phone'), false);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.write(kb()), 'ignored');
    assert.deepStrictEqual(await r.stop(), { saved: false, files: 0 });
    assert.ok(/EACCES|EPERM/.test(logs[0]) && !/Secret|Videos/.test(logs[0]));
  }
  // ---- debug lines (paths) only go to debug, which the caller may drop
  {
    const logs = []; const dbg = [];
    const r = new R.SessionRecorder({ dir: DIR, fs: fakeFs(), clock: () => T, log: (m) => logs.push(m), debug: (m) => dbg.push(m) });
    r.start('P'); r.write(kb()); await r.stop();
    assert.deepStrictEqual(logs, []);
    assert.ok(dbg.length >= 1);
  }
  // ---- a stuck stream cannot hang the quit forever
  {
    const fs = fakeFs();
    const r = new R.SessionRecorder({ dir: DIR, fs, clock: () => T });
    r.start('P'); r.write(kb());
    const s = [...fs.files.values()][0].stream;
    s.end = () => {}; // never finishes
    s.once('close', () => {});
    const t = Date.now();
    const origSet = global.setTimeout;
    global.setTimeout = (fn, ms) => origSet(fn, ms > 1000 ? 20 : ms); // shrink the 10 s guard for the test
    try { await r.stop(); } finally { global.setTimeout = origSet; }
    assert.ok(Date.now() - t < 2000);
  }
  assert.throws(() => new R.SessionRecorder({}), /folder/);
  clearInterval(keepAlive);
  console.log('recording tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
