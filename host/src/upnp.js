'use strict';
// Mobile data without a relay server: while a phone is connected, ask the home router (UPnP / IGD, the same "open a port"
// request games and torrent clients send) to forward ONE UDP port to the port this PC's WebRTC connection already uses,
// and offer that public address to the phone as an extra candidate. A phone on mobile data sits behind a carrier NAT that
// gives it a different public port for every destination, so it can never be reached by a direct peer-to-peer hole
// punch; but it can always send to an open public address, and that is all ICE needs from it.
//
// Safety: only the one UDP port of the live session is opened (to the PC's own LAN address, never another device), the
// router is asked for a lease so it forgets the mapping by itself, the mapping is deleted when the session ends or the
// app quits, and anything arriving on it still has to pass ICE's per-session credentials and the DTLS fingerprint that
// travels in the sealed offer. If the router has no UPnP, answers with a non-public WAN address (carrier-grade NAT) or
// anything fails, the offer is sent unchanged: this never blocks or slows a connection by more than TIMEOUT_MS.
//
// Everything that touches the network is injectable, so the logic is unit-tested without a router.
const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 2500;
const LEASE_S = 3600;
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
const CRLF = String.fromCharCode(13, 10);

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** True for an IPv4 address that is routable on the internet: not private, loopback, link-local or carrier-grade (100.64/10). */
function isPublicIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  return true;
}

/** The first `typ host` UDP candidate of [sdp] whose address is [lanIp]: {ip, port}, or null. */
function pickHostCandidate(sdp, lanIp) {
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = /^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host\b/.exec(line);
    if (m && m[1] === lanIp) return { ip: m[1], port: Number(m[2]) };
  }
  return null;
}

/**
 * [sdp] with one more server-reflexive candidate, {extIp}:{extPort}, placed right after the host candidate it forwards to
 * ({lanIp}:{lanPort}) in every section that has it. Unchanged when that candidate is not there.
 */
function addMappedCandidate(sdp, { lanIp, lanPort, extIp, extPort }) {
  const eol = String(sdp).includes(CRLF) ? CRLF : String.fromCharCode(10);
  const hostRe = new RegExp('^a=candidate:\\S+ 1 udp \\d+ ' + lanIp.replace(/\./g, '\\.') + ' ' + lanPort + ' typ host\\b');
  let n = 0;
  const out = [];
  for (const line of String(sdp).split(/\r?\n/)) {
    out.push(line);
    if (hostRe.test(line)) {
      out.push(`a=candidate:9${String(++n)}${String(extPort)} 1 udp 1686052607 ${extIp} ${extPort} typ srflx raddr ${lanIp} rport ${lanPort} generation 0`);
    }
  }
  return out.join(eol);
}

/** Pulls the WAN connection service out of a UPnP device description: {serviceType, controlUrl (absolute)} or null. */
function parseDescription(xml, location) {
  const text = String(xml);
  const base = (/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(text) || [])[1] || location;
  for (const type of SERVICES) {
    const i = text.indexOf('<serviceType>' + type + '</serviceType>');
    if (i < 0) continue;
    const rest = text.slice(i, text.indexOf('</service>', i) + 10);
    const ctl = (/<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(rest) || [])[1];
    if (ctl) {
      try { return { serviceType: type, controlUrl: new URL(ctl, base).href }; } catch { return null; }
    }
  }
  return null;
}

function soapBody(serviceType, action, args) {
  const inner = Object.entries(args || {}).map(([k, v]) => `<${k}>${String(v)}</${k}>`).join('');
  return '<?xml version="1.0"?>' + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
}

/** A SOAP fault's UPnP error code, or null. */
function faultCode(xml) {
  const m = /<errorCode>\s*(\d+)\s*<\/errorCode>/.exec(String(xml));
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------ real network (replaced in tests)

/** SSDP search for the router; resolves {location, routerIp} or null. */
function discoverGateway(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { sock.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (m, r) => {
      const loc = /^location:\s*(\S+)/im.exec(m.toString());
      if (loc) finish({ location: loc[1], routerIp: r.address });
    });
    sock.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'upnp:rootdevice']) {
        const q = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 1', 'ST: ' + st, '', ''].join(CRLF));
        try { sock.send(q, 1900, '239.255.255.250'); } catch { /* no network */ }
      }
    });
  });
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // routers' SOAP servers generally do not understand chunked bodies: always send an explicit length
    const h = { ...headers, Connection: 'close', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) };
    // one fresh connection per request (agent: false): home routers close a kept-alive socket after each reply, and a reused
    // one then fails with ECONNRESET
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: h, timeout: timeoutMs, agent: false }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > 200000) req.destroy(new Error('too large')); });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The address this PC uses to reach [routerIp] (its LAN address on that network). */
function localAddressFor(routerIp) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch { /* closed */ } resolve(null); });
    s.connect(1900, routerIp, () => {
      let a = null;
      try { a = s.address().address; } catch { /* not bound */ }
      try { s.close(); } catch { /* closed */ }
      resolve(a);
    });
  });
}

// ------------------------------------------------------------------ the mapper

class PortMapper {
  /**
   * @param deps.discover  () => Promise<{location, routerIp} | null>
   * @param deps.request   (url, opts) => Promise<{status, body}>
   * @param deps.localAddressFor  (routerIp) => Promise<string | null>
   * @param deps.log       (text) => void   (no addresses beyond the error code)
   */
  constructor({ discover = discoverGateway, request = httpRequest, localAddress = localAddressFor, log = () => {}, timeoutMs = TIMEOUT_MS, random = Math.random } = {}) {
    Object.assign(this, { discover, request, localAddress, log, timeoutMs, random });
    this.gw = null;
    this.failedAt = 0;
  }

  async #gateway() {
    if (this.gw) return this.gw;
    // after a failure do not search again for a minute, so a router without UPnP costs a session nothing
    if (this.failedAt && Date.now() - this.failedAt < 60_000) return null;
    const found = await this.discover();
    if (!found) { this.failedAt = Date.now(); return null; }
    const d = await this.request(found.location, { timeoutMs: 1500 });
    const svc = d.status === 200 ? parseDescription(d.body, found.location) : null;
    const localIp = svc ? await this.localAddress(found.routerIp) : null;
    if (!svc || !localIp) { this.failedAt = Date.now(); return null; }
    this.gw = { ...svc, routerIp: found.routerIp, localIp };
    return this.gw;
  }

  async #soap(action, args) {
    const gw = this.gw;
    const r = await this.request(gw.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body: soapBody(gw.serviceType, action, args), timeoutMs: 1500,
    });
    if (r.status !== 200) { const e = new Error('upnp ' + action + ' ' + r.status); e.code = faultCode(r.body); throw e; }
    return r.body;
  }

  /**
   * Opens the mapping for the live host candidate of [sdp] and returns {sdp, release, extIp, extPort}, or null when that
   * is not possible. Never throws, never takes longer than the timeout.
   */
  async mapForOffer(sdp) {
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(null), this.timeoutMs); });
    try {
      return await Promise.race([this.#map(sdp), timeout]);
    } catch (e) {
      this.log('port mapping skipped: ' + String(e.code || e.message || e).slice(0, 80));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #map(sdp) {
    const gw = await this.#gateway();
    if (!gw) return null;
    const ipBody = await this.#soap('GetExternalIPAddress', {});
    const extIp = (/<NewExternalIPAddress>\s*([^<\s]+)\s*<\/NewExternalIPAddress>/.exec(ipBody) || [])[1];
    if (!isPublicIPv4(extIp)) { this.log('port mapping skipped: the router has no public address'); return null; }
    const cand = pickHostCandidate(sdp, gw.localIp);
    if (!cand) return null;
    let extPort = cand.port;
    let lease = LEASE_S;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.#soap('AddPortMapping', {
          NewRemoteHost: '', NewExternalPort: extPort, NewProtocol: 'UDP', NewInternalPort: cand.port, NewInternalClient: cand.ip,
          NewEnabled: 1, NewPortMappingDescription: 'Glidr Screen', NewLeaseDuration: lease,
        });
        const done = { extIp, extPort, sdp: addMappedCandidate(sdp, { lanIp: cand.ip, lanPort: cand.port, extIp, extPort }) };
        let released = false;
        done.release = async () => {
          if (released) return;
          released = true;
          try { await this.#soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: extPort, NewProtocol: 'UDP' }); } catch { /* the lease ends it */ }
        };
        return done;
      } catch (e) {
        if (e.code === 725) lease = 0; // this router only keeps permanent mappings: we delete it ourselves
        else if (e.code === 718) extPort = 49152 + Math.floor(this.random() * 16000); // that external port is taken
        else throw e;
      }
    }
    return null;
  }
}

module.exports = { httpRequest, PortMapper, isPublicIPv4, pickHostCandidate, addMappedCandidate, parseDescription, soapBody, faultCode, LEASE_S, TIMEOUT_MS };
