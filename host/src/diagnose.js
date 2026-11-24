'use strict';
// "Test connection": three quick checks of what a phone connection depends on. Everything that touches the network is
// injected (fetch, dgram, a Signaling factory, the clock) so the logic is unit-tested without a network.
//
//   1. ntfy reachable   a sealed test frame goes to a throw-away topic and is read back through the same subscribe
//                       path the host uses for phones (a real Signaling instance in production)
//   2. STUN             one binding request over UDP; only the address FAMILY is reported, never the address
//   3. clock            skew against the ntfy server's Date header; the host ignores requests older than 90 s
const nodeCrypto = require('crypto');

const STUN_HOST = 'stun.l.google.com';
const STUN_PORT = 19302;
const MAGIC = 0x2112a442;
const SKEW_WARN_MS = 60_000;

// ------------------------------------------------------------------ STUN (RFC 5389)

/** 20-byte binding request: type 0x0001, length 0, magic cookie, 12-byte transaction id. */
function buildBindingRequest(txid = nodeCrypto.randomBytes(12)) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  txid.copy(b, 8);
  return b;
}

/**
 * Parses a binding success response for [txid]. Returns {family: 'IPv4'|'IPv6', address, port} from
 * XOR-MAPPED-ADDRESS (or the legacy MAPPED-ADDRESS), or null when it is not a valid answer to our request.
 * Callers report the family only.
 */
function parseBindingResponse(buf, txid) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf.readUInt16BE(0) !== 0x0101 || buf.readUInt32BE(4) !== MAGIC) return null;
  if (!buf.subarray(8, 20).equals(txid)) return null;
  const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
  let found = null;
  for (let p = 20; p + 4 <= end;) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const v = buf.subarray(p + 4, p + 4 + len);
    if (v.length < len) break;
    if ((type === 0x0020 || type === 0x0001) && v.length >= 8) {
      const xor = type === 0x0020;
      const fam = v[1];
      const port = v.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0);
      if (fam === 1) {
        const a = Buffer.from(v.subarray(4, 8));
        if (xor) { const m = Buffer.alloc(4); m.writeUInt32BE(MAGIC); for (let i = 0; i < 4; i++) a[i] ^= m[i]; }
        found = { family: 'IPv4', address: [...a].join('.'), port };
      } else if (fam === 2 && v.length >= 20) {
        const a = Buffer.from(v.subarray(4, 20));
        if (xor) {
          const m = Buffer.alloc(16);
          m.writeUInt32BE(MAGIC, 0);
          txid.copy(m, 4);
          for (let i = 0; i < 16; i++) a[i] ^= m[i];
        }
        found = { family: 'IPv6', address: a.toString('hex').replace(/(.{4})(?=.)/g, '$1:'), port };
      }
      if (found && xor) break; // prefer the XOR form
    }
    p += 4 + len + ((4 - (len % 4)) % 4); // attributes are padded to 4 bytes
  }
  return found;
}

/** Sends one binding request and resolves with the parsed mapping (rejects on timeout or error). */
function stunBinding({ dgram, host = STUN_HOST, port = STUN_PORT, timeoutMs = 4000, txid = nodeCrypto.randomBytes(12) }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('no answer within ' + Math.round(timeoutMs / 1000) + ' s (UDP blocked?)')), timeoutMs);
    sock.on('error', (e) => finish(reject, e));
    sock.on('message', (msg) => {
      const r = parseBindingResponse(msg, txid);
      if (r) finish(resolve, r);
    });
    sock.send(buildBindingRequest(txid), port, host, (err) => { if (err) finish(reject, err); });
  });
}

// ------------------------------------------------------------------ clock

/** Local clock minus server clock in ms (positive = this PC is ahead). The Date header has 1 s resolution. */
function clockSkewMs(dateHeader, sentAt, receivedAt) {
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return null;
  return Math.round((sentAt + receivedAt) / 2 - server);
}

function skewResult(skew) {
  if (skew === null) return { ok: false, detail: 'The server sent no usable Date header' };
  const s = Math.round(Math.abs(skew) / 1000);
  if (Math.abs(skew) > SKEW_WARN_MS) {
    return {
      ok: false,
      detail: `Warning: this PC's clock is ${s} s ${skew > 0 ? 'ahead of' : 'behind'} the server. Requests older than 90 s are ignored, so phones may be refused. Sync the Windows clock.`,
    };
  }
  return { ok: true, detail: s <= 1 ? 'Clock matches the server' : `Clock is within ${s} s of the server` };
}

// ------------------------------------------------------------------ checks

const short = (e) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 140);

/** Publishes a sealed frame to a throw-away topic and waits to read it back through a Signaling instance. */
async function checkNtfy({ signalBase, createSignaling, timeoutMs, settleMs, random }) {
  const key = random(16).toString('base64url');
  const nonce = random(8).toString('hex');
  const sig = createSignaling(signalBase);
  let timer;
  try {
    sig.setSlots([{ id: 'diag', key }]);
    const got = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no message back within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      sig.on('message', (m) => { if (m?.msg?.n === nonce) resolve(); });
    });
    got.catch(() => {}); // a timeout while still subscribing must not become an unhandled rejection
    const online = new Promise((resolve) => sig.on('status', (s) => { if (s === 'online') resolve(true); }));
    sig.start();
    await Promise.race([online, got]); // rejects with the timeout if the server is never reachable
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    await sig.publish(key, { t: 'diag', from: 'p', n: nonce });
    await got;
    return { ok: true, detail: 'Signaling server reachable, message delivered and decrypted' };
  } finally {
    clearTimeout(timer);
    try { sig.stop(); } catch { /* ignore */ }
  }
}

async function checkStun({ dgram, timeoutMs }) {
  const r = await stunBinding({ dgram, timeoutMs });
  return { ok: true, detail: `STUN answered, public address found (${r.family})` }; // never include the address itself
}

async function checkClock({ fetch, signalBase, now, timeoutMs }) {
  const sent = now();
  const res = await fetch(`${signalBase}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
  const received = now();
  return skewResult(clockSkewMs(res.headers.get('date'), sent, received));
}

/**
 * Runs all checks in parallel. Never rejects: a failing check becomes {ok:false, detail}.
 * @returns {Promise<{name:string, ok:boolean, detail:string, ms:number}[]>}
 */
async function runChecks({
  fetch: fetchFn = globalThis.fetch, dgram, createSignaling, signalBase,
  now = Date.now, random = nodeCrypto.randomBytes, timeoutMs = 8000, settleMs = 300,
} = {}) {
  const base = String(signalBase || 'https://ntfy.sh').replace(/\/+$/, '');
  const run = async (name, fn) => {
    const t0 = now();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, detail: short(e) }; }
    return { name, ok: !!r.ok, detail: r.detail, ms: Math.max(0, now() - t0) };
  };
  return Promise.all([
    run('Signaling server (ntfy)', () => checkNtfy({ signalBase: base, createSignaling, timeoutMs, settleMs, random })),
    run('STUN (direct connection)', () => checkStun({ dgram, timeoutMs: Math.min(timeoutMs, 4000) })),
    run('Clock', () => checkClock({ fetch: fetchFn, signalBase: base, now, timeoutMs })),
  ]);
}

module.exports = { runChecks, buildBindingRequest, parseBindingResponse, stunBinding, clockSkewMs, skewResult, SKEW_WARN_MS };
