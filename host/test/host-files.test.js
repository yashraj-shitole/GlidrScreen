'use strict';
// File transfer through HostCore: offer policy (allowControl, view only, allowFiles), accept / reject / done on `ctl`,
// bytes from the `files` channel events, abort on session end / control off / switch off, balloon event.
// Electron, engine, signaling and input are faked. Run: node host/test/host-files.test.js
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-host-files-'));
const dir = path.join(root, 'Glidr');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ slot = {}, settings = {} } = {}) {
  const data = {
    sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC',
    slots: [{ id: 'a', key: 'k', name: 'My Phone', claimedAt: 1, ...slot }], ...settings,
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim: () => {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }), filesDir: () => dir });
  const dc = [];
  const origSend = engine.send.bind(engine);
  engine.send = (c) => { origSend(c); if (c.t === 'send') dc.push(JSON.parse(c.data)); };
  const received = [];
  core.on('file-received', (r) => received.push(r));
  return {
    data, core, engine, dc, received,
    async connect() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      const sid = core.sess.sid;
      engine.emit('evt', { t: 'offer', sid, sdp: 'v=0' });
      engine.emit('evt', { t: 'dc-open', sid });
      return sid;
    },
    ctl: (m) => engine.emit('evt', { t: 'ctl', sid: core.sess.sid, data: JSON.stringify(m) }),
    text: (m) => engine.emit('evt', { t: 'files', sid: core.sess.sid, data: JSON.stringify(m) }),
    bin: (b) => engine.emit('evt', { t: 'files-bin', sid: core.sess.sid, data: new Uint8Array(b) }),
    replies: () => dc.filter((m) => m.t.startsWith('file-')),
    async settle() { await sleep(60); },
    async upload(id, name, data) {
      this.ctl({ t: 'file-offer', id, name, size: data.length });
      await this.settle();
      this.text({ t: 'begin', id });
      for (let i = 0; i < data.length; i += 16384) this.bin(data.subarray(i, i + 16384));
      this.text({ t: 'end', id, sha256: sha(data) });
      await this.settle();
    },
  };
}

(async () => {
  // ---- happy path
  {
    const t = setup();
    await t.connect();
    const data = crypto.randomBytes(40_000);
    await t.upload('00000001', '../x/Report.pdf', data);
    assert.deepStrictEqual(t.replies(), [{ t: 'file-accept', id: '00000001' }, { t: 'file-done', id: '00000001', ok: true, name: 'Report.pdf' }]);
    assert.ok(fs.readFileSync(path.join(dir, 'Report.pdf')).equals(data));
    assert.deepStrictEqual(t.received, [{ name: 'Report.pdf', size: 40_000, from: 'My Phone' }]);
    t.core.endSession('x', false);
  }
  // ---- allowFiles is on by default (setting missing), off rejects 'disabled'
  {
    const t = setup({ settings: { allowFiles: false } });
    await t.connect();
    t.ctl({ t: 'file-offer', id: '00000002', name: 'a.txt', size: 1 });
    assert.deepStrictEqual(t.replies(), [{ t: 'file-reject', id: '00000002', reason: 'disabled' }]);
    t.core.endSession('x', false);
  }
  // ---- allowControl off -> disabled; view-only phone -> view-only
  {
    const t = setup({ settings: { allowControl: false } });
    await t.connect();
    t.ctl({ t: 'file-offer', id: '00000003', name: 'a.txt', size: 1 });
    assert.strictEqual(t.replies()[0].reason, 'disabled');
    t.core.endSession('x', false);
    const v = setup({ slot: { viewOnly: true } });
    await v.connect();
    v.ctl({ t: 'file-offer', id: '00000004', name: 'a.txt', size: 1 });
    assert.strictEqual(v.replies()[0].reason, 'view-only');
    v.core.endSession('x', false);
  }
  // ---- too big, busy
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'file-offer', id: '00000005', name: 'huge.iso', size: 200 * 1024 * 1024 + 1 });
    assert.strictEqual(t.replies().pop().reason, 'too-big');
    t.ctl({ t: 'file-offer', id: '00000006', name: 'a.txt', size: 5 });
    t.ctl({ t: 'file-offer', id: '00000007', name: 'b.txt', size: 5 });
    assert.deepStrictEqual(t.replies().slice(1), [{ t: 'file-accept', id: '00000006' }, { t: 'file-reject', id: '00000007', reason: 'busy' }]);
    t.core.endSession('x', false);
  }
  // ---- session end mid-transfer: partial deleted, nothing sent afterwards
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'file-offer', id: '00000008', name: 'cut.bin', size: 100_000 });
    await t.settle();
    t.text({ t: 'begin', id: '00000008' });
    t.bin(crypto.randomBytes(16384));
    await t.settle();
    const before = fs.readdirSync(dir);
    assert.ok(before.some((n) => n.endsWith('.glidr-part')));
    const n = t.dc.length;
    t.core.endSession('viewer left', false);
    await t.settle();
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.glidr-part')), 'partial removed');
    assert.ok(!fs.existsSync(path.join(dir, 'cut.bin')));
    assert.strictEqual(t.dc.length, n, 'nothing sent to a gone session');
    assert.strictEqual(t.received.length, 0);
  }
  // ---- control switched off mid-transfer, and allowFiles switched off mid-transfer
  {
    const t = setup();
    await t.connect();
    t.ctl({ t: 'file-offer', id: '00000009', name: 'a.bin', size: 100_000 });
    t.text({ t: 'begin', id: '00000009' });
    t.bin(crypto.randomBytes(1000));
    await t.settle();
    t.data.allowControl = false;
    t.core.controlChanged();
    await t.settle();
    assert.deepStrictEqual(t.replies().pop(), { t: 'file-done', id: '00000009', ok: false, name: '' });
    t.data.allowControl = true;
    t.ctl({ t: 'file-offer', id: '0000000a', name: 'b.bin', size: 100_000 });
    t.text({ t: 'begin', id: '0000000a' });
    await t.settle();
    t.data.allowFiles = false;
    t.core.filesChanged();
    await t.settle();
    assert.deepStrictEqual(t.replies().pop(), { t: 'file-done', id: '0000000a', ok: false, name: '' });
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.glidr-part')));
    t.core.endSession('x', false);
  }
  // ---- the files channel closing aborts; frames for a stale / unknown session are ignored; malformed input never throws
  {
    const t = setup();
    const sid = await t.connect();
    t.ctl({ t: 'file-offer', id: '0000000b', name: 'c.bin', size: 5 });
    t.text({ t: 'begin', id: '0000000b' });
    t.engine.emit('evt', { t: 'files', sid: 'other', data: '{"t":"end","id":"0000000b"}' });
    t.engine.emit('evt', { t: 'files-close', sid });
    await t.settle();
    assert.strictEqual(t.replies().pop().ok, false);
    t.ctl({ t: 'file-offer' });
    t.ctl({ t: 'file-offer', id: 5, name: [], size: {} });
    t.engine.emit('evt', { t: 'files-bin', sid, data: new Uint8Array(3) });
    t.engine.emit('evt', { t: 'files', sid, data: 'garbage' });
    t.core.endSession('x', false);
    t.engine.emit('evt', { t: 'files-bin', sid, data: new Uint8Array(3) }); // after the session: ignored
  }
  // ---- offers before the data channel is live are ignored
  {
    const t = setup();
    t.engine.cmds.length = 0;
    t.core.sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'early', n: 'P' }, serverTime: Date.now() });
    await new Promise((r) => setImmediate(r));
    t.ctl({ t: 'file-offer', id: '0000000c', name: 'a.txt', size: 1 });
    assert.deepStrictEqual(t.dc, []);
    t.core.endSession('x', false);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ok host-files');
})().catch((e) => { console.error(e); process.exit(1); });
