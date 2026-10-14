'use strict';
// Windows input injection through user32!SendInput (koffi FFI, no native build step).
// Coordinates are physical pixels on the virtual desktop. The cursor is tracked here as floats so slow
// phone-side movement keeps its sub-pixel remainder, and pointer ballistics of the PC are bypassed
// (the phone applies its own acceleration curve).
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });
const INPUT_SIZE = koffi.sizeof(INPUT);

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int n)');

const MOUSEEVENTF = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
};
const KEYEVENTF = { EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004 };
const MAX_NOTCHES = 50;

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Shift: 0x10, Ctrl: 0x11, Alt: 0x12, Pause: 0x13, CapsLock: 0x14,
  Esc: 0x1b, Space: 0x20, PgUp: 0x21, PgDn: 0x22, End: 0x23, Home: 0x24, Left: 0x25, Up: 0x26, Right: 0x27,
  Down: 0x28, PrtSc: 0x2c, Ins: 0x2d, Del: 0x2e, Win: 0x5b, Menu: 0x5d,
  Mute: 0xad, VolDown: 0xae, VolUp: 0xaf, Next: 0xb0, Prev: 0xb1, Stop: 0xb2, PlayPause: 0xb3,
  NumLock: 0x90, ScrollLock: 0x91,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 1; i <= 24; i++) VK['F' + i] = 0x6f + i;
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5d,
  0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3]);

function vkFor(name) {
  if (VK[name] !== undefined) return VK[name];
  if (typeof name === 'string' && name.length === 1) {
    const c = name.toUpperCase();
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c.charCodeAt(0);
  }
  return undefined;
}

function send(...inputs) {
  if (!inputs.length) return 0;
  return SendInput(inputs.length, inputs, INPUT_SIZE);
}
const mouse = (dx, dy, data, flags) => ({ type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const kbd = (vk, scan, flags) => ({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

class InputInjector {
  constructor() {
    this.cx = 0; this.cy = 0; // tracked cursor (physical px)
    this.lastX = NaN; this.lastY = NaN; // last position we set
    this.bounds = null; // {x,y,w,h} the cursor is confined to, or null for the whole desktop
    this.down = new Set(); // keys / buttons currently held, released on reset()
  }

  static cursorPos() {
    const p = {};
    GetCursorPos(p);
    return { x: p.x, y: p.y };
  }

  virtualDesktop() {
    return {
      x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79),
    };
  }

  setBounds(rect) { this.bounds = rect; }

  /** Place the cursor at physical px (x, y), clamped to the confinement rect. */
  moveTo(x, y) {
    const b = this.bounds || this.virtualDesktop();
    this.cx = Math.min(b.x + b.w - 1, Math.max(b.x, x));
    this.cy = Math.min(b.y + b.h - 1, Math.max(b.y, y));
    this.#apply();
  }

  /** Relative move in physical px; fractional remainders are kept between calls. */
  moveBy(dx, dy) {
    const cur = InputInjector.cursorPos();
    // The user (or another app) moved the cursor since we last placed it: follow the real position.
    if (Math.abs(cur.x - this.lastX) > 1 || Math.abs(cur.y - this.lastY) > 1 || Number.isNaN(this.lastX)) {
      this.cx = cur.x; this.cy = cur.y;
    }
    this.moveTo(this.cx + dx, this.cy + dy);
  }

  /** Normalised (0..1) position inside the confinement rect. */
  moveNorm(nx, ny) {
    const b = this.bounds || this.virtualDesktop();
    this.moveTo(b.x + nx * (b.w - 1), b.y + ny * (b.h - 1));
  }

  #apply() {
    const v = this.virtualDesktop();
    const px = Math.round(this.cx), py = Math.round(this.cy);
    // Windows maps n -> floor(n * width / 65536): aim at the pixel centre so the round trip is exact.
    const nx = Math.min(65535, Math.round(((px - v.x) + 0.5) * 65536 / Math.max(1, v.w)));
    const ny = Math.min(65535, Math.round(((py - v.y) + 0.5) * 65536 / Math.max(1, v.h)));
    send(mouse(nx, ny, 0, MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK));
    this.lastX = px; this.lastY = py;
  }

  /** button: 'l' | 'r' | 'm'; action: 'd' down, 'u' up, 'c' click. */
  button(button, action) {
    const f = {
      l: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP],
      r: [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP],
      m: [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP],
    }[button];
    if (!f) return;
    const key = 'b' + button;
    if (action === 'd' || action === 'c') { send(mouse(0, 0, 0, f[0])); this.down.add(key); }
    if (action === 'u' || action === 'c') { send(mouse(0, 0, 0, f[1])); this.down.delete(key); }
  }

  /** Wheel in notches (+y = scroll up / content moves down, +x = right). */
  wheel(x, y) {
    // A batch is a fraction of a notch to a few notches; clamp so a bad value cannot overflow mouseData.
    x = Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, x));
    y = Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, y));
    const out = [];
    if (y) out.push(mouse(0, 0, Math.round(y * 120), MOUSEEVENTF.WHEEL));
    if (x) out.push(mouse(0, 0, Math.round(x * 120), MOUSEEVENTF.HWHEEL));
    send(...out);
  }

  /** action: 'd' down, 'u' up, 'p' press. */
  key(name, action = 'p') {
    const vk = vkFor(name);
    if (vk === undefined) return false;
    const ext = EXTENDED.has(vk) ? KEYEVENTF.EXTENDEDKEY : 0;
    if (action === 'd' || action === 'p') { send(kbd(vk, 0, ext)); this.down.add('k' + vk); }
    if (action === 'u' || action === 'p') { send(kbd(vk, 0, ext | KEYEVENTF.KEYUP)); this.down.delete('k' + vk); }
    return true;
  }

  /** Hold the keys in order, release in reverse: ['Ctrl','Shift','Esc']. */
  combo(names) {
    const list = names.filter((n) => vkFor(n) !== undefined);
    list.forEach((n) => this.key(n, 'd'));
    [...list].reverse().forEach((n) => this.key(n, 'u'));
  }

  /**
   * Types arbitrary Unicode (any script) through KEYEVENTF_UNICODE. Line breaks and tabs are real Enter / Tab
   * presses: most apps ignore them as Unicode characters.
   */
  text(str) {
    const out = [];
    const keyTap = (vk) => out.push(kbd(vk, 0, 0), kbd(vk, 0, KEYEVENTF.KEYUP));
    for (let i = 0; i < str.length; i++) {
      const unit = str.charCodeAt(i);
      if (unit === 0x0d) { keyTap(VK.Enter); if (str.charCodeAt(i + 1) === 0x0a) i++; } // \r\n is one Enter
      else if (unit === 0x0a) keyTap(VK.Enter);
      else if (unit === 0x09) keyTap(VK.Tab);
      else out.push(kbd(0, unit, KEYEVENTF.UNICODE), kbd(0, unit, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
      if (out.length >= 64) { send(...out); out.length = 0; }
    }
    send(...out);
  }

  /** Release anything still held (viewer disconnected mid-drag or mid-shortcut). */
  reset() {
    for (const k of [...this.down]) {
      if (k === 'bl') this.button('l', 'u');
      else if (k === 'br') this.button('r', 'u');
      else if (k === 'bm') this.button('m', 'u');
      else if (k[0] === 'k') {
        const vk = Number(k.slice(1));
        send(kbd(vk, 0, (EXTENDED.has(vk) ? KEYEVENTF.EXTENDEDKEY : 0) | KEYEVENTF.KEYUP));
      }
    }
    this.down.clear();
  }
}

module.exports = { InputInjector, vkFor };
