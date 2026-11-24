'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, ENC_PREFIX } = require('../src/store');

/** Reversible fake: ciphertext is "FAKE:" + the text, so a wrong profile is simulated with a different tag. */
function fakeSafe(tag = 'A', available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`${tag}:${s}`),
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith(tag + ':')) throw new Error('cannot decrypt');
      return t.slice(tag.length + 1);
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glidr-store-'));
const readFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

// defaults
{
  const s = new Store(tmp(), { safeStorage: null });
  assert.strictEqual(s.get('keepAwake'), true);
  assert.strictEqual(s.get('endOnLock'), false);
  assert.strictEqual(s.get('shareAudio'), false);
}

// round trip: file holds ciphertext, memory holds plaintext
{
  const dir = tmp();
  const a = new Store(dir, { safeStorage: fakeSafe() });
  const slot = a.createSlot();
  a.claim(slot.id, 'Pixel');
  const plain = slot.key;
  const onDisk = readFile(dir).slots[0].key;
  assert.ok(onDisk.startsWith(ENC_PREFIX));
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes(plain));
  const b = new Store(dir, { safeStorage: fakeSafe() });
  assert.strictEqual(b.data.slots[0].key, plain);
  assert.strictEqual(b.data.slots[0].needsRepair, undefined);
  assert.strictEqual(b.data.slots[0].name, 'Pixel');
}

// migration of existing plaintext keys rewrites the file on first load
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    slots: [{ id: 'a1', key: 'plainkey1', name: 'Old', createdAt: 1, claimedAt: 5, lastSeen: 6 }],
  }));
  const s = new Store(dir, { safeStorage: fakeSafe() });
  assert.strictEqual(s.data.slots[0].key, 'plainkey1');
  const disk = readFile(dir);
  assert.ok(disk.slots[0].key.startsWith(ENC_PREFIX));
  assert.ok(!JSON.stringify(disk).includes('plainkey1'));
  assert.strictEqual(disk.keepAwake, true); // new defaults are written too
  assert.strictEqual(new Store(dir, { safeStorage: fakeSafe() }).data.slots[0].key, 'plainkey1');
}

// encryption unavailable: plaintext fallback, no migration, nothing marked broken
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    slots: [{ id: 'a1', key: 'plainkey1', createdAt: 1, claimedAt: 5 }],
  }));
  const s = new Store(dir, { safeStorage: fakeSafe('A', false) });
  assert.strictEqual(s.data.slots[0].key, 'plainkey1');
  assert.strictEqual(readFile(dir).slots[0].key, 'plainkey1');
  s.set({ hostName: 'x' });
  assert.strictEqual(readFile(dir).slots[0].key, 'plainkey1');
  const noSafe = new Store(dir, { safeStorage: null });
  noSafe.createSlot();
  assert.ok(!readFile(dir).slots.some((x) => x.key.startsWith(ENC_PREFIX)));
}

// a throwing isEncryptionAvailable is treated as unavailable
{
  const dir = tmp();
  const bad = { isEncryptionAvailable: () => { throw new Error('boom'); }, encryptString: () => { throw new Error('x'); }, decryptString: () => { throw new Error('x'); } };
  const s = new Store(dir, { safeStorage: bad });
  const slot = s.createSlot();
  assert.strictEqual(readFile(dir).slots[0].key, slot.key);
}

// decryption failure: slot kept, flagged, key emptied; ciphertext preserved across saves; other slots unaffected
{
  const dir = tmp();
  const a = new Store(dir, { safeStorage: fakeSafe('A') });
  const s1 = a.createSlot(); a.claim(s1.id, 'One');
  const s2 = a.createSlot(); a.claim(s2.id, 'Two');
  const stored = readFile(dir).slots.map((x) => x.key);
  // corrupt only the first one's ciphertext so that it is not decryptable
  const disk = readFile(dir);
  disk.slots[0].key = ENC_PREFIX + Buffer.from('B:zzz').toString('base64');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(disk));
  const b = new Store(dir, { safeStorage: fakeSafe('A') });
  assert.strictEqual(b.data.slots.length, 2);
  assert.strictEqual(b.data.slots[0].needsRepair, true);
  assert.strictEqual(b.data.slots[0].key, '');
  assert.strictEqual(b.data.slots[0].name, 'One');
  assert.strictEqual(b.data.slots[1].needsRepair, undefined);
  assert.strictEqual(b.data.slots[1].key, s2.key);
  b.set({ hostName: 'other' }); // a later save must not delete or blank the locked ciphertext
  const after = readFile(dir);
  assert.strictEqual(after.slots[0].key, disk.slots[0].key);
  assert.strictEqual(after.slots[0].needsRepair, undefined);
  assert.ok(after.slots[1].key.startsWith(ENC_PREFIX));
  assert.strictEqual(after.slots[1].key, stored[1]);
  // removing it ("Pair again") drops it for good
  b.revoke(b.data.slots[0].id);
  assert.strictEqual(readFile(dir).slots.length, 1);
}

// encrypted file, encryption now unavailable: all claimed slots need repair, none deleted
{
  const dir = tmp();
  const a = new Store(dir, { safeStorage: fakeSafe('A') });
  const s1 = a.createSlot(); a.claim(s1.id, 'One');
  const b = new Store(dir, { safeStorage: fakeSafe('A', false) });
  assert.strictEqual(b.data.slots.length, 1);
  assert.strictEqual(b.data.slots[0].needsRepair, true);
  b.set({ hostName: 'z' });
  // back to a working profile: key is still recoverable
  const c = new Store(dir, { safeStorage: fakeSafe('A') });
  assert.strictEqual(c.data.slots[0].key, s1.key);
}

console.log('ok');
