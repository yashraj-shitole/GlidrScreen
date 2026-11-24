'use strict';
// Wake-on-LAN, PC side: find the network adapter a magic packet would have to reach (the physical one the PC is
// on the LAN with) and put its MAC and directed broadcast address into the pairing link. The phone sends the packet.
// os.networkInterfaces is injected so this stays a pure function in tests.
const os = require('os');

/** Adapters that are not the PC's own LAN card. "TAP" is matched as a word so e.g. "Laptop" is not skipped. */
const SKIP_NAME = /vethernet|hyper-v|virtualbox|vmware|docker|wsl|(^|[^a-z])tap([^a-z]|$)|tailscale|loopback|zerotier|wireguard|openvpn|npcap|bluetooth|vpn/i;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const MAC12 = /^[0-9a-fA-F]{12}$/;

const isIpv4 = (s) => typeof s === 'string' && IPV4.test(s);
const isMac12 = (s) => typeof s === 'string' && MAC12.test(s);

const toInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Directed broadcast address of [address]/[netmask], e.g. 192.168.1.20 + 255.255.255.0 -> 192.168.1.255. */
function broadcastOf(address, netmask) {
  if (!isIpv4(address) || !isIpv4(netmask)) return null;
  const mask = toInt(netmask);
  if (mask === 0 || mask === 0xffffffff) return null; // no LAN to broadcast on
  return toIp(((toInt(address) | (~mask >>> 0)) >>> 0));
}

/** "aa:bb:cc:dd:ee:ff" / "AA-BB-..." -> "AABBCCDDEEFF"; null when it is not a usable unicast MAC. */
function normalizeMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (!isMac12(hex) || /^0{12}$/.test(hex)) return null;
  if (parseInt(hex.slice(0, 2), 16) & 1) return null; // multicast bit: not a card's own address
  return hex.toUpperCase();
}

const isV4 = (a) => a && (a.family === 'IPv4' || a.family === 4);
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/**
 * The primary physical adapter as {mac: "AABBCCDDEEFF", broadcast: "192.168.1.255"}, or null.
 * Skips internal, virtual and VPN adapters, all-zero MACs and link-local (169.254.x.x) addresses; prefers an adapter
 * with a private IPv4 address, then the first one the OS lists.
 */
function primaryAdapter(networkInterfaces = os.networkInterfaces) {
  let ifaces;
  try { ifaces = networkInterfaces() || {}; } catch { return null; }
  let best = null;
  for (const [name, list] of Object.entries(ifaces)) {
    if (SKIP_NAME.test(name) || !Array.isArray(list)) continue;
    for (const a of list) {
      if (!isV4(a) || a.internal) continue;
      const mac = normalizeMac(a.mac);
      const broadcast = broadcastOf(a.address, a.netmask);
      if (!mac || !broadcast || a.address.startsWith('169.254.')) continue;
      const cand = { mac, broadcast, priv: isPrivate(a.address) };
      if (!best || (cand.priv && !best.priv)) best = cand;
    }
  }
  return best && { mac: best.mac, broadcast: best.broadcast };
}

module.exports = { primaryAdapter, broadcastOf, normalizeMac, isIpv4, isMac12, SKIP_NAME };
