'use strict';
// Hidden-window WebRTC engine. Chromium does capture + (hardware where available) encode + DTLS-SRTP.
// The main process owns signaling, input injection and pairing; this file only owns the peer connection.
// A small "viewer" role is included so the host can self-test the whole protocol without a phone.
const bridge = window.engineBridge;
const FPS = 24;
const QUALITY = {
  auto: { bitrate: 6_000_000, height: 1080 },
  low: { bitrate: 1_200_000, height: 540 },
  balanced: { bitrate: 3_000_000, height: 720 },
  high: { bitrate: 9_000_000, height: 1440 },
};
const GATHER_TIMEOUT_MS = 4000;

let host = null; // {sid, pc, dc, sender, stream, preset, statsTimer, lastBytes, lastT}
let viewer = null; // self-test only

const emit = (o) => bridge.emit(o);

async function capture(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
        maxFrameRate: FPS, maxWidth: 2560, maxHeight: 1440,
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion'; // keep the frame rate, let resolution give way under congestion
  return stream;
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

function codecPreferences(pref) {
  const all = RTCRtpSender.getCapabilities('video').codecs;
  const h264 = all.filter((c) => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || ''));
  const vp8 = all.filter((c) => /vp8/i.test(c.mimeType));
  const rtx = all.filter((c) => /rtx/i.test(c.mimeType));
  const order = pref === 'vp8' ? [vp8, h264] : [h264, vp8];
  const list = [...order[0], ...order[1], ...rtx];
  return list.length > rtx.length ? list : all;
}

async function applyQuality() {
  if (!host?.sender) return;
  const q = QUALITY[host.preset] || QUALITY.auto;
  const srcH = host.sender.track?.getSettings().height || q.height;
  const p = host.sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  const e = p.encodings[0];
  e.maxBitrate = q.bitrate;
  e.maxFramerate = FPS;
  e.scaleResolutionDownBy = Math.max(1, srcH / q.height);
  p.degradationPreference = 'maintain-framerate';
  try { await host.sender.setParameters(p); } catch (err) { console.warn('setParameters', err); }
}

async function hostStart(cmd) {
  hostStop();
  const stream = await capture(cmd.sourceId);
  const pc = new RTCPeerConnection({ iceServers: cmd.iceServers, bundlePolicy: 'max-bundle' });
  const s = { sid: cmd.sid, pc, stream, preset: cmd.quality || 'auto', dc: null, sender: null };
  host = s;
  const tr = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
  s.sender = tr.sender;
  try { tr.setCodecPreferences(codecPreferences(cmd.codec)); } catch (e) { console.warn('codec prefs', e); }

  const dc = pc.createDataChannel('ctl', { ordered: true });
  s.dc = dc;
  dc.onopen = () => emit({ t: 'dc-open', sid: s.sid });
  dc.onclose = () => emit({ t: 'dc-close', sid: s.sid });
  dc.onmessage = (e) => emit({ t: 'ctl', sid: s.sid, data: String(e.data) });
  pc.onconnectionstatechange = () => {
    emit({ t: 'state', sid: s.sid, state: pc.connectionState });
    if (pc.connectionState === 'connected') { applyQuality(); startStats(s); }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await applyQuality();
  await waitGathered(pc);
  emit({ t: 'offer', sid: s.sid, sdp: pc.localDescription.sdp });
}

async function hostAnswer(cmd) {
  if (!host || host.sid !== cmd.sid) return;
  await host.pc.setRemoteDescription({ type: 'answer', sdp: cmd.sdp });
}

async function hostSwitch(cmd) {
  const s = host;
  if (!s || s.sid !== cmd.sid) return;
  const stream = await capture(cmd.sourceId);
  if (host !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
  const old = s.stream;
  await s.sender.replaceTrack(stream.getVideoTracks()[0]);
  s.stream = stream;
  old.getTracks().forEach((t) => t.stop());
  await applyQuality();
  const st = stream.getVideoTracks()[0].getSettings();
  emit({ t: 'switched', sid: s.sid, monitorId: cmd.monitorId, w: st.width, h: st.height });
}

function hostSend(cmd) {
  if (host?.dc?.readyState === 'open') host.dc.send(cmd.data);
}

function hostStop(sid) {
  if (!host || (sid && host.sid !== sid)) return;
  clearInterval(host.statsTimer);
  try { host.dc?.close(); } catch { /* ignore */ }
  try { host.pc.close(); } catch { /* ignore */ }
  host.stream.getTracks().forEach((t) => t.stop());
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
    const kbps = s.lastT ? Math.round(((out.bytesSent - s.lastBytes) * 8) / ((out.timestamp - s.lastT))) : 0;
    s.lastBytes = out.bytesSent; s.lastT = out.timestamp;
    emit({
      t: 'stats', sid: s.sid,
      fps: Math.round(out.framesPerSecond || 0), w: out.frameWidth, h: out.frameHeight, kbps,
      codec, encoder: out.encoderImplementation, rtt: pair?.currentRoundTripTime ?? null,
      path: local ? (remote?.candidateType === 'relay' ? 'relay' : local.candidateType) : null, limit: out.qualityLimitationReason,
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

async function run(cmd) {
  try {
    switch (cmd.t) {
      case 'start': await hostStart(cmd); break;
      case 'answer': await hostAnswer(cmd); break;
      case 'switch': await hostSwitch(cmd); break;
      case 'send': hostSend(cmd); break;
      case 'quality': if (host) { host.preset = cmd.preset; await applyQuality(); } break;
      case 'stop': hostStop(cmd.sid); break;
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
