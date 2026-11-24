'use strict';
// Offline: fetch is stubbed. Covers reconnect() and the exclusion of slots that need repair.
const assert = require('assert');
const { Signaling } = require('../src/signaling');
const { newKey, deriveSlot } = require('../src/crypto');

const calls = [];
let first = true;
global.fetch = (url, { signal }) => {
  calls.push(String(url));
  const lines = first ? [JSON.stringify({ event: 'message', id: 'msg1', topic: 'nope', message: 'x' }) + '\n'] : [];
  first = false;
  async function* body() {
    for (const l of lines) yield Buffer.from(l);
    await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  return Promise.resolve({ ok: true, body: body() });
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const good = newKey().toString('base64url');
  const topic = deriveSlot(Buffer.from(good, 'base64url')).topic;
  const sig = new Signaling('https://example.test/');
  sig.setSlots([{ id: 'g', key: good }, { id: 'r', key: '', needsRepair: true }, { id: 'r2', key: good, needsRepair: true }]);
  assert.strictEqual(sig.slots.size, 1);

  sig.reconnect(); // not running: no-op
  await tick();
  assert.strictEqual(calls.length, 0);

  sig.start();
  await tick();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].startsWith(`https://example.test/${topic}/json`));
  assert.ok(!calls[0].includes('since='));

  sig.backoff = 16000;
  sig.reconnect();
  await tick();
  assert.strictEqual(calls.length, 2); // reopened immediately, without waiting for backoff
  assert.strictEqual(sig.backoff, 1000);
  assert.ok(calls[1].includes('since=msg1'), calls[1]); // resumes after the last message: nothing is lost

  sig.stop();
  sig.reconnect(); // stopped: stays stopped
  await tick();
  assert.strictEqual(calls.length, 2);
  console.log('ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
