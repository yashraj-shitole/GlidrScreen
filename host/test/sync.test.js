'use strict';
// Clipboard sync + cursor stream logic with fake IO and fake timers. Run: node host/test/sync.test.js
const assert = require('assert');
const { ClipboardSync, CursorStream, validClipText, normalize, MAX_CLIP_CHARS } = require('../src/sync');

const fakeTimers = () => {
  const t = { fn: null, ms: null, cleared: 0 };
  t.setInterval = (fn, ms) => { t.fn = fn; t.ms = ms; return 1; };
  t.clearInterval = () => { t.cleared++; t.fn = null; };
  return t;
};

// ---- validation
assert.strictEqual(validClipText('hi'), 'hi');
assert.strictEqual(validClipText(''), null);
assert.strictEqual(validClipText(42), null);
assert.strictEqual(validClipText(undefined), null);
assert.strictEqual(validClipText('a'.repeat(MAX_CLIP_CHARS)), 'a'.repeat(MAX_CLIP_CHARS));
assert.strictEqual(validClipText('a'.repeat(MAX_CLIP_CHARS + 1)), null);
assert.strictEqual(MAX_CLIP_CHARS, 262144);

// ---- clipboard: change detection, caps, no echo
{
  let pc = 'start'; const sent = []; const timers = fakeTimers();
  const c = new ClipboardSync({ read: () => pc, write: (t) => { pc = t; }, send: (t) => sent.push(t), ...timers });
  assert.strictEqual(c.on, false);
  c.setOn(true);
  assert.strictEqual(timers.ms, 500);
  timers.fn(); assert.deepStrictEqual(sent, [], 'baseline is not pushed');
  pc = 'one'; timers.fn(); timers.fn(); assert.deepStrictEqual(sent, ['one'], 'sent once per change');
  pc = ''; timers.fn(); assert.deepStrictEqual(sent, ['one'], 'empty ignored');
  pc = 'one'; timers.fn(); assert.deepStrictEqual(sent, ['one', 'one'], 'a real change back to the same text is a change');
  pc = 'x'.repeat(MAX_CLIP_CHARS + 1); timers.fn(); timers.fn(); assert.strictEqual(sent.length, 2, 'oversize not sent');
  pc = 'x'.repeat(MAX_CLIP_CHARS); timers.fn(); assert.strictEqual(sent.length, 3, 'exactly at the cap is sent');

  // phone -> PC: written, and not echoed back
  assert.strictEqual(c.fromPhone('from phone'), true);
  assert.strictEqual(pc, 'from phone');
  timers.fn(); assert.strictEqual(sent.length, 3, 'phone text is not echoed');
  pc = 'user copied'; timers.fn(); assert.strictEqual(sent[sent.length - 1], 'user copied');
  assert.strictEqual(c.fromPhone(''), false);
  assert.strictEqual(c.fromPhone('y'.repeat(MAX_CLIP_CHARS + 1)), false);
  assert.strictEqual(pc, 'user copied', 'rejected text never reaches the clipboard');
  assert.strictEqual(c.fromPhone(12345), false);

  c.setOn(false); assert.strictEqual(c.on, false); assert.strictEqual(timers.cleared, 1);
  c.setOn(false); assert.strictEqual(timers.cleared, 1, 'stop is idempotent');
  // turning it on again re-baselines instead of pushing the current text
  const n = sent.length; pc = 'while off'; c.setOn(true); timers.fn(); assert.strictEqual(sent.length, n);
  c.stop(); assert.strictEqual(c.on, false);
}
// phone text works without sync being on, and a throwing reader / writer is survived
{
  let w = null; const c = new ClipboardSync({ read: () => { throw new Error('locked'); }, write: (t) => { w = t; }, send: () => assert.fail('no send') });
  assert.strictEqual(c.fromPhone('abc'), true); assert.strictEqual(w, 'abc');
  c.setOn(true); c.poll(); c.stop();
  const bad = new ClipboardSync({ read: () => '', write: () => { throw new Error('busy'); }, send: () => {} });
  assert.strictEqual(bad.fromPhone('abc'), false);
}

// ---- cursor normalisation
assert.strictEqual(normalize(0, 1920), 0);
assert.strictEqual(normalize(1919, 1920), 1);
assert.strictEqual(normalize(-50, 1920), 0);
assert.strictEqual(normalize(5000, 1920), 1);
assert.strictEqual(normalize(959.5, 1920), 0.5);
assert.strictEqual(normalize(10, 1), 0);

// ---- cursor stream: change detection, throttling, bounds offset, start/stop
{
  let pos = { x: 2920, y: 540 }; let now = 1000; const sent = []; const timers = fakeTimers();
  const bounds = { x: 1920, y: 0, w: 1921, h: 1081 }; // second monitor, so x offset 1000 of 1920
  const cs = new CursorStream({ getPos: () => pos, getBounds: () => bounds, send: (m) => sent.push(m), now: () => now, ...timers });
  cs.start();
  assert.strictEqual(cs.on, true);
  assert.ok(timers.ms >= 33 && timers.ms <= 40);
  assert.deepStrictEqual(sent, [{ x: 0.5208, y: 0.5 }], 'position is sent on start');
  now += 40; timers.fn(); assert.strictEqual(sent.length, 1, 'unchanged position is not resent');
  pos = { x: 2921, y: 540 }; now += 5; timers.fn(); assert.strictEqual(sent.length, 2, 'changed position is sent');
  pos = { x: 2922, y: 540 }; now += 5; timers.fn(); assert.strictEqual(sent.length, 2, 'throttled 5 ms after a send');
  now += 30; timers.fn(); assert.strictEqual(sent.length, 3, 'sent once the interval passed');
  // 1 s of movement polled every 10 ms: at most ~30 messages
  const before = sent.length;
  for (let i = 0; i < 100; i++) { now += 10; pos = { x: 2000 + i, y: 100 + i }; timers.fn(); }
  assert.ok(sent.length - before <= 31, 'at most ~30/s, got ' + (sent.length - before));
  assert.ok(sent.length - before >= 25);
  for (const m of sent) assert.ok(m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1);
  // cursor on another monitor clamps to the edge
  now += 40; pos = { x: -300, y: 2000 }; timers.fn();
  assert.deepStrictEqual(sent[sent.length - 1], { x: 0, y: 1 });
  cs.stop(); assert.strictEqual(cs.on, false); assert.strictEqual(timers.cleared, 1);
  const n = sent.length; now += 100; assert.strictEqual(timers.fn, null, 'timer cleared'); assert.strictEqual(sent.length, n);
  // restart sends the current position again, even if unchanged
  cs.start(); assert.strictEqual(sent.length, n + 1);
  cs.start(); assert.strictEqual(sent.length, n + 1, 'start is idempotent');
  cs.stop();
}
// bad bounds / throwing reader never send or throw
{
  const sent = []; let b = { x: 0, y: 0, w: 0, h: 0 };
  const cs = new CursorStream({ getPos: () => ({ x: 1, y: 1 }), getBounds: () => b, send: (m) => sent.push(m), now: () => 1e6, ...fakeTimers() });
  assert.strictEqual(cs.tick(), false);
  b = null; assert.strictEqual(cs.tick(), false);
  const cs2 = new CursorStream({ getPos: () => { throw new Error('x'); }, getBounds: () => ({ x: 0, y: 0, w: 10, h: 10 }), send: () => assert.fail('no'), now: () => 1e6, ...fakeTimers() });
  assert.strictEqual(cs2.tick(), false);
  assert.strictEqual(sent.length, 0);
}

console.log('ok sync');
