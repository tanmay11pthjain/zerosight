import { describe, expect, it } from 'vitest';
import { WORDS } from '../src/lib/words';
import {
  EntropyPool,
  MOUSE_POINTS,
  SealBrokenError,
  checkWords,
  decryptPart,
  encryptPart,
  fileCipherKey,
  forgeKey,
  makeLinkSecret,
  makePadlock,
  openKeybox,
  openManifest,
  sealKeybox,
  sealManifest,
} from '../src/lib/crypto';

const roomId = 'a'.repeat(64);
async function key() {
  const p = new EntropyPool();
  for (let i = 0; i < 200; i++) p.addPoint(i * 3, i * 7, i);
  await p.sampleCpu(8);
  return forgeKey(p);
}

describe('key generation (mouse + CPU)', () => {
  it('counts only distinct points and stops at 120', () => {
    const p = new EntropyPool();
    for (let i = 0; i < 50; i++) p.addPoint(10, 10, i);
    expect(p.points).toBe(1);
    for (let i = 0; i < 500; i++) p.addPoint(i, i * 2, i);
    expect(p.points).toBe(MOUSE_POINTS);
  });

  it('collects CPU timing samples and forges a 256-bit key', async () => {
    const p = new EntropyPool();
    await p.sampleCpu(16);
    expect(p.cpuSamples).toBe(16);
    expect(await forgeKey(p)).toHaveLength(32);
  });

  it('still makes a unique key with no movement (skip path)', async () => {
    expect(await forgeKey(new EntropyPool())).not.toEqual(await forgeKey(new EntropyPool()));
  });
});

describe('parts', () => {
  it('round-trips and rejects tampering, reordering and the wrong file', async () => {
    const k = await fileCipherKey(await key(), 0);
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    const plain = crypto.getRandomValues(new Uint8Array(5000));
    const c1 = await encryptPart(k, prefix, 0, 1, false, plain.buffer);
    expect(await decryptPart(k, prefix, 0, 1, false, c1)).toEqual(plain);
    const bad = c1.slice();
    bad[10] ^= 1;
    await expect(decryptPart(k, prefix, 0, 1, false, bad)).rejects.toBeInstanceOf(SealBrokenError);
    await expect(decryptPart(k, prefix, 0, 2, false, c1)).rejects.toBeInstanceOf(SealBrokenError);
    await expect(decryptPart(k, prefix, 0, 1, true, c1)).rejects.toBeInstanceOf(SealBrokenError);
    await expect(decryptPart(k, prefix, 1, 1, false, c1)).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('gives each file its own key', async () => {
    const fk = await key();
    const prefix = new Uint8Array(8);
    const c = await encryptPart(await fileCipherKey(fk, 0), prefix, 0, 1, true, new Uint8Array(10).buffer);
    await expect(decryptPart(await fileCipherKey(fk, 1), prefix, 0, 1, true, c)).rejects.toBeInstanceOf(SealBrokenError);
  });
});

describe('manifest', () => {
  it('hides names and sizes and detects tampering', async () => {
    const fk = await key();
    const m = { v: 2 as const, files: [{ name: 'Q3 board.pdf', type: 'application/pdf', size: 1234, partSize: 8, partCount: 1, ivPrefix: 'AAAAAAAAAAA=' }] };
    const sealed = await sealManifest(fk, m);
    expect(new TextDecoder().decode(sealed)).not.toContain('board');
    expect(await openManifest(fk, sealed)).toEqual(m);
    sealed[20] ^= 1;
    await expect(openManifest(fk, sealed)).rejects.toBeInstanceOf(SealBrokenError);
  });
});

describe('keybox (ML-KEM-768 + link secret)', () => {
  it('opens only with the right padlock key, link secret and room', async () => {
    const fk = await key();
    const secret = makeLinkSecret();
    const { padlock, secretKey } = makePadlock();
    const box = await sealKeybox(fk, padlock, secret, roomId);
    expect(box).toHaveLength(1148);
    expect(await openKeybox(box, secretKey, padlock, secret, roomId)).toEqual(fk);
    await expect(openKeybox(box, secretKey, padlock, makeLinkSecret(), roomId)).rejects.toBeInstanceOf(SealBrokenError);
    await expect(openKeybox(box, secretKey, padlock, secret, 'b'.repeat(64))).rejects.toBeInstanceOf(SealBrokenError);
    await expect(openKeybox(box, makePadlock().secretKey, padlock, secret, roomId)).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('defeats a server that swaps in its own padlock, because it lacks the link secret', async () => {
    const fk = await key();
    const secret = makeLinkSecret();
    const attacker = makePadlock();
    const box = await sealKeybox(fk, attacker.padlock, secret, roomId);
    // The attacker holds the matching secret key but not the link secret.
    await expect(openKeybox(box, attacker.secretKey, attacker.padlock, makeLinkSecret(), roomId)).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('shows both sides the same six check words', async () => {
    expect(WORDS).toHaveLength(256);
    const { padlock } = makePadlock();
    const w = await checkWords(padlock);
    expect(w).toHaveLength(6);
    expect(await checkWords(padlock.slice())).toEqual(w);
  });
});
