'use strict';
// Pure automatic bandwidth adaptation for the outgoing screen video. No WebRTC, no timers, no I/O: feed it one
// stats sample every ~2 s and apply what it returns with RTCRtpSender.setParameters (no renegotiation).
//
// This one file is loaded two ways: `require('./adaptation')` from node (host.js, tests) and with a plain
// <script src="../src/adaptation.js"> from host/renderer/engine.html (the renderer cannot `require`), where it
// defines the global `Adaptation`.
//
// Ladder (auto and latency): each step down first makes the picture smaller, then, once the 360p-equivalent floor is
// reached, lowers the bitrate further.
//      level   1080p preset: scale  bitrate
//        0                    1.0    6.0 Mb/s   <- the preset ceiling, never exceeded
//        1                    1.5    4.0
//        2                    2.0    3.0
//        3                    3.0    2.0        (360p floor: scale never goes above maxHeight / 360)
//        4                    3.0    1.4
//        5                    3.0    1.0
// Clarity mode keeps the preset resolution (scale is always 1) and gives way with bitrate and frame rate instead.
//
// Hysteresis: down needs `downAfter` consecutive bad samples (2; latency 1), up needs `upNeeded` consecutive clean
// ones (6). A step down soon after a step up means the probe failed, so the next up needs twice as many clean samples
// (6, 12, 24, 48 and no more); the requirement resets once the link has been clean at the ceiling. RTT between 200
// and 250 ms is a dead band: not bad, but it does not count as clean either.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.Adaptation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MODES = ['auto', 'latency', 'clarity'];
  const MIN_HEIGHT = 360;           // never below a 360p-equivalent picture
  const MIN_BITRATE = 250_000;
  const RTT_BAD_MS = 250;
  const RTT_CLEAN_MS = 200;
  const UP_BASE = 6;
  const UP_MAX = 48;
  const PROBE_WINDOW = 8;           // a step down within this many samples of a step up is a failed probe
  const STABLE_RESET = 20;          // clean samples at the ceiling that forget the backoff
  const DOWN_AFTER = { auto: 2, latency: 1, clarity: 2 };

  /** 'auto' | 'latency' | 'clarity'. Unknown -> 'auto'; undefined/null -> `current` (or 'auto'). */
  function normalizeMode(v, current) {
    if (v === undefined || v === null) return MODES.includes(current) ? current : 'auto';
    return typeof v === 'string' && MODES.includes(v) ? v : 'auto';
  }

  /** Per-mode sender settings. contentHint null = leave the preset's own hint. */
  function modeSettings(mode) {
    switch (normalizeMode(mode)) {
      case 'latency': return { degradationPreference: 'maintain-framerate', contentHint: 'motion' };
      case 'clarity': return { degradationPreference: 'maintain-resolution', contentHint: 'detail' };
      default: return { degradationPreference: 'maintain-framerate', contentHint: null };
    }
  }

  const round10k = (n) => Math.max(MIN_BITRATE, Math.round(n / 10_000) * 10_000);

  /** Steps from level 0 (ceiling) downwards: [{scaleDownBy, maxBitrate, maxFramerate|null}]. */
  function ladder({ mode, maxBitrate, maxHeight, fps }) {
    const m = normalizeMode(mode);
    const top = Math.max(MIN_BITRATE, Math.round(maxBitrate));
    const steps = [];
    if (m === 'clarity') {
      const f = Number.isFinite(fps) && fps > 0 ? fps : null;
      const rows = [[1, 0], [0.75, 0], [0.55, 30], [0.4, 24], [0.3, 15]];
      for (const [factor, cap] of rows) {
        steps.push({
          scaleDownBy: 1,
          maxBitrate: factor === 1 ? top : round10k(top * factor),
          maxFramerate: cap && f && f > cap ? cap : null,
        });
      }
      return steps;
    }
    const maxScale = Math.max(1, (Number.isFinite(maxHeight) ? maxHeight : MIN_HEIGHT) / MIN_HEIGHT);
    const scales = [1, 1.5, 2, 3, 4].filter((s) => s < maxScale - 1e-9);
    scales.push(maxScale);
    scales.forEach((s, i) => {
      steps.push({ scaleDownBy: s, maxBitrate: i === 0 ? top : round10k(top / s), maxFramerate: null });
    });
    for (const factor of [0.7, 0.5]) {
      steps.push({ scaleDownBy: maxScale, maxBitrate: round10k((top / maxScale) * factor), maxFramerate: null });
    }
    return steps;
  }

  /**
   * One controller per session. `cfg` = {mode, maxBitrate, maxHeight, fps} (the preset ceiling).
   * `sample({qualityLimitationReason, rttMs, bitrateKbps, fps})` -> {scaleDownBy, maxBitrate, maxFramerate, level,
   * changed, mode}. scaleDownBy is relative to the preset resolution (the engine multiplies it with its own
   * source-to-preset scale).
   */
  function create(cfg) {
    let conf = null;
    let steps = [];
    let level = 0, bad = 0, clean = 0, idx = 0, lastUpAt = null, upNeeded = UP_BASE;

    function reset() { level = 0; bad = 0; clean = 0; idx = 0; lastUpAt = null; upNeeded = UP_BASE; }
    function current(changed) {
      const s = steps[level];
      return { scaleDownBy: s.scaleDownBy, maxBitrate: s.maxBitrate, maxFramerate: s.maxFramerate, level, changed: !!changed, mode: conf.mode };
    }
    /** Returns true when the ceiling or mode really changed (and the controller went back to the ceiling). */
    function configure(next) {
      const n = {
        mode: normalizeMode(next && next.mode, conf ? conf.mode : undefined),
        maxBitrate: next && next.maxBitrate, maxHeight: next && next.maxHeight, fps: next && next.fps,
      };
      if (conf && conf.mode === n.mode && conf.maxBitrate === n.maxBitrate && conf.maxHeight === n.maxHeight && conf.fps === n.fps) return false;
      conf = n;
      steps = ladder(conf);
      reset();
      return true;
    }
    configure(cfg);

    function sample(s) {
      if (!s || typeof s !== 'object') return current(false);
      idx++;
      const rtt = Number.isFinite(s.rttMs) ? s.rttMs : null;
      const reason = s.qualityLimitationReason;
      const isBad = reason === 'bandwidth' || reason === 'cpu' || (rtt !== null && rtt > RTT_BAD_MS);
      const isClean = !isBad && (rtt === null || rtt <= RTT_CLEAN_MS);
      const before = level;
      if (isBad) {
        bad++; clean = 0;
        if (bad >= (DOWN_AFTER[conf.mode] || 2) && level < steps.length - 1) {
          level++; bad = 0;
          if (lastUpAt !== null && idx - lastUpAt <= PROBE_WINDOW) upNeeded = Math.min(upNeeded * 2, UP_MAX);
        }
      } else {
        bad = 0;
        if (isClean) {
          clean++;
          if (level === 0 && clean >= STABLE_RESET) upNeeded = UP_BASE;
          if (level > 0 && clean >= upNeeded) { level--; clean = 0; lastUpAt = idx; }
        } else {
          clean = 0;
        }
      }
      return current(level !== before);
    }

    return { sample, configure, current: () => current(false), get level() { return level; }, get mode() { return conf.mode; }, get steps() { return steps.slice(); } };
  }

  return { MODES, MIN_HEIGHT, RTT_BAD_MS, UP_BASE, UP_MAX, normalizeMode, modeSettings, ladder, create };
});
