'use strict';
// Moves the real cursor a few pixels and puts it back. No keys are typed.
const assert = require('assert');
const { InputInjector, vkFor } = require('../src/input');
const inj = new InputInjector();
const start = InputInjector.cursorPos();
inj.moveTo(start.x, start.y);
inj.moveBy(40, 25);
let p = InputInjector.cursorPos();
console.log('start', start, 'after +40,+25', p);
assert.ok(Math.abs(p.x - (start.x + 40)) <= 1 && Math.abs(p.y - (start.y + 25)) <= 1, 'relative move');
inj.moveBy(-40.5, -25.5);
inj.moveBy(0.5, 0.5);
p = InputInjector.cursorPos();
assert.ok(Math.abs(p.x - start.x) <= 1 && Math.abs(p.y - start.y) <= 1, 'move back with fractions');
inj.wheel(0, 0); // no-op
assert.strictEqual(vkFor('Enter'), 13); assert.strictEqual(vkFor('a'), 65); assert.strictEqual(vkFor('F5'), 0x74);
console.log('ok', p);
