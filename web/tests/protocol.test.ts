// Full protocol against the real API (in-process, memory storage, PGlite):
// sender uploads 3 files, receiver joins, ML-KEM key delivery, download, burn.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-ignore: the API is a sibling package run from source
import { buildApp } from '../../api/src/app.ts';
// @ts-ignore
import { loadConfig } from '../../api/src/config.ts';
// @ts-ignore
import { openDb } from '../../api/src/db.ts';
// @ts-ignore
import { memoryStorage } from '../../api/src/storage/memory.ts';
import { call, type PublicRoom } from '../src/lib/api';
import { EntropyPool, b64, forgeKey, makeLinkSecret, makePadlock, openKeybox, sealKeybox, unb64 } from '../src/lib/crypto';
import { downloadFile, fetchManifest, uploadAll, type FileSink } from '../src/lib/transfer';

process.env.NODE_ENV = 'test';
const BASE = 'http://127.0.0.1:8799';
let app: any;
let db: any;

beforeAll(async () => {
  const config = loadConfig({ minPartSize: 64 * 1024, publicUrl: BASE, storageType: 'memory' });
  db = await openDb('');
  app = await buildApp({ config, db, storage: memoryStorage(BASE) });
  await app.listen({ port: 8799, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

function memSink() {
  const chunks: Uint8Array[] = [];
  const sink: FileSink = { write: async (c) => void chunks.push(c.slice()), close: async () => {}, abort: async () => {} };
  return { sink, bytes: () => new Uint8Array(Buffer.concat(chunks)) };
}

describe('ZeroSight protocol', () => {
  it('sends three files to one receiver and burns the room after download', async () => {
    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 131 + (i >> 7)) & 255);
    const files = [new File([big], 'Project_Data.bin'), new File(['hello zero'], 'note.txt', { type: 'text/plain' }), new File([], 'empty.txt')];

    // Sender: create room, forge key, upload.
    const room = await call<{ roomId: string; ownerToken: string; files: { index: number; partSize: number; partCount: number }[] }>('POST', '/rooms', {
      body: { maxReceivers: 1, fuse: '1h', files: files.map((f) => ({ size: f.size })) },
    });
    const linkSecret = makeLinkSecret();
    const pool = new EntropyPool();
    for (let i = 0; i < 120; i++) pool.addPoint(i, i * 3, i);
    await pool.sampleCpu(8);
    const fileKey = await forgeKey(pool);
    const seen: number[] = [];
    await uploadAll(room.roomId, room.ownerToken, fileKey, files, room.files, (i, d, t) => d === t && seen.push(i), () => false);
    expect(new Set(seen)).toEqual(new Set([0, 1, 2]));
    expect((await call<PublicRoom>('GET', `/rooms/${room.roomId}`)).state).toBe('ready');

    // Receiver: join (counted login), post padlock.
    const join = await call<{ receiverId: string; token: string }>('POST', `/rooms/${room.roomId}/join`, { body: { device: 'device-nonce-0123456789ab' } });
    const { padlock, secretKey } = makePadlock();
    await call('PUT', `/rooms/${room.roomId}/padlock`, { token: join.token, body: { padlock: b64(padlock) } });

    // Sender: seal the file key to that padlock.
    const owner = await call<any>('GET', `/rooms/${room.roomId}/me`, { token: room.ownerToken });
    const rp = unb64(owner.receivers[0].padlock);
    const box = await sealKeybox(fileKey, rp, linkSecret, room.roomId);
    await call('POST', `/rooms/${room.roomId}/keybox`, { token: room.ownerToken, body: { receiverId: join.receiverId, keybox: b64(box) } });

    // Receiver: open key box, read file list, download and verify every file.
    const me = await call<any>('GET', `/rooms/${room.roomId}/me`, { token: join.token });
    const fk = await openKeybox(unb64(me.keybox), secretKey, padlock, linkSecret, room.roomId);
    const m = await fetchManifest(room.roomId, join.token, fk);
    expect(m.files.map((f) => [f.name, f.size])).toEqual([
      ['Project_Data.bin', 300 * 1024],
      ['note.txt', 10],
      ['empty.txt', 0],
    ]);
    const outs = [];
    for (let i = 0; i < m.files.length; i++) {
      const s = memSink();
      await downloadFile(room.roomId, join.token, fk, m, i, s.sink, () => {});
      outs.push(s.bytes());
    }
    expect(Buffer.from(outs[0]).equals(Buffer.from(big))).toBe(true);
    expect(new TextDecoder().decode(outs[1])).toBe('hello zero');
    expect(outs[2]).toHaveLength(0);

    const ack = await call<{ burned: boolean }>('POST', `/rooms/${room.roomId}/ack`, { token: join.token, body: { ok: true } });
    expect(ack.burned).toBe(true);
    const after = await call<PublicRoom>('GET', `/rooms/${room.roomId}`);
    expect(after.burn?.reason).toBe('delivered');
  });

  it('a second device triggers the Red Alert instantly', async () => {
    const room = await call<{ roomId: string; ownerToken: string; files: any[] }>('POST', '/rooms', { body: { files: [{ size: 5 }] } });
    await call('POST', `/rooms/${room.roomId}/join`, { body: { device: 'device-nonce-aaaaaaaaaaaa' } });
    await expect(call('POST', `/rooms/${room.roomId}/join`, { body: { device: 'device-nonce-bbbbbbbbbbbb' } })).rejects.toMatchObject({ status: 423 });
    expect((await call<PublicRoom>('GET', `/rooms/${room.roomId}`)).burn?.reason).toBe('red-alert');
  });
});
