'use strict';
// Mobile data in HostCore: the offer carries the router-mapped candidate, falls back to the plain offer on any failure,
// and the router port is closed when the session ends or the app quits. Electron, engine, signaling and the router are
// fakes. Run: node host/test/host-upnp.test.js
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

function setup({ useUpnp, mapper }) {
  const data = {
    sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', useUpnp,
    slots: [{ id: 'a', key: 'k', name: 'My Phone', claimedAt: 1 }],
  };
  const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim: () => {} };
  const published = [];
  const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish(key, msg) { published.push(msg); return Promise.resolve(); } });
  const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
  const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
  const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }), portMapper: mapper });
  const logs = [];
  core.on('log', (m) => logs.push(m));
  return {
    core, engine, published, logs, data,
    async request() {
      sig.emit('message', { slotId: 'a', msg: { from: 'p', t: 'req', sid: 'sid' + Math.random(), n: 'Phone' }, serverTime: Date.now() });
      await new Promise((r) => setImmediate(r));
      return core.sess.sid;
    },
    offer: (sid, sdp = 'v=0') => engine.emit('evt', { t: 'offer', sid, sdp }),
    offers: () => published.filter((m) => m.t === 'offer'),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const fakeMapper = (result) => { const m = { calls: 0, async mapForOffer(sdp) { m.calls++; return typeof result === 'function' ? result(sdp) : result; } }; return m; };
const mapping = () => { const r = { released: 0, sdp: 'v=0 MAPPED', async release() { r.released++; } }; return r; };

(async () => {
  // ---- setting off (or not a real true): the offer goes out at once, unchanged, and the router is never asked
  for (const useUpnp of [false, undefined, 'yes']) {
    const mapper = fakeMapper(mapping());
    const t = setup({ useUpnp, mapper });
    const sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    assert.strictEqual(t.offers().length, 1, 'published synchronously');
    assert.strictEqual(t.offers()[0].sdp, 'v=0 PLAIN');
    assert.strictEqual(mapper.calls, 0);
    t.core.endSession('x', false);
  }
  // ---- on and mapped: the offer carries the mapped candidate; the port is closed when the session ends
  {
    const m = mapping();
    const t = setup({ useUpnp: true, mapper: fakeMapper(m) });
    const sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    await tick();
    assert.deepStrictEqual(t.offers().map((o) => o.sdp), ['v=0 MAPPED']);
    assert.strictEqual(m.released, 0, 'open while the session lives');
    assert.strictEqual(t.core.mappings.size, 1);
    t.core.endSession('x', false);
    assert.strictEqual(m.released, 1, 'closed when it ends');
    assert.strictEqual(t.core.mappings.size, 0);
    t.core.endSession('x', false);
    assert.strictEqual(m.released, 1, 'once');
    assert.ok(t.logs.every((l) => !/\d+\.\d+\.\d+\.\d+/.test(l)), 'no addresses in the log');
  }
  // ---- on but nothing could be opened (no UPnP, carrier NAT, error): the plain offer goes out
  for (const result of [null, () => { throw new Error('boom'); }]) {
    const t = setup({ useUpnp: true, mapper: fakeMapper(result) });
    const sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    await tick();
    assert.deepStrictEqual(t.offers().map((o) => o.sdp), ['v=0 PLAIN']);
    assert.strictEqual(t.core.mappings.size, 0);
    t.core.endSession('x', false);
  }
  // ---- the session ended while the router was being asked: nothing is published and the port is closed again
  {
    const m = mapping();
    let finish;
    const mapper = { async mapForOffer() { await new Promise((r) => { finish = r; }); return m; } };
    const t = setup({ useUpnp: true, mapper });
    const sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    t.core.endSession('x', false);
    finish();
    await tick(); await tick();
    assert.strictEqual(t.offers().length, 0, 'no offer for a dead session');
    assert.strictEqual(m.released, 1, 'the port that was just opened is closed');
    assert.strictEqual(t.core.mappings.size, 0);
  }
  // ---- app quit: every open port is closed
  {
    const m = mapping();
    const t = setup({ useUpnp: true, mapper: fakeMapper(m) });
    const sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    await tick();
    await t.core.releaseMappings();
    assert.strictEqual(m.released, 1);
    assert.strictEqual(t.core.mappings.size, 0);
    t.core.endSession('x', false);
    assert.strictEqual(m.released, 1, 'not closed twice');
  }
  // ---- the setting: on by default, a damaged value falls back to on
  {
    const os = require('os');
    const path = require('path');
    const { Store } = require('../src/store');
    const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'glidr-upnp-store-'));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('useUpnp'), true);
    require('fs').writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ useUpnp: 'maybe', slots: [] }));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('useUpnp'), true);
    require('fs').writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ useUpnp: false, slots: [] }));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('useUpnp'), false, 'an explicit off stays off');
  }
  // ---- the relay (TURN) for mobile data: validated, and carried to the phone inside the offer
  {
    const { parseRelayUrls, normalizeTurn } = require('../src/store');
    assert.deepStrictEqual(parseRelayUrls('turn:a.example:3478, turns:b.example:443?transport=tcp  turn:c.example:80?transport=udp'),
      ['turn:a.example:3478', 'turns:b.example:443?transport=tcp', 'turn:c.example:80?transport=udp']);
    assert.deepStrictEqual(parseRelayUrls('http://x.example, stun:s.example:3478, turn:, javascript:alert(1), turn:ok.example:1 turn:with space'), ['turn:ok.example:1', 'turn:with']);
    assert.strictEqual(parseRelayUrls('turn:a:1 turn:b:1 turn:c:1 turn:d:1 turn:e:1').length, 4, 'at most four');
    assert.deepStrictEqual(parseRelayUrls(''), []);
    assert.strictEqual(normalizeTurn(null), null);
    assert.strictEqual(normalizeTurn({ urls: ['http://x'] }), null, 'no valid address = no relay');
    assert.deepStrictEqual(normalizeTurn({ urls: 'turn:r.example:3478', username: 'u', credential: 'p', extra: 1 }), { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' });
    assert.deepStrictEqual(normalizeTurn({ urls: ['turn:r.example:3478'], username: 5 }), { urls: ['turn:r.example:3478'], username: '', credential: '' });
    // the store drops a damaged relay setting instead of half using it
    const os = require('os');
    const path = require('path');
    const { Store } = require('../src/store');
    const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'glidr-turn-store-'));
    require('fs').writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ turn: { urls: ['ftp://x'], username: 'u' }, slots: [] }));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('turn'), null);
    require('fs').writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ turn: { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' }, slots: [] }));
    assert.deepStrictEqual(new Store(dir, { safeStorage: null }).get('turn'), { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' });

    // no relay: the offer has no turn field
    let t = setup({ useUpnp: false, mapper: fakeMapper(null) });
    let sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    assert.ok(!('turn' in t.offers()[0]));
    t.core.endSession('x', false);
    // a relay: the same offer carries it
    t = setup({ useUpnp: false, mapper: fakeMapper(null) });
    t.data.turn = { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' };
    sid = await t.request();
    t.offer(sid, 'v=0 PLAIN');
    assert.deepStrictEqual(t.offers()[0].turn, { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' });
    t.core.endSession('x', false);
  }
  console.log('host upnp tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
