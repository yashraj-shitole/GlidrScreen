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

// Delivery mode (`quality.mode`: auto | latency | clarity) lives with the adaptation logic; re-exported for host.js.
const { normalizeMode, modeSettings } = require('./adaptation');

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

// ---------------------------------------------------------------------------------------------------------------
// Video codec choice. The phone reports what it can DECODE (`req.dec`); the PC only offers codecs from that list, so a
// phone without a decoder never gets a black picture. VP9 and AV1 are explicit opt-ins (`codec` setting): they save
// bandwidth on slow links but can be heavy to encode, so `auto` never picks them. A phone that sends no `dec` (older
// app) is treated exactly as before: H.264 / VP8 only. The engine (renderer/engine.js) receives the resulting order as
// `codecOrder` in the `start` command and maps the names to RTCRtpSender capabilities.

const VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
const CODEC_PREFS = ['auto', ...VIDEO_CODECS];
const MAX_DEC_ENTRIES = 8;

/** A stored/requested `codec` setting; anything unknown becomes 'auto'. */
function normalizeCodecPref(v) {
  return typeof v === 'string' && CODEC_PREFS.includes(v) ? v : 'auto';
}

/**
 * Validates the phone's `dec` field. Returns the de-duplicated list of known codec names, or null (= unknown, behave
 * like an old phone) when it is absent, not an array, longer than 8 entries, holds anything but the four allowed
 * strings, or is empty.
 */
function parseDecoders(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_DEC_ENTRIES) return null;
  if (!v.every((x) => typeof x === 'string' && VIDEO_CODECS.includes(x))) return null;
  return [...new Set(v)];
}

/**
 * Codec names in offer order (the engine appends the rtx entries after them).
 *  - h264 / vp8 / auto: as before (H.264 then VP8; vp8 puts VP8 first).
 *  - vp9 / av1: that codec first, then H.264, then VP8, but only when the phone decodes it; otherwise the auto order.
 *  - Known decoders: the list is filtered to what the phone decodes. If that leaves nothing, the unfiltered legacy
 *    order is used (the phone said it cannot decode H.264 or VP8; offering them is no worse than offering nothing).
 *  - Unknown decoders (null): never VP9 / AV1.
 */
function codecOrder(pref, decoders) {
  const p = normalizeCodecPref(pref);
  const known = Array.isArray(decoders) && decoders.length > 0;
  const legacy = p === 'vp8' ? ['vp8', 'h264'] : ['h264', 'vp8'];
  if (!known) return legacy;
  let order = legacy;
  if ((p === 'vp9' || p === 'av1') && decoders.includes(p)) order = [p, 'h264', 'vp8'];
  const filtered = order.filter((c) => decoders.includes(c));
  return filtered.length ? filtered : legacy;
}

module.exports = { VIDEO_CODECS, CODEC_PREFS, normalizeCodecPref, parseDecoders, codecOrder, PRESETS, FPS_CHOICES, DEFAULT_FPS, SAVER_FPS, normalizeFps, normalizeMode, modeSettings, resolveQuality, parseQualityMessage };
