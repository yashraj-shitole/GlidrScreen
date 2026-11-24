'use strict';
// Connection self-test: STUN encoding, clock-skew maths and the three checks with fetch / dgram / Signaling faked.
const assert = require('assert');
const { EventEmitter } = require('events');
const d = require('../src/diagnose');
const { deriveSlot, seal, open } = require('../src/crypto');

// ---- STUN request encoding
const txid = Buffer.from('000102030405060708090a0b', 'hex');
const req = d.buildBindingRequest(txid);
assert.strictEqual(req.length, 20);
assert.strictEqual(req.toString('hex'), '000100002112a442000102030405060708090a0b');
assert.strictEqual(d.buildBindingRequest().length, 20);
assert.ok(!d.buildBindingRequest().equals(d.buildBindingRequest()), 'random transaction ids');

/** Binding success response carrying one attribute. */
function response(attrType, value, id = txid, type = 0x0101) {
  const pad = (4 - (value.length % 4)) % 4;
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(4 + value.length + pad, 2);
  h.writeUInt32BE(0x2112a442, 4);
  id.copy(h, 8);
  const a = Buffer.alloc(4);
  a.writeUInt16BE(attrType, 0);
  a.writeUInt16BE(value.length, 2);
  return Buffer.concat([h, a, value, Buffer.alloc(pad)]);
}
// 203.0.113.9:54321 -> XOR with cookie 0x2112a442 and port 0x2112
const xorV4 = Buffer.from([0, 1, 54321 >> 8 ^ 0x21, (54321 & 255) ^ 0x12, 203 ^ 0x21, 0 ^ 0x12, 113 ^ 0xa4, 9 ^ 0x42]);
assert.deepStrictEqual(d.parseBindingResponse(response(0x0020, xorV4), txid), { family: 'IPv4', address: '203.0.113.9', port: 54321 });
// legacy MAPPED-ADDRESS (not XORed)
const plainV4 = Buffer.from([0, 1, 0x1f, 0x90, 198, 51, 100, 7]);
assert.deepStrictEqual(d.parseBindingResponse(response(0x0001, plainV4), txid), { family: 'IPv4', address: '198.51.100.7', port: 8080 });
// IPv6: address XORed with cookie || txid
const v6 = Buffer.from('20010db8000000000000000000000001', 'hex');
const mask = Buffer.concat([Buffer.from('2112a442', 'hex'), txid]);
const xorV6 = Buffer.concat([Buffer.from([0, 2, 0x1f ^ 0x21, 0x90 ^ 0x12]), Buffer.from(v6.map((b, i) => b ^ mask[i]))]);
const r6 = d.parseBindingResponse(response(0x0020, xorV6), txid);
assert.strictEqual(r6.family, 'IPv6');
assert.strictEqual(r6.address, '2001:0db8:0000:0000:0000:0000:0000:0001');
assert.strictEqual(r6.port, 8080);
// SOFTWARE attribute before the mapped address is skipped (with padding)
const software = Buffer.concat([
  (() => { const b = Buffer.alloc(4); b.writeUInt16BE(0x8022, 0); b.writeUInt16BE(5, 2); return b; })(), Buffer.from('abcde'), Buffer.alloc(3),
]);
const two = response(0x0020, xorV4);
const withSw = Buffer.concat([two.subarray(0, 20), software, two.subarray(20)]);
withSw.writeUInt16BE(two.readUInt16BE(2) + software.length, 2);
assert.strictEqual(d.parseBindingResponse(withSw, txid).address, '203.0.113.9');
// rejects
assert.strictEqual(d.parseBindingResponse(response(0x0020, xorV4, Buffer.alloc(12, 9)), txid), null, 'other transaction');
assert.strictEqual(d.parseBindingResponse(response(0x0020, xorV4, txid, 0x0111), txid), null, 'error response');
assert.strictEqual(d.parseBindingResponse(Buffer.alloc(10), txid), null);
assert.strictEqual(d.parseBindingResponse(Buffer.alloc(20), txid), null);
assert.strictEqual(d.parseBindingResponse(response(0x8022, Buffer.from('hi!!')), txid), null, 'no mapped address');
assert.strictEqual(d.parseBindingResponse('nope', txid), null);
const trunc = response(0x0020, xorV4); trunc.writeUInt16BE(200, 22);
assert.strictEqual(d.parseBindingResponse(trunc, txid), null, 'attribute longer than the packet');

// ---- clock skew maths
const date = 'Wed, 25 Nov 2026 12:00:00 GMT';
const t = Date.parse(date);
assert.strictEqual(d.clockSkewMs(date, t - 100, t + 100), 0, 'midpoint of the request');
assert.strictEqual(d.clockSkewMs(date, t + 4000, t + 6000), 5000, 'PC ahead');
assert.strictEqual(d.clockSkewMs(date, t - 6000, t - 4000), -5000, 'PC behind');
assert.strictEqual(d.clockSkewMs('garbage', t, t), null);
assert.strictEqual(d.clockSkewMs(null, t, t), null);
assert.strictEqual(d.skewResult(0).ok, true);
assert.strictEqual(d.skewResult(900).detail, 'Clock matches the server');
assert.strictEqual(d.skewResult(-42_000).ok, true);
assert.strictEqual(d.skewResult(60_000).ok, true, '60 s exactly is still fine');
let w = d.skewResult(60_001);
assert.strictEqual(w.ok, false);
assert.ok(/Warning.*behind|Warning.*ahead/.test(w.detail) && w.detail.includes('90 s'));
assert.ok(d.skewResult(-75_000).detail.includes('75 s behind'));
assert.ok(d.skewResult(75_000).detail.includes('75 s ahead'));
assert.strictEqual(d.skewResult(null).ok, false);

// ---- stunBinding with a fake socket
function fakeDgram(behaviour) {
  const made = [];
  return {
    made,
    createSocket(kind) {
      assert.strictEqual(kind, 'udp4');
      const s = new EventEmitter();
      s.closed = false;
      s.close = () => { s.closed = true; };
      s.send = (buf, port, host, cb) => {
        s.sent = { buf, port, host };
        behaviour(s, buf, cb);
      };
      made.push(s);
      return s;
    },
  };
}
const answer = (family) => (s, buf, cb) => {
  cb();
  const id = buf.subarray(8, 20);
  setImmediate(() => {
    s.emit('message', response(0x0020, family === 6 ? xorV6 : xorV4, Buffer.alloc(12, 1))); // not ours: ignored
    s.emit('message', response(0x0020, family === 6 ? xorV6 : xorV4, Buffer.from(id)));
  });
};

(async () => {
  {
    const dg = fakeDgram((s, buf, cb) => {
      cb();
      // answer with the right transaction id but computed from the request
      const id = Buffer.from(buf.subarray(8, 20));
      const m = Buffer.concat([Buffer.from('2112a442', 'hex'), id]);
      const x = Buffer.concat([Buffer.from([0, 2, 0x1f ^ 0x21, 0x90 ^ 0x12]), Buffer.from(v6.map((b, i) => b ^ m[i]))]);
      setImmediate(() => s.emit('message', response(0x0020, x, id)));
    });
    const r = await d.stunBinding({ dgram: dg, timeoutMs: 500 });
    assert.strictEqual(r.family, 'IPv6');
    assert.strictEqual(dg.made[0].sent.port, 19302);
    assert.strictEqual(dg.made[0].sent.host, 'stun.l.google.com');
    assert.strictEqual(dg.made[0].sent.buf.length, 20);
    assert.ok(dg.made[0].closed);
  }
  {
    const dg = fakeDgram(() => {}); // never answers
    await assert.rejects(d.stunBinding({ dgram: dg, timeoutMs: 30 }), /no answer/);
    assert.ok(dg.made[0].closed);
  }
  {
    const dg = fakeDgram((s, buf, cb) => cb(new Error('getaddrinfo ENOTFOUND')));
    await assert.rejects(d.stunBinding({ dgram: dg, timeoutMs: 500 }), /ENOTFOUND/);
    assert.ok(dg.made[0].closed);
  }

  // ---- runChecks: all good
  const HEALTH_DATE = new Date().toUTCString();
  const okFetch = async (url) => {
    assert.ok(url.endsWith('/v1/health'), url);
    return { ok: true, headers: { get: (h) => (h.toLowerCase() === 'date' ? HEALTH_DATE : null) } };
  };
  /** Fake Signaling that behaves like the real one: only delivers what was sealed with the subscribed key. */
  const sigLog = [];
  const createSignaling = (base, opts = {}) => {
    const s = new EventEmitter();
    s.base = base;
    s.setSlots = (slots) => { s.slots = slots; };
    s.start = () => { if (!opts.never) setImmediate(() => s.emit('status', 'online')); };
    s.stop = () => { s.stopped = true; };
    s.publish = async (key, obj) => {
      sigLog.push({ key, obj });
      assert.strictEqual(key, s.slots[0].key, 'published on the subscribed topic');
      const { encKey } = deriveSlot(Buffer.from(key, 'base64url'));
      const msg = open(encKey, seal(encKey, obj)); // really goes through seal / open
      if (!opts.drop) setImmediate(() => s.emit('message', { slotId: 'diag', msg, serverTime: Date.now() }));
    };
    return s;
  };
  {
    const sigs = [];
    const res = await d.runChecks({
      fetch: okFetch, dgram: fakeDgram(answer(4)), signalBase: 'https://ntfy.example/', settleMs: 0, timeoutMs: 500,
      createSignaling: (b) => { const s = createSignaling(b); sigs.push(s); return s; },
    });
    assert.strictEqual(res.length, 3);
    assert.deepStrictEqual(res.map((r) => r.ok), [true, true, true]);
    for (const r of res) { assert.strictEqual(typeof r.name, 'string'); assert.strictEqual(typeof r.detail, 'string'); assert.ok(r.ms >= 0); }
    assert.strictEqual(sigs[0].base, 'https://ntfy.example', 'trailing slash trimmed');
    assert.ok(sigs[0].stopped, 'throw-away subscription is closed');
    assert.ok(res[1].detail.includes('IPv4'));
    assert.ok(!res.map((r) => r.detail).join(' ').includes('203.0.113.9'), 'public address is never reported');
    assert.ok(!JSON.stringify(res).includes(sigLog[0].key), 'topic key never reported');
    assert.strictEqual(sigLog[0].obj.t, 'diag');
  }
  // ---- failures are reported per check, never thrown
  {
    const res = await d.runChecks({
      fetch: async () => { throw new Error('fetch failed'); }, dgram: fakeDgram(() => {}),
      createSignaling: (b) => createSignaling(b, { drop: true }), signalBase: 'https://x', settleMs: 0, timeoutMs: 40,
    });
    assert.deepStrictEqual(res.map((r) => r.ok), [false, false, false]);
    assert.ok(/no message back/.test(res[0].detail));
    assert.ok(/no answer/.test(res[1].detail));
    assert.ok(/fetch failed/.test(res[2].detail));
  }
  {
    // server unreachable: the subscription never comes online
    const res = await d.runChecks({
      fetch: okFetch, dgram: fakeDgram(answer(4)), createSignaling: (b) => createSignaling(b, { never: true }),
      signalBase: 'https://x', settleMs: 0, timeoutMs: 40,
    });
    assert.deepStrictEqual(res.map((r) => r.ok), [false, true, true]);
    assert.ok(/no message back/.test(res[0].detail));
  }
  // ---- skew warning flows through
  {
    const old = new Date(Date.now() - 5 * 60_000).toUTCString(); // server 5 minutes behind: PC is ahead
    const res = await d.runChecks({
      fetch: async () => ({ headers: { get: () => old } }), dgram: fakeDgram(answer(4)),
      createSignaling: (b) => createSignaling(b), signalBase: 'https://x', settleMs: 0, timeoutMs: 500,
    });
    assert.strictEqual(res[2].ok, false);
    assert.ok(res[2].detail.includes('ahead'));
  }
  // ---- missing dependencies still do not throw
  {
    const res = await d.runChecks({ fetch: okFetch, signalBase: 'https://x', timeoutMs: 20 });
    assert.deepStrictEqual(res.map((r) => r.ok), [false, false, true]);
  }
  console.log('ok diagnose');
})().catch((e) => { console.error(e); process.exit(1); });
