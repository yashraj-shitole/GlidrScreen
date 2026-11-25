'use strict';
// Session recording through HostCore: off by default, the phone is told (hello.recording and `recording`), start / stop
// when the setting changes in a live session, chunks from the engine reach the recorder (and are acknowledged), the
// 2 GB limit / an engine failure / session end finalise the file, and nothing sensitive is logged or put in the balloon
// event. Electron, engine, signaling, input and the file system are fakes. Run: node host/test/host-recording.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

const display = { id: 7, label: 'D', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const fakeElectron = {
  screen: {
    getPrimaryDisplay: () => display, getAllDisplays: () => [display],
    dipToScreenRect: (_w, b) => ({ x: b.x, y: b.y, width: b.width, height: b.height }),
  },
  desktopCapturer: { getSources: async () => [{ id: 'screen:7:0', display_id: '7' }] },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
const { HostCore } = require('../src/host');
Module._load = origLoad;

const DIR = path.resolve('C:\\Users\\x\\Videos\\Glidr');
const T = new Date(2026, 4, 28, 14, 15, 3).getTime();

function fakeFs({ failMkdir = null } = {}) {
  const files = new Map();
  const fs = {
    files,
    mkdirSync() { if (failMkdir) { const e = new Error('x'); e.code = failMkdir; throw e; } },
    openSync(p) { if (files.has(p)) { const e = new Error('x'); e.code = 'EEXIST'; throw e; } files.set(p, { chunks: [], ended: false }); return 3; },
    createWriteStream(p) {
      const f = files.get(p);
      const s = new EventEmitter();
      s.writableLength = 0;
      s.write = (b) => { f.chunks.push(Buffer.from(b)); return true; };
      s.end = (cb) => setImmediate(() => { f.ended = true; if (cb) cb(); s.emit('close'); });
      s.destroy = () => {};
      return s;
    },
    unlinkSync(p) { files.delete(p); },
  };
  return fs;
}
const bytes = (f) => f.chunks.reduce((n, c) => n + c.length, 0);

function setup({ settings = {}, fs = fakeFs(), deps = {} } = {}) {
  const data = {
    sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC',
    slots: [{ id: 'a', key: 'k', name: 'My Phone', claimedAt: 1 }], ...settings,
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim: () => {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }) });
  core.recordingsDir = () => DIR;
  core.recDeps = { fs, clock: () => T, ...deps };
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  const saved = []; const logs = [];
  core.on('recording-saved', (e) => saved.push(e));
  core.on('log', (m) => logs.push(m));
  return {
    data, core, engine, dc, fs, saved, logs,
    cmds: (t) => engine.cmds.filter((c) => c.t === t),
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0' });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    chunk: (sid, n, seg = 1) => engine.emit('evt', { t: 'rec-chunk', sid, seg, data: new Uint8Array(n).fill(5) }),
    hello: () => dc.find((m) => m.t === 'hello'),
    recMsgs: () => dc.filter((m) => m.t === 'recording'),
  };
}

(async () => {
  // ---- the setting: off by default, only a real true switches it on, it persists
  {
    const os = require('os');
    const { Store } = require('../src/store');
    const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'glidr-rec-store-'));
    const st = new Store(dir, { safeStorage: null });
    assert.strictEqual(st.get('recordSessions'), false);
    st.set({ recordSessions: true });
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('recordSessions'), true);
    require('fs').writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ recordSessions: 'yes', slots: [] }));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('recordSessions'), false, 'a hand-edited value cannot switch it on');
  }
  // ---- off by default: no recording, the phone is told false, nothing is created
  {
    const t = setup();
    const sid = await t.connect();
    assert.strictEqual(t.cmds('start')[0].record, false);
    assert.strictEqual(t.hello().recording, false);
    assert.strictEqual(t.core.snapshot().recording, false);
    assert.strictEqual(t.cmds('rec').length, 0, 'the engine was never asked to record, nothing to switch off');
    t.chunk(sid, 5000); // a chunk nobody asked for
    assert.strictEqual(t.fs.files.size, 0);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [false], 'the engine is told to stop');
    t.chunk(sid, 5000);
    assert.strictEqual(t.cmds('rec').length, 1, 'once');
    assert.strictEqual(t.cmds('rec-ack').length, 2);
    t.core.endSession('x', false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, []);
  }
  // ---- on: start command, hello, engine told, chunks written and acknowledged, saved event with the phone's name only
  {
    const t = setup({ settings: { recordSessions: true } });
    const sid = await t.connect();
    assert.strictEqual(t.cmds('start')[0].record, true);
    assert.strictEqual(t.hello().recording, true, 'the very first message tells the phone');
    assert.strictEqual(t.dc.indexOf(t.hello()), 0);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [true]);
    assert.strictEqual(t.core.snapshot().recording, true);
    assert.deepStrictEqual([...t.fs.files.keys()], [path.join(DIR, 'Glidr-My_Phone-20260528-141503.webm')]);
    t.chunk(sid, 4000); t.chunk(sid, 4000);
    assert.strictEqual(bytes([...t.fs.files.values()][0]), 8000);
    assert.deepStrictEqual(t.cmds('rec-ack').map((c) => c.n), [4000, 4000]);
    // a chunk of another session is ignored
    t.engine.emit('evt', { t: 'rec-chunk', sid: 'nope', seg: 1, data: new Uint8Array(100) });
    assert.strictEqual(bytes([...t.fs.files.values()][0]), 8000);
    // a monitor switch: next segment, same session, the phone hears nothing
    const before = t.dc.length;
    t.chunk(sid, 3000, 2);
    assert.strictEqual(t.fs.files.size, 2);
    assert.strictEqual(t.dc.length, before);
    t.core.endSession('viewer left', false);
    assert.strictEqual(t.core.snapshot().recording, false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, [{ from: 'My Phone' }], 'phone name only, no path');
    for (const f of t.fs.files.values()) assert.strictEqual(f.ended, true);
    assert.ok(t.logs.every((m) => !/Videos|\.webm|Glidr-/.test(m)), 'no file name or path in the log: ' + t.logs.join('|'));
    assert.ok(t.cmds('stop').length === 1);
  }
  // ---- switched on / off during a live session: immediate, and the phone is told each time
  {
    const t = setup();
    const sid = await t.connect();
    t.data.recordSessions = true;
    t.core.recordingChanged();
    assert.deepStrictEqual(t.recMsgs(), [{ t: 'recording', on: true }]);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [true]);
    assert.strictEqual(t.core.snapshot().recording, true);
    t.core.recordingChanged(); // no change: no second file, no second message
    assert.strictEqual(t.fs.files.size, 1);
    assert.strictEqual(t.recMsgs().length, 1);
    t.chunk(sid, 5000);
    t.data.recordSessions = false;
    t.core.recordingChanged();
    assert.deepStrictEqual(t.recMsgs(), [{ t: 'recording', on: true }, { t: 'recording', on: false }]);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [true, false]);
    assert.strictEqual(t.core.snapshot().recording, false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, [{ from: 'My Phone' }]);
    // the late chunk of the stopped recording changes nothing
    t.chunk(sid, 5000);
    assert.strictEqual(bytes([...t.fs.files.values()][0]), 5000);
    t.core.recordingChanged();
    assert.strictEqual(t.recMsgs().length, 2, 'off and still off: nothing sent');
    t.core.endSession('x', false);
  }
  // ---- not live yet: switching the setting does nothing (the start command decides, the channel opening applies it)
  {
    const t = setup();
    t.data.recordSessions = true;
    t.core.recordingChanged();
    assert.strictEqual(t.fs.files.size, 0);
    assert.deepStrictEqual(t.recMsgs(), []);
  }
  // ---- the file cannot be created: the phone is told "not recording", the engine is switched off, the session goes on
  {
    const t = setup({ settings: { recordSessions: true }, fs: fakeFs({ failMkdir: 'EACCES' }) });
    await t.connect();
    assert.strictEqual(t.hello().recording, false);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [false]);
    assert.ok(t.core.sess.live, 'the session is not affected');
    assert.ok(t.logs.some((m) => /EACCES/.test(m)));
    t.core.endSession('x', false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, []);
  }
  // ---- the file size limit: the recording ends, the phone and the engine are told, the file is kept
  {
    const t = setup({ settings: { recordSessions: true }, deps: { maxBytes: 6000 } });
    const sid = await t.connect();
    t.chunk(sid, 4000);
    t.chunk(sid, 4000); // over the limit
    assert.deepStrictEqual(t.recMsgs(), [{ t: 'recording', on: false }]);
    assert.deepStrictEqual(t.cmds('rec').map((c) => c.on), [true, false]);
    assert.strictEqual(t.core.snapshot().recording, false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, [{ from: 'My Phone' }]);
    assert.strictEqual(bytes([...t.fs.files.values()][0]), 4000);
    t.core.endSession('x', false);
  }
  // ---- the engine cannot record (rec-stop): the phone is told, the file is finalised
  {
    const t = setup({ settings: { recordSessions: true } });
    const sid = await t.connect();
    t.chunk(sid, 3000);
    t.engine.emit('evt', { t: 'rec-stop', sid });
    assert.deepStrictEqual(t.recMsgs(), [{ t: 'recording', on: false }]);
    assert.strictEqual(t.core.snapshot().recording, false);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, [{ from: 'My Phone' }]);
    t.engine.emit('evt', { t: 'rec-stop', sid }); // again: nothing happens
    assert.strictEqual(t.recMsgs().length, 1);
    t.core.endSession('x', false);
  }
  // ---- engine crash / session end by any route finalise the file
  {
    const t = setup({ settings: { recordSessions: true } });
    const sid = await t.connect();
    t.chunk(sid, 3000);
    t.core.endSession('engine crashed', true);
    await t.core.recordingsDone();
    assert.deepStrictEqual(t.saved, [{ from: 'My Phone' }]);
    assert.strictEqual([...t.fs.files.values()][0].ended, true);
    assert.strictEqual(t.core.sess, null);
  }
  // ---- a recording too small to keep (under 1 KB) is removed and nothing is announced
  {
    const t = setup({ settings: { recordSessions: true } });
    const sid = await t.connect();
    t.chunk(sid, 100);
    t.core.endSession('x', false);
    await t.core.recordingsDone();
    assert.strictEqual(t.fs.files.size, 0);
    assert.deepStrictEqual(t.saved, []);
  }
  // ---- the next session records into a new file, the old one is untouched
  {
    const fs = fakeFs();
    const t = setup({ settings: { recordSessions: true }, fs });
    let sid = await t.connect();
    t.chunk(sid, 3000);
    t.core.endSession('x', false);
    sid = await t.connect();
    t.chunk(sid, 2000);
    assert.deepStrictEqual([...fs.files.keys()].map((p) => path.basename(p)), ['Glidr-My_Phone-20260528-141503.webm', 'Glidr-My_Phone-20260528-141503-2.webm']);
    assert.strictEqual(bytes([...fs.files.values()][0]), 3000);
    t.core.endSession('x', false);
    await t.core.recordingsDone();
  }
  console.log('host recording tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
