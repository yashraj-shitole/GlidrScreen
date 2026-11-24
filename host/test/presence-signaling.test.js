'use strict';
// Signaling.publish with a short timeout (used for the 'sleep' and 'quit' markers) against a local fake ntfy.
// Run: node host/test/presence-signaling.test.js
const assert = require('assert');
const http = require('http');
const { Signaling } = require('../src/signaling');
const { Presence } = require('../src/presence');
const { newKey, deriveSlot, open } = require('../src/crypto');

(async () => {
  const seen = [];
  let hang = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, cache: req.headers.cache, body });
      if (!hang) { res.writeHead(200); res.end('{}'); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = newKey().toString('base64url');
  const slot = deriveSlot(Buffer.from(key, 'base64url'));
  const sig = new Signaling(base);

  // a presence marker through the real publish: right topic, cached by ntfy, sealed with the slot key, small
  const store = { get: (k) => (k === 'slots' ? [{ id: 'a', key, claimedAt: 1 }] : true) };
  const p = new Presence({ signaling: sig, store });
  await p.publish('online');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].url, '/' + slot.topic);
  assert.strictEqual(seen[0].cache, 'yes');
  assert.ok(seen[0].body.length < 200);
  const msg = open(slot.encKey, seen[0].body);
  assert.strictEqual(msg.t, 'presence');
  assert.strictEqual(msg.from, 'h');
  assert.strictEqual(msg.state, 'online');

  // a hanging server: the short timeout rejects quickly, Presence.quit() swallows it and returns within its limit
  hang = true;
  const t0 = Date.now();
  await assert.rejects(sig.publish(key, { t: 'x' }, 150));
  assert.ok(Date.now() - t0 < 1500);
  const q = new Presence({ signaling: sig, store, quitTimeoutMs: 300 });
  q.start();
  const t1 = Date.now();
  await q.quit();
  assert.ok(Date.now() - t1 < 1500, 'quit must not wait for a hanging server');

  server.closeAllConnections?.();
  server.close();
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
