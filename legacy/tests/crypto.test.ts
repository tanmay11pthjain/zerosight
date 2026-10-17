import { describe, expect, it } from 'vitest';
import { WORDS } from '../src/lib/words';
import {
  CHUNK_SIZE,
  EntropyPool,
  PADLOCK_BYTES,
  SealBrokenError,
  buildEnvelope,
  fingerprint,
  forgeKey,
  freezeFile,
  makePadlock,
  sealKey,
  thawEnvelope,
} from '../src/lib/crypto';

async function forged() {
  const pool = new EntropyPool();
  for (let i = 0; i < 300; i++) pool.add(Math.random() * 1000, Math.random() * 800, performance.now());
  return (await forgeKey(pool)).key;
}

async function crate(size: number, roomId = 'ROOM42') {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  const key = await forged();
  const { padlock, secretKey } = makePadlock();
  const frozen = await freezeFile({ name: 'report.pdf', type: 'application/pdf', data: data.buffer }, key);
  const { kemCt, wrapped } = await sealKey(key, padlock, roomId);
  const bytes = new Uint8Array(await buildEnvelope(frozen, kemCt, wrapped, 1).arrayBuffer());
  return { data, bytes, secretKey, frozen };
}

describe('safety words', () => {
  it('has 256 unique words', () => {
    expect(WORDS).toHaveLength(256);
    expect(new Set(WORDS).size).toBe(256);
  });

  it('gives both sides the same six words for the same padlock', async () => {
    const { padlock } = makePadlock();
    expect(padlock).toHaveLength(PADLOCK_BYTES);
    const a = await fingerprint(padlock);
    const b = await fingerprint(padlock.slice());
    expect(a.words).toHaveLength(6);
    expect(a.words).toEqual(b.words);
  });
});

describe('forge', () => {
  it('forges a 256-bit key and empties the pool', async () => {
    const pool = new EntropyPool();
    pool.add(1, 2, 3);
    const { key, samples } = await forgeKey(pool);
    expect(key).toHaveLength(32);
    expect(samples).toBe(3);
    expect(pool.count).toBe(0);
  });

  it('still forges a key with zero motion (device randomness only)', async () => {
    const a = (await forgeKey(new EntropyPool())).key;
    const b = (await forgeKey(new EntropyPool())).key;
    expect(a).not.toEqual(b);
  });
});

describe('freeze, seal, thaw', () => {
  it.each([0, 5, CHUNK_SIZE, CHUNK_SIZE + 7, 2 * CHUNK_SIZE + 3])('round-trips %i bytes', async (size) => {
    const { data, bytes, secretKey } = await crate(size);
    const opened = await thawEnvelope(bytes, secretKey, 'ROOM42');
    expect(opened.name).toBe('report.pdf');
    expect(opened.size).toBe(size);
    expect(Buffer.from(await opened.data.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  }, 20_000);

  it('never puts readable bytes in the envelope', async () => {
    const secret = new TextEncoder().encode('the launch codes are 0000');
    const key = await forged();
    const { padlock } = makePadlock();
    const frozen = await freezeFile({ name: 'codes.txt', type: 'text/plain', data: secret.buffer }, key);
    const { kemCt, wrapped } = await sealKey(key, padlock, 'R');
    const text = Buffer.from(await buildEnvelope(frozen, kemCt, wrapped, 1).arrayBuffer());
    expect(text.includes(Buffer.from('launch codes'))).toBe(false);
    expect(text.includes(Buffer.from('codes.txt'))).toBe(false);
  });

  it('refuses a tampered crate', async () => {
    const { bytes, secretKey } = await crate(4096);
    bytes[bytes.length - 40] ^= 0x01;
    await expect(thawEnvelope(bytes, secretKey, 'ROOM42')).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('refuses a truncated crate', async () => {
    const { bytes, secretKey } = await crate(CHUNK_SIZE + 100);
    await expect(thawEnvelope(bytes.subarray(0, bytes.length - 116), secretKey, 'ROOM42')).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('refuses the wrong padlock key', async () => {
    const { bytes } = await crate(100);
    const stranger = makePadlock().secretKey;
    await expect(thawEnvelope(bytes, stranger, 'ROOM42')).rejects.toBeInstanceOf(SealBrokenError);
  });

  it('refuses a crate moved to another room', async () => {
    const { bytes, secretKey } = await crate(100, 'ROOM42');
    await expect(thawEnvelope(bytes, secretKey, 'OTHER1')).rejects.toBeInstanceOf(SealBrokenError);
  });
});
