'use strict';
// Live round trip through the public ntfy.sh rendezvous (needs internet).
const assert = require('assert');
const { Signaling } = require('../src/signaling');
const { newKey } = require('../src/crypto');

(async () => {
  const key = newKey().toString('base64url');
  const sig = new Signaling(process.env.GLIDR_SIGNAL || 'https://ntfy.sh');
  sig.setSlots([{ id: 's1', key }]);
  const got = new Promise((res, rej) => {
    sig.on('message', res);
    setTimeout(() => rej(new Error('timeout waiting for message')), 15000);
  });
  sig.start();
  await new Promise((r) => sig.once('status', r));
  const t0 = Date.now();
  await sig.publish(key, { t: 'req', sid: 'x', n: 'test' });
  const m = await got;
  console.log('round trip ms', Date.now() - t0, m);
  assert.strictEqual(m.msg.t, 'req');
  sig.stop();
  console.log('ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
