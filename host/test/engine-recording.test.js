'use strict';
// The recording block of renderer/engine.js, loaded in a vm with a fake WebRTC stack and a fake MediaRecorder:
// starts when the channel opens (or on `rec`), mime fallback, 2 s slices at 4 Mbit/s, chunks carry the segment number,
// dropping when the main process does not acknowledge, restart on a monitor switch, and that no failure reaches the stream.
// Run: node host/test/engine-recording.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load({ supported = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'], throwOnCreate = false } = {}) {
  const events = [];
  const handlers = [];
  const recorders = [];
  const tracks = [];
  const mkTrack = (kind) => { const t = { kind, readyState: 'live', contentHint: '', getSettings: () => ({ height: 1080, width: 1920 }), applyConstraints: async () => {}, stop() { this.readyState = 'ended'; } }; tracks.push(t); return t; };
  const mkStream = (audio) => { const v = mkTrack('video'); const a = audio ? mkTrack('audio') : null; return { getVideoTracks: () => [v], getAudioTracks: () => (a ? [a] : []), getTracks: () => (a ? [v, a] : [v]) }; };
  let withAudio = false;
  const dcs = [];
  const sender = { track: null, getParameters: () => ({}), setParameters: async () => {}, replaceTrack: async (t) => { sender.track = t; } };
  class FakePC {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'new'; }
    addTransceiver(t) { if (t.kind === 'video') sender.track = t; return { sender, setCodecPreferences() {} }; }
    createDataChannel(label) {
      const l = {};
      const dc = { label, readyState: 'connecting', close() {}, addEventListener: (n, f) => { (l[n] = l[n] || []).push(f); }, open() { dc.readyState = 'open'; (l.open || []).forEach((f) => f()); } };
      if (label === 'ctl') dcs.push(dc);
      return dc;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription() { this.localDescription = { sdp: 'v=0' }; }
    addEventListener() {} removeEventListener() {}
    close() {}
  }
  class FakeMediaRecorder {
    static isTypeSupported(m) { return supported.includes(m); }
    constructor(stream, opts) {
      if (throwOnCreate) throw new Error('no recorder here');
      this.stream = stream; this.opts = opts; this.state = 'inactive'; recorders.push(this);
    }
    start(slice) { this.slice = slice; this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    data(size, bytes = [1, 2, 3]) { this.ondataavailable({ data: { size, arrayBuffer: async () => new Uint8Array(bytes).buffer } }); }
  }
  const sandbox = {
    console: { log() {}, warn() {}, error: console.error },
    window: { engineBridge: { emit: (o) => events.push(o), onCmd: (fn) => handlers.push(fn) } },
    navigator: { mediaDevices: { getUserMedia: async () => { const s = mkStream(withAudio); return s; } } },
    RTCPeerConnection: FakePC, RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
    PhoneCam: { attach() {}, detach() {}, async handle() {} }, // the phone camera panel (phonecam.js) has its own test
    MediaRecorder: FakeMediaRecorder, MediaStream: class { constructor(t) { this.tracks = t; } },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, document: { getElementById: () => ({}) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'adaptation.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'engine.js'), 'utf8'), sandbox);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    events, recorders, tracks, dcs, settle,
    setAudio: (v) => { withAudio = v; },
    cmd: async (c) => { handlers.forEach((h) => h(c)); await settle(); },
    start: (extra = {}) => ({ t: 'start', sid: 's1', sourceId: 'x', iceServers: [], preset: 'auto', fps: 24, bitrate: 6e6, height: 1080, contentHint: 'motion', ...extra }),
    chunks: () => events.filter((e) => e.t === 'rec-chunk'),
  };
}

(async () => {
  // ---- record:true: nothing before the channel is open, then a recorder with the agreed settings
  {
    const e = load();
    e.setAudio(true);
    await e.cmd(e.start({ record: true, audio: true }));
    assert.strictEqual(e.recorders.length, 0, 'not before the channel is open');
    e.dcs[0].open();
    assert.strictEqual(e.recorders.length, 1);
    const r = e.recorders[0];
    assert.strictEqual(r.opts.mimeType, 'video/webm;codecs=vp9,opus');
    assert.strictEqual(r.opts.videoBitsPerSecond, 4_000_000);
    assert.strictEqual(r.slice, 2000);
    assert.strictEqual(r.stream.tracks.length, 2, 'screen and audio');
    // a chunk crosses as bytes, with the segment number
    r.data(3, [7, 8, 9]);
    await e.settle();
    const c = e.chunks();
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].sid, 's1'); assert.strictEqual(c[0].seg, 1);
    assert.deepStrictEqual([...c[0].data], [7, 8, 9]);
    assert.strictEqual(c[0].data.constructor.name, 'Uint8Array');
    // the host stopping the recording and the session end both stop the recorder
    await e.cmd({ t: 'rec', sid: 's1', on: false });
    assert.strictEqual(r.state, 'inactive');
    await e.cmd({ t: 'rec', sid: 's1', on: true });
    assert.strictEqual(e.recorders.length, 2);
    await e.cmd({ t: 'stop', sid: 's1' });
    assert.strictEqual(e.recorders[1].state, 'inactive');
    e.recorders[1].data(3); await e.settle();
    assert.strictEqual(e.chunks().length, 1, 'nothing is sent after the session ended');
  }
  // ---- record absent / false: no recorder until the host asks
  {
    const e = load();
    await e.cmd(e.start());
    e.dcs[0].open();
    assert.strictEqual(e.recorders.length, 0);
    await e.cmd({ t: 'rec', sid: 'other', on: true });
    assert.strictEqual(e.recorders.length, 0, 'another session id is ignored');
    await e.cmd({ t: 'rec', sid: 's1', on: true });
    assert.strictEqual(e.recorders.length, 1);
    await e.cmd({ t: 'rec', sid: 's1', on: true });
    assert.strictEqual(e.recorders.length, 1, 'already recording: no second recorder');
    assert.strictEqual(e.recorders[0].stream.tracks.length, 1, 'video only without shared audio');
  }
  // ---- mime fallback: vp8, then plain webm, then the browser's default
  for (const [supported, want] of [[['video/webm;codecs=vp8,opus', 'video/webm'], 'video/webm;codecs=vp8,opus'], [['video/webm'], 'video/webm'], [[], undefined]]) {
    const e = load({ supported });
    await e.cmd(e.start({ record: true }));
    e.dcs[0].open();
    assert.strictEqual(e.recorders[0].opts.mimeType, want);
  }
  // ---- backpressure: chunks the main process has not acknowledged are dropped past the cap, acks free the room
  {
    const e = load();
    await e.cmd(e.start({ record: true }));
    e.dcs[0].open();
    const r = e.recorders[0];
    const MB = 1024 * 1024;
    r.data(20 * MB); r.data(10 * MB); await e.settle();
    assert.strictEqual(e.chunks().length, 2);
    r.data(10 * MB); await e.settle(); // 40 MB outstanding > 32 MB cap
    assert.strictEqual(e.chunks().length, 2, 'dropped');
    assert.ok(e.events.some((x) => x.t === 'log' && /dropped/.test(x.message)));
    await e.cmd({ t: 'rec-ack', sid: 's1', n: 20 * MB });
    r.data(10 * MB); await e.settle();
    assert.strictEqual(e.chunks().length, 3, 'acknowledged bytes free the queue');
    assert.ok(!e.events.some((x) => x.t === 'error'), 'the live session saw no error');
  }
  // ---- a monitor switch restarts the recorder on the new picture with the next segment number
  {
    const e = load();
    e.setAudio(true);
    await e.cmd(e.start({ record: true, audio: true }));
    e.dcs[0].open();
    const first = e.recorders[0];
    first.data(3); await e.settle();
    await e.cmd({ t: 'switch', sid: 's1', monitorId: 2, sourceId: 'y' });
    assert.strictEqual(first.state, 'inactive');
    assert.strictEqual(e.recorders.length, 2);
    const second = e.recorders[1];
    assert.strictEqual(second.state, 'recording');
    assert.strictEqual(second.stream.tracks.length, 2, 'new video track plus the running audio track');
    first.data(3); second.data(3); await e.settle(); // the old recorder's last chunk may arrive late
    assert.deepStrictEqual(e.chunks().map((c) => c.seg), [1, 1, 2]);
    assert.ok(e.events.some((x) => x.t === 'switched'));
  }
  // ---- a switch while not recording does not start recording
  {
    const e = load();
    await e.cmd(e.start());
    e.dcs[0].open();
    await e.cmd({ t: 'switch', sid: 's1', monitorId: 2, sourceId: 'y' });
    assert.strictEqual(e.recorders.length, 0);
  }
  // ---- a recorder that cannot be created is reported (rec-stop), never as an engine error, and the offer still goes out
  {
    const e = load({ throwOnCreate: true });
    await e.cmd(e.start({ record: true }));
    assert.ok(e.events.some((x) => x.t === 'offer'));
    e.dcs[0].open();
    assert.ok(e.events.some((x) => x.t === 'rec-stop' && x.sid === 's1'));
    assert.ok(!e.events.some((x) => x.t === 'error'));
  }
  console.log('engine recording tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
