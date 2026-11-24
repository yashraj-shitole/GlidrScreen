'use strict';
// Per-phone permissions in HostCore: expired slots are refused (and kept), view only blocks input and writes,
// the time limit ends a session with reason 'time limit'. Electron, engine, signaling and input are faked.
// Run: node host/test/host-perms.test.js
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
const { Store } = require('../src/store');
Module._load = origLoad;

const fs = require('fs');
const os = require('os');
const path = require('path');

function setup({ slot = {}, settings = {} } = {}) {
  const data = {
    sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC',
    slots: [{ id: 'a', key: 'k', name: 'Phone', claimedAt: 1, ...slot }], ...settings,
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim: () => {}, data };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, published: [], publish(key, m) { this.published.push(m); return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const input = { setBounds() {}, reset: rec('reset'), moveBy: rec('moveBy'), moveNorm: rec('moveNorm'), button: rec('button'), wheel: rec('wheel'), key: rec('key'), combo: rec('combo'), text: rec('text') };
  let clipText = 'initial';
  const clipboard = { readText: () => clipText, writeText: (t) => { clipText = t; } };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard, cursorPos: () => ({ x: 0, y: 0 }) });
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  const request = () => sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
  return {
    data, store, core, sig, engine, calls, dc, getClip: () => clipText, request,
    async connect() {
      request();
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0' });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
    inputCalls: () => calls.filter((c) => c[0] !== 'reset'),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendAll = (t) => {
  t.ctl({ t: 'mv', dx: 1, dy: 2 }); t.ctl({ t: 'abs', x: 0.5, y: 0.5 }); t.ctl({ t: 'btn', b: 'l', a: 'c' });
  t.ctl({ t: 'wheel', x: 0, y: 1 }); t.ctl({ t: 'key', k: 'a' }); t.ctl({ t: 'combo', keys: ['Ctrl', 'c'] }); t.ctl({ t: 'text', s: 'hi' });
  t.ctl({ t: 'clip', s: 'from phone' });
};

(async () => {
  // ---- expired slot: deny 'expired', nothing removed, no session
  {
    const t = setup({ slot: { expiresAt: Date.now() - 1000 } });
    t.request();
    await tick();
    assert.strictEqual(t.core.sess, null);
    assert.deepStrictEqual(t.sig.published.map((m) => [m.t, m.reason]), [['deny', 'expired']]);
    assert.strictEqual(t.data.slots.length, 1, 'slot is not removed');
    assert.strictEqual(t.engine.cmds.length, 0);
    // renewed access lets the same phone in again
    t.data.slots[0].expiresAt = Date.now() + 60_000;
    t.request();
    await tick();
    assert.ok(t.core.sess);
    t.core.endSession('x', false);
  }
  // ---- slots without the new fields behave as before
  {
    const t = setup();
    await t.connect();
    assert.strictEqual(t.dc.find((m) => m.t === 'hello').control, true);
    sendAll(t);
    assert.strictEqual(t.inputCalls().length, 7);
    assert.strictEqual(t.getClip(), 'from phone');
    t.core.endSession('x', false);
  }
  // ---- view only: hello.control false, no input, no clipboard write
  {
    const t = setup({ slot: { viewOnly: true } });
    await t.connect();
    assert.strictEqual(t.dc.find((m) => m.t === 'hello').control, false);
    sendAll(t);
    assert.deepStrictEqual(t.inputCalls(), []);
    assert.strictEqual(t.getClip(), 'initial');
    // monitors / ping still work
    t.ctl({ t: 'ping', n: 1, ts: 2 });
    assert.ok(t.dc.some((m) => m.t === 'pong'));
    // toggled live: the phone is told, input follows at once
    t.data.slots[0].viewOnly = false;
    t.core.controlChanged();
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'control').pop(), { t: 'control', on: true });
    t.ctl({ t: 'mv', dx: 1, dy: 1 });
    assert.strictEqual(t.inputCalls().length, 1);
    t.data.slots[0].viewOnly = true;
    t.core.controlChanged();
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'control').pop(), { t: 'control', on: false });
    t.ctl({ t: 'mv', dx: 1, dy: 1 });
    assert.strictEqual(t.inputCalls().length, 1);
    t.core.endSession('x', false);
  }
  // ---- global switch off still blocks a normal phone; both must be on
  {
    const t = setup({ settings: { allowControl: false } });
    await t.connect();
    assert.strictEqual(t.dc.find((m) => m.t === 'hello').control, false);
    sendAll(t);
    assert.deepStrictEqual(t.inputCalls(), []);
    t.core.endSession('x', false);
  }
  // ---- time limit: session ends with 'time limit' and the phone is told; timer is cleared on endSession
  {
    const t = setup({ slot: { maxSessionMin: 0.002 } }); // 120 ms
    await t.connect();
    assert.ok(t.core.sess.limitTimer);
    await sleep(60);
    assert.ok(t.core.sess, 'still running before the limit');
    await sleep(160);
    assert.strictEqual(t.core.sess, null);
    const bye = t.sig.published.find((m) => m.t === 'bye');
    assert.ok(bye && bye.reason === 'time limit', 'phone notified');
    assert.ok(t.engine.cmds.some((c) => c.t === 'stop'));
  }
  {
    const t = setup({ slot: { maxSessionMin: 0.002 } });
    await t.connect();
    const timer = t.core.sess.limitTimer;
    t.core.endSession('viewer left', false);
    await sleep(200);
    assert.strictEqual(t.sig.published.filter((m) => m.t === 'bye').length, 0, 'cleared timer never fires');
    assert.ok(timer);
    // a later session is not hit by the old timer
    await t.connect();
    await sleep(60);
    assert.ok(t.core.sess);
    t.core.endSession('x', false);
  }
  // ---- access that runs out mid-session ends it too; extending it keeps the session
  {
    const t = setup({ slot: { expiresAt: Date.now() + 100 } });
    await t.connect();
    await sleep(180);
    assert.strictEqual(t.core.sess, null);
    assert.strictEqual(t.sig.published.find((m) => m.t === 'bye').reason, 'time limit');
    assert.strictEqual(t.data.slots.length, 1);
  }
  {
    const t = setup({ slot: { expiresAt: Date.now() + 100 } });
    await t.connect();
    t.data.slots[0].expiresAt = 0; // "Always"
    t.core.refreshSlots();
    await sleep(200);
    assert.ok(t.core.sess, 'extension re-arms the limit');
    t.data.slots[0].expiresAt = Date.now() + 50;
    t.core.refreshSlots();
    await sleep(120);
    assert.strictEqual(t.core.sess, null, 'shortened limit applies to the running session');
  }
  // ---- guest flow through the real Store: unclaimed has no expiry; claim starts the hour
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-perms-'));
    const store = new Store(dir, { safeStorage: null });
    const plain = store.createSlot();
    assert.ok(!('viewOnly' in plain) && !('expiresAt' in plain) && !('maxSessionMin' in plain) && !('expireAfterClaimMs' in plain), 'normal slots unchanged');
    const g = store.createSlot({ viewOnly: true, expireAfterClaimMs: 3_600_000, maxSessionMin: 60 });
    assert.strictEqual(g.viewOnly, true);
    assert.strictEqual(g.maxSessionMin, 60);
    assert.strictEqual(g.expiresAt, undefined, 'clock has not started');
    assert.strictEqual(store.data.slots.length, 1, 'one open pairing at a time');
    const before = Date.now();
    store.claim(g.id, 'Guest phone');
    assert.ok(g.expiresAt >= before + 3_600_000 && g.expiresAt <= Date.now() + 3_600_000);
    assert.strictEqual('expireAfterClaimMs' in g, false);
    const first = g.expiresAt;
    store.claim(g.id, 'Guest phone'); // later requests do not extend it
    assert.strictEqual(g.expiresAt, first);
    const reloaded = new Store(dir, { safeStorage: null }).data.slots[0];
    assert.deepStrictEqual([reloaded.viewOnly, reloaded.expiresAt, reloaded.maxSessionMin], [true, first, 60]);
    // junk options are ignored
    const junk = store.createSlot({ viewOnly: 'yes', expireAfterClaimMs: -5, maxSessionMin: 'x' });
    assert.ok(!('viewOnly' in junk) && !('expireAfterClaimMs' in junk) && !('maxSessionMin' in junk));
  }
  await tick();
  console.log('ok host-perms');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
