'use strict';
// Loads the real renderer/engine.js (plus ../src/adaptation.js, as engine.html does) in a vm with a fake WebRTC
// stack and checks how modes and adaptation reach setParameters / the stats event.
// Run: node host/test/engine-adaptation.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'engine.html'), 'utf8');
assert.ok(/script-src 'self'/.test(html), 'CSP kept');
assert.ok(/<script src="\.\.\/src\/adaptation\.js"><\/script><script src="engine\.js">/.test(html), 'adaptation.js loaded before engine.js');

const events = [];
let cmdHandler = null;
const timers = [];
let params = null; // what the sender currently has
const setCalls = [];
let statsReport = null;

const track = {
  contentHint: '',
  getSettings: () => ({ height: 1440, width: 2560 }),
  applyConstraints: async () => {},
  stop() {},
};
const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
const sender = {
  track,
  getParameters: () => JSON.parse(JSON.stringify(params || {})),
  setParameters: async (p) => { params = JSON.parse(JSON.stringify(p)); setCalls.push(params); },
};
class FakePC {
  constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'new'; FakePC.last = this; }
  addTransceiver() { return { sender, setCodecPreferences() {} }; }
  createDataChannel() { return { close() {}, readyState: 'open' }; }
  async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
  async setLocalDescription() { this.localDescription = { sdp: 'v=0' }; }
  async getStats() {
    const m = new Map(statsReport.map((r) => [r.id, r]));
    m.forEach = Map.prototype.forEach.bind(m);
    return m;
  }
  addEventListener() {} removeEventListener() {}
  close() {}
}
FakePC.last = null;

const sandbox = {
  console,
  window: { engineBridge: { emit: (o) => events.push(o), onCmd: (fn) => { cmdHandler = fn; } } },
  navigator: { mediaDevices: { getUserMedia: async () => stream } },
  RTCPeerConnection: FakePC,
  RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
  setInterval: (fn) => { timers.push(fn); return timers.length; },
  clearInterval: () => {},
  setTimeout, clearTimeout,
  document: { getElementById: () => ({}) },
  PhoneCam: { attach() {}, detach() {}, async handle() {} }, // the phone camera panel (phonecam.js) has its own test
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'adaptation.js'), 'utf8'), sandbox);
assert.ok(sandbox.Adaptation && typeof sandbox.Adaptation.create === 'function', 'Adaptation global in the renderer');
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'engine.js'), 'utf8'), sandbox);
assert.ok(events.some((e) => e.t === 'ready'));

const cmd = (c) => { cmdHandler(c); };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const lastStats = () => events.filter((e) => e.t === 'stats').pop();
async function tick(report) {
  statsReport = report;
  await timers[timers.length - 1]();
  await settle();
}
const rep = (reason, rttSec, bytes, ts) => [
  { id: 'o', type: 'outbound-rtp', kind: 'video', qualityLimitationReason: reason, bytesSent: bytes, timestamp: ts, framesPerSecond: 24, frameWidth: 1920, frameHeight: 1080 },
  { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
  { id: 'p', type: 'candidate-pair', currentRoundTripTime: rttSec, localCandidateId: 'l', remoteCandidateId: 'r' },
  { id: 'l', type: 'local-candidate', candidateType: 'host' },
  { id: 'r', type: 'remote-candidate', candidateType: 'host' },
];

(async () => {
  cmd({ t: 'start', sid: 's1', sourceId: 'x', iceServers: [], preset: 'auto', fps: 24, bitrate: 6_000_000, height: 1080, contentHint: 'motion' });
  await settle();
  assert.ok(events.some((e) => e.t === 'offer'), 'offer produced');
  // initial parameters: preset ceiling, auto mode
  let p = params;
  assert.strictEqual(p.encodings[0].maxBitrate, 6_000_000);
  assert.strictEqual(p.encodings[0].scaleResolutionDownBy, 1440 / 1080);
  assert.strictEqual(p.degradationPreference, 'maintain-framerate');
  assert.strictEqual(track.contentHint, 'motion');

  // the connection comes up: stats loop starts, and the stats event reports the mode
  FakePC.last.connectionState = 'connected';
  FakePC.last.onconnectionstatechange();
  await settle();
  let ts = 1000, bytes = 0;
  await tick(rep('none', 0.03, bytes += 1e6, ts += 2000));
  assert.strictEqual(lastStats().mode, 'auto');
  assert.strictEqual(lastStats().adapt, 0);
  // the first 6 samples are the warm-up: a fresh connection's bandwidth ramp is not congestion
  for (let i = 0; i < 5; i++) await tick(rep('none', 0.03, bytes += 1e6, ts += 2000));
  const calls0 = setCalls.length;

  // two bandwidth-limited samples in auto: one step down through setParameters, no renegotiation
  await tick(rep('bandwidth', 0.05, bytes += 1e5, ts += 2000));
  assert.strictEqual(setCalls.length, calls0, 'one bad sample does nothing');
  await tick(rep('bandwidth', 0.05, bytes += 1e5, ts += 2000));
  assert.strictEqual(setCalls.length, calls0 + 1);
  p = params;
  assert.strictEqual(p.encodings[0].scaleResolutionDownBy, (1440 / 1080) * 1.5);
  assert.strictEqual(p.encodings[0].maxBitrate, 4_000_000);
  assert.strictEqual(lastStats().adapt, 1);

  // high RTT counts, and six clean samples climb back
  for (let i = 0; i < 6; i++) await tick(rep('none', 0.03, bytes += 1e6, ts += 2000));
  assert.strictEqual(params.encodings[0].maxBitrate, 6_000_000);
  assert.strictEqual(lastStats().adapt, 0);

  // latency mode: one bad sample steps down, hint motion, maintain-framerate
  cmd({ t: 'quality', sid: 's1', preset: 'auto', fps: 24, bitrate: 6_000_000, height: 1080, contentHint: 'detail', mode: 'latency' });
  await settle();
  assert.strictEqual(params.degradationPreference, 'maintain-framerate');
  assert.strictEqual(track.contentHint, 'motion', 'latency forces the motion hint');
  await tick(rep('none', 0.4, bytes += 1e5, ts += 2000)); // 400 ms RTT
  assert.strictEqual(lastStats().mode, 'latency');
  assert.strictEqual(lastStats().adapt, 1);

  // clarity: maintain-resolution, detail hint, resolution stays at the preset, bitrate / fps give way
  cmd({ t: 'quality', sid: 's1', preset: 'auto', fps: 60, bitrate: 8_400_000, height: 1080, mode: 'clarity' });
  await settle();
  assert.strictEqual(params.degradationPreference, 'maintain-resolution');
  assert.strictEqual(track.contentHint, 'detail');
  assert.strictEqual(params.encodings[0].scaleResolutionDownBy, 1440 / 1080);
  for (let i = 0; i < 12; i++) await tick(rep('bandwidth', 0.05, bytes += 1e5, ts += 2000));
  assert.strictEqual(params.encodings[0].scaleResolutionDownBy, 1440 / 1080, 'clarity keeps the preset resolution');
  assert.ok(params.encodings[0].maxBitrate < 8_400_000);
  assert.ok(params.encodings[0].maxFramerate < 60);
  assert.strictEqual(lastStats().mode, 'clarity');

  // a later quality message without mode keeps the mode; an unknown mode falls back to auto
  cmd({ t: 'quality', sid: 's1', preset: 'balanced', fps: 24, bitrate: 3_000_000, height: 720 });
  await settle();
  assert.strictEqual(params.degradationPreference, 'maintain-resolution');
  cmd({ t: 'quality', sid: 's1', preset: 'balanced', fps: 24, bitrate: 3_000_000, height: 720, mode: 'turbo' });
  await settle();
  assert.strictEqual(params.degradationPreference, 'maintain-framerate');
  await tick(rep('none', 0.03, bytes += 1e6, ts += 2000));
  assert.strictEqual(lastStats().mode, 'auto');
  assert.strictEqual(params.encodings[0].maxBitrate, 3_000_000);

  // no errors were reported by the engine
  assert.deepStrictEqual(events.filter((e) => e.t === 'error'), []);
  console.log('ok engine-adaptation');
})().catch((e) => { console.error(e); process.exit(1); });
