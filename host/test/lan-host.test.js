'use strict';
// LAN signaling at host level: frames POSTed to the LAN server reach the host's `message` handler (Signaling and a
// real HostCore), everything published goes to ntfy AND the LAN buffer, and the pairing link / settings / adapter pieces.
// Run: node host/test/lan-host.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { EventEmitter } = require('events');
const crypto = require('../src/crypto');
const wol = require('../src/wol');
const { Signaling } = require('../src/signaling');
const { LanServer } = require('../src/lanserver');
const { Store } = require('../src/store');

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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A GET stream collecting message lines. */
function stream(port, p) {
  const msgs = [];
  const s = { msgs, closed: false };
  s.ready = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          if (l) { const o = JSON.parse(l); if (o.event === 'open') resolve(s); if (o.event === 'message') msgs.push(o); }
        }
      });
      res.on('close', () => { s.closed = true; });
    });
    req.on('error', reject);
    s.close = () => req.destroy();
  });
  return s;
}

/** Fake ntfy: records POSTs; `status` can be switched to simulate it being down or over quota. */
async function fakeNtfy() {
  const posts = [];
  const o = { posts, status: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { posts.push({ url: req.url, body }); res.writeHead(o.status); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  o.base = `http://127.0.0.1:${server.address().port}`;
  o.close = () => { server.closeAllConnections?.(); server.close(); };
  return o;
}

(async () => {
  const keyA = crypto.newKey();
  const keyB64 = keyA.toString('base64url');
  const a = crypto.deriveSlot(keyA);
  const ntfy = await fakeNtfy();

  // ---- Signaling + LanServer: phone POST over LAN -> 'message'; publish -> both sinks
  {
    const sig = new Signaling(ntfy.base);
    const lan = new LanServer({ allowLoopback: true });
    sig.attachLan(lan);
    sig.setSlots([{ id: 'phoneA', key: keyB64 }, { id: 'bad', key: '', needsRepair: true }]);
    const port = await lan.start(0, '127.0.0.1');
    const seen = [];
    sig.on('message', (m) => seen.push(m));

    const req = crypto.seal(a.encKey, { t: 'req', from: 'p', sid: 'sid1', n: 'Pixel' });
    assert.strictEqual((await request(port, 'POST', `/${a.topic}`, req)).status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].slotId, 'phoneA');
    assert.deepStrictEqual(seen[0].msg, { t: 'req', from: 'p', sid: 'sid1', n: 'Pixel' });
    assert.ok(Math.abs(seen[0].serverTime - Date.now()) < 5000, 'serverTime is in ms, like ntfy ones');
    assert.strictEqual(ntfy.posts.length, 0, 'a LAN message does not touch ntfy');

    // a frame that fails authentication is dropped before the host sees it
    await request(port, 'POST', `/${a.topic}`, crypto.seal(crypto.deriveSlot(crypto.newKey()).encKey, { t: 'req', from: 'p', sid: 'x' }));
    assert.strictEqual(seen.length, 1);

    // publish: sealed once, sent to ntfy and to the LAN stream
    const st = stream(port, `/${a.topic}/json`);
    await st.ready;
    await sig.publish(keyB64, { t: 'offer', from: 'h', sid: 'sid1', sdp: 'v=0' });
    assert.strictEqual(ntfy.posts.length, 1);
    assert.strictEqual(ntfy.posts[0].url, '/' + a.topic);
    await tick();
    assert.strictEqual(st.msgs.length, 1);
    assert.strictEqual(st.msgs[0].topic, a.topic);
    assert.strictEqual(st.msgs[0].message, ntfy.posts[0].body, 'the very same sealed frame goes to both');
    assert.deepStrictEqual(crypto.open(a.encKey, st.msgs[0].message), { t: 'offer', from: 'h', sid: 'sid1', sdp: 'v=0' });

    // ntfy down: a phone that got it over the LAN makes publish succeed; with nobody listening the error stays
    ntfy.status = 500;
    await sig.publish(keyB64, { t: 'bye', from: 'h', sid: 'sid1' });
    await tick();
    assert.strictEqual(st.msgs.length, 2);
    st.close();
    await tick(50);
    await assert.rejects(sig.publish(keyB64, { t: 'bye', from: 'h', sid: 'sid2' }), /publish HTTP 500/);
    ntfy.status = 200;

    // a phone that connects later and asks for what it missed gets it from the buffer
    const late = stream(port, `/${a.topic}/json?since=all`);
    await late.ready; await tick();
    assert.ok(late.msgs.length >= 3);
    late.close();

    // a removed phone: its topic stops being served
    sig.setSlots([]);
    assert.strictEqual((await request(port, 'POST', `/${a.topic}`, req)).status, 404);
    await lan.stop();

    // without LAN (not attached / not listening) publish behaves exactly as before
    const plain = new Signaling(ntfy.base);
    ntfy.posts.length = 0;
    await plain.publish(keyB64, { t: 'x', from: 'h' });
    assert.strictEqual(ntfy.posts.length, 1);
    const off = new Signaling(ntfy.base);
    off.attachLan(new LanServer()); // attached but never started
    await off.publish(keyB64, { t: 'x', from: 'h' });
    assert.strictEqual(ntfy.posts.length, 2);
  }

  // ---- HostCore: a req over the LAN starts a session; the offer leaves on both sinks
  {
    const sig = new Signaling(ntfy.base);
    const lan = new LanServer({ allowLoopback: true });
    sig.attachLan(lan);
    const data = { sharing: true, allowControl: true, quality: 'auto', codec: 'auto', stun: ['stun:x'], turn: null, hostName: 'PC', slots: [{ id: 'phoneA', key: keyB64, name: 'Phone', claimedAt: 1 }] };
    const store = { get: (k) => data[k], set: (p) => Object.assign(data, p), slot: (id) => data.slots.find((s) => s.id === id), claim() {} };
    const engine = Object.assign(new EventEmitter(), { cmds: [], send(c) { this.cmds.push(c); } });
    const input = { setBounds() {}, reset() {}, moveBy() {}, moveNorm() {}, button() {}, wheel() {}, key() {}, combo() {}, text() {} };
    const core = new HostCore({ store, signaling: sig, engine, input, clipboard: { readText: () => '', writeText() {} }, cursorPos: () => ({ x: 0, y: 0 }) });
    const port = await lan.start(0, '127.0.0.1');
    core.refreshSlots(); // hands the slots to Signaling (the ntfy loop is not started: only the LAN route is under test)
    const st = stream(port, `/${a.topic}/json`);
    await st.ready;
    ntfy.posts.length = 0;

    const sid = 'lanrequest1';
    const res = await request(port, 'POST', `/${a.topic}`, crypto.seal(a.encKey, { t: 'req', from: 'p', sid, n: 'Pixel', ts: Date.now() }));
    assert.strictEqual(res.status, 200);
    await tick(60);
    assert.ok(core.sess && core.sess.sid === sid, 'the host started a session for the LAN request');
    assert.ok(engine.cmds.some((c) => c.t === 'start' && c.sid === sid));

    engine.emit('evt', { t: 'offer', sid, sdp: 'v=0 offer', audio: false });
    await tick(80);
    assert.strictEqual(ntfy.posts.length, 1, 'offer published to ntfy');
    const onLan = st.msgs.map((m) => crypto.open(a.encKey, m.message)).find((m) => m && m.t === 'offer');
    assert.ok(onLan, 'offer published on the LAN stream');
    assert.strictEqual(onLan.sid, sid); assert.strictEqual(onLan.sdp, 'v=0 offer'); assert.strictEqual(onLan.from, 'h');
    assert.strictEqual(crypto.open(a.encKey, ntfy.posts[0].body).sdp, 'v=0 offer');

    // the answer comes back over the LAN too
    await request(port, 'POST', `/${a.topic}`, crypto.seal(a.encKey, { t: 'answer', from: 'p', sid, sdp: 'v=0 answer' }));
    await tick(40);
    assert.ok(engine.cmds.some((c) => c.t === 'answer' && c.sid === sid && c.sdp === 'v=0 answer'));

    // the same request arriving on ntfy as well (phone fell back after 4 s) does not start a second session
    sig.emit('message', { slotId: 'phoneA', msg: { t: 'req', from: 'p', sid, n: 'Pixel' }, serverTime: Date.now() });
    await tick(30);
    assert.strictEqual(engine.cmds.filter((c) => c.t === 'start').length, 1);

    // bye over the LAN ends the session
    await request(port, 'POST', `/${a.topic}`, crypto.seal(a.encKey, { t: 'bye', from: 'p', sid }));
    await tick(40);
    assert.strictEqual(core.sess, null);
    st.close();
    await lan.stop();
  }

  // ---- pairing link: `l` is appended last, only when valid; without it the link is byte-identical to before
  {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const base = crypto.toLink(key, 'My PC', 'https://ntfy.sh');
    assert.strictEqual(base, 'glidr://screen?v=1&k=AAECAwQFBgcICQoLDA0ODw&n=My+PC&s=https%3A%2F%2Fntfy.sh');
    assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', undefined, undefined, undefined), base);
    assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', null, null, 'nonsense'), base);
    assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', null, null, '192.168.1.20:50123'), base + '&l=192.168.1.20%3A50123');
    const wolLink = crypto.toLink(key, 'My PC', 'https://ntfy.sh', '001a2b3c4d5e', '192.168.1.255');
    assert.strictEqual(wolLink, base + '&m=001A2B3C4D5E&b=192.168.1.255');
    assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', '001a2b3c4d5e', '192.168.1.255', '10.0.0.5:49152'), wolLink + '&l=10.0.0.5%3A49152');
    const q = new URL(crypto.toLink(key, 'x', 's', null, null, '10.0.0.5:65535').replace('glidr://', 'http://')).searchParams;
    assert.strictEqual(q.get('l'), '10.0.0.5:65535');
    for (const bad of ['10.0.0.5', '10.0.0.5:0', '10.0.0.5:65536', '10.0.0.5:070', '300.1.1.1:5000', 'host:5000', '10.0.0.5:5000/x', ':5000', '', 5000, '[::1]:5000', '10.0.0.5:5000 ']) {
      assert.ok(!crypto.isLanEndpoint(bad), String(bad));
    }
    assert.ok(crypto.isLanEndpoint('1.2.3.4:1') && crypto.isLanEndpoint('255.255.255.255:65535'));
  }

  // ---- the LAN address comes from the same adapter choice as Wake-on-LAN
  {
    const nics = (o) => () => o;
    const v4 = (address, netmask, mac, extra = {}) => ({ address, netmask, family: 'IPv4', mac, internal: false, ...extra });
    assert.strictEqual(wol.primaryLanAddress(nics({ 'Wi-Fi': [v4('192.168.1.20', '255.255.255.0', 'a4:bb:6d:01:02:03')] })), '192.168.1.20');
    assert.strictEqual(wol.primaryLanAddress(nics({ 'vEthernet (WSL)': [v4('172.20.0.1', '255.255.240.0', '00:15:5d:00:00:01')], Ethernet: [v4('10.0.0.5', '255.255.255.0', 'aa:bb:cc:00:00:01')] })), '10.0.0.5');
    assert.strictEqual(wol.primaryLanAddress(nics({ Ethernet: [v4('169.254.3.4', '255.255.0.0', 'aa:bb:cc:dd:ee:ff')] })), null);
    assert.strictEqual(wol.primaryLanAddress(nics({})), null);
    assert.strictEqual(wol.primaryLanAddress(() => { throw new Error('boom'); }), null);
    // and primaryAdapter still returns exactly {mac, broadcast}
    assert.deepStrictEqual(wol.primaryAdapter(nics({ 'Wi-Fi': [v4('192.168.1.20', '255.255.255.0', 'a4:bb:6d:01:02:03')] })), { mac: 'A4BB6D010203', broadcast: '192.168.1.255' });
  }

  // ---- settings: on by default, a hand-edited file cannot break them, the port is kept
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-lan-'));
    const s = new Store(dir, { safeStorage: null });
    assert.strictEqual(s.get('allowLan'), true);
    assert.strictEqual(s.get('lanPort'), 0);
    s.set({ lanPort: 50123, allowLan: false });
    const again = new Store(dir, { safeStorage: null });
    assert.strictEqual(again.get('lanPort'), 50123);
    assert.strictEqual(again.get('allowLan'), false);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ allowLan: 'yes', lanPort: 80 }));
    const odd = new Store(dir, { safeStorage: null });
    assert.strictEqual(odd.get('allowLan'), true);
    assert.strictEqual(odd.get('lanPort'), 0, 'a port outside 1024-65535 is ignored');
  }

  ntfy.close();
  console.log('ok lan-host');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
