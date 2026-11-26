'use strict';
// UPnP port mapping for mobile data (src/upnp.js): address rules, SDP editing, the router's description, and the mapper
// against a fake router. Run: node host/test/upnp.test.js
const assert = require('assert');
const { PortMapper, isPublicIPv4, pickHostCandidate, addMappedCandidate, parseDescription, faultCode } = require('../src/upnp');

const CRLF = String.fromCharCode(13, 10);
const SDP = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
  'm=video 59994 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 192.168.1.132', 'a=mid:0',
  'a=candidate:148953233 1 udp 2122260223 172.29.240.1 59993 typ host generation 0 network-id 1',
  'a=candidate:3898225041 1 udp 2122194687 192.168.1.132 59994 typ host generation 0 network-id 2 network-cost 10',
  'a=candidate:1192284335 1 udp 1685987071 103.173.51.117 59994 typ srflx raddr 192.168.1.132 rport 59994 generation 0 network-id 2 network-cost 10',
  'a=candidate:1982806537 1 tcp 1518280447 172.29.240.1 9 typ host tcptype active generation 0 network-id 1',
  'a=ice-ufrag:abcd', '',
].join(CRLF);

const DESC = '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceList><device><deviceList><device><serviceList>'
  + '<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>'
  + '<controlURL>/ctl/IPConn</controlURL><eventSubURL>/evt/IPConn</eventSubURL></service></serviceList></device></deviceList></device></deviceList></device></root>';

/** A fake router: records the SOAP calls, answers GetExternalIPAddress, and can fail AddPortMapping on demand. */
function fakeRouter({ externalIp = '103.173.51.117', failAdd = [] } = {}) {
  const calls = [];
  const fails = [...failAdd];
  const request = async (url, opts = {}) => {
    if (opts.method !== 'POST') return { status: 200, body: DESC };
    const action = /#(\w+)"/.exec(opts.headers.SOAPAction)[1];
    const arg = (k) => (new RegExp('<' + k + '>([^<]*)</' + k + '>').exec(opts.body) || [])[1];
    calls.push({ action, url, ext: arg('NewExternalPort'), int: arg('NewInternalPort'), client: arg('NewInternalClient'), lease: arg('NewLeaseDuration'), proto: arg('NewProtocol') });
    if (action === 'GetExternalIPAddress') return { status: 200, body: `<NewExternalIPAddress>${externalIp}</NewExternalIPAddress>` };
    if (action === 'AddPortMapping' && fails.length) return { status: 500, body: `<errorCode>${fails.shift()}</errorCode>` };
    return { status: 200, body: '' };
  };
  return { request, calls };
}
const mapper = (router, extra = {}) => new PortMapper({
  discover: async () => ({ location: 'http://192.168.1.1:1900/gatedesc.xml', routerIp: '192.168.1.1' }),
  request: router.request, localAddress: async () => '192.168.1.132', ...extra,
});

(async () => {
  // ---- which addresses count as public
  for (const ip of ['103.173.51.117', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) assert.strictEqual(isPublicIPv4(ip), true, ip);
  for (const ip of ['192.168.1.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.9.9', '127.0.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '', null, 'x', '1.2.3', '256.1.1.1']) assert.strictEqual(isPublicIPv4(ip), false, String(ip));

  // ---- picking and editing the SDP
  assert.deepStrictEqual(pickHostCandidate(SDP, '192.168.1.132'), { ip: '192.168.1.132', port: 59994 });
  assert.strictEqual(pickHostCandidate(SDP, '192.168.1.55'), null, 'no candidate on another address');
  assert.strictEqual(pickHostCandidate(SDP.replace('typ host generation 0 network-id 2', 'typ relay generation 0 network-id 2'), '192.168.1.132'), null);
  const edited = addMappedCandidate(SDP, { lanIp: '192.168.1.132', lanPort: 59994, extIp: '103.173.51.117', extPort: 59994 });
  const lines = edited.split(CRLF);
  const hostAt = lines.findIndex((l) => l.includes('192.168.1.132 59994 typ host'));
  assert.ok(/^a=candidate:\S+ 1 udp 1686052607 103\.173\.51\.117 59994 typ srflx raddr 192\.168\.1\.132 rport 59994 generation 0$/.test(lines[hostAt + 1]), 'the new candidate follows its host candidate');
  assert.strictEqual(lines.length, SDP.split(CRLF).length + 1, 'exactly one line was added');
  assert.ok(edited.endsWith(CRLF) && edited.includes(CRLF + 'a=ice-ufrag:abcd' + CRLF), 'line endings and the rest are untouched');
  assert.strictEqual(addMappedCandidate(SDP, { lanIp: '192.168.1.99', lanPort: 1, extIp: '8.8.8.8', extPort: 1 }), SDP, 'no matching host candidate: unchanged');
  assert.ok(edited.length - SDP.length < 160, 'it stays small enough for the sealed offer');

  // ---- the router's description
  assert.deepStrictEqual(parseDescription(DESC, 'http://192.168.1.1:1900/uateqa/gatedesc.xml'), {
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', controlUrl: 'http://192.168.1.1:1900/ctl/IPConn',
  });
  assert.strictEqual(parseDescription('<root></root>', 'http://x/'), null);
  assert.strictEqual(faultCode('<errorCode>718</errorCode>'), 718);
  assert.strictEqual(faultCode('nothing'), null);

  // ---- a normal router: one mapping, to this PC's own address and port, with a lease, deleted on release
  {
    const router = fakeRouter();
    const m = await mapper(router).mapForOffer(SDP);
    assert.ok(m, 'mapped');
    assert.strictEqual(m.extIp, '103.173.51.117');
    assert.ok(m.sdp.includes('103.173.51.117 59994 typ srflx'));
    const add = router.calls.find((c) => c.action === 'AddPortMapping');
    assert.deepStrictEqual([add.ext, add.int, add.client, add.proto, add.lease], ['59994', '59994', '192.168.1.132', 'UDP', '3600'], 'one UDP port, to this PC, with a lease');
    assert.strictEqual(router.calls.filter((c) => c.action === 'AddPortMapping').length, 1);
    await m.release(); await m.release();
    const del = router.calls.filter((c) => c.action === 'DeletePortMapping');
    assert.strictEqual(del.length, 1, 'released once');
    assert.deepStrictEqual([del[0].ext, del[0].proto], ['59994', 'UDP']);
  }
  // ---- carrier-grade NAT or a private WAN address: nothing is opened (it could not help)
  for (const externalIp of ['100.100.1.2', '10.0.0.2', '192.168.0.1']) {
    const router = fakeRouter({ externalIp });
    assert.strictEqual(await mapper(router).mapForOffer(SDP), null);
    assert.ok(!router.calls.some((c) => c.action === 'AddPortMapping'), 'no port opened behind a non-public address');
  }
  // ---- no host candidate on the LAN address: nothing is opened
  {
    const router = fakeRouter();
    assert.strictEqual(await mapper(router, { localAddress: async () => '192.168.1.77' }).mapForOffer(SDP), null);
    assert.ok(!router.calls.some((c) => c.action === 'AddPortMapping'));
  }
  // ---- a router that only keeps permanent mappings: retried with lease 0
  {
    const router = fakeRouter({ failAdd: [725] });
    const m = await mapper(router).mapForOffer(SDP);
    assert.ok(m);
    assert.deepStrictEqual(router.calls.filter((c) => c.action === 'AddPortMapping').map((c) => c.lease), ['3600', '0']);
  }
  // ---- the external port is taken: another one is tried, and the offer carries that one
  {
    const router = fakeRouter({ failAdd: [718] });
    const m = await mapper(router, { random: () => 0.5 }).mapForOffer(SDP);
    assert.ok(m);
    const adds = router.calls.filter((c) => c.action === 'AddPortMapping');
    assert.strictEqual(adds[1].ext, String(49152 + 8000));
    assert.strictEqual(adds[1].int, '59994', 'still forwarded to the same internal port');
    assert.ok(m.sdp.includes('103.173.51.117 57152 typ srflx raddr 192.168.1.132 rport 59994'));
  }
  // ---- any other router error: no mapping, no throw
  {
    const logs = [];
    const router = fakeRouter({ failAdd: [501] });
    assert.strictEqual(await mapper(router, { log: (t) => logs.push(t) }).mapForOffer(SDP), null);
    assert.ok(logs.some((t) => /501/.test(t)) && !logs.some((t) => /192\.168|103\.173/.test(t)), 'the log has the code, not addresses');
  }
  // ---- no UPnP router: null, and the next session does not search again within a minute
  {
    let searches = 0;
    const m = new PortMapper({ discover: async () => { searches++; return null; }, request: async () => ({ status: 404, body: '' }), localAddress: async () => '192.168.1.132' });
    assert.strictEqual(await m.mapForOffer(SDP), null);
    assert.strictEqual(await m.mapForOffer(SDP), null);
    assert.strictEqual(searches, 1);
  }
  // ---- a router that never answers cannot hold the connection up
  {
    const never = new Promise(() => {});
    const m = new PortMapper({ discover: () => never, request: () => never, localAddress: () => never, timeoutMs: 80 });
    const t0 = Date.now();
    assert.strictEqual(await m.mapForOffer(SDP), null);
    assert.ok(Date.now() - t0 < 1000);
  }
  console.log('upnp tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
