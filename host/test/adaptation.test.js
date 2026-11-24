'use strict';
// Bandwidth adaptation maths and delivery modes. Run: node host/test/adaptation.test.js
const assert = require('assert');
const Adaptation = require('../src/adaptation');
const media = require('../src/media');

const CLEAN = { qualityLimitationReason: 'none', rttMs: 40, bitrateKbps: 5000, fps: 24 };
const BW = { qualityLimitationReason: 'bandwidth', rttMs: 60, bitrateKbps: 900, fps: 18 };
const CPU = { qualityLimitationReason: 'cpu', rttMs: 40, bitrateKbps: 3000, fps: 12 };
const HIGH_RTT = { qualityLimitationReason: 'none', rttMs: 300, bitrateKbps: 5000, fps: 24 };
const P1080 = { mode: 'auto', maxBitrate: 6_000_000, maxHeight: 1080, fps: 24 };

// --- mode normalisation
for (const m of ['auto', 'latency', 'clarity']) assert.strictEqual(Adaptation.normalizeMode(m), m);
for (const m of ['fast', '', 'AUTO', 5, {}, true, '__proto__']) assert.strictEqual(Adaptation.normalizeMode(m, 'latency'), 'auto', String(m));
assert.strictEqual(Adaptation.normalizeMode(undefined), 'auto');
assert.strictEqual(Adaptation.normalizeMode(undefined, 'clarity'), 'clarity'); // missing keeps the session's mode
assert.strictEqual(Adaptation.normalizeMode(null, 'latency'), 'latency');
assert.strictEqual(Adaptation.normalizeMode(undefined, 'bogus'), 'auto');
assert.strictEqual(media.normalizeMode, Adaptation.normalizeMode); // host.js gets it through media.js

// --- sender settings per mode
assert.deepStrictEqual(Adaptation.modeSettings('latency'), { degradationPreference: 'maintain-framerate', contentHint: 'motion' });
assert.deepStrictEqual(Adaptation.modeSettings('clarity'), { degradationPreference: 'maintain-resolution', contentHint: 'detail' });
assert.deepStrictEqual(Adaptation.modeSettings('auto'), { degradationPreference: 'maintain-framerate', contentHint: null });
assert.deepStrictEqual(Adaptation.modeSettings('nonsense'), Adaptation.modeSettings('auto'));

// --- ladders: start at the ceiling, never above it, never below 360p, monotone
for (const [preset, p] of Object.entries(media.PRESETS)) {
  for (const mode of ['auto', 'latency', 'clarity']) {
    const steps = Adaptation.ladder({ mode, maxBitrate: p.bitrate, maxHeight: p.height, fps: 60 });
    assert.strictEqual(steps[0].scaleDownBy, 1, preset);
    assert.strictEqual(steps[0].maxBitrate, p.bitrate, preset);
    assert.strictEqual(steps[0].maxFramerate, null);
    for (let i = 0; i < steps.length; i++) {
      assert.ok(steps[i].maxBitrate <= p.bitrate, `${preset}/${mode} step ${i} above ceiling`);
      assert.ok(steps[i].maxBitrate >= 250_000);
      assert.ok(steps[i].scaleDownBy >= 1);
      if (mode === 'clarity') assert.strictEqual(steps[i].scaleDownBy, 1, 'clarity never lowers resolution');
      else assert.ok(p.height / steps[i].scaleDownBy >= 360 - 1e-6, `${preset}/${mode} below 360p at step ${i}`);
      if (i > 0) {
        assert.ok(steps[i].scaleDownBy >= steps[i - 1].scaleDownBy);
        assert.ok(steps[i].maxBitrate <= steps[i - 1].maxBitrate);
      }
    }
    if (mode !== 'clarity') assert.ok(Math.abs(p.height / steps[steps.length - 1].scaleDownBy - 360) < 1e-6 || p.height <= 360);
  }
}
// resolution comes first, then bitrate-only steps
{
  const steps = Adaptation.ladder(P1080);
  assert.deepStrictEqual(steps.map((s) => s.scaleDownBy), [1, 1.5, 2, 3, 3, 3]);
  assert.deepStrictEqual(steps.map((s) => s.maxBitrate), [6_000_000, 4_000_000, 3_000_000, 2_000_000, 1_400_000, 1_000_000]);
}
// clarity gives way with fps and bitrate; fps caps never raise a lower preset fps
{
  const steps = Adaptation.ladder({ mode: 'clarity', maxBitrate: 6_000_000, maxHeight: 1080, fps: 60 });
  assert.deepStrictEqual(steps.map((s) => s.maxFramerate), [null, null, 30, 24, 15]);
  const low = Adaptation.ladder({ mode: 'clarity', maxBitrate: 6_000_000, maxHeight: 1080, fps: 15 });
  assert.ok(low.every((s) => s.maxFramerate === null));
}

// --- stepping rules
{
  const a = Adaptation.create(P1080);
  assert.deepStrictEqual(a.current(), { scaleDownBy: 1, maxBitrate: 6_000_000, maxFramerate: null, level: 0, changed: false, mode: 'auto' });
  assert.strictEqual(a.sample(BW).changed, false); // one bad sample is not enough in auto
  assert.strictEqual(a.sample(CLEAN).changed, false);
  assert.strictEqual(a.sample(BW).changed, false); // not consecutive
  const r = a.sample(CPU); // second consecutive bad sample (cpu counts too)
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.level, 1);
  assert.strictEqual(r.scaleDownBy, 1.5);
  assert.strictEqual(r.maxBitrate, 4_000_000);
  // RTT over 250 ms counts as bad, 250 itself does not
  const b = Adaptation.create(P1080);
  b.sample(HIGH_RTT); assert.strictEqual(b.sample(HIGH_RTT).level, 1);
  const c = Adaptation.create(P1080);
  c.sample({ ...CLEAN, rttMs: 250 }); assert.strictEqual(c.sample({ ...CLEAN, rttMs: 250 }).level, 0);
  // 'other' limitation is ignored, garbage samples do nothing
  const d = Adaptation.create(P1080);
  for (let i = 0; i < 10; i++) assert.strictEqual(d.sample({ qualityLimitationReason: 'other', rttMs: 30 }).level, 0);
  assert.strictEqual(d.sample(null).changed, false);
  assert.strictEqual(d.sample(undefined).level, 0);
  assert.strictEqual(d.sample({}).level, 0);
  // missing rtt is tolerated
  for (let i = 0; i < 3; i++) d.sample({ qualityLimitationReason: 'none' });
  assert.strictEqual(d.level, 0);
}
// up only after 6 consecutive clean samples; a bad or dead-band sample restarts the count
{
  const a = Adaptation.create(P1080);
  a.sample(BW); a.sample(BW); assert.strictEqual(a.level, 1);
  for (let i = 0; i < 5; i++) assert.strictEqual(a.sample(CLEAN).level, 1);
  a.sample({ ...CLEAN, rttMs: 220 }); // dead band: not clean
  for (let i = 0; i < 5; i++) assert.strictEqual(a.sample(CLEAN).level, 1);
  assert.strictEqual(a.sample(CLEAN).level, 0); // 6th clean in a row
  assert.strictEqual(a.sample(CLEAN).scaleDownBy, 1);
  // never above the ceiling, however long the link stays clean
  for (let i = 0; i < 100; i++) assert.strictEqual(a.sample(CLEAN).level, 0);
}
// never below the last step
{
  const a = Adaptation.create(P1080);
  const n = a.steps.length;
  for (let i = 0; i < 200; i++) a.sample(BW);
  assert.strictEqual(a.level, n - 1);
  const cur = a.current();
  assert.ok(1080 / cur.scaleDownBy >= 360 - 1e-6);
  assert.ok(cur.maxBitrate >= 250_000);
}

// --- modes
{
  const l = Adaptation.create({ ...P1080, mode: 'latency' });
  const r = l.sample(BW); // one bad sample is enough
  assert.strictEqual(r.level, 1);
  assert.strictEqual(r.mode, 'latency');
  assert.ok(r.scaleDownBy > 1);
  const c = Adaptation.create({ ...P1080, mode: 'clarity' });
  const seen = new Set();
  for (let i = 0; i < 60; i++) { const x = c.sample(BW); seen.add(x.scaleDownBy); }
  assert.deepStrictEqual([...seen], [1], 'clarity never lowers resolution');
  assert.strictEqual(c.current().maxBitrate, 6_000_000 * 0.3);
  assert.strictEqual(c.current().maxFramerate, 15);
  // clarity at 60 fps preset
  const c60 = Adaptation.create({ mode: 'clarity', maxBitrate: 8_400_000, maxHeight: 1080, fps: 60 });
  c60.sample(BW); c60.sample(BW); c60.sample(BW); c60.sample(BW);
  assert.strictEqual(c60.current().maxFramerate, 30);
}
// configure: same config keeps the level, a changed mode / ceiling returns to the ceiling
{
  const a = Adaptation.create(P1080);
  a.sample(BW); a.sample(BW);
  assert.strictEqual(a.configure({ ...P1080 }), false);
  assert.strictEqual(a.level, 1);
  assert.strictEqual(a.configure({ ...P1080, mode: 'latency' }), true);
  assert.strictEqual(a.level, 0);
  assert.strictEqual(a.mode, 'latency');
  a.sample(BW);
  assert.strictEqual(a.configure({ ...P1080, mode: undefined, maxBitrate: 3_000_000, maxHeight: 720 }), true); // missing mode keeps latency
  assert.strictEqual(a.mode, 'latency');
  assert.strictEqual(a.current().maxBitrate, 3_000_000);
  assert.strictEqual(Adaptation.create({ ...P1080, mode: 'junk' }).mode, 'auto');
}

// --- synthetic link: congestion burst then clean link
/** Run `n` samples against a link; capacityKbps = Infinity is a clean link. Returns the changes. */
function drive(a, n, capacityKbps, log) {
  for (let i = 0; i < n; i++) {
    const cur = a.current();
    const over = cur.maxBitrate / 1000 > capacityKbps;
    const sample = over
      ? { qualityLimitationReason: 'bandwidth', rttMs: 120, bitrateKbps: capacityKbps, fps: 15 }
      : { qualityLimitationReason: 'none', rttMs: 35, bitrateKbps: cur.maxBitrate / 1000, fps: 24 };
    const r = a.sample(sample);
    if (log) log.push({ t: log.t = (log.t || 0) + 1, level: r.level, changed: r.changed, over });
  }
}

for (const mode of ['auto', 'latency', 'clarity']) {
  for (const p of Object.values(media.PRESETS)) {
    const a = Adaptation.create({ mode, maxBitrate: p.bitrate, maxHeight: p.height, fps: 24 });
    const log = [];
    drive(a, 20, Infinity, log); // clean start
    assert.strictEqual(a.level, 0);
    drive(a, 12, 300, log); // 24 s of heavy congestion: well below any usable step
    assert.ok(a.level > 0, 'steps down under congestion');
    drive(a, 120, Infinity, log); // clean link again
    assert.strictEqual(a.level, 0, `${mode}/${p.height}: returns to the ceiling on a clean link`);
    const tail = log.slice(-30);
    assert.ok(tail.every((x) => !x.changed), 'settled: no changes in the last minute');
    assert.deepStrictEqual(a.current(), Adaptation.create({ mode, maxBitrate: p.bitrate, maxHeight: p.height, fps: 24 }).current());
  }
}

// --- synthetic link: a link that can only carry 2 Mbit/s for a long time must settle, not oscillate
{
  const a = Adaptation.create(P1080);
  const log = [];
  drive(a, 40, 2000, log);
  const settledAt = log.findIndex((x, i) => i >= 1 && log.slice(i).every((y) => !y.over));
  assert.ok(a.current().maxBitrate <= 2_000_000);
  // long run: failed probes back off, so bad samples and changes stay rare
  drive(a, 1500, 2000, log);
  const longRun = log.slice(40);
  const changes = longRun.filter((x) => x.changed);
  const bad = longRun.filter((x) => x.over).length;
  assert.ok(changes.length <= 2 * Math.ceil(longRun.length / 48) + 2, 'changes ' + changes.length);
  assert.ok(bad / longRun.length < 0.1, 'congested fraction ' + bad / longRun.length);
  // gaps between successive step-ups never shrink (exponential backoff up to the cap)
  const ups = [];
  longRun.forEach((x, i) => { if (x.changed && !x.over && i > 0) ups.push(i); });
  const gaps = ups.slice(1).map((v, i) => v - ups[i]);
  for (let i = 1; i < Math.min(gaps.length, 5); i++) assert.ok(gaps[i] >= gaps[i - 1], 'backoff gaps ' + gaps);
  // the link recovers: it climbs back to the ceiling
  drive(a, 400, Infinity, log);
  assert.strictEqual(a.level, 0, 'recovers when the link recovers');
  assert.ok(settledAt >= 0);
}

// --- flapping link (alternating 1 bad / 1 clean sample) must not move at all in auto
{
  const a = Adaptation.create(P1080);
  for (let i = 0; i < 400; i++) a.sample(i % 2 ? CLEAN : BW);
  assert.strictEqual(a.level, 0);
  // nor with 1 bad / 5 clean
  const b = Adaptation.create(P1080);
  for (let i = 0; i < 600; i++) b.sample(i % 6 === 0 ? BW : CLEAN);
  assert.strictEqual(b.level, 0);
}

// --- random congestion: invariants hold on a long noisy sequence
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const mode of ['auto', 'latency', 'clarity']) {
    const a = Adaptation.create({ mode, maxBitrate: 3_000_000, maxHeight: 720, fps: 30 });
    let prevLevel = 0;
    for (let i = 0; i < 20000; i++) {
      const x = rnd();
      const s = x < 0.15 ? BW : x < 0.2 ? CPU : x < 0.27 ? HIGH_RTT : x < 0.3 ? { qualityLimitationReason: 'other' } : CLEAN;
      const r = a.sample(s);
      assert.ok(r.maxBitrate <= 3_000_000 && r.maxBitrate >= 250_000);
      assert.ok(r.scaleDownBy >= 1 && 720 / r.scaleDownBy >= 360 - 1e-6);
      if (mode === 'clarity') assert.strictEqual(r.scaleDownBy, 1);
      assert.ok(Math.abs(r.level - prevLevel) <= 1, 'one step at a time');
      prevLevel = r.level;
    }
  }
}

console.log('ok adaptation');
