'use strict';
// Phone camera / microphone through HostCore: `renegotiate` on ctl -> engine `pm-offer`, the engine's `pm` events ->
// `renegotiate-answer` / `renegotiate-error` / `media-stop`, the 'window' event for main.js, and the settings that gate it.
// Electron, engine, signaling and input are faked. Run: node host/test/host-phonemedia.test.js
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

const sdpOffer = (dir = 'sendonly') => 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
  + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=recvonly\r\n'
  + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n'
  + `m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=${dir}\r\n`
  + `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:3\r\na=${dir}\r\n`;

function setup({ slot = {}, settings = {} } = {}) {
  const data = {
    sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC',
    allowPhoneMedia: true, phoneMediaSink: 'sink-A',
    slots: [{ id: 'a', key: 'k', name: 'My Phone', claimedAt: 1, ...slot }], ...settings,
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim: () => {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }) });
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  const windows = [];
  core.phoneMedia.on('window', (w) => windows.push(w));
  return {
    data, core, engine, dc, windows,
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0' });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
    pm: (e) => engine.emit('evt', { t: 'pm', sid: core.sess.sid, ...e }),
    pmCmds: () => engine.cmds.filter((c) => c.t.startsWith('pm-')),
    replies: () => dc.filter((m) => /^(renegotiate|media)/.test(m.t)),
  };
}

(async () => {
  // ---- the whole round trip
  {
    const t = setup();
    const sid = await t.connect();
    t.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    assert.deepStrictEqual(t.pmCmds(), [{ t: 'pm-offer', sid, sdp: sdpOffer(), sink: 'sink-A' }]);
    t.pm({ k: 'answer', sdp: 'v=0 answer' });
    assert.deepStrictEqual(t.replies(), [{ t: 'renegotiate-answer', sdp: 'v=0 answer' }]);
    t.pm({ k: 'tracks', video: true, audio: true });
    assert.deepStrictEqual(t.windows, [{ show: true, video: true, audio: true, name: 'My Phone' }]);
    // Stop in the PC window
    t.pm({ k: 'stop' });
    assert.deepStrictEqual(t.replies().pop(), { t: 'media-stop', reason: 'pc' });
    assert.deepStrictEqual(t.pmCmds().pop(), { t: 'pm-drop', sid });
    assert.strictEqual(t.windows.pop().show, false);
    // the output chosen in the window is saved in the settings
    t.pm({ k: 'sink', id: 'cable' });
    assert.strictEqual(t.data.phoneMediaSink, 'cable');
    t.core.endSession('x', false);
  }
  // ---- off by default: the setting missing means disabled
  {
    const t = setup({ settings: { allowPhoneMedia: undefined } });
    await t.connect();
    t.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    assert.deepStrictEqual(t.replies(), [{ t: 'renegotiate-error', reason: 'disabled' }]);
    assert.deepStrictEqual(t.pmCmds(), []);
    t.core.endSession('x', false);
  }
  // ---- remote control off, or a view-only phone
  {
    const a = setup({ settings: { allowControl: false } });
    await a.connect();
    a.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    assert.strictEqual(a.replies()[0].reason, 'disabled');
    a.core.endSession('x', false);
    const b = setup({ slot: { viewOnly: true } });
    await b.connect();
    b.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    assert.strictEqual(b.replies()[0].reason, 'disabled');
    b.core.endSession('x', false);
  }
  // ---- bad sdp and busy
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'renegotiate', sdp: 'nonsense' });
    t.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    t.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    assert.deepStrictEqual(t.replies().map((m) => m.reason), ['bad-sdp', 'busy']);
    t.core.endSession('x', false);
  }
  // ---- the owner switches the setting off (main.js calls phoneMediaChanged) while the camera is showing
  {
    const t = setup();
    const sid = await t.connect();
    t.pm({ k: 'tracks', video: true, audio: false });
    t.data.allowPhoneMedia = false;
    t.core.phoneMediaChanged();
    assert.deepStrictEqual(t.replies().pop(), { t: 'media-stop', reason: 'disabled' });
    assert.deepStrictEqual(t.pmCmds().pop(), { t: 'pm-drop', sid });
    assert.strictEqual(t.windows.pop().show, false);
    t.core.endSession('x', false);
  }
  // ---- remote control switched off, and a phone made view only, while the camera is showing
  {
    const t = setup();
    await t.connect();
    t.pm({ k: 'tracks', video: true, audio: true });
    t.data.allowControl = false;
    t.core.controlChanged();
    assert.deepStrictEqual(t.replies().pop(), { t: 'media-stop', reason: 'disabled' });
    t.core.endSession('x', false);
    const v = setup();
    await v.connect();
    v.pm({ k: 'tracks', video: false, audio: true });
    v.data.slots[0].viewOnly = true;
    v.core.controlChanged();
    assert.strictEqual(v.replies().pop().reason, 'disabled');
    v.core.endSession('x', false);
  }
  // ---- session end hides the window; events of an old session are ignored
  {
    const t = setup();
    const sid = await t.connect();
    t.pm({ k: 'tracks', video: true, audio: false });
    t.core.endSession('phone left', false);
    assert.deepStrictEqual(t.windows.map((w) => w.show), [true, false]);
    t.engine.emit('evt', { t: 'pm', sid, k: 'tracks', video: true, audio: true }); // late event of the finished session
    assert.strictEqual(t.windows.length, 2);
  }
  // ---- the SDP is never written to the log
  {
    const t = setup();
    const logs = [];
    t.core.on('log', (m) => logs.push(m));
    await t.connect();
    process.env.GLIDR_DEBUG = '1'; // the generic "ctl <json>" debug line must skip it too
    t.ctl({ t: 'renegotiate', sdp: sdpOffer() });
    delete process.env.GLIDR_DEBUG;
    t.pm({ k: 'error', reason: 'bad-sdp', message: 'Failed to set remote offer' });
    assert.ok(logs.every((m) => !m.includes('m=video') && !m.includes('v=0')), logs.join('\n'));
    assert.strictEqual(t.replies().pop().reason, 'bad-sdp');
    t.core.endSession('x', false);
  }
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
