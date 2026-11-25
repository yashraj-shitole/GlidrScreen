'use strict';
// Video codec choice: the pure ordering in src/media.js, `dec` validation, the settings value check in the store and
// the engine's codecPreferences (run in a vm with fake RTCRtpSender capabilities). Run: node host/test/codecs.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { codecOrder, parseDecoders, normalizeCodecPref, CODEC_PREFS } = require('../src/media');
const { Store } = require('../src/store');

const ALL = ['h264', 'vp8', 'vp9', 'av1'];
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// ---- parseDecoders: only a small array of the four lower-case names is accepted
eq(parseDecoders(['h264', 'vp8', 'vp9', 'av1']), ALL);
eq(parseDecoders(['vp9', 'vp9', 'h264']), ['vp9', 'h264'], 'de-duplicated');
eq(parseDecoders(['av1']), ['av1']);
for (const bad of [undefined, null, 'h264', 5, {}, [], ['H264'], ['h265'], ['h264', 1], ['h264', null], [['h264']], new Array(9).fill('h264'), ['__proto__']]) {
  assert.strictEqual(parseDecoders(bad), null, JSON.stringify(bad));
}
eq(parseDecoders(new Array(8).fill('vp8')), ['vp8'], 'eight entries are fine');

// ---- codec setting
eq(CODEC_PREFS, ['auto', 'h264', 'vp8', 'vp9', 'av1']);
for (const c of CODEC_PREFS) assert.strictEqual(normalizeCodecPref(c), c);
for (const c of [undefined, null, 'vp10', 'H264', 7, {}]) assert.strictEqual(normalizeCodecPref(c), 'auto');

// ---- unknown decoders (old phone): exactly as before, never VP9 / AV1
for (const dec of [null, undefined]) {
  eq(codecOrder('auto', dec), ['h264', 'vp8']);
  eq(codecOrder('h264', dec), ['h264', 'vp8']);
  eq(codecOrder('vp8', dec), ['vp8', 'h264']);
  eq(codecOrder('vp9', dec), ['h264', 'vp8'], 'vp9 chosen but the phone is unknown: no VP9');
  eq(codecOrder('av1', dec), ['h264', 'vp8'], 'av1 chosen but the phone is unknown: no AV1');
  eq(codecOrder('bogus', dec), ['h264', 'vp8']);
}

// ---- phone decodes everything
eq(codecOrder('auto', ALL), ['h264', 'vp8'], 'auto never picks VP9 / AV1 by itself');
eq(codecOrder('h264', ALL), ['h264', 'vp8']);
eq(codecOrder('vp8', ALL), ['vp8', 'h264']);
eq(codecOrder('vp9', ALL), ['vp9', 'h264', 'vp8']);
eq(codecOrder('av1', ALL), ['av1', 'h264', 'vp8']);

// ---- the list is limited to what the phone decodes
eq(codecOrder('vp9', ['h264', 'vp8', 'vp9']), ['vp9', 'h264', 'vp8']);
eq(codecOrder('vp9', ['vp9', 'vp8']), ['vp9', 'vp8'], 'no H.264 decoder: VP9 then VP8');
eq(codecOrder('vp9', ['vp9']), ['vp9']);
eq(codecOrder('av1', ['av1', 'h264']), ['av1', 'h264']);
eq(codecOrder('vp9', ['h264', 'vp8']), ['h264', 'vp8'], 'pref not supported by the phone: silent fallback to auto order');
eq(codecOrder('av1', ['h264', 'vp8', 'vp9']), ['h264', 'vp8'], 'AV1 asked, only VP9 decodes: still no AV1');
eq(codecOrder('av1', ['vp8']), ['vp8']);
eq(codecOrder('auto', ['vp8']), ['vp8'], 'phone without H.264: VP8 only');
eq(codecOrder('h264', ['vp8', 'vp9']), ['vp8'], 'H.264 asked but not decodable');
eq(codecOrder('vp8', ['h264']), ['h264']);
eq(codecOrder('auto', ['vp9', 'av1']), ['h264', 'vp8'], 'nothing usable left: legacy order rather than an empty offer');
eq(codecOrder('vp9', []), ['h264', 'vp8'], 'empty list = unknown');

// every combination: a non-empty, duplicate-free list of known names; VP9 / AV1 only when asked AND decodable
const subsets = [];
for (let m = 1; m < 16; m++) subsets.push(ALL.filter((_, i) => m & (1 << i)));
for (const pref of [...CODEC_PREFS, 'junk']) {
  for (const dec of [null, ...subsets]) {
    const o = codecOrder(pref, dec);
    const label = `${pref} ${dec}`;
    assert.ok(o.length > 0 && new Set(o).size === o.length && o.every((c) => ALL.includes(c)), label);
    for (const c of ['vp9', 'av1']) {
      if (o.includes(c)) assert.ok(pref === c && dec && dec.includes(c), `${c} only on explicit opt-in the phone can decode (${label})`);
    }
    // limited to the phone's decoders, unless it has neither H.264 nor VP8 (then the legacy order, as today)
    if (dec && !(dec.includes('h264') || dec.includes('vp8') || dec.includes(pref))) eq(o, pref === 'vp8' ? ['vp8', 'h264'] : ['h264', 'vp8'], label);
    else if (dec) assert.ok(o.every((c) => dec.includes(c)), label);
    if ((pref === 'vp9' || pref === 'av1') && dec && dec.includes(pref)) assert.strictEqual(o[0], pref, label);
  }
}

// ---- store: a hand-edited codec value cannot reach the engine
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-codec-'));
try {
  for (const [stored, want] of [['vp9', 'vp9'], ['av1', 'av1'], ['vp8', 'vp8'], ['h264', 'h264'], ['auto', 'auto'], ['hevc', 'auto'], [7, 'auto'], [undefined, 'auto']]) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(stored === undefined ? {} : { codec: stored }));
    assert.strictEqual(new Store(dir, { safeStorage: null }).get('codec'), want, String(stored));
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// ---- engine.js codecPreferences with fake capabilities (as Chromium lists them)
const cap = (mimeType, sdpFmtpLine) => (sdpFmtpLine === undefined ? { mimeType, clockRate: 90000 } : { mimeType, clockRate: 90000, sdpFmtpLine });
const CAPS = [
  cap('video/VP8'),
  cap('video/rtx', 'apt=96'),
  cap('video/VP9', 'profile-id=0'), cap('video/VP9', 'profile-id=2'),
  cap('video/AV1', 'level-idx=5;profile=0;tier=0'),
  cap('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'),
  cap('video/H264', 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f'),
  cap('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f'),
  cap('video/rtx', 'apt=97'),
  cap('video/red'), cap('video/ulpfec'),
];
function loadEngine(caps) {
  const sandbox = {
    console, setTimeout, clearTimeout,
    window: { engineBridge: { emit() {}, onCmd() {} } },
    navigator: {}, document: { getElementById: () => ({}) },
    RTCRtpSender: { getCapabilities: () => ({ codecs: caps }) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'adaptation.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'engine.js'), 'utf8'), sandbox);
  return sandbox.codecPreferences;
}
const codecPreferences = loadEngine(CAPS);
const names = (list) => Array.from(list, (c) => {
  const id = /profile-(?:level-)?id=(\w+)/.exec(c.sdpFmtpLine || '');
  return c.mimeType.replace('video/', '').toLowerCase() + (id ? ':' + id[1] : '');
});
const run = (pref, dec) => names(codecPreferences(pref, dec, codecOrder(pref, dec)));
const H = ['h264:42e01f', 'h264:640c1f'];

eq(run('auto', null), [...H, 'vp8', 'rtx', 'rtx'], 'unchanged for an old phone; packetization-mode 0 dropped');
eq(run('vp8', null), ['vp8', ...H, 'rtx', 'rtx'], 'vp8 first');
eq(run('vp9', null), [...H, 'vp8', 'rtx', 'rtx'], 'never VP9 to an unknown phone');
eq(run('av1', null), [...H, 'vp8', 'rtx', 'rtx']);
eq(run('vp9', ALL), ['vp9:0', ...H, 'vp8', 'rtx', 'rtx'], 'VP9 profile 0 only, rtx after the codecs');
eq(run('av1', ALL), ['av1', ...H, 'vp8', 'rtx', 'rtx']);
eq(run('auto', ALL), [...H, 'vp8', 'rtx', 'rtx'], 'auto never offers VP9 / AV1');
eq(run('vp9', ['h264', 'vp8']), [...H, 'vp8', 'rtx', 'rtx'], 'phone cannot decode VP9: fallback');
eq(run('vp9', ['vp9', 'vp8']), ['vp9:0', 'vp8', 'rtx', 'rtx']);
// the engine alone also refuses VP9 / AV1 for an unknown phone or one that did not list them, whatever `order` says
eq(names(codecPreferences('vp9', null, ['vp9', 'h264', 'vp8'])), [...H, 'vp8', 'rtx', 'rtx']);
eq(names(codecPreferences('av1', ['h264', 'vp8'], ['av1', 'h264'])), [...H, 'rtx', 'rtx']);
// an old host build sends no order: today's behaviour
eq(names(codecPreferences('vp8')), ['vp8', ...H, 'rtx', 'rtx']);
eq(names(codecPreferences('auto')), [...H, 'vp8', 'rtx', 'rtx']);
// this Chromium cannot encode AV1: the list falls through to H.264 / VP8
const noAv1 = loadEngine(CAPS.filter((c) => !/av1/i.test(c.mimeType)));
eq(names(noAv1('av1', ALL, codecOrder('av1', ALL))), [...H, 'vp8', 'rtx', 'rtx']);
// nothing usable at all: the full capability list rather than an empty (invalid) one
eq(loadEngine([cap('video/red')])('auto', null, ['h264', 'vp8']).length, 1);

console.log('ok codecs');
