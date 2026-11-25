'use strict';
// Headroom check: a sealed offer must stay under the 3900-character frame limit (host/src/crypto.js) even with the
// audio transceiver added. The SDP below mirrors the shape of a Chromium offer with H.264 + VP8 (+rtx), an optional
// Opus section, a data channel and several ICE candidates; fingerprint / ufrag / pwd / candidates are random so
// they compress as badly as real ones. Run: node host/test/offer-size.test.js
const assert = require('assert');
const crypto = require('crypto');
const { deriveSlot, newKey, seal, open } = require('../src/crypto');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64').replace(/=+$/, '');
const fingerprint = () => [...crypto.randomBytes(32)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

function candidates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 3 === 0 ? 'host' : i % 3 === 1 ? 'srflx' : 'host';
    const ip = i % 3 === 1 ? `203.0.113.${10 + i}` : `192.168.${1 + (i % 4)}.${20 + i}`;
    const tail = kind === 'srflx' ? ` raddr 0.0.0.0 rport 0` : '';
    out.push(`a=candidate:${crypto.randomInt(1e9)} 1 udp ${2113937151 - i * 1000} ${ip} ${40000 + crypto.randomInt(20000)} typ ${kind}${tail} generation 0 network-cost 999`);
  }
  // an IPv6 and mDNS-style host candidate as Chromium emits them
  out.push(`a=candidate:${crypto.randomInt(1e9)} 1 udp 2113939711 2401:4900:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)}:${hex(2)} ${50000 + crypto.randomInt(9000)} typ host generation 0 network-cost 999`);
  return out;
}

const ext = (id, uri) => `a=extmap:${id} ${uri}`;

function videoSection(mid, newCodecs) {
  // Chromium lists several H.264 profiles (packetization-mode=1 only, as engine.js prefers), VP8, and an rtx entry for each.
  const h264 = ['42e01f', '4d001f', '640c1f', '42001f', '4d0032', '640032'];
  const pts = [];
  const codec = [];
  let pt = 96;
  const fb = (p) => ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'].map((f) => `a=rtcp-fb:${p} ${f}`);
  for (const prof of h264) {
    codec.push(`a=rtpmap:${pt} H264/90000`, ...fb(pt), `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${prof}`,
      `a=rtpmap:${pt + 1} rtx/90000`, `a=fmtp:${pt + 1} apt=${pt}`);
    pts.push(pt, pt + 1); pt += 2;
  }
  codec.push(`a=rtpmap:${pt} VP8/90000`, ...fb(pt), `a=rtpmap:${pt + 1} rtx/90000`, `a=fmtp:${pt + 1} apt=${pt}`);
  pts.push(pt, pt + 1);
  if (newCodecs) {
    // VP9 (profile 0 only, as engine.js filters) and AV1, each with rtx, as Chromium lists them
    pt += 2;
    codec.push(`a=rtpmap:${pt} VP9/90000`, ...fb(pt), `a=fmtp:${pt} profile-id=0`, `a=rtpmap:${pt + 1} rtx/90000`, `a=fmtp:${pt + 1} apt=${pt}`);
    pts.push(pt, pt + 1); pt += 2;
    codec.push(`a=rtpmap:${pt} AV1/90000`, ...fb(pt), `a=fmtp:${pt} level-idx=5;profile=0;tier=0`, `a=rtpmap:${pt + 1} rtx/90000`, `a=fmtp:${pt + 1} apt=${pt}`);
    pts.push(pt, pt + 1);
  }
  const lines = [
    `m=video 9 UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0', `a=ice-ufrag:${b64(4)}`, `a=ice-pwd:${b64(18)}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint()}`, 'a=setup:actpass', `a=mid:${mid}`,
    ext(1, 'urn:ietf:params:rtp-hdrext:toffset'), ext(2, 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'),
    ext(3, 'urn:3gpp:video-orientation'), ext(4, 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'),
    ext(5, 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay'), ext(6, 'http://www.webrtc.org/experiments/rtp-hdrext/video-content-type'),
    ext(7, 'http://www.webrtc.org/experiments/rtp-hdrext/video-timing'), ext(8, 'http://www.webrtc.org/experiments/rtp-hdrext/color-space'),
    ext(9, 'urn:ietf:params:rtp-hdrext:sdes:mid'), ext(10, 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'),
    ext(11, 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id'),
    'a=sendonly', 'a=msid:' + b64(12) + ' ' + b64(12), 'a=rtcp-mux', 'a=rtcp-rsize', ...codec,
    `a=ssrc-group:FID ${crypto.randomInt(2 ** 31)} ${crypto.randomInt(2 ** 31)}`,
  ];
  for (let i = 0; i < 2; i++) {
    const ssrc = crypto.randomInt(2 ** 31);
    lines.push(`a=ssrc:${ssrc} cname:${b64(9)}`, `a=ssrc:${ssrc} msid:${b64(12)} ${b64(12)}`);
  }
  return lines;
}


function audioSection(mid) {
  const ssrc = crypto.randomInt(2 ** 31);
  return [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0', `a=ice-ufrag:${b64(4)}`, `a=ice-pwd:${b64(18)}`,
    'a=ice-options:trickle', `a=fingerprint:sha-256 ${fingerprint()}`, 'a=setup:actpass', `a=mid:${mid}`,
    ext(1, 'urn:ietf:params:rtp-hdrext:ssrc-audio-level'), ext(2, 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'),
    ext(3, 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'), ext(4, 'urn:ietf:params:rtp-hdrext:sdes:mid'),
    'a=sendonly', `a=msid:${b64(12)} ${b64(12)}`, 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1', `a=ssrc:${ssrc} cname:${b64(9)}`, `a=ssrc:${ssrc} msid:${b64(12)} ${b64(12)}`,
  ];
}

function dataSection(mid) {
  return ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', `a=ice-ufrag:${b64(4)}`, `a=ice-pwd:${b64(18)}`,
    'a=ice-options:trickle', `a=fingerprint:sha-256 ${fingerprint()}`, 'a=setup:actpass', `a=mid:${mid}`, 'a=sctp-port:5000', 'a=max-message-size:262144'];
}

function sdp({ audio, cands, newCodecs }) {
  const mids = audio ? ['0', '1', '2'] : ['0', '1'];
  const head = ['v=0', `o=- ${crypto.randomInt(2 ** 31)}${crypto.randomInt(1e9)} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0',
    `a=group:BUNDLE ${mids.join(' ')}`, 'a=extmap-allow-mixed', `a=msid-semantic: WMS ${b64(12)}`];
  // max-bundle: candidates are listed once, on the first m-section
  const v = videoSection('0', newCodecs); v.splice(9, 0, ...candidates(cands));
  const out = [...head, ...v, ...(audio ? audioSection('1') : []), ...dataSection(audio ? '2' : '1')];
  return out.join('\r\n') + '\r\n';
}

const slot = deriveSlot(newKey());
const frameFor = (s) => seal(slot.encKey, { t: 'offer', from: 'h', sid: hex(8), ts: Date.now(), sdp: s, v: 1, host: 'DESKTOP-ABC123' });

const rows = [];
for (const [label, audio, cands] of [['video only, 8 candidates', false, 8], ['video + audio, 8 candidates', true, 8], ['video + audio, 14 candidates', true, 14]]) {
  const s = sdp({ audio, cands });
  const frame = frameFor(s);
  assert.ok(open(slot.encKey, frame).sdp === s, 'round trip');
  rows.push({ label, sdp: s.length, frame: frame.length, headroom: 3900 - frame.length });
  assert.ok(frame.length < 3900, `${label}: frame ${frame.length} chars must stay under 3900`);
}
// VP9 and AV1 (opt-in codecs) in the offer on top of the six H.264 profiles and VP8, with audio: the worst case.
for (const [label, cands] of [['video + audio + VP9 + AV1, 8 candidates', 8], ['video + audio + VP9 + AV1, 14 candidates', 14]]) {
  const s = sdp({ audio: true, cands, newCodecs: true });
  const frame = frameFor(s);
  assert.ok(open(slot.encKey, frame).sdp === s, 'round trip');
  rows.push({ label, sdp: s.length, frame: frame.length, headroom: 3900 - frame.length });
  assert.ok(3900 - frame.length >= 1000, `${label}: needs at least 1 kB headroom, frame ${frame.length}`);
}
const base = rows[0], withAudio = rows[1];
assert.ok(base.sdp > 4500 && base.sdp < 9000, 'representative SDP size, got ' + base.sdp);
assert.ok(withAudio.frame - base.frame < 500, 'audio adds a few hundred characters at most');
for (const r of rows) console.log(`${r.label}: sdp ${r.sdp} B -> frame ${r.frame} chars (headroom ${r.headroom})`);
console.log('ok offer-size');
