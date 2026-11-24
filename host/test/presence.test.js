'use strict';
// Presence ("PC last seen"): which markers are published, when, to which slots, and that nothing can throw or hang.
// Clock, timers and signaling are fakes. Run: node host/test/presence.test.js
const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');
const { Presence, HEARTBEAT_MS } = require('../src/presence');
const { newKey, deriveSlot, seal, open } = require('../src/crypto');

/** Fake clock + timers. advance(ms) runs everything that falls due, in order. */
function fakeTime() {
  let now = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map(); // id -> {at, fn, every}
  const add = (fn, ms, every) => { const id = nextId++; timers.set(id, { at: now + ms, fn, every }); return id; };
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearTimeout: (id) => timers.delete(id),
      clearInterval: (id) => timers.delete(id),
    },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let best = null;
        for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t];
        if (!best) break;
        const [id, t] = best;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

function rig({ slots, sharing = true, publish } = {}) {
  const time = fakeTime();
  const data = {
    sharing,
    slots: slots || [
      { id: 'a', key: newKey().toString('base64url'), claimedAt: 1 },
      { id: 'b', key: newKey().toString('base64url'), claimedAt: 2 },
    ],
  };
  const store = { get: (k) => data[k] };
  const sent = []; // {key, msg, timeoutMs}
  const signaling = { base: 'https://ntfy.sh', publish: publish || ((key, msg, timeoutMs) => { sent.push({ key, msg, timeoutMs }); return Promise.resolve(); }) };
  const presence = new Presence({ signaling, store, now: time.now, timers: time.timers });
  const core = new EventEmitter();
  const monitor = new EventEmitter();
  presence.attach({ core, monitor });
  const states = () => sent.map((s) => s.msg.state);
  return { time, data, sent, signaling, presence, core, monitor, states, tick: () => new Promise((r) => setImmediate(r)) };
}
const key = (r, id) => r.data.slots.find((s) => s.id === id).key;

(async () => {
  // startup: nothing at once, then 'online' to every claimed slot with a full message
  {
    const r = rig();
    assert.strictEqual(r.sent.length, 0);
    r.time.advance(3_999);
    assert.strictEqual(r.sent.length, 0);
    r.time.advance(2);
    assert.deepStrictEqual(r.states(), ['online', 'online']);
    assert.deepStrictEqual(r.sent.map((s) => s.key), [key(r, 'a'), key(r, 'b')]);
    for (const { msg } of r.sent) {
      assert.strictEqual(msg.t, 'presence');
      assert.strictEqual(msg.from, 'h');
      assert.strictEqual(msg.ts, 1_700_000_004_000); // stamped when the timer fired
    }
  }

  // slots that cannot take a marker are skipped: unclaimed, no key, needs re-pairing
  {
    const r = rig({ slots: [
      { id: 'ok', key: newKey().toString('base64url'), claimedAt: 1 },
      { id: 'open', key: newKey().toString('base64url'), claimedAt: 0 },
      { id: 'nokey', key: '', claimedAt: 1, needsRepair: true },
      { id: 'repair', key: newKey().toString('base64url'), claimedAt: 1, needsRepair: true },
    ] });
    r.time.advance(5_000);
    assert.deepStrictEqual(r.sent.map((s) => s.key), [key(r, 'ok')]);
  }

  // heartbeat every 5 minutes while sharing is on
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    r.time.advance(HEARTBEAT_MS);
    assert.strictEqual(HEARTBEAT_MS, 300_000);
    assert.deepStrictEqual(r.states(), ['online', 'online']);
    r.time.advance(HEARTBEAT_MS);
    assert.strictEqual(r.sent.length, 4);
  }

  // pausing publishes 'paused' once and stops the heartbeat; resuming sharing publishes 'online' at once
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    r.data.sharing = false;
    r.core.emit('changed');
    assert.deepStrictEqual(r.states(), ['paused', 'paused']);
    r.core.emit('changed'); // unchanged: nothing more
    r.time.advance(3 * HEARTBEAT_MS);
    assert.strictEqual(r.sent.length, 2);
    r.data.sharing = true;
    r.core.emit('changed');
    assert.deepStrictEqual(r.states().slice(2), ['online', 'online']);
    r.time.advance(HEARTBEAT_MS);
    assert.strictEqual(r.sent.length, 6); // heartbeat is back
  }

  // started with sharing off: 'paused' at startup, no heartbeat
  {
    const r = rig({ sharing: false });
    r.time.advance(5_000);
    assert.deepStrictEqual(r.states(), ['paused', 'paused']);
    r.time.advance(2 * HEARTBEAT_MS);
    assert.strictEqual(r.sent.length, 2);
  }

  // a phone that claims a slot later gets a marker right away, only that slot, only once
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    r.data.slots.push({ id: 'new', key: newKey().toString('base64url'), claimedAt: 0 }); // open pairing: nothing yet
    r.core.emit('changed');
    assert.strictEqual(r.sent.length, 0);
    r.data.slots[2].claimedAt = 99; // claimed
    r.core.emit('changed');
    assert.deepStrictEqual(r.sent.map((s) => s.key), [key(r, 'new')]);
    assert.strictEqual(r.sent[0].msg.state, 'online');
    r.core.emit('changed');
    assert.strictEqual(r.sent.length, 1);
    // a phone claiming while sharing is paused is told 'paused'
    r.data.sharing = false; r.core.emit('changed'); r.sent.length = 0;
    r.data.slots.push({ id: 'late', key: newKey().toString('base64url'), claimedAt: 5 });
    r.core.emit('changed');
    assert.deepStrictEqual(r.states(), ['paused']);
  }

  // a removed phone is forgotten, so pairing it again (new id) is announced and the set does not grow forever
  {
    const r = rig();
    r.time.advance(5_000);
    r.data.slots = r.data.slots.slice(1);
    r.core.emit('changed');
    assert.deepStrictEqual([...r.presence.announced], ['b']);
  }

  // sleep: 'sleep' on suspend with a short timeout, no heartbeat while asleep, 'online' shortly after resume
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    r.monitor.emit('suspend');
    assert.deepStrictEqual(r.states(), ['sleep', 'sleep']);
    assert.ok(r.sent.every((s) => s.timeoutMs <= 2_000), 'suspend publish must not hang');
    r.time.advance(HEARTBEAT_MS * 2);
    assert.strictEqual(r.sent.length, 2, 'no heartbeat while asleep');
    r.core.emit('changed'); // events during sleep are ignored too
    assert.strictEqual(r.sent.length, 2);
    r.monitor.emit('resume');
    assert.strictEqual(r.sent.length, 2, 'wait for the network after wake');
    r.time.advance(3_100);
    assert.deepStrictEqual(r.states().slice(2), ['online', 'online']);
    r.time.advance(HEARTBEAT_MS);
    assert.strictEqual(r.sent.length, 6); // heartbeat restarted
  }

  // resume while sharing is paused says 'paused', not 'online'
  {
    const r = rig({ sharing: false });
    r.time.advance(5_000);
    r.sent.length = 0;
    r.monitor.emit('suspend');
    r.monitor.emit('resume');
    r.time.advance(3_100);
    assert.deepStrictEqual(r.states(), ['sleep', 'sleep', 'paused', 'paused']);
  }

  // a second suspend before the resume marker cancels it
  {
    const r = rig();
    r.time.advance(5_000);
    r.monitor.emit('suspend');
    r.monitor.emit('resume');
    r.time.advance(1_000);
    r.monitor.emit('suspend');
    r.sent.length = 0;
    r.time.advance(10_000);
    assert.strictEqual(r.sent.length, 0);
  }

  // quit: 'quit' to every slot, short timeout, nothing afterwards, only once
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    await r.presence.quit();
    assert.deepStrictEqual(r.states(), ['quit', 'quit']);
    assert.ok(r.sent.every((s) => s.timeoutMs <= 1_500));
    await r.presence.quit();
    r.time.advance(2 * HEARTBEAT_MS);
    r.data.sharing = false; r.core.emit('changed'); r.monitor.emit('suspend'); r.monitor.emit('resume');
    r.time.advance(10_000);
    assert.strictEqual(r.sent.length, 2);
    assert.strictEqual(r.time.pending(), 0, 'no timers left behind');
  }

  // quit never waits longer than the limit, even if the network hangs
  {
    const r = rig({ publish: () => new Promise(() => {}) });
    r.time.advance(5_000);
    let done = false;
    const p = r.presence.quit().then(() => { done = true; });
    await r.tick();
    assert.strictEqual(done, false);
    r.time.advance(1_499);
    await r.tick();
    assert.strictEqual(done, false);
    r.time.advance(2);
    await p;
    assert.strictEqual(done, true);
  }

  // quit before the first marker (or without attach) resolves at once and publishes nothing
  {
    const time = fakeTime();
    const sent = [];
    const p = new Presence({ signaling: { publish: (...a) => { sent.push(a); return Promise.resolve(); } }, store: { get: () => [] }, now: time.now, timers: time.timers });
    await p.quit();
    assert.strictEqual(sent.length, 0);
  }

  // publish failures (rejects and sync throws) are swallowed and one slot failing does not stop the others
  {
    const sent = [];
    let n = 0;
    const r = rig({ publish: (k, msg) => {
      n++;
      if (n === 1) return Promise.reject(new Error('offline'));
      if (n === 2) throw new Error('boom');
      sent.push(msg.state); return Promise.resolve();
    }, slots: [1, 2, 3].map((i) => ({ id: 's' + i, key: newKey().toString('base64url'), claimedAt: 1 })) });
    r.time.advance(5_000);
    await r.tick();
    assert.deepStrictEqual(sent, ['online']);
    await r.presence.suspend();
    await r.presence.quit();
  }

  // a broken store never throws out of sync / attach handlers
  {
    const r = rig();
    r.data.slots = null;
    r.core.emit('changed');
    r.time.advance(5_000);
    assert.strictEqual(r.sent.length, 0);
    r.data.slots = undefined;
    r.monitor.emit('suspend');
  }

  // a new rendezvous server gets a fresh marker
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    r.signaling.base = 'https://ntfy.example.org';
    r.core.emit('changed');
    assert.deepStrictEqual(r.states(), ['online', 'online']);
  }

  // sealed frames: authentic for the slot's own key, tiny, and far below the 3900 character frame limit
  {
    const k = newKey();
    const slot = deriveSlot(k);
    const time = fakeTime();
    const p = new Presence({ signaling: {}, store: { get: () => [] }, now: time.now, timers: time.timers });
    for (const state of ['online', 'sleep', 'paused', 'quit']) {
      const msg = p.message(state);
      const frame = seal(slot.encKey, msg);
      assert.ok(frame.length < 200, `${state} frame is ${frame.length} chars`);
      assert.deepStrictEqual(open(slot.encKey, frame), msg);
      assert.strictEqual(open(deriveSlot(newKey()).encKey, frame), null); // another phone's key cannot read it
    }
  }

  // unknown states are never published
  {
    const r = rig();
    r.time.advance(5_000);
    r.sent.length = 0;
    await r.presence.publish('exploded');
    assert.strictEqual(r.sent.length, 0);
  }

  // host.js ignores presence frames: its own echo (from 'h') and any presence a phone might send (from 'p')
  {
    const display = { id: 7, label: 'D', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
    const fakeElectron = {
      screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display], dipToScreenRect: (_w, b) => b },
      desktopCapturer: { getSources: async () => [{ id: 'screen:7:0', display_id: '7' }] },
    };
    const origLoad = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
    const { HostCore } = require('../src/host');
    Module._load = origLoad;
    const data = { sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], hostName: 'PC', slots: [{ id: 'a', key: 'k', name: 'P', claimedAt: 1 }] };
    const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {}, data };
    const published = [];
    const sig = Object.assign(new EventEmitter(), { setSlots() {}, start() {}, stop() {}, publish: (k, m) => { published.push(m); return Promise.resolve(); } });
    const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
    const core = new HostCore({ store, signaling: sig, engine, input: { reset() {}, setBounds() {} } });
    for (const from of ['h', 'p']) {
      sig.emit('message', { slotId: 'a', msg: { t: 'presence', from, ts: Date.now(), state: 'online' }, serverTime: Date.now() });
      sig.emit('message', { slotId: 'a', msg: { t: 'presence', from, sid: 'x', ts: Date.now(), state: 'quit' }, serverTime: Date.now() });
    }
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(core.sess, null);
    assert.strictEqual(engine.cmds.length, 0);
    assert.strictEqual(published.length, 0);
  }

  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
