'use strict';
// Window sharing through HostCore: `windows` list / `wthumb` streams, `source` switching, input bounds, and the
// automatic fall-back when the shared window closes. Electron, the engine, signaling, input and Win32 are faked.
// Run: node host/test/host-windows.test.js
const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');

const display = { id: 7, label: 'D', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const thumb = { isEmpty: () => false, getSize: () => ({ width: 384, height: 216 }), toJPEG: () => Buffer.from('jpegbytes') };
const state = { windows: [], captureCalls: [] };
const fakeElectron = {
  screen: {
    getPrimaryDisplay: () => display, getAllDisplays: () => [display],
    dipToScreenRect: (_w, b) => ({ x: b.x, y: b.y, width: b.width, height: b.height }),
  },
  desktopCapturer: {
    getSources: async (opts) => {
      state.captureCalls.push(opts);
      if (opts.types[0] === 'window') return state.windows.map((w) => ({ id: w.id, name: w.name, thumbnail: thumb }));
      return [{ id: 'screen:7:0', display_id: '7' }];
    },
  },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, getMediaSourceId: () => 'window:555:0' }] },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
const { HostCore } = require('../src/host');
Module._load = origLoad;

const rect = { x: 100, y: 80, w: 1000, h: 700, iconic: false };
const rects = {};
const wins = (n) => Array.from({ length: n }, (_, i) => ({ id: `window:${1000 + i}:0`, name: `Window ${i}` }));

function setup() {
  state.windows = wins(14);
  state.windows.forEach((w) => { rects[Number(w.id.split(':')[1])] = { ...rect }; });
  const data = { sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'Phone' }] };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { bounds: null, moved: [], setBounds(b) { this.bounds = b; }, moveTo(x, y) { this.moved.push([x, y]); }, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const focused = [];
  const logs = [];
  const core = new HostCore({
    store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 5, y: 5 }),
    windowRect: (h) => rects[h] || null, focusWindow: (h) => { focused.push(h); return true; },
  });
  core.on('log', (l) => logs.push(l));
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  return {
    core, sig, engine, input, dc, focused, logs,
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0', audio: false });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
    switched: (extra) => engine.emit('evt', { t: 'switched', sid: core.sess.sid, w: 1000, h: 700, ...extra }),
    of: (type) => dc.filter((m) => m.t === type),
    switches: () => engine.cmds.filter((c) => c.t === 'switch'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (i) => `window:${1000 + i}:0`;

(async () => {
  // ---- list stream: first list at once, 30 max / own window hidden, previews for the first 12, only changes re-sent
  {
    const t = setup();
    state.windows = [...wins(40).slice(0, 2), { id: 'window:555:0', name: 'Settings (ours)' }, { id: 'window:600:0', name: 'Glidr Screen' }, { id: 'window:601:0', name: '' }, ...wins(40).slice(2)];
    state.windows.forEach((w) => { rects[Number(w.id.split(':')[1])] = { ...rect }; });
    rects[601] = { ...rect };
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(80);
    const lists = t.of('windows');
    assert.strictEqual(lists.length, 1, 'list sent right away');
    assert.strictEqual(lists[0].list.length, 30, 'at most 30 windows');
    assert.ok(lists[0].list.every((w) => w.id !== 'window:555:0' && w.id !== 'window:600:0' && w.id !== 'window:601:0'), 'own and untitled windows skipped');
    assert.deepStrictEqual(Object.keys(lists[0].list[0]).sort(), ['h', 'id', 'title', 'w']);
    assert.deepStrictEqual([lists[0].list[0].w, lists[0].list[0].h], [1000, 700]);
    const th = t.of('wthumb');
    assert.strictEqual(th.length, 12, 'previews for the first 12 windows only');
    assert.deepStrictEqual(th[0], { t: 'wthumb', id: lists[0].list[0].id, w: 384, h: 216, jpg: Buffer.from('jpegbytes').toString('base64') });
    const thumbCall = state.captureCalls.filter((c) => c.types[0] === 'window' && c.thumbnailSize.width === 384).pop();
    assert.deepStrictEqual(thumbCall.thumbnailSize, { width: 384, height: 216 });

    await sleep(2300); // next 2 s tick: nothing changed -> nothing sent
    assert.strictEqual(t.of('windows').length, 1, 'unchanged list is not re-sent');
    rects[1002] = { ...rect, w: 1100 };
    await sleep(2100);
    assert.strictEqual(t.of('windows').length, 2, 'a changed size is re-sent');
    t.ctl({ t: 'windows', on: false });
    const n = t.dc.length;
    rects[1003] = { ...rect, w: 1234 };
    await sleep(2300);
    assert.strictEqual(t.dc.length, n, 'nothing after the phone turned the stream off');
    t.core.endSession('x', false);
  }

  // ---- sharing a window
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(60);
    t.ctl({ t: 'source', kind: 'window', id: idOf(2) });
    await sleep(10);
    assert.deepStrictEqual(t.switches(), [{ t: 'switch', sid: t.core.sess.sid, kind: 'window', id: idOf(2), monitorId: null, sourceId: idOf(2) }]);
    assert.deepStrictEqual(t.focused, [1002], 'window brought to the front');
    assert.strictEqual(t.of('active').length, 0, 'nothing reported before the engine confirms the capture');
    assert.strictEqual(t.input.bounds.w, 1920 - 0, 'input still on the monitor until confirmed');
    t.switched({ kind: 'window', id: idOf(2), monitorId: null });
    assert.deepStrictEqual(t.of('active'), [{ t: 'active', kind: 'window', id: idOf(2), title: 'Window 2', w: 1000, h: 700 }]);
    assert.deepStrictEqual(t.input.bounds, { x: 100, y: 80, w: 1000, h: 700 }, 'pointer maps to the window');
    assert.deepStrictEqual(t.input.moved, [[600, 430]], 'cursor outside the window moves to its centre');

    // the window moves and is resized: bounds are refreshed (at most every 250 ms)
    rects[1002] = { x: 300, y: 200, w: 640, h: 480, iconic: false };
    await sleep(450);
    assert.deepStrictEqual(t.input.bounds, { x: 300, y: 200, w: 640, h: 480 }, 'bounds follow the window');
    assert.strictEqual(t.of('source-error').length, 0);

    // switching back to a monitor with kind:monitor behaves like `monitor`
    t.ctl({ t: 'source', kind: 'monitor', id: '7' });
    await sleep(10);
    const sw = t.switches().pop();
    assert.deepStrictEqual([sw.monitorId, sw.sourceId, sw.kind], [7, 'screen:7:0', undefined]);
    assert.deepStrictEqual(t.input.bounds, { x: 0, y: 0, w: 1920, h: 1080 });
    t.switched({ kind: 'monitor', monitorId: 7, w: 1920, h: 1080 });
    assert.deepStrictEqual(t.of('active').pop(), { t: 'active', id: 7, w: 1920, h: 1080 }, 'monitor active message unchanged');
    rects[1002] = { x: 0, y: 0, w: 10, h: 10, iconic: true };
    await sleep(400);
    assert.strictEqual(t.of('source-error').length, 0, 'a window that is no longer shared is not followed');
    t.core.endSession('x', false);
  }

  // ---- ids that are not in the latest list, windows that vanished, garbage
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(60);
    const before = t.switches().length;
    t.ctl({ t: 'source', kind: 'window', id: 'window:424242:0' }); // never listed
    t.ctl({ t: 'source', kind: 'window', id: 'screen:7:0' });
    delete rects[1005]; // listed, but closed since
    t.ctl({ t: 'source', kind: 'window', id: idOf(5) });
    rects[1006] = { x: -32000, y: -32000, w: 0, h: 0, iconic: true }; // minimised since
    t.ctl({ t: 'source', kind: 'window', id: idOf(6) });
    await sleep(10);
    assert.deepStrictEqual(t.of('source-error').map((m) => m.id), ['window:424242:0', 'screen:7:0', idOf(5), idOf(6)]);
    assert.ok(t.of('source-error').every((m) => m.reason === 'gone'));
    assert.strictEqual(t.switches().length, before, 'nothing was captured');
    t.ctl({ t: 'source', kind: 'window', id: 12 }); // not a string: ignored
    t.ctl({ t: 'source', kind: 'bogus', id: idOf(1) });
    t.ctl({ t: 'source' });
    await sleep(10);
    assert.strictEqual(t.of('source-error').length, 4);
    assert.strictEqual(t.switches().length, before);
    t.core.endSession('x', false);
  }

  // ---- a window can be chosen without the list stream (fresh lookup), but still only a real, listed window
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'source', kind: 'window', id: idOf(3) });
    await sleep(30);
    assert.strictEqual(t.switches().length, 1);
    t.ctl({ t: 'source', kind: 'window', id: 'window:999999:0' });
    await sleep(30);
    assert.deepStrictEqual(t.of('source-error').map((m) => m.id), ['window:999999:0']);
    t.core.endSession('x', false);
  }

  // ---- shared window minimised: one source-error, automatic fall back to the primary monitor
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(60);
    t.ctl({ t: 'source', kind: 'window', id: idOf(0) });
    await sleep(10);
    t.switched({ kind: 'window', id: idOf(0), monitorId: null });
    t.ctl({ t: 'windows', on: false });
    const n = t.switches().length;
    rects[1000] = { x: -32000, y: -32000, w: 0, h: 0, iconic: true };
    await sleep(450);
    assert.deepStrictEqual(t.of('source-error'), [{ t: 'source-error', id: idOf(0), reason: 'gone' }]);
    assert.strictEqual(t.switches().length, n + 1, 'fall back switches the capture to a monitor');
    const sw = t.switches().pop();
    assert.deepStrictEqual([sw.monitorId, sw.sourceId], [7, 'screen:7:0']);
    assert.deepStrictEqual(t.input.bounds, { x: 0, y: 0, w: 1920, h: 1080 });
    t.switched({ kind: 'monitor', monitorId: 7, w: 1920, h: 1080 });
    assert.deepStrictEqual(t.of('active').pop(), { t: 'active', id: 7, w: 1920, h: 1080 }, 'normal monitor active message');
    await sleep(500);
    assert.strictEqual(t.of('source-error').length, 1, 'reported once only');
    assert.strictEqual(t.switches().length, n + 1);
    t.core.endSession('x', false);
  }

  // ---- shared window closed (IsWindow false)
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'source', kind: 'window', id: idOf(4) });
    await sleep(30);
    t.switched({ kind: 'window', id: idOf(4), monitorId: null });
    delete rects[1004];
    await sleep(450);
    assert.strictEqual(t.of('source-error').length, 1);
    assert.strictEqual(t.switches().length, 2);
    t.core.endSession('x', false);
  }

  // ---- the engine could not capture the window: the phone is told, nothing changes
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'source', kind: 'window', id: idOf(1) });
    await sleep(30);
    t.engine.emit('evt', { t: 'error', sid: t.core.sess.sid, where: 'switch', message: 'Could not start video source' });
    assert.deepStrictEqual(t.of('source-error'), [{ t: 'source-error', id: idOf(1), reason: 'gone' }]);
    t.switched({ kind: 'window', id: idOf(1), monitorId: null }); // a late confirmation after the failure is ignored
    assert.strictEqual(t.of('active').length, 0);
    assert.deepStrictEqual(t.input.bounds, { x: 0, y: 0, w: 1920, h: 1080 });
    t.core.endSession('x', false);
  }

  // ---- window titles never reach the log
  {
    const t = setup();
    state.windows = [{ id: 'window:700:0', name: 'Secret bank statement.pdf' }];
    rects[700] = { ...rect };
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(60);
    t.ctl({ t: 'source', kind: 'window', id: 'window:700:0' });
    await sleep(20);
    t.switched({ kind: 'window', id: 'window:700:0', monitorId: null });
    delete rects[700];
    await sleep(450);
    t.core.endSession('x', false);
    assert.ok(!t.logs.some((l) => /secret|bank|statement/i.test(l)), 'no title in the log: ' + t.logs.join(' | '));
  }

  // ---- session end stops the streams and the follower (the process must be able to exit)
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'windows', on: true });
    await sleep(60);
    t.ctl({ t: 'source', kind: 'window', id: idOf(0) });
    await sleep(10);
    t.switched({ kind: 'window', id: idOf(0), monitorId: null });
    t.core.endSession('x', false);
    assert.strictEqual(t.core.winTimer, null);
    assert.strictEqual(t.core.winLatest, null);
  }
  console.log('ok host-windows');
})().catch((e) => { console.error(e); process.exit(1); });
