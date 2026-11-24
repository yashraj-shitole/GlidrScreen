'use strict';
// HostCore control-channel routing (quality/fps/saver, lock, cursor, clipboard, audio flag) with Electron,
// the engine, signaling, input and the clipboard faked. Run: node host/test/host-ctl.test.js
const assert = require('assert');
const Module = require('module');
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

function setup(settings = {}) {
  const data = { sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'Phone' }], ...settings };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, published: [], publish(key, m) { this.published.push(m); return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  let clipText = 'initial';
  const clipboard = { readText: () => clipText, writeText: (t) => { clipText = t; } };
  let cursor = { x: 960, y: 540 };
  const input = { bounds: null, setBounds(b) { this.bounds = b; }, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard, cursorPos: () => cursor });
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  return {
    data, core, sig, engine, input, dc,
    setClip: (t) => { clipText = t; }, getClip: () => clipText, setCursor: (c) => { cursor = c; },
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0', audio: !!engine.audioOk });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---- start command carries fps / audio; hello reports them
  {
    const t = setup();
    await t.connect();
    const start = t.engine.cmds.find((c) => c.t === 'start');
    assert.strictEqual(start.audio, false, 'audio off unless shareAudio is true');
    assert.strictEqual(start.fps, 24); assert.strictEqual(start.quality, 'auto'); assert.strictEqual(start.bitrate, 6_000_000);
    assert.strictEqual(start.contentHint, 'motion'); assert.strictEqual(start.sourceId, 'screen:7:0');
    const hello = t.dc.find((m) => m.t === 'hello');
    assert.strictEqual(hello.fps, 24); assert.strictEqual(hello.locked, false); assert.strictEqual(hello.audio, false); assert.strictEqual(hello.v, 1);
    t.core.endSession('x', false);
  }
  // ---- shareAudio: start asks for audio; hello.audio mirrors what the engine really captured
  {
    const t = setup({ shareAudio: true });
    t.engine.audioOk = true;
    await t.connect();
    assert.strictEqual(t.engine.cmds.find((c) => c.t === 'start').audio, true);
    assert.strictEqual(t.dc.find((m) => m.t === 'hello').audio, true);
    t.core.endSession('x', false);
    const f = setup({ shareAudio: true }); // engine could not capture audio -> offer says audio:false
    await f.connect();
    assert.strictEqual(f.dc.find((m) => m.t === 'hello').audio, false);
  }
  // ---- lock state
  {
    const t = setup();
    t.core.setLocked(true); // no session: stored only
    assert.strictEqual(t.dc.length, 0);
    await t.connect();
    assert.strictEqual(t.dc.find((m) => m.t === 'hello').locked, true);
    t.core.setLocked(false);
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'locked'), [{ t: 'locked', on: false }]);
    t.core.setLocked(false); // unchanged: nothing more
    t.core.setLocked(true);
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'locked').pop(), { t: 'locked', on: true });
    assert.strictEqual(t.dc.filter((m) => m.t === 'locked').length, 2);
    t.core.endSession('x', false);
  }
  // ---- quality / fps / saver
  {
    const t = setup();
    await t.connect();
    const q = () => t.engine.cmds.filter((c) => c.t === 'quality').pop();
    t.ctl({ t: 'quality', p: 'balanced', fps: 60 });
    assert.deepStrictEqual([q().preset, q().fps, q().bitrate, q().saver], ['balanced', 60, 4_200_000, false]);
    t.ctl({ t: 'quality', p: 'high', fps: 60 });
    assert.strictEqual(q().fps, 30);
    t.ctl({ t: 'quality', p: 'auto', fps: 77 });
    assert.strictEqual(q().fps, 24);
    t.ctl({ t: 'quality', p: 'auto', fps: 60, saver: true });
    assert.deepStrictEqual([q().fps, q().bitrate, q().contentHint, q().saver], [15, 3_000_000, 'detail', true]);
    t.ctl({ t: 'quality', p: 'low' });
    assert.deepStrictEqual([q().preset, q().fps, q().saver], ['low', 24, false]);
    const n = t.engine.cmds.length;
    t.ctl({ t: 'quality', p: 'bogus' });
    assert.strictEqual(t.engine.cmds.length, n, 'unknown preset ignored');
    t.core.endSession('x', false);
  }
  // ---- cursor stream
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'curs', on: true });
    const curs = () => t.dc.filter((m) => m.t === 'cur');
    assert.strictEqual(curs().length, 1);
    assert.ok(Math.abs(curs()[0].x - 960 / 1919) < 1e-3 && Math.abs(curs()[0].y - 540 / 1079) < 1e-3);
    await new Promise((r) => setTimeout(r, 120)); // unchanged: nothing more
    assert.strictEqual(curs().length, 1);
    t.setCursor({ x: 100, y: 200 });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(curs().length >= 2, 'moved cursor is streamed');
    t.ctl({ t: 'curs', on: false });
    const n = curs().length;
    t.setCursor({ x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(curs().length, n, 'stopped by the phone');
    t.ctl({ t: 'curs', on: true }); // restart, then session end must stop it
    t.core.endSession('x', false);
    const m = t.dc.length;
    t.setCursor({ x: 700, y: 700 });
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(t.dc.length, m, 'stopped when the session ends');
  }
  // ---- clipboard
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'clip', s: 'hello from phone' });
    assert.strictEqual(t.getClip(), 'hello from phone');
    t.ctl({ t: 'clip', s: 'x'.repeat(262145) });
    assert.strictEqual(t.getClip(), 'hello from phone', 'oversize rejected');
    t.ctl({ t: 'clip', s: '' });
    assert.strictEqual(t.getClip(), 'hello from phone', 'empty ignored');
    t.ctl({ t: 'clip', s: 5 });
    assert.strictEqual(t.getClip(), 'hello from phone');

    t.data.allowControl = false;
    t.ctl({ t: 'clip', s: 'blocked' });
    assert.strictEqual(t.getClip(), 'hello from phone', 'ignored while control is off');
    t.data.allowControl = true;

    t.ctl({ t: 'clipsync', on: true });
    await new Promise((r) => setTimeout(r, 1100)); // two polls: the phone's own text is not echoed
    assert.strictEqual(t.dc.filter((m) => m.t === 'clip').length, 0);
    t.setClip('copied on pc');
    await new Promise((r) => setTimeout(r, 700));
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'clip'), [{ t: 'clip', s: 'copied on pc' }]);
    t.ctl({ t: 'clip', s: 'phone again' });
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(t.dc.filter((m) => m.t === 'clip').length, 1, 'phone write not echoed');
    t.ctl({ t: 'clipsync', on: false });
    t.setClip('after off');
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(t.dc.filter((m) => m.t === 'clip').length, 1);
    t.ctl({ t: 'clipsync', on: true });
    t.core.endSession('x', false);
    t.setClip('after end');
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(t.dc.filter((m) => m.t === 'clip').length, 1, 'polling stops with the session');
  }
  await tick();
  console.log('ok host-ctl');
})().catch((e) => { console.error(e); process.exit(1); });
