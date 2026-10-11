'use strict';
// Pairing crypto. Mirrored 1:1 by android/screenview/.../signaling/SignalCrypto.kt (see docs/PROTOCOL.md).
//
//   key     16 random bytes shared once through the QR code / manual code
//   encKey  HKDF-SHA256(key, salt "glidr-screen/v1", info "enc",   32 bytes)
//   topic   "gs-" + base32(HKDF-SHA256(key, salt, info "topic", 20 bytes))
//   frame   base64url( nonce12 || AES-256-GCM(gzip(json)) || tag16 ), AAD "glidr-screen/1"
const crypto = require('crypto');
const zlib = require('zlib');

const SALT = Buffer.from('glidr-screen/v1');
const AAD = Buffer.from('glidr-screen/1');
const MAX_FRAME_CHARS = 3900; // ntfy rejects bodies over 4096 bytes

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA256 (RFC 5869), single-block expand (len <= 32). */
function hkdf(ikm, info, len) {
  const prk = hmac(SALT, ikm);
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, len);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newKey() {
  return crypto.randomBytes(16);
}

function deriveSlot(key) {
  return {
    topic: 'gs-' + base32(hkdf(key, 'topic', 20)),
    encKey: hkdf(key, 'enc', 32),
  };
}

function seal(encKey, obj, nonce = crypto.randomBytes(12)) {
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const c = crypto.createCipheriv('aes-256-gcm', encKey, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const frame = Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64url');
  if (frame.length > MAX_FRAME_CHARS) throw new Error(`signal frame too large (${frame.length})`);
  return frame;
}

/** Returns the decoded object, or null when the frame is not authentic. */
function open(encKey, frame) {
  try {
    const raw = Buffer.from(String(frame).trim(), 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
    return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  } catch {
    return null;
  }
}

function toLink(key, hostName, signalBase) {
  const q = new URLSearchParams({ v: '1', k: key.toString('base64url'), n: hostName, s: signalBase });
  return `glidr://screen?${q}`;
}

/** 26 base32 characters grouped for typing: ABCD-EFGH-... */
function toManualCode(key) {
  return base32(key).toUpperCase().replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function fromManualCode(code) {
  const key = unbase32(String(code).replace(/[^a-zA-Z2-7]/g, ''));
  return key.length >= 16 ? key.subarray(0, 16) : null;
}

module.exports = { newKey, deriveSlot, seal, open, toLink, toManualCode, fromManualCode, hkdf, base32 };
