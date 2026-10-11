'use strict';
const assert = require('assert');
const c = require('../src/crypto');

// Known-answer vectors, also asserted in SignalCryptoTest.kt so both ends stay compatible.
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const slot = c.deriveSlot(key);
console.log('topic  ', slot.topic);
console.log('encKey ', slot.encKey.toString('hex'));
console.log('code   ', c.toManualCode(key));

assert.strictEqual(slot.topic.length, 3 + 32);
assert.strictEqual(c.fromManualCode(c.toManualCode(key)).toString('hex'), key.toString('hex'));

const nonce = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
const frame = c.seal(slot.encKey, { t: 'req', sid: 'abc', n: 'Pixel' }, nonce);
console.log('frame  ', frame);
assert.deepStrictEqual(c.open(slot.encKey, frame), { t: 'req', sid: 'abc', n: 'Pixel' });

// tampering and wrong key must be rejected
const bad = Buffer.from(frame, 'base64url');
bad[20] ^= 1;
assert.strictEqual(c.open(slot.encKey, bad.toString('base64url')), null);
assert.strictEqual(c.open(c.deriveSlot(c.newKey()).encKey, frame), null);
assert.strictEqual(c.open(slot.encKey, 'not a frame'), null);

// an SDP-sized payload must fit in one ntfy message
const sdp = Array.from({ length: 60 }, (_, i) => `a=candidate:${i} 1 udp 2113937151 192.168.1.${i} 5${i}000 typ host generation 0`).join('\r\n');
const big = c.seal(slot.encKey, { t: 'offer', sid: 'abc', sdp });
console.log('sdp frame chars', big.length);
console.log('ok');
