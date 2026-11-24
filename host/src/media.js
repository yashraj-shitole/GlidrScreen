'use strict';
// Pure quality / frame-rate maths shared by host.js (and unit tested). The engine window only applies the result.
//
// Presets cap resolution and bitrate; the frame rate is chosen by the phone (`fps`, `saver`) and then capped per
// preset so the encoder is never asked for something it cannot do well:
//
//   preset     height  bitrate  max fps
//   low         540p   1.2 Mb/s    30
//   balanced    720p   3.0 Mb/s    60
//   auto       1080p   6.0 Mb/s    60
//   high       1440p   9.0 Mb/s    30   (1440p60 is too heavy for most hardware encoders)
//
// 60 fps raises the bitrate by 1.4x (more frames to code). Data saver forces 15 fps and halves the bitrate.

const PRESETS = {
  auto: { height: 1080, bitrate: 6_000_000, maxFps: 60 },
  low: { height: 540, bitrate: 1_200_000, maxFps: 30 },
  balanced: { height: 720, bitrate: 3_000_000, maxFps: 60 },
  high: { height: 1440, bitrate: 9_000_000, maxFps: 30 },
};
const FPS_CHOICES = [15, 24, 30, 60];
const DEFAULT_FPS = 24;
const SAVER_FPS = 15;
const SAVER_BITRATE_FACTOR = 0.5;
const FPS60_BITRATE_FACTOR = 1.4;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Any value that is not one of 15/24/30/60 becomes 24. */
function normalizeFps(v) {
  return FPS_CHOICES.includes(v) ? v : DEFAULT_FPS;
}

/**
 * Effective settings for a preset + requested fps + saver flag. Unknown preset behaves like 'auto'.
 * @returns {{preset, fps, saver, bitrate, height, contentHint}}
 */
function resolveQuality({ preset, fps, saver } = {}) {
  const name = has(PRESETS, preset) ? preset : 'auto';
  const base = PRESETS[name];
  const sv = saver === true;
  const f = sv ? SAVER_FPS : Math.min(normalizeFps(fps), base.maxFps);
  let bitrate = base.bitrate;
  if (sv) bitrate *= SAVER_BITRATE_FACTOR;
  else if (f >= 60) bitrate *= FPS60_BITRATE_FACTOR;
  return {
    preset: name, fps: f, saver: sv, bitrate: Math.round(bitrate), height: base.height,
    contentHint: sv || f < 24 ? 'detail' : 'motion', // 'motion' keeps the frame rate; 'detail' keeps the sharpness
  };
}

/**
 * Validates a phone `quality` message. Returns the resolved settings, or null when `p` is present but unknown
 * (the message is then ignored). A missing `p` keeps the current preset; a missing `fps` means 24.
 */
function parseQualityMessage(m, currentPreset) {
  if (!m || typeof m !== 'object') return null;
  let preset = currentPreset;
  if (m.p !== undefined) {
    if (typeof m.p !== 'string' || !has(PRESETS, m.p)) return null;
    preset = m.p;
  }
  return resolveQuality({ preset, fps: m.fps, saver: m.saver === true });
}

module.exports = { PRESETS, FPS_CHOICES, DEFAULT_FPS, SAVER_FPS, normalizeFps, resolveQuality, parseQualityMessage };
