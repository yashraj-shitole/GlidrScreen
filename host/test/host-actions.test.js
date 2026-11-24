'use strict';
// HostCore quick actions over the control channel (hello.actions, `action`, `action-result`, `actions` updates), with
// Electron, the engine, signaling, input and the runner faked: nothing is ever executed. Run: node host/test/host-actions.test.js
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
const Actions = require('../src/actions');

function setup(settings = {}, slotExtra = {}) {
  const data = {
    sharing: true, allowControl: true, allowActions: false, actionsEnabled: null, launchers: [],
    quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'Phone', ...slotExtra }], ...settings,
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const ran = [];
  let now = 5_000_000;
  const core = new HostCore({
    store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }),
    runAction: async (sp) => { ran.push(sp); }, actionClock: () => now,
  });
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  return {
    data, core, dc, ran, advance: (ms) => { now += ms; },
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0' });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    async ctl(m) {
      engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: typeof m === 'string' ? m : JSON.stringify(m) });
      await new Promise((r) => setImmediate(r));
    },
    results: () => dc.filter((m) => m.t === 'action-result'),
  };
}

(async () => {
  // ---- master switch off (the default): hello.actions is empty and every action is refused
  {
    const t = setup();
    await t.connect();
    assert.deepStrictEqual(t.dc.find((m) => m.t === 'hello').actions, []);
    await t.ctl({ t: 'action', id: 'lock' });
    assert.deepStrictEqual(t.results(), [{ t: 'action-result', id: 'lock', ok: false, reason: 'disabled' }]);
    assert.strictEqual(t.ran.length, 0);
    t.core.endSession('x', false);
  }
  // ---- master switch on: lock and sleep only; they run with fixed argument lists
  {
    const t = setup({ allowActions: true });
    await t.connect();
    assert.deepStrictEqual(t.dc.find((m) => m.t === 'hello').actions, [
      { id: 'lock', label: 'Lock PC', danger: false }, { id: 'sleep', label: 'Sleep', danger: false },
    ]);
    await t.ctl({ t: 'action', id: 'lock' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'lock', ok: true });
    assert.strictEqual(t.ran.length, 1);
    assert.deepStrictEqual(t.ran[0].args, ['user32.dll,LockWorkStation']);
    assert.strictEqual(t.ran[0].opts.shell, false);
    // restart is not on: refused even with confirm
    t.advance(3000);
    await t.ctl({ t: 'action', id: 'restart', confirm: true });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'restart', ok: false, reason: 'disabled' });
    assert.strictEqual(t.ran.length, 1);
    // rate limit: immediately again -> rate; after 2 s fine
    await t.ctl({ t: 'action', id: 'sleep' });
    assert.strictEqual(t.results().pop().ok, true);
    await t.ctl({ t: 'action', id: 'sleep' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'sleep', ok: false, reason: 'rate' });
    // the limiter survives a reconnect (kept per phone, not per session)
    t.core.endSession('x', false);
    await t.connect();
    await t.ctl({ t: 'action', id: 'sleep' });
    assert.strictEqual(t.results().pop().reason, 'rate');
    // garbage is ignored: no reply, nothing runs
    const before = t.dc.length; const ranBefore = t.ran.length;
    await t.ctl({ t: 'action' });
    await t.ctl({ t: 'action', id: { $: 1 } });
    await t.ctl({ t: 'action', id: 'lock; calc' });
    await t.ctl({ t: 'action', id: 'x'.repeat(100) });
    await t.ctl({ t: 'action', cmd: 'calc.exe', path: 'C:\\evil.exe', args: ['x'] });
    await t.ctl('not json');
    assert.strictEqual(t.dc.length, before); assert.strictEqual(t.ran.length, ranBefore);
    t.core.endSession('x', false);
  }
  // ---- restart: needs the PC owner's switch AND confirm:true; cancel-shutdown comes with it
  {
    const t = setup({ allowActions: true, actionsEnabled: ['lock', 'sleep', 'restart'] });
    await t.connect();
    assert.deepStrictEqual(t.dc.find((m) => m.t === 'hello').actions.map((a) => [a.id, a.danger]),
      [['lock', false], ['sleep', false], ['restart', true], ['cancel-shutdown', false]]);
    await t.ctl({ t: 'action', id: 'restart' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'restart', ok: false, reason: 'confirm' });
    assert.strictEqual(t.ran.length, 0);
    await t.ctl({ t: 'action', id: 'restart', confirm: true });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'restart', ok: true });
    assert.deepStrictEqual(t.ran[0].args, ['/r', '/t', '15', '/c', 'Glidr Screen']);
    t.advance(2000);
    await t.ctl({ t: 'action', id: 'cancel-shutdown' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'cancel-shutdown', ok: true });
    assert.deepStrictEqual(t.ran[1].args, ['/a']);
    t.core.endSession('x', false);
  }
  // ---- a runner that fails: reason failed
  {
    const t = setup({ allowActions: true });
    t.core.runActionFn = async () => { throw new Error('nope'); };
    await t.connect();
    await t.ctl({ t: 'action', id: 'lock' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'lock', ok: false, reason: 'failed' });
    t.core.endSession('x', false);
  }
  // ---- view-only phone: empty list in hello, refused if it asks anyway
  {
    const t = setup({ allowActions: true }, { viewOnly: true });
    await t.connect();
    assert.deepStrictEqual(t.dc.find((m) => m.t === 'hello').actions, []);
    await t.ctl({ t: 'action', id: 'lock' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'lock', ok: false, reason: 'view-only' });
    assert.strictEqual(t.ran.length, 0);
    t.core.endSession('x', false);
  }
  // ---- allowControl off on the PC: refused; switching it changes the phone's list
  {
    const t = setup({ allowActions: true });
    await t.connect();
    t.data.allowControl = false;
    t.core.controlChanged();
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'actions').pop(), { t: 'actions', list: [] });
    await t.ctl({ t: 'action', id: 'lock' });
    assert.strictEqual(t.results().pop().reason, 'view-only');
    t.data.allowControl = true;
    t.core.controlChanged();
    assert.strictEqual(t.dc.filter((m) => m.t === 'actions').pop().list.length, 2);
    t.core.endSession('x', false);
  }
  // ---- PC owner changes the list: the live phone is told
  {
    const t = setup({ allowActions: true });
    await t.connect();
    t.data.actionsEnabled = Actions.setEnabled({ allowActions: true, actionsEnabled: null, launchers: [] }, 'shutdown', true);
    t.core.actionsChanged();
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'actions').pop().list.map((a) => a.id), ['lock', 'sleep', 'shutdown', 'cancel-shutdown']);
    t.data.allowActions = false;
    t.core.actionsChanged();
    assert.deepStrictEqual(t.dc.filter((m) => m.t === 'actions').pop(), { t: 'actions', list: [] });
    // a launcher the owner removed while the phone still shows it
    t.data.allowActions = true;
    await t.ctl({ t: 'action', id: 'deadbeef' });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: 'deadbeef', ok: false, reason: 'unknown' });
    t.core.endSession('x', false);
    const n = t.dc.length;
    t.core.actionsChanged(); // no session: nothing sent
    assert.strictEqual(t.dc.length, n);
  }
  // ---- a launcher: hidden until enabled; the phone sees label only
  {
    const added = Actions.addLauncher([], { label: 'Tool', path: 'https://example.com/x?a=1&b=2' });
    const t = setup({ allowActions: true, launchers: added.launchers });
    await t.connect();
    assert.deepStrictEqual(t.dc.find((m) => m.t === 'hello').actions.map((a) => a.id), ['lock', 'sleep']);
    t.data.actionsEnabled = ['lock', added.id];
    t.core.actionsChanged();
    const list = t.dc.filter((m) => m.t === 'actions').pop().list;
    assert.deepStrictEqual(list, [{ id: 'lock', label: 'Lock PC', danger: false }, { id: added.id, label: 'Tool', danger: false }]);
    assert.ok(!JSON.stringify(t.dc).includes('example.com'), 'the phone never sees a path or URL');
    await t.ctl({ t: 'action', id: added.id });
    assert.deepStrictEqual(t.results().pop(), { t: 'action-result', id: added.id, ok: true });
    assert.deepStrictEqual(t.ran[0].args, ['https://example.com/x?a=1&b=2']);
    t.core.endSession('x', false);
  }
  console.log('host actions tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
