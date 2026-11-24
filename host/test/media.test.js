'use strict';
// Quality / fps / saver maths and phone message validation. Run: node host/test/media.test.js
const assert = require('assert');
const { resolveQuality, parseQualityMessage, normalizeFps, PRESETS } = require('../src/media');

// fps normalisation
for (const f of [15, 24, 30, 60]) assert.strictEqual(normalizeFps(f), f);
for (const f of [undefined, null, 0, 12, 25, 120, '30', NaN, {}]) assert.strictEqual(normalizeFps(f), 24, String(f));

// defaults: 24 fps, preset bitrate, motion hint
let q = resolveQuality({ preset: 'auto' });
assert.deepStrictEqual(q, { preset: 'auto', fps: 24, saver: false, bitrate: 6_000_000, height: 1080, contentHint: 'motion' });
assert.strictEqual(resolveQuality({}).preset, 'auto');
assert.strictEqual(resolveQuality({ preset: 'nope' }).preset, 'auto');
assert.strictEqual(resolveQuality({ preset: '__proto__' }).preset, 'auto');

// cap table: 60 fps only for auto/balanced; low and high clamp to 30
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 60 }).fps, 60);
assert.strictEqual(resolveQuality({ preset: 'balanced', fps: 60 }).fps, 60);
assert.strictEqual(resolveQuality({ preset: 'high', fps: 60 }).fps, 30);
assert.strictEqual(resolveQuality({ preset: 'low', fps: 60 }).fps, 30);
assert.strictEqual(resolveQuality({ preset: 'high', fps: 30 }).fps, 30);
assert.strictEqual(resolveQuality({ preset: 'high', fps: 15 }).fps, 15);
assert.strictEqual(resolveQuality({ preset: 'low', fps: 24 }).fps, 24);

// 60 fps costs 1.4x bitrate
assert.strictEqual(resolveQuality({ preset: 'balanced', fps: 60 }).bitrate, 4_200_000);
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 30 }).bitrate, 6_000_000);

// saver: 15 fps, half bitrate, detail hint, whatever fps was asked for
for (const preset of Object.keys(PRESETS)) {
  q = resolveQuality({ preset, fps: 60, saver: true });
  assert.strictEqual(q.fps, 15);
  assert.strictEqual(q.bitrate, PRESETS[preset].bitrate / 2);
  assert.strictEqual(q.contentHint, 'detail');
  assert.strictEqual(q.saver, true);
}
// saver must be exactly true
assert.strictEqual(resolveQuality({ preset: 'auto', saver: 'true' }).saver, false);
assert.strictEqual(resolveQuality({ preset: 'auto', saver: 1 }).fps, 24);

// content hint: motion for >= 24, detail below (15 without saver)
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 24 }).contentHint, 'motion');
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 60 }).contentHint, 'motion');
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 15 }).contentHint, 'detail');
assert.strictEqual(resolveQuality({ preset: 'auto', fps: 15 }).bitrate, 6_000_000);

// message parsing
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 'ultra' }, 'auto'), null);
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 5 }, 'auto'), null);
assert.strictEqual(parseQualityMessage(null, 'auto'), null);
assert.deepStrictEqual(parseQualityMessage({ t: 'quality', p: 'low' }, 'auto'), resolveQuality({ preset: 'low' }));
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 'balanced', fps: 60 }, 'auto').fps, 60);
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 'balanced', fps: 99 }, 'auto').fps, 24); // unknown fps -> 24
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 'high', fps: 60 }, 'auto').fps, 30);
assert.strictEqual(parseQualityMessage({ t: 'quality', p: 'auto', saver: true }, 'auto').fps, 15);
assert.strictEqual(parseQualityMessage({ t: 'quality', fps: 30 }, 'low').preset, 'low'); // missing p keeps preset
assert.strictEqual(parseQualityMessage({ t: 'quality', fps: 60 }, 'high').fps, 30);

console.log('ok media');
