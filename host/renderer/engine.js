'use strict';
// Hidden-window WebRTC engine. Chromium does capture + (hardware where available) encode + DTLS-SRTP.
// The main process owns signaling, input injection and pairing; this file only owns the peer connection.
// A small "viewer" role is included so the host can self-test the whole protocol without a phone.
const bridge = window.engineBridge;
// `Adaptation` (bandwidth adaptation + delivery modes) comes from ../src/adaptation.js, loaded by engine.html.
const DEFAULT_FPS = 24;
// Fallback table; the host (src/media.js) normally sends the resolved fps / bitrate / height / contentHint.
const QUALITY = {
  auto: { bitrate: 6_000_000, height: 1080 },
  low: { bitrate: 1_200_000, height: 540 },
  balanced: { bitrate: 3_000_000, height: 720 },
  high: { bitrate: 9_000_000, height: 1440 },
};
const GATHER_TIMEOUT_MS = 4000;

let host = null; // {sid, pc, dc, sender, stream, audioTrack, q, statsTimer, lastBytes, lastT}
let viewer = null; // self-test only

const emit = (o) => bridge.emit(o);

/** Effective settings from a start / quality command: fps per session, never a module constant. */
function adaptConfig(q) {
  return { mode: q.mode, maxBitrate: q.bitrate, maxHeight: q.height, fps: q.fps };
}

function resolve(cmd, prevMode) {
  const preset = QUALITY[cmd.preset || cmd.quality] ? (cmd.preset || cmd.quality) : 'auto';
  const base = QUALITY[preset];
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const saver = cmd.saver === true;
  const fps = num(cmd.fps, saver ? 15 : DEFAULT_FPS);
  const mode = Adaptation.normalizeMode(cmd.mode, prevMode);
  return {
    preset, saver, fps, mode,
    bitrate: num(cmd.bitrate, Math.round(base.bitrate * (saver ? 0.5 : 1))),
    height: num(cmd.height, base.height),
    // 'motion' keeps the frame rate and lets resolution give way under congestion; 'detail' does the opposite
    // latency / clarity modes force the hint; auto keeps the preset's own
    contentHint: Adaptation.modeSettings(mode).contentHint
      || (cmd.contentHint === 'detail' || cmd.contentHint === 'motion' ? cmd.contentHint : (saver || fps < 24 ? 'detail' : 'motion')),
  };
}

/**
 * Screen capture. With wantAudio the same getUserMedia call also asks for Windows loopback (system) audio;
 * if that is refused the video-only capture is used and the failure is logged. Returns {stream, audioTrack}.
 */
async function capture(sourceId, q, wantAudio) {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
      maxFrameRate: q.fps, maxWidth: 2560, maxHeight: 1440,
    },
  };
  let stream = null;
  let audioTrack = null;
  if (wantAudio) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
      audioTrack = stream.getAudioTracks()[0] || null;
      if (!audioTrack) emit({ t: 'log', message: 'audio capture returned no audio track; sending video only' });
    } catch (e) {
      stream = null;
      emit({ t: 'log', message: 'audio capture failed, sending video only: ' + String(e && e.message || e) });
    }
  }
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  stream.getVideoTracks()[0].contentHint = q.contentHint;
  return { stream, audioTrack };
}

function waitGathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', on); resolve(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', on);
  });
}

function opusPreferences() {
  const all = RTCRtpSender.getCapabilities('audio').codecs;
  const opus = all.filter((c) => /opus/i.test(c.mimeType));
  return opus.length ? opus : all;
}

/**
 * Codec list for setCodecPreferences. `order` is the host's decision (src/media.js codecOrder: names in offer order,
 * already limited to what the phone can decode; it arrives in the `start` command like the other media.js numbers).
 * Without it (an old host build or a self-test) the order is H.264 then VP8, VP8 first when pref is 'vp8'. `decoders`
 * (the phone's decoder names, or null when unknown) is applied again here as a safety net: VP9 / AV1 are never
 * offered to a phone that did not say it can decode them. rtx entries follow the codecs. A codec this Chromium cannot
 * encode is skipped, so the list falls through to H.264 / VP8 on its own.
 */
function codecPreferences(pref, decoders, order) {
  const all = RTCRtpSender.getCapabilities('video').codecs;
  const known = Array.isArray(decoders) && decoders.length > 0;
  const byName = {
    h264: all.filter((c) => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || '')),
    vp8: all.filter((c) => /vp8/i.test(c.mimeType)),
    // 8-bit 4:2:0 screen capture: VP9 profile 0 only (profile 2 is 10-bit and only makes the offer larger)
    vp9: all.filter((c) => /vp9/i.test(c.mimeType) && !/profile-id=(?!0(?:;|$))/.test(c.sdpFmtpLine || '')),
    av1: all.filter((c) => /av1/i.test(c.mimeType)),
  };
  const rtx = all.filter((c) => /rtx/i.test(c.mimeType));
  const names = (Array.isArray(order) && order.length ? order : (pref === 'vp8' ? ['vp8', 'h264'] : ['h264', 'vp8']))
    .filter((n) => Object.prototype.hasOwnProperty.call(byName, n) && (known ? decoders.includes(n) : n === 'h264' || n === 'vp8'));
  const list = [...new Set(names)].flatMap((n) => byName[n]);
  return list.length ? [...list, ...rtx] : all;
}

async function applyQuality() {
  if (!host?.sender) return;
  const q = host.q;
  const track = host.sender.track;
  if (track) {
    track.contentHint = q.contentHint;
    // Best effort: the encoder's maxFramerate below is what actually limits the rate.
    if (host.capFps !== q.fps) {
      try { await track.applyConstraints({ frameRate: { max: q.fps } }); host.capFps = q.fps; } catch (err) { console.warn('frameRate constraint', err); }
    }
  }
  const srcH = track?.getSettings().height || q.height;
  const p = host.sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  const e = p.encodings[0];
  // The preset gives the ceiling; the adaptation lowers it (smaller picture, bitrate, in clarity mode fps) under congestion.
  const ad = host.adapt.current();
  e.maxBitrate = Math.min(q.bitrate, ad.maxBitrate);
  e.maxFramerate = ad.maxFramerate ? Math.min(q.fps, ad.maxFramerate) : q.fps;
  e.scaleResolutionDownBy = Math.max(1, srcH / q.height) * ad.scaleDownBy;
  p.degradationPreference = Adaptation.modeSettings(q.mode).degradationPreference;
  try { await host.sender.setParameters(p); } catch (err) { console.warn('setParameters', err); }
}

async function hostStart(cmd) {
  hostStop();
  const q = resolve(cmd);
  const { stream, audioTrack } = await capture(cmd.sourceId, q, cmd.audio === true);
  const pc = new RTCPeerConnection({ iceServers: cmd.iceServers, bundlePolicy: 'max-bundle' });
  const s = { sid: cmd.sid, pc, stream, audioTrack, q, adapt: Adaptation.create({ ...adaptConfig(q), warmup: 6 }), capFps: q.fps, dc: null, sender: null };
  host = s;
  const tr = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
  s.sender = tr.sender;
  try { tr.setCodecPreferences(codecPreferences(cmd.codec, cmd.decoders, cmd.codecOrder)); } catch (e) { console.warn('codec prefs', e); }
  if (audioTrack) {
    const at = pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });
    try { at.setCodecPreferences(opusPreferences()); } catch (e) { console.warn('opus prefs', e); }
  }
  // <phonecam> the phone's camera / microphone arrive through renegotiations the phone starts (phonecam.js)
  PhoneCam.attach(pc, s.sid);
  // </phonecam>

  const dc = pc.createDataChannel('ctl', { ordered: true });
  s.dc = dc;
  recInit(s, cmd, dc); // session recording: block "session recording" near the end of this file
  dc.onopen =() => emit({ t: 'dc-open', sid: s.sid });
  dc.onclose = () => emit({ t: 'dc-close', sid: s.sid });
  dc.onmessage = (e) => emit({ t: 'ctl', sid: s.sid, data: String(e.data) });
  // File transfer from the phone: its own reliable channel, so megabytes of chunks never queue behind input.
  // Text frames are begin / end, binary frames are file bytes; the main process (src/files.js) writes them to disk.
  const fdc = pc.createDataChannel('files', { ordered: true });
  fdc.binaryType = 'arraybuffer';
  s.fdc = fdc;
  fdc.onmessage = (e) => {
    if (typeof e.data === 'string') emit({ t: 'files', sid: s.sid, data: e.data });
    else emit({ t: 'files-bin', sid: s.sid, data: new Uint8Array(e.data) });
  };
  fdc.onclose = () => emit({ t: 'files-close', sid: s.sid });
  pc.onconnectionstatechange = () => {
    emit({ t: 'state', sid: s.sid, state: pc.connectionState });
    if (pc.connectionState === 'connected') { applyQuality(); startStats(s); }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await applyQuality();
  await waitGathered(pc);
  emit({ t: 'offer', sid: s.sid, sdp: pc.localDescription.sdp, audio: !!audioTrack });
}

async function hostAnswer(cmd) {
  if (!host || host.sid !== cmd.sid) return;
  await host.pc.setRemoteDescription({ type: 'answer', sdp: cmd.sdp });
}

async function hostSwitch(cmd) {
  const s = host;
  if (!s || s.sid !== cmd.sid) return;
  const { stream } = await capture(cmd.sourceId, s.q, false); // audio is system-wide: the running audio track stays
  if (host !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
  const old = s.stream;
  await s.sender.replaceTrack(stream.getVideoTracks()[0]);
  s.stream = stream;
  recRestart(s); // session recording: the file keeps going on the new picture (next segment)
  s.capFps = s.q.fps; // the new capture was opened with the current fps
  old.getVideoTracks().forEach((t) => t.stop()); // not getTracks(): that would also stop the audio track
  await applyQuality();
  const st = stream.getVideoTracks()[0].getSettings();
  // kind / id echo the command so the host can tell a window switch from a monitor switch (window sources have no monitorId)
  emit({ t: 'switched', sid: s.sid, monitorId: cmd.monitorId, kind: cmd.kind || 'monitor', id: cmd.id, w: st.width, h: st.height });
}

function hostSend(cmd) {
  if (host?.dc?.readyState === 'open') host.dc.send(cmd.data);
}

function hostStop(sid) {
  if (!host || (sid && host.sid !== sid)) return;
  PhoneCam.detach(); // <phonecam>
  clearInterval(host.statsTimer);
  recStop(host); // session recording
  try { host.dc?.close(); } catch { /* ignore */ }
  try { host.fdc?.close(); } catch { /* ignore */ }
  try { host.pc.close(); } catch { /* ignore */ }
  host.stream.getTracks().forEach((t) => t.stop());
  host.audioTrack?.stop();
  host = null;
}

function startStats(s) {
  clearInterval(s.statsTimer);
  s.lastBytes = 0; s.lastT = 0;
  s.statsTimer = setInterval(async () => {
    if (host !== s) return;
    let report;
    try { report = await s.pc.getStats(); } catch { return; } // closed meanwhile
    let out = null, pair = null, local = null, remote = null, codec = null;
    const byId = {};
    report.forEach((r) => { byId[r.id] = r; });
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId[r.selectedCandidatePairId];
    });
    if (pair) { local = byId[pair.localCandidateId]; remote = byId[pair.remoteCandidateId]; }
    if (out?.codecId) codec = byId[out.codecId]?.mimeType;
    if (!out) return;
    const rttMs = Number.isFinite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null;
    const kbps = s.lastT ? Math.round(((out.bytesSent - s.lastBytes) * 8) / ((out.timestamp - s.lastT))) : 0;
    s.lastBytes = out.bytesSent; s.lastT = out.timestamp;
    const ad = s.adapt.sample({ qualityLimitationReason: out.qualityLimitationReason, rttMs, bitrateKbps: kbps, fps: out.framesPerSecond || 0 });
    if (ad.changed) applyQuality(); // setParameters only, no renegotiation
    emit({
      t: 'stats', sid: s.sid,
      fps: Math.round(out.framesPerSecond || 0), w: out.frameWidth, h: out.frameHeight, kbps,
      codec, encoder: out.encoderImplementation, rtt: pair?.currentRoundTripTime ?? null,
      path: local ? (remote?.candidateType === 'relay' ? 'relay' : local.candidateType) : null, limit: out.qualityLimitationReason,
      mode: s.q.mode, adapt: ad.level, // active delivery mode; adaptation step (0 = preset ceiling)
    });
  }, 2000);
}

// ---------------------------------------------------------------- viewer (self-test only)

async function viewerStart(cmd) {
  viewerStop();
  const pc = new RTCPeerConnection({ iceServers: cmd.iceServers });
  const v = { pc, dc: null, msgs: 0 };
  viewer = v;
  pc.ondatachannel = (e) => {
    if (e.channel.label !== 'ctl') return; // the `files` channel is not part of the self-test
    v.dc = e.channel;
    v.dc.onmessage = (m) => emit({ t: 'v-ctl', data: String(m.data) });
    v.dc.onopen = () => emit({ t: 'v-open' });
  };
  pc.ontrack = (e) => {
    const sink = document.getElementById('sink');
    sink.srcObject = e.streams[0] || new MediaStream([e.track]);
    sink.play().catch(() => {});
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: cmd.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitGathered(pc);
  emit({ t: 'v-answer', sdp: pc.localDescription.sdp });
}

function viewerStop() {
  if (!viewer) return;
  try { viewer.pc.close(); } catch { /* ignore */ }
  viewer = null;
}

async function viewerStats() {
  if (!viewer) return emit({ t: 'v-stats', ok: false });
  const sink = document.getElementById('sink');
  const q = sink.getVideoPlaybackQuality ? sink.getVideoPlaybackQuality() : {};
  let inbound = null, codec = null;
  const report = await viewer.pc.getStats();
  report.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r; });
  if (inbound?.codecId) codec = report.get(inbound.codecId)?.mimeType;
  let blank = null;
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const g = c.getContext('2d');
    g.drawImage(sink, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; sum += l; min = Math.min(min, l); max = Math.max(max, l); }
    blank = { avg: Math.round(sum / (d.length / 4)), range: max - min };
  } catch { /* ignore */ }
  emit({
    t: 'v-stats', ok: true, frames: inbound?.framesDecoded || 0, decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames,
    w: inbound?.frameWidth, h: inbound?.frameHeight, codec, decoder: inbound?.decoderImplementation, blank,
  });
}

// ---------------------------------------------------------------- session recording (see src/recording.js, docs/PROTOCOL.md "Recording")
// Only runs when the PC owner switched "Record sessions on this PC" on: the `start` command carries record:true, or the
// host sends `rec` {on}. MediaRecorder records the captured screen (and the shared audio) next to the WebRTC sender, so
// the live stream is never touched: every step is in a try / catch, and when the main process lags (chunks not yet
// acknowledged with `rec-ack` pass REC_MAX_PENDING) chunks are dropped instead of queued. A monitor / window switch
// starts a new recorder on the new picture; its chunks carry the next `seg` number and the main process rolls to the
// next file. The final chunk of a recorder that is stopped with the session is not sent (the file is closed by then).
const REC_TIMESLICE_MS = 2000;
const REC_BITRATE = 4_000_000;
const REC_MAX_PENDING = 32 * 1024 * 1024;
const REC_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

function recMime() {
  for (const m of REC_MIMES) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* next */ } }
  return '';
}

function recInit(s, cmd, dc) {
  try {
    s.rec = { want: cmd.record === true, seg: 0, recorder: null, pending: 0, dropped: 0 };
    // "live" = the control channel is open
    dc.addEventListener?.('open', () => { if (host === s && s.rec?.want) recStart(s); });
  } catch (e) { console.warn('recording init', e); }
}

function recStart(s) {
  try {
    const r = s.rec;
    if (!r || r.recorder || host !== s) return;
    r.want = true;
    const vt = s.stream.getVideoTracks()[0];
    if (!vt || vt.readyState !== 'live') return;
    const tracks = [vt];
    if (s.audioTrack && s.audioTrack.readyState === 'live') tracks.push(s.audioTrack);
    const mimeType = recMime();
    const rec = new MediaRecorder(new MediaStream(tracks), { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: REC_BITRATE });
    const seg = ++r.seg;
    rec.ondataavailable = (ev) => { recChunk(s, seg, ev.data); };
    rec.onerror = () => recFail(s, 'recorder error');
    r.recorder = rec;
    rec.start(REC_TIMESLICE_MS);
  } catch (e) { recFail(s, e); }
}

async function recChunk(s, seg, blob) {
  const r = s.rec;
  try {
    if (host !== s || !r || !blob || blob.size === 0) return;
    if (r.pending + blob.size > REC_MAX_PENDING) { // the main process lags: drop, the live stream comes first
      if (++r.dropped === 1) emit({ t: 'log', message: 'recording: chunks are being dropped (the PC cannot write fast enough)' });
      return;
    }
    r.pending += blob.size; // counted before the await, so chunks that finish together are counted together
    const data = new Uint8Array(await blob.arrayBuffer()); // typed arrays cross the bridge like the file transfer's bytes
    if (host !== s) { r.pending = Math.max(0, r.pending - blob.size); return; }
    emit({ t: 'rec-chunk', sid: s.sid, seg, data });
  } catch (e) { recFail(s, e); }
}

/** Stops the recorder without telling anyone (session end, switch, or the host asked). */
function recStop(s) {
  try {
    const r = s?.rec;
    if (!r) return;
    r.want = false;
    const rec = r.recorder;
    r.recorder = null;
    if (rec && rec.state !== 'inactive') rec.stop(); // its last chunk still arrives (and is dropped if the session is over)
  } catch { /* the recorder is gone already */ }
}

function recRestart(s) {
  try {
    const r = s.rec;
    if (!r || !r.recorder) return;
    recStop(s);
    r.want = true;
    recStart(s);
  } catch (e) { recFail(s, e); }
}

/** Recording broke: stop it and tell the host (which tells the phone), the session goes on. */
function recFail(s, why) {
  try {
    recStop(s);
    emit({ t: 'log', message: 'recording stopped: ' + String(why && why.message || why) });
    emit({ t: 'rec-stop', sid: s.sid });
  } catch { /* nothing more to do */ }
}

// Handled here, next to the main command queue: acknowledgements must not wait behind a slow start or switch.
bridge.onCmd((cmd) => {
  try {
    const s = host;
    if (!s || !s.rec || cmd.sid !== s.sid) return;
    if (cmd.t === 'rec-ack') s.rec.pending = Math.max(0, s.rec.pending - (Number(cmd.n) || 0));
    else if (cmd.t === 'rec') {
      if (cmd.on === true) { s.rec.want = true; if (s.dc?.readyState === 'open') recStart(s); } else recStop(s);
    }
  } catch (e) { console.warn('recording command', e); }
});
// ---------------------------------------------------------------- end session recording

async function run(cmd) {
  try {
    switch (cmd.t) {
      case 'start': await hostStart(cmd); break;
      case 'answer': await hostAnswer(cmd); break;
      case 'switch': await hostSwitch(cmd); break;
      case 'send': hostSend(cmd); break;
      case 'quality':
        if (host) {
          host.q = resolve(cmd, host.q.mode);
          host.adapt.configure(adaptConfig(host.q)); // back to the ceiling only when mode / preset / fps changed
          await applyQuality();
        }
        break;
      case 'stop': hostStop(cmd.sid); break;
      case 'pm-offer': case 'pm-drop': await PhoneCam.handle(cmd); break; // <phonecam>
      case 'v-start': await viewerStart(cmd); break;
      case 'v-send': viewer?.dc?.send(cmd.data); break;
      case 'v-stats': await viewerStats(); break;
      case 'v-stop': viewerStop(); break;
      default: break;
    }
  } catch (e) {
    emit({ t: 'error', sid: cmd.sid || host?.sid, where: cmd.t, message: String(e && e.message || e) });
  }
}

// Commands run one at a time, in order. Run concurrently, a 'stop' arriving while 'start' awaits the capture
// found nothing to stop and the new session leaked, and two quick 'switch'es left a capture running.
// Data channel sends are synchronous and must not wait behind a slow start or switch.
let queue = Promise.resolve();
bridge.onCmd((cmd) => {
  if (cmd.t === 'send' || cmd.t === 'v-send') { run(cmd); return; }
  queue = queue.then(() => run(cmd));
});
emit({ t: 'ready' });
