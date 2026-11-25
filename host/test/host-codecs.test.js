'use strict';
// The phone's `req.dec` (decoders it can really decode) reaches the engine `start` command, validated, together with
// the codec order the PC will offer. Electron, signaling and the engine are faked.
// Run: node host/test/host-codecs.test.js
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

async function start(codec, req) {
  const data = { sharing: true, allowControl: true, quality: 'auto', codec, stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'Phone' }] };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish() { return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }) });
  sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone', ...req }, serverTime: Date.now() });
  await new Promise((r) => setImmediate(r));
  const cmd = engine.cmds.find((c) => c.t === 'start');
  core.endSession?.('test', false);
  assert.ok(cmd, 'start command sent');
  return cmd;
}

(async () => {
  const ALL = ['h264', 'vp8', 'vp9', 'av1'];
  // dec reaches the engine; the order follows the setting and the phone
  let c = await start('vp9', { dec: ALL });
  assert.deepStrictEqual(c.decoders, ALL);
  assert.deepStrictEqual(c.codecOrder, ['vp9', 'h264', 'vp8']);
  assert.strictEqual(c.codec, 'vp9');

  c = await start('av1', { dec: ['av1', 'vp8', 'vp8'] });
  assert.deepStrictEqual(c.decoders, ['av1', 'vp8'], 'de-duplicated');
  assert.deepStrictEqual(c.codecOrder, ['av1', 'vp8']);

  c = await start('av1', { dec: ['h264', 'vp8'] });
  assert.deepStrictEqual(c.codecOrder, ['h264', 'vp8'], 'the phone cannot decode AV1: silent fallback');

  c = await start('auto', { dec: ALL });
  assert.deepStrictEqual(c.codecOrder, ['h264', 'vp8'], 'auto never picks VP9 / AV1');

  // an old phone sends nothing: unknown decoders, never VP9 / AV1
  c = await start('vp9', {});
  assert.strictEqual(c.decoders, null);
  assert.deepStrictEqual(c.codecOrder, ['h264', 'vp8']);

  // invalid dec is ignored as a whole
  for (const dec of ['vp9', 7, {}, [], ['vp9', 'hevc'], ['VP9'], new Array(9).fill('vp9'), [null]]) {
    c = await start('vp9', { dec });
    assert.strictEqual(c.decoders, null, JSON.stringify(dec));
    assert.deepStrictEqual(c.codecOrder, ['h264', 'vp8'], JSON.stringify(dec));
  }

  // a corrupt stored setting falls back to auto
  c = await start('hevc', { dec: ALL });
  assert.strictEqual(c.codec, 'auto');
  assert.deepStrictEqual(c.codecOrder, ['h264', 'vp8']);

  console.log('ok host-codecs');
})().catch((e) => { console.error(e); process.exit(1); });
