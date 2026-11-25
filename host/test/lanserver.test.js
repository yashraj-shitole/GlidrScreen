'use strict';
// LAN signaling server over real HTTP on 127.0.0.1 (loopback allowed for the test, a remote address injected where a
// non-private peer is needed). Run: node host/test/lanserver.test.js
const assert = require('assert');
const http = require('http');
const net = require('net');
const { LanServer, isPrivateAddress, randomPort } = require('../src/lanserver');
const { newKey, deriveSlot, seal } = require('../src/crypto');

const key = newKey();
const slot = deriveSlot(key);
const otherSlot = deriveSlot(newKey());
const topics = new Map([[slot.topic, { id: 'slotA', encKey: slot.encKey }]]);
const frame = (obj, k = slot.encKey) => seal(k, obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request; resolves {status, body, headers}. */
function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A GET stream: collects parsed lines; `next(pred)` waits for a matching one. */
function stream(port, path) {
  const lines = [];
  const waiters = [];
  const s = { lines, status: 0, closed: false };
  s.ready = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      s.status = res.statusCode;
      s.res = res;
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!l) continue;
          let o; try { o = JSON.parse(l); } catch { o = { raw: l }; }
          lines.push(o);
          for (const w of [...waiters]) if (w.pred(o)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(o); }
        }
      });
      res.on('close', () => { s.closed = true; });
      resolve(s);
    });
    req.on('error', (e) => { s.closed = true; reject(e); });
    s.req = req;
  });
  s.next = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const found = lines.find(pred);
    if (found) return resolve(found);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for line')); } }, ms);
  });
  s.close = () => s.req.destroy();
  return s;
}

const isMsg = (o) => o.event === 'message';

(async () => {
  // ---- address classes
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.9.9', '::ffff:192.168.1.5', 'fe80::1', 'fe80::1%12', 'febf::1', 'fc00::1', 'fd12:3456::9']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '100.64.0.1', '11.0.0.1', '2001:db8::1', 'fec0::1', '::ffff:8.8.8.8', '127.0.0.1', '::1', '', undefined, 'garbage']) assert.ok(!isPrivateAddress(a), String(a));
  assert.ok(isPrivateAddress('127.0.0.1', true) && isPrivateAddress('::1', true) && isPrivateAddress('::ffff:127.0.0.1', true));
  for (let i = 0; i < 200; i++) { const p = randomPort(); assert.ok(p >= 49152 && p <= 65535); }
  assert.strictEqual(randomPort(() => 0), 49152);
  assert.strictEqual(randomPort(() => 0.999999999), 65535);

  // ---- loopback is refused unless allowed (a local tunnel must not be able to expose the server)
  {
    const strict = new LanServer({ topics: () => topics });
    const port = await strict.start(0);
    assert.strictEqual((await request(port, 'GET', `/${slot.topic}/json`)).status, 403);
    assert.strictEqual((await request(port, 'POST', `/${slot.topic}`, frame({ t: 'x' }))).status, 403);
    await strict.stop();
  }

  let now = 1_800_000_000_000;
  let remote = null; // injected peer address; null = the real one
  const lan = new LanServer({
    topics: () => topics, allowLoopback: true, now: () => now, keepaliveMs: 60,
    maxStreams: 3, socketIdleMs: 400, streamMaxMs: 60_000,
    remoteAddress: (req) => remote || req.socket.remoteAddress,
  });
  const got = [];
  lan.on('message', (m) => got.push(m));
  assert.strictEqual(lan.listening, false);
  assert.strictEqual(lan.push(slot.topic, 'x'), 0, 'not listening: nothing buffered or sent');
  const port = await lan.start(0, '127.0.0.1');
  assert.ok(port >= 49152 && port <= 65535, 'random port in the dynamic range: ' + port);
  assert.strictEqual(lan.listening, true);
  assert.strictEqual(await lan.start(0), port, 'a second start is a no-op');

  // ---- POST: authentic frame -> 200 {}, emitted exactly like an ntfy message
  const f1 = frame({ t: 'req', from: 'p', sid: 's1', n: 'Pixel' });
  let r = await request(port, 'POST', `/${slot.topic}`, f1, { 'Content-Type': 'text/plain' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, '{}');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].slotId, 'slotA');
  assert.deepStrictEqual(got[0].msg, { t: 'req', from: 'p', sid: 's1', n: 'Pixel' });
  assert.strictEqual(got[0].serverTime, now);
  assert.deepStrictEqual(Object.keys(got[0]).sort(), ['msg', 'serverTime', 'slotId']);

  // an exact repeat of the same frame (replay / double send) is acknowledged but not delivered twice
  r = await request(port, 'POST', `/${slot.topic}`, f1);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(got.length, 1);

  // ---- authentication: garbage, a frame sealed with another key, a tampered frame -> dropped, never buffered
  const tampered = Buffer.from(frame({ t: 'req', from: 'p', sid: 'zz' }), 'base64url'); tampered[20] ^= 1;
  for (const bad of ['not a frame', '', frame({ t: 'req', from: 'p', sid: 'zz' }, otherSlot.encKey), tampered.toString('base64url')]) {
    r = await request(port, 'POST', `/${slot.topic}`, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 30));
  }
  assert.strictEqual(got.length, 1, 'unauthentic frames never reach the host');

  // ---- stream: open event, then live messages (a phone POST and a host push), with ntfy's JSON shape
  const s1 = stream(port, `/${slot.topic}/json`);
  await s1.ready;
  assert.strictEqual(s1.status, 200);
  const open1 = await s1.next((o) => o.event === 'open');
  assert.strictEqual(open1.topic, slot.topic);
  assert.deepStrictEqual(s1.lines.filter(isMsg), [], 'no replay without since');
  const f2 = frame({ t: 'req', from: 'p', sid: 's2' });
  await request(port, 'POST', `/${slot.topic}`, f2);
  const m2 = await s1.next(isMsg);
  assert.strictEqual(m2.message, f2);
  assert.strictEqual(m2.topic, slot.topic);
  assert.strictEqual(typeof m2.id, 'string'); assert.ok(m2.id.length >= 8);
  assert.strictEqual(m2.time, Math.floor(now / 1000));
  const f3 = frame({ t: 'offer', from: 'h', sid: 's2', sdp: 'v=0' });
  assert.strictEqual(lan.push(slot.topic, f3), 1, 'delivered to the one live stream');
  const m3 = await s1.next((o) => isMsg(o) && o.message === f3);
  assert.notStrictEqual(m3.id, m2.id);
  assert.strictEqual(got.length, 2, 'a host push is not looped back as a phone message');
  assert.strictEqual(lan.push('gs-unknowntopic', f3), 0, 'unknown topic: nothing');

  // ---- keepalive
  await s1.next((o) => o.event === 'keepalive');

  // ---- since: replay of buffered messages newer than an id; unknown id and no since replay nothing
  const s2 = stream(port, `/${slot.topic}/json?since=${encodeURIComponent(m2.id)}`);
  await s2.ready;
  await s2.next((o) => o.event === 'open');
  const replayed = await s2.next(isMsg);
  assert.strictEqual(replayed.message, f3);
  assert.strictEqual(replayed.id, m3.id);
  await sleep(40);
  assert.strictEqual(s2.lines.filter(isMsg).length, 1, 'only the messages after the id');
  const s3 = stream(port, `/${slot.topic}/json?since=doesnotexist`);
  await s3.ready; await s3.next((o) => o.event === 'open'); await sleep(40);
  assert.strictEqual(s3.lines.filter(isMsg).length, 0);
  // stream cap (maxStreams 3: s1, s2, s3 are open)
  r = await request(port, 'GET', `/${slot.topic}/json`);
  assert.strictEqual(r.status, 503);
  s3.close(); s2.close();
  await sleep(60);
  const s4 = stream(port, `/${slot.topic}/json?since=all`);
  await s4.ready;
  assert.strictEqual(s4.status, 200, 'a closed stream frees its place');
  await s4.next((o) => o.event === 'open'); await sleep(40);
  assert.strictEqual(s4.lines.filter(isMsg).length, 3, 'since=all replays everything buffered (f1, f2, f3)');
  s4.close();

  // ---- unknown topics and paths: 404 and nothing else
  for (const [method, path] of [['GET', `/${otherSlot.topic}/json`], ['POST', `/${otherSlot.topic}`], ['GET', '/'], ['GET', '/json'], ['GET', '/favicon.ico'], ['GET', `/${slot.topic}/other`], ['GET', `/${slot.topic},${otherSlot.topic}/json`], ['GET', '/v1/health'], ['POST', '/gs-x']]) {
    r = await request(port, method, path, method === 'POST' ? f1 : undefined);
    assert.strictEqual(r.status, 404, `${method} ${path}`);
    assert.ok(!r.body.includes(slot.topic));
  }
  assert.strictEqual((await request(port, 'GET', `/${slot.topic}`)).status, 405);
  assert.strictEqual((await request(port, 'POST', `/${slot.topic}/json`, f1)).status, 405);
  assert.strictEqual((await request(port, 'DELETE', `/${slot.topic}`)).status, 405);
  assert.strictEqual((await request(port, 'GET', '/' + 'a'.repeat(600))).status, 414);

  // ---- 403 for a peer outside the private ranges, even for a known topic (and for unknown ones: nothing is revealed)
  remote = '203.0.113.9';
  for (const [method, path] of [['GET', `/${slot.topic}/json`], ['POST', `/${slot.topic}`], ['GET', '/nothing']]) {
    r = await request(port, method, path, method === 'POST' ? frame({ t: 'req', from: 'p', sid: 'evil' }) : undefined);
    assert.strictEqual(r.status, 403, `${method} ${path}`);
  }
  assert.ok(!got.some((m) => m.msg.sid === 'evil'));
  remote = '::ffff:192.168.1.77'; // private peer (dual stack form): served
  r = await request(port, 'POST', `/${slot.topic}`, frame({ t: 'req', from: 'p', sid: 'lan1' }));
  assert.strictEqual(r.status, 200);
  remote = null;

  // ---- size caps: declared and streamed
  const before = got.length;
  r = await request(port, 'POST', `/${slot.topic}`, 'a'.repeat(5000)).catch((e) => ({ status: e.code }));
  assert.ok(r.status === 413 || r.status === 'EPIPE' || r.status === 'ECONNRESET', String(r.status));
  await new Promise((resolve) => { // chunked body without a Content-Length that grows past the cap
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`POST /${slot.topic} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`);
      for (let i = 0; i < 6; i++) sock.write('400\r\n' + 'a'.repeat(1024) + '\r\n');
    });
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('error', () => {});
    sock.on('close', () => { assert.ok(/^HTTP\/1\.1 413/.test(out), out.slice(0, 40)); resolve(); });
  });
  // a header block larger than the cap is refused before the handler runs
  const huge = await request(port, 'GET', `/${slot.topic}/json`, undefined, { 'X-Pad': 'a'.repeat(20_000) }).catch((e) => ({ status: e.code || 'error' }));
  assert.ok(huge.status === 431 || huge.status === 400 || huge.status === 'ECONNRESET' || huge.status === 'error', String(huge.status));
  assert.strictEqual(got.length, before, 'oversize bodies never reach the host');
  // a frame at the real maximum (3900 chars, as crypto.js allows) is accepted
  const big = frame({ t: 'offer', from: 'p', pad: Array.from({ length: 580 }, (_, i) => (i * 2654435761 >>> 0).toString(36)).join('') });
  assert.ok(big.length > 1500 && big.length <= 3900, String(big.length));
  assert.strictEqual((await request(port, 'POST', `/${slot.topic}`, big)).status, 200);

  // ---- idle sockets are timed out (a client that connects and says nothing)
  const idleClosed = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const t0 = Date.now();
    sock.on('close', () => resolve(Date.now() - t0));
    sock.on('error', () => {});
    setTimeout(() => { sock.destroy(); resolve(-1); }, 3000);
  });
  assert.ok(idleClosed > 0 && idleClosed < 2500, 'idle socket closed by the server after ' + idleClosed + ' ms');

  // ---- buffer: last 50 messages for 10 minutes
  const lan2 = new LanServer({ topics: () => topics, allowLoopback: true, now: () => now });
  const port2 = await lan2.start(0, '127.0.0.1');
  for (let i = 0; i < 60; i++) lan2.push(slot.topic, frame({ t: 'x', i }));
  let sa = stream(port2, `/${slot.topic}/json?since=all`);
  await sa.ready; await sa.next((o) => o.event === 'open'); await sleep(60);
  const kept = sa.lines.filter(isMsg);
  assert.strictEqual(kept.length, 50, 'at most 50 messages are kept');
  sa.close();
  now += 9 * 60_000;
  sa = stream(port2, `/${slot.topic}/json?since=all`);
  await sa.ready; await sa.next((o) => o.event === 'open'); await sleep(60);
  assert.strictEqual(sa.lines.filter(isMsg).length, 50, 'still there after 9 minutes');
  sa.close();
  now += 2 * 60_000; // 11 minutes after the pushes
  sa = stream(port2, `/${slot.topic}/json?since=all`);
  await sa.ready; await sa.next((o) => o.event === 'open'); await sleep(60);
  assert.strictEqual(sa.lines.filter(isMsg).length, 0, 'gone after 10 minutes');
  sa.close();
  // duration form
  lan2.push(slot.topic, frame({ t: 'y' }));
  now += 30_000;
  lan2.push(slot.topic, frame({ t: 'z' }));
  sa = stream(port2, `/${slot.topic}/json?since=10s`);
  await sa.ready; await sa.next((o) => o.event === 'open'); await sleep(60);
  assert.strictEqual(sa.lines.filter(isMsg).length, 1);
  sa.close();

  // ---- a removed phone: its stream and buffer go away
  const sb = stream(port2, `/${slot.topic}/json`);
  await sb.ready; await sb.next((o) => o.event === 'open');
  topics.delete(slot.topic);
  lan2.topicsChanged();
  await sleep(80);
  assert.ok(sb.closed, 'stream of a removed slot is closed');
  assert.strictEqual((await request(port2, 'GET', `/${slot.topic}/json`)).status, 404);
  topics.set(slot.topic, { id: 'slotA', encKey: slot.encKey });
  assert.strictEqual(lan2.push(slot.topic, frame({ t: 'q' })), 0);
  await lan2.stop();

  // ---- a stream that lives too long is ended (a vanished phone must not keep its place forever)
  const lan3 = new LanServer({ topics: () => topics, allowLoopback: true, streamMaxMs: 120 });
  const port3 = await lan3.start(0, '127.0.0.1');
  const sc = stream(port3, `/${slot.topic}/json`);
  await sc.ready; await sc.next((o) => o.event === 'open');
  await sleep(300);
  assert.ok(sc.closed);
  await lan3.stop();

  // ---- busy saved port: another one is chosen
  const blocker = net.createServer().listen(0, '0.0.0.0');
  await new Promise((r2) => blocker.once('listening', r2));
  const lan4 = new LanServer({ topics: () => topics });
  const p4 = await lan4.start(blocker.address().port);
  assert.notStrictEqual(p4, blocker.address().port);
  await lan4.stop();
  blocker.close();

  // ---- stop() ends streams and frees the port
  const s5 = stream(port, `/${slot.topic}/json`);
  await s5.ready; await s5.next((o) => o.event === 'open');
  await lan.stop();
  await sleep(50);
  assert.ok(s5.closed);
  assert.strictEqual(lan.listening, false);
  await assert.rejects(request(port, 'GET', `/${slot.topic}/json`));
  assert.strictEqual(lan.push(slot.topic, f3), 0);

  console.log('ok lanserver');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
