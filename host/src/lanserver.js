'use strict';
// LAN signaling: a tiny ntfy-compatible HTTP server on the local network, so a phone on the same Wi-Fi can do the
// request / offer / answer exchange directly with this PC and never touches ntfy.sh (which allows only a few hundred
// anonymous messages per IP per day and may be down or blocked). See docs/PROTOCOL.md, "LAN signaling".
//
//   POST /<topic>                 body = one sealed frame (max 4096 bytes)   -> 200 {}
//   GET  /<topic>/json[?since=X]  newline-delimited JSON stream, like ntfy
//
// Why plain HTTP is acceptable: every frame is AES-256-GCM sealed with the pairing key (crypto.js), exactly as on
// ntfy.sh, so an eavesdropper on the Wi-Fi sees nothing readable and cannot forge anything. What this server must NOT
// do is leak or expose anything, so:
//   - only topics derived from this PC's own pairing keys exist; every other path is 404 (the server reveals nothing);
//   - only private / link-local / loopback-if-allowed peers are served (403 otherwise), so a router port forward or a
//     tunnel that terminates on this PC cannot expose it to the internet;
//   - frames that fail authentication are dropped before they are buffered or handed on;
//   - sizes, concurrent streams, header sizes and idle sockets are all capped; frames are never logged.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { open } = require('./crypto');

const MAX_BODY = 4096;          // same cap as ntfy
const MAX_URL = 512;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_STREAMS = 16;
const BUFFER_MESSAGES = 50;
const BUFFER_TTL_MS = 10 * 60_000;
const KEEPALIVE_MS = 30_000;
const STREAM_MAX_MS = 30 * 60_000; // a phone that is still there simply reconnects; a vanished one frees its slot
const SOCKET_IDLE_MS = 90_000;     // 3 keepalives; also times out a client that opens a socket and says nothing
const MAX_STREAM_BACKLOG = 256 * 1024; // a reader that does not read is cut off
const PORT_MIN = 49152;
const PORT_MAX = 65535;

/** True for the address ranges a phone on the same network can come from (and loopback only when [allowLoopback]). */
function isPrivateAddress(addr, allowLoopback = false) {
  let a = String(addr || '').toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); // IPv4 seen through a dual-stack socket
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number);
    if (o1 === 10) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 169 && o2 === 254) return true;
    return allowLoopback && o1 === 127;
  }
  if (net.isIPv6(a)) {
    if (a === '::1') return allowLoopback;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  }
  return false;
}

/** A random port in the dynamic range 49152-65535. */
function randomPort(rand = Math.random) {
  return PORT_MIN + Math.floor(rand() * (PORT_MAX - PORT_MIN + 1));
}

const newId = () => crypto.randomBytes(9).toString('base64url'); // 12 characters, like ntfy

class LanServer extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {() => Map<string,{id:string,encKey:Buffer}>} [o.topics] the served topics (topic -> slot); anything else is 404
   * @param {boolean} [o.allowLoopback] treat 127.0.0.1 / ::1 as allowed (tests; off in the app so a local tunnel cannot expose it)
   * @param {(req: http.IncomingMessage) => string} [o.remoteAddress] where the peer is, injectable for tests
   * @param {() => number} [o.now] clock in ms
   * @param {number} [o.keepaliveMs] [o.ttlMs] [o.maxMessages] [o.maxStreams] [o.maxBody] [o.socketIdleMs] [o.streamMaxMs] limits (tests shrink them)
   * @param {(m:string)=>void} [o.log] never receives a frame
   *
   * Emits `message` {slotId, msg, serverTime} for every authentic frame POSTed by a phone (the shape Signaling emits for ntfy).
   */
  constructor(o = {}) {
    super();
    this.topics = o.topics || (() => new Map());
    this.allowLoopback = o.allowLoopback === true;
    this.remoteAddress = o.remoteAddress || ((req) => req.socket.remoteAddress);
    this.now = o.now || Date.now;
    this.keepaliveMs = o.keepaliveMs ?? KEEPALIVE_MS;
    this.ttlMs = o.ttlMs ?? BUFFER_TTL_MS;
    this.maxMessages = o.maxMessages ?? BUFFER_MESSAGES;
    this.maxStreams = o.maxStreams ?? MAX_STREAMS;
    this.maxBody = o.maxBody ?? MAX_BODY;
    this.socketIdleMs = o.socketIdleMs ?? SOCKET_IDLE_MS;
    this.streamMaxMs = o.streamMaxMs ?? STREAM_MAX_MS;
    this.log = o.log || (() => {});
    this.server = null;
    this.port = 0;
    /** topic -> [{id, time(s), frame}], oldest first */
    this.buffers = new Map();
    /** live GET streams */
    this.streams = new Set();
  }

  get listening() { return !!this.server; }

  /**
   * Starts listening on all interfaces. [port] 0 or a busy port picks a random free one in 49152-65535 (a few tries).
   * Resolves with the port in use; the caller persists it so pairing links keep working across restarts.
   */
  async start(port = 0, host = '0.0.0.0') {
    if (this.server) return this.port;
    let want = Number.isInteger(port) && port >= 1024 && port <= PORT_MAX ? port : 0;
    for (let i = 0; i < 30; i++) {
      const p = want || randomPort();
      try {
        await this.#listen(p, host);
        return this.port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
        want = 0; // the saved port is taken: choose another
      }
    }
    throw new Error('no free port for LAN signaling');
  }

  #listen(port, host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES, keepAliveTimeout: 5_000 }, (req, res) => this.#handle(req, res));
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.timeout = this.socketIdleMs;
      server.maxHeadersCount = 40;
      server.on('clientError', (_e, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        else socket.destroy();
      });
      server.once('error', reject);
      server.listen({ port, host }, () => {
        server.removeListener('error', reject);
        server.on('error', (e) => this.log('lan server error: ' + e.code));
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  /** Stops listening, ends every stream and forgets every buffered frame. */
  async stop() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    for (const s of [...this.streams]) this.#endStream(s);
    this.buffers.clear();
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** The set of served topics changed (a phone was removed): drop streams and buffers of topics that no longer exist. */
  topicsChanged() {
    const live = this.topics();
    for (const s of [...this.streams]) if (!live.has(s.topic)) this.#endStream(s);
    for (const t of [...this.buffers.keys()]) if (!live.has(t)) this.buffers.delete(t);
  }

  /**
   * Buffers a sealed frame the host published and sends it to every stream on [topic]. Returns how many streams got it
   * (0 when nobody listens right now or the server is off: the caller then still relies on ntfy).
   */
  push(topic, frame) {
    if (!this.server || !this.topics().has(topic)) return 0;
    const ev = this.#store(topic, frame);
    return this.#fanOut(topic, ev);
  }

  #store(topic, frame) {
    const list = this.buffers.get(topic) || [];
    const ev = { id: newId(), time: Math.floor(this.now() / 1000), at: this.now(), frame };
    list.push(ev);
    this.buffers.set(topic, list);
    this.#prune(list);
    return ev;
  }

  #prune(list) {
    const cutoff = this.now() - this.ttlMs;
    while (list.length && (list[0].at < cutoff || list.length > this.maxMessages)) list.shift();
  }

  #fanOut(topic, ev) {
    const line = JSON.stringify({ id: ev.id, time: ev.time, event: 'message', topic, message: ev.frame }) + '\n';
    let n = 0;
    for (const s of this.streams) {
      if (s.topic !== topic) continue;
      if (this.#write(s, line)) n++;
    }
    return n;
  }

  #write(s, line) {
    const res = s.res;
    if (res.destroyed || res.writableEnded) return false;
    if (res.writableLength > MAX_STREAM_BACKLOG) { this.#endStream(s); return false; }
    res.write(line);
    return true;
  }

  #endStream(s) {
    this.streams.delete(s);
    clearInterval(s.keepalive);
    clearTimeout(s.maxTimer);
    try { s.res.end(); } catch { /* already gone */ }
    try { s.res.destroy(); } catch { /* already gone */ }
  }

  // ------------------------------------------------------------------ requests

  #reply(res, status, body = '{}') {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', Connection: status >= 400 ? 'close' : 'keep-alive' });
    res.end(body);
  }

  #handle(req, res) {
    // Peer first: nothing else (not even a 404) is said to an address that is not on the local network.
    let remote = '';
    try { remote = this.remoteAddress(req); } catch { /* treated as unknown */ }
    if (!isPrivateAddress(remote, this.allowLoopback)) return this.#reply(res, 403, '{"error":"local network only"}');

    if (!req.url || req.url.length > MAX_URL) return this.#reply(res, 414, '{"error":"url too long"}');
    let url;
    try { url = new URL(req.url, 'http://lan.invalid'); } catch { return this.#reply(res, 400, '{"error":"bad url"}'); }
    const m = /^\/([A-Za-z0-9_-]{1,64})(\/json)?$/.exec(url.pathname);
    const slot = m && this.topics().get(m[1]);
    if (!slot) return this.#reply(res, 404, '{"error":"not found"}'); // unknown topic: indistinguishable from any other path
    const topic = m[1];

    if (m[2]) {
      if (req.method !== 'GET') return this.#reply(res, 405, '{"error":"method not allowed"}');
      return this.#stream(req, res, topic, url.searchParams.get('since'));
    }
    if (req.method !== 'POST') return this.#reply(res, 405, '{"error":"method not allowed"}');
    return this.#post(req, res, topic, slot);
  }

  #post(req, res, topic, slot) {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > this.maxBody) return this.#reply(res, 413, '{"error":"body too large"}');
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > this.maxBody) { over = true; res.once('finish', () => req.destroy()); this.#reply(res, 413, '{"error":"body too large"}'); return; }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return;
      const frame = Buffer.concat(chunks).toString('utf8').trim();
      const msg = open(slot.encKey, frame);
      if (!msg || typeof msg !== 'object') return this.#reply(res, 400, '{"error":"invalid frame"}'); // not authentic: dropped, never buffered
      const list = this.buffers.get(topic) || [];
      this.#prune(list);
      if (list.some((e) => e.frame === frame)) return this.#reply(res, 200); // an exact repeat (a replay or a double send) is not delivered twice
      const ev = this.#store(topic, frame);
      this.#fanOut(topic, ev);
      this.#reply(res, 200);
      this.emit('message', { slotId: slot.id, msg, serverTime: ev.at });
    });
  }

  #stream(req, res, topic, since) {
    if (this.streams.size >= this.maxStreams) return this.#reply(res, 503, '{"error":"too many streams"}');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    res.socket?.setNoDelay(true);
    const s = { topic, res, keepalive: null, maxTimer: null };
    this.streams.add(s);
    const done = () => this.#endStream(s);
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    s.keepalive = setInterval(() => {
      this.#write(s, JSON.stringify({ id: newId(), time: Math.floor(this.now() / 1000), event: 'keepalive', topic }) + '\n');
    }, this.keepaliveMs);
    s.keepalive.unref?.();
    s.maxTimer = setTimeout(done, this.streamMaxMs);
    s.maxTimer.unref?.();
    this.#write(s, JSON.stringify({ id: newId(), time: Math.floor(this.now() / 1000), event: 'open', topic }) + '\n');
    for (const ev of this.#replay(topic, since)) {
      this.#write(s, JSON.stringify({ id: ev.id, time: ev.time, event: 'message', topic, message: ev.frame }) + '\n');
    }
  }

  /**
   * Buffered messages newer than [since]: a message id, "all", or a duration like "30s" / "10m". Without it nothing is
   * replayed (a live stream only). An id this server does not know replays nothing either, so a stale id from another
   * server cannot make old messages reappear.
   */
  #replay(topic, since) {
    const list = this.buffers.get(topic);
    if (!list || !since) return [];
    this.#prune(list);
    if (since === 'all') return [...list];
    const dur = /^(\d{1,6})([smh])$/.exec(since);
    if (dur) {
      const cutoff = this.now() - Number(dur[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[dur[2]];
      return list.filter((e) => e.at >= cutoff);
    }
    const i = list.findIndex((e) => e.id === since);
    return i < 0 ? [] : list.slice(i + 1);
  }
}

module.exports = { LanServer, isPrivateAddress, randomPort, MAX_BODY, MAX_STREAMS, BUFFER_MESSAGES, BUFFER_TTL_MS, KEEPALIVE_MS };
