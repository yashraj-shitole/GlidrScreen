'use strict';
// Phone `quality.mode` routing through HostCore into the engine command (Electron, engine and signaling faked).
// Run: node host/test/quality-mode.test.js
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

function setup() {
  const data = { sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'Phone' }] };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const clipboard = { readText: () => '', writeText() {} };
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard, cursorPos: () => ({ x: 0, y: 0 }) });
  return {
    core, engine,
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0', audio: false });
      engine.emit('evt', { t: 'dc-open', sid });
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
    sent: () => engine.cmds.filter((c) => c.t === 'quality'),
  };
}

(async () => {
  const t = setup();
  await t.connect();

  t.ctl({ t: 'quality', p: 'balanced', fps: 30 });
  assert.strictEqual(t.sent().pop().mode, 'auto', 'default mode is auto');

  t.ctl({ t: 'quality', p: 'balanced', fps: 30, mode: 'latency' });
  const q = t.sent().pop();
  assert.strictEqual(q.mode, 'latency'); assert.strictEqual(q.preset, 'balanced'); assert.strictEqual(q.fps, 30);
  assert.strictEqual(t.core.sess.mode, 'latency', 'remembered per session');

  t.ctl({ t: 'quality', p: 'high' }); // no mode: the session keeps its mode
  assert.strictEqual(t.sent().pop().mode, 'latency');

  t.ctl({ t: 'quality', p: 'high', mode: 'clarity' });
  assert.strictEqual(t.sent().pop().mode, 'clarity');

  for (const bad of ['turbo', 7, '', {}, true]) {
    t.ctl({ t: 'quality', p: 'high', mode: bad });
    assert.strictEqual(t.sent().pop().mode, 'auto', 'unknown mode -> auto: ' + JSON.stringify(bad));
  }

  t.ctl({ t: 'quality', p: 'high', mode: 'clarity' });
  const n = t.sent().length;
  t.ctl({ t: 'quality', p: 'ultra', mode: 'latency' }); // unknown preset: the whole message is ignored
  assert.strictEqual(t.sent().length, n);
  assert.strictEqual(t.core.sess.mode, 'clarity');
  t.core.endSession('x', false);

  // a new session starts in auto again
  const t2 = setup();
  await t2.connect();
  t2.ctl({ t: 'quality', p: 'low' });
  assert.strictEqual(t2.sent().pop().mode, 'auto');
  t2.core.endSession('x', false);

  console.log('ok quality-mode');
})().catch((e) => { console.error(e); process.exit(1); });
