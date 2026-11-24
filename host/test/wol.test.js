'use strict';
const assert = require('assert');
const wol = require('../src/wol');
const crypto = require('../src/crypto');

const v4 = (address, netmask, mac, extra = {}) => ({ address, netmask, family: 'IPv4', mac, internal: false, cidr: null, ...extra });
const nics = (o) => () => o;

// broadcast maths
assert.strictEqual(wol.broadcastOf('192.168.1.20', '255.255.255.0'), '192.168.1.255');
assert.strictEqual(wol.broadcastOf('10.1.2.3', '255.0.0.0'), '10.255.255.255');
assert.strictEqual(wol.broadcastOf('172.16.5.130', '255.255.255.128'), '172.16.5.255');
assert.strictEqual(wol.broadcastOf('192.168.0.70', '255.255.255.192'), '192.168.0.127');
assert.strictEqual(wol.broadcastOf('192.168.1.20', '255.255.255.255'), null);
assert.strictEqual(wol.broadcastOf('192.168.1.20', '0.0.0.0'), null);
assert.strictEqual(wol.broadcastOf('nope', '255.255.255.0'), null);

// plain Wi-Fi
assert.deepStrictEqual(
  wol.primaryAdapter(nics({ 'Wi-Fi': [v4('192.168.1.20', '255.255.255.0', 'a4:bb:6d:01:02:03')] })),
  { mac: 'A4BB6D010203', broadcast: '192.168.1.255' },
);
// "-" separated MAC, numeric family (Node 18.0-18.3)
assert.deepStrictEqual(
  wol.primaryAdapter(nics({ Ethernet: [{ address: '10.0.0.5', netmask: '255.255.0.0', family: 4, mac: 'AA-BB-CC-DD-EE-01', internal: false }] })),
  { mac: 'AABBCCDDEE01', broadcast: '10.0.255.255' },
);

// virtual, VPN, loopback, internal and zero-MAC adapters are skipped
const virtualNames = ['vEthernet (WSL)', 'vEthernet (Default Switch)', 'Hyper-V Virtual Ethernet Adapter', 'VirtualBox Host-Only Network',
  'VMware Network Adapter VMnet8', 'Docker NAT', 'WSL', 'TAP-Windows Adapter V9', 'Tailscale', 'Loopback Pseudo-Interface 1', 'Ethernet 3 (vpn)'];
for (const name of virtualNames) {
  assert.strictEqual(wol.primaryAdapter(nics({ [name]: [v4('192.168.56.1', '255.255.255.0', '0a:00:27:00:00:01')] })), null, name);
}
assert.strictEqual(wol.primaryAdapter(nics({ Ethernet: [v4('127.0.0.1', '255.0.0.0', 'aa:bb:cc:dd:ee:ff', { internal: true })] })), null);
assert.strictEqual(wol.primaryAdapter(nics({ Ethernet: [v4('192.168.1.2', '255.255.255.0', '00:00:00:00:00:00')] })), null);
assert.strictEqual(wol.primaryAdapter(nics({ Ethernet: [v4('169.254.3.4', '255.255.0.0', 'aa:bb:cc:dd:ee:ff')] })), null, 'link-local');
assert.strictEqual(wol.primaryAdapter(nics({ Ethernet: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false }] })), null);
assert.strictEqual(wol.primaryAdapter(nics({})), null);
assert.strictEqual(wol.primaryAdapter(() => { throw new Error('boom'); }), null);
// a name that merely contains "tap" is not a TAP adapter
assert.ok(wol.primaryAdapter(nics({ 'Laptop LAN': [v4('192.168.1.9', '255.255.255.0', 'aa:bb:cc:00:00:09')] })));

// the real adapter wins over the virtual ones listed first; private beats public
assert.deepStrictEqual(
  wol.primaryAdapter(nics({
    'vEthernet (WSL)': [v4('172.20.0.1', '255.255.240.0', '00:15:5d:00:00:01')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1', '255.255.255.0', '0a:00:27:00:00:02')],
    Ethernet: [v4('203.0.113.9', '255.255.255.0', '11:22:33:44:55:66')],
    'Wi-Fi': [v4('192.168.1.50', '255.255.255.0', 'a4:bb:6d:aa:bb:cc')],
  })),
  { mac: 'A4BB6DAABBCC', broadcast: '192.168.1.255' },
);
// with two private adapters the first one listed wins
assert.strictEqual(
  wol.primaryAdapter(nics({
    Ethernet: [v4('192.168.1.5', '255.255.255.0', '01:00:00:00:00:00'.replace('01', '02'))],
    'Wi-Fi': [v4('192.168.1.6', '255.255.255.0', 'a4:bb:6d:00:00:01')],
  })).mac,
  '020000000000',
);
// multicast-bit "MAC" is not a card address
assert.strictEqual(wol.primaryAdapter(nics({ Ethernet: [v4('192.168.1.5', '255.255.255.0', '01:00:5e:00:00:01')] })), null);

// ---- toLink: unchanged without WoL data, extended only when both are valid
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const base = crypto.toLink(key, 'My PC', 'https://ntfy.sh');
assert.strictEqual(base, 'glidr://screen?v=1&k=AAECAwQFBgcICQoLDA0ODw&n=My+PC&s=https%3A%2F%2Fntfy.sh', 'known answer');
assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', undefined, undefined), base);
assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', 'A4BB6D010203'), base, 'mac alone');
assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', undefined, '192.168.1.255'), base, 'broadcast alone');
assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', 'A4BB6D010203', '192.168.1.255'), base + '&m=A4BB6D010203&b=192.168.1.255');
assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', 'a4bb6d010203', '10.0.0.255'), base + '&m=A4BB6D010203&b=10.0.0.255', 'hex is upper-cased');
for (const [m, b] of [
  ['A4BB6D01020', '192.168.1.255'], ['A4BB6D0102033', '192.168.1.255'], ['A4:BB:6D:01:02:03', '192.168.1.255'],
  ['GGGGGGGGGGGG', '192.168.1.255'], ['A4BB6D010203', '192.168.1.256'], ['A4BB6D010203', '192.168.1'],
  ['A4BB6D010203', '192.168.1.255&x=1'], ['A4BB6D010203', '01.2.3.4'], ['A4BB6D010203', ''], ['', ''],
  [123456789012, '192.168.1.255'], ['A4BB6D010203', 3232235775], [null, null], ['A4BB6D010203\n', '192.168.1.255'],
]) {
  assert.strictEqual(crypto.toLink(key, 'My PC', 'https://ntfy.sh', m, b), base, `invalid ${m} / ${b}`);
}

console.log('ok wol');
