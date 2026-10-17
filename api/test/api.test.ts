import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { memoryStorage } from '../src/storage/memory.ts';

process.env.NODE_ENV = 'test';
const KB = 1024;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let storage: ReturnType<typeof memoryStorage>;

async function setup(over: Partial<Config> = {}) {
  const config = loadConfig({ minPartSize: 64 * KB, publicUrl: 'http://t', storageType: 'memory', ...over });
  db = await openDb('');
  storage = memoryStorage(config.publicUrl);
  app = await buildApp({ config, db, storage });
}
beforeEach(() => setup());
afterEach(async () => {
  await app.close();
  await db.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (url: string, payload: unknown, t?: string) => app.inject({ method: 'POST', url, payload: payload as object, headers: t ? auth(t) : {} });
const local = (url: string) => url.replace('http://t', '');
const padlock = () => randomBytes(1184).toString('base64');
const keybox = () => randomBytes(1148).toString('base64');
const device = () => randomBytes(18).toString('base64url');

async function uploadedRoom(sizes: number[], maxReceivers = 1) {
  const r = await post('/api/rooms', { maxReceivers, fuse: '1h', files: sizes.map((size) => ({ size })) });
  expect(r.statusCode).toBe(201);
  const room = r.json();
  for (const f of room.files) {
    const parts = Array.from({ length: f.partCount }, (_, i) => i + 1);
    const { urls } = (await post(`/api/rooms/${room.roomId}/files/${f.index}/parts`, { parts }, room.ownerToken)).json();
    for (const u of urls) {
      const plain = Math.min(f.partSize, Math.max(0, sizes[f.index] - (u.part - 1) * f.partSize));
      const put = await app.inject({ method: 'PUT', url: local(u.url), payload: randomBytes(plain + 16), headers: { 'content-type': 'application/octet-stream' } });
      expect(put.statusCode).toBe(200);
    }
    expect((await post(`/api/rooms/${room.roomId}/files/${f.index}/complete`, {}, room.ownerToken)).statusCode).toBe(200);
  }
  const manifest = randomBytes(200);
  const { url } = (await post(`/api/rooms/${room.roomId}/manifest`, { size: manifest.length }, room.ownerToken)).json();
  await app.inject({ method: 'PUT', url: local(url), payload: manifest, headers: { 'content-type': 'application/octet-stream' } });
  expect((await post(`/api/rooms/${room.roomId}/finalize`, {}, room.ownerToken)).statusCode).toBe(200);
  return room as { roomId: string; ownerToken: string; files: { index: number; partSize: number; partCount: number }[] };
}

describe('room lifecycle', () => {
  it('uses 64-character room ids and hides tokens from public status', async () => {
    const r = (await post('/api/rooms', { files: [{ size: 10 }] })).json();
    expect(r.roomId).toMatch(/^[0-9a-f]{64}$/);
    const pub = (await app.inject(`/api/rooms/${r.roomId}`)).json();
    expect(pub).toMatchObject({ state: 'uploading', fileCount: 1, joined: 0, maxReceivers: 1 });
    expect(JSON.stringify(pub)).not.toContain(r.ownerToken);
  });

  it('delivers end to end, then burns with a verifiable receipt and deletes storage', async () => {
    const room = await uploadedRoom([150 * KB, 0]);
    const join = (await post(`/api/rooms/${room.roomId}/join`, { device: device() })).json();
    expect(join.token).toBeTruthy();
    const download0 = await post(`/api/rooms/${room.roomId}/download`, { manifest: true }, join.token);
    expect(download0.json().error).toBe('no-key');

    expect((await app.inject({ method: 'PUT', url: `/api/rooms/${room.roomId}/padlock`, payload: { padlock: padlock() }, headers: auth(join.token) })).statusCode).toBe(200);
    expect((await post(`/api/rooms/${room.roomId}/keybox`, { receiverId: join.receiverId, keybox: keybox() }, room.ownerToken)).statusCode).toBe(200);
    const me = (await app.inject({ url: `/api/rooms/${room.roomId}/me`, headers: auth(join.token) })).json();
    expect(me.keybox).toHaveLength(1532);

    const m = (await post(`/api/rooms/${room.roomId}/download`, { manifest: true }, join.token)).json();
    expect((await app.inject(local(m.url))).rawPayload.length).toBe(200);
    const { urls } = (await post(`/api/rooms/${room.roomId}/download`, { file: 0, parts: [1, 2, 3] }, join.token)).json();
    const got = await Promise.all(urls.map((u: { url: string }) => app.inject(local(u.url)).then((r) => r.rawPayload.length)));
    expect(got).toEqual([64 * KB + 16, 64 * KB + 16, 22 * KB + 16]);

    const ack = (await post(`/api/rooms/${room.roomId}/ack`, { ok: true }, join.token)).json();
    expect(ack.burned).toBe(true);
    const pub = (await app.inject(`/api/rooms/${room.roomId}`)).json();
    expect(pub.state).toBe('burned');
    expect(pub.burn.reason).toBe('delivered');
    const rc = pub.burn.receipt;
    const key = createPublicKey({ key: rc.serverKey, format: 'jwk' });
    expect(verify(null, Buffer.from(rc.signed), key, Buffer.from(rc.signature, 'base64'))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await storage.size(`rooms/${room.roomId}/0.enc`)).toBeNull();
    expect(await storage.size(`rooms/${room.roomId}/manifest.enc`)).toBeNull();
  });

  it('rejects a part of the wrong size', async () => {
    const r = (await post('/api/rooms', { files: [{ size: 100 }] })).json();
    const { urls } = (await post(`/api/rooms/${r.roomId}/files/0/parts`, { parts: [1] }, r.ownerToken)).json();
    const bad = await app.inject({ method: 'PUT', url: local(urls[0].url), payload: randomBytes(50), headers: { 'content-type': 'application/octet-stream' } });
    expect(bad.statusCode).toBe(403);
    expect((await post(`/api/rooms/${r.roomId}/files/0/complete`, {}, r.ownerToken)).statusCode).toBe(409);
  });
});

describe('Red Alert login counting', () => {
  it('admits exactly the allowed number under a race, then destroys everything', async () => {
    const room = await uploadedRoom([10 * KB], 1);
    const results = await Promise.all(Array.from({ length: 5 }, () => post(`/api/rooms/${room.roomId}/join`, { device: device() })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes).toContain(423);
    const pub = (await app.inject(`/api/rooms/${room.roomId}`)).json();
    expect(pub.state).toBe('burned');
    expect(pub.burn.reason).toBe('red-alert');
    await new Promise((r) => setTimeout(r, 20));
    expect(await storage.size(`rooms/${room.roomId}/0.enc`)).toBeNull();
  });

  it('does not count the same browser twice', async () => {
    const room = await uploadedRoom([10], 1);
    const d = device();
    expect((await post(`/api/rooms/${room.roomId}/join`, { device: d })).statusCode).toBe(200);
    expect((await post(`/api/rooms/${room.roomId}/join`, { device: d })).statusCode).toBe(409);
    expect((await app.inject(`/api/rooms/${room.roomId}`)).json().state).toBe('ready');
  });

  it('always allows exactly one recipient, even if the request asks for more', async () => {
    const room = await uploadedRoom([10], 5);
    expect((await app.inject(`/api/rooms/${room.roomId}`)).json().maxReceivers).toBe(1);
    expect((await post(`/api/rooms/${room.roomId}/join`, { device: device() })).statusCode).toBe(200);
    expect((await post(`/api/rooms/${room.roomId}/join`, { device: device() })).statusCode).toBe(423);
  });

  it('offers 15 minute, 1 hour and 24 hour timers only', async () => {
    for (const fuse of ['15m', '1h', '24h']) expect((await post('/api/rooms', { fuse, files: [{ size: 1 }] })).statusCode).toBe(201);
    expect((await post('/api/rooms', { fuse: '7d', files: [{ size: 1 }] })).statusCode).toBe(400);
  });

  it('reports a burned link as burned, not as a new alert', async () => {
    const room = await uploadedRoom([10], 1);
    await post(`/api/rooms/${room.roomId}/burn`, {}, room.ownerToken);
    const r = await post(`/api/rooms/${room.roomId}/join`, { device: device() });
    expect(r.statusCode).toBe(410);
    expect(r.json().burn.reason).toBe('sender');
  });
});

describe('access control', () => {
  it('blocks receivers from owner actions and strangers from everything', async () => {
    const room = await uploadedRoom([10], 1);
    const j = (await post(`/api/rooms/${room.roomId}/join`, { device: device() })).json();
    expect((await post(`/api/rooms/${room.roomId}/burn`, {}, j.token)).statusCode).toBe(403);
    expect((await post(`/api/rooms/${room.roomId}/keybox`, { receiverId: j.receiverId, keybox: keybox() }, 'nope')).statusCode).toBe(403);
    expect((await post(`/api/rooms/${room.roomId}/download`, { manifest: true }, room.ownerToken)).statusCode).toBe(403);
    expect((await app.inject('/api/rooms/abc')).statusCode).toBe(404);
  });

  it('refuses a key box before the receiver posted a padlock, and bad padlocks', async () => {
    const room = await uploadedRoom([10], 1);
    const j = (await post(`/api/rooms/${room.roomId}/join`, { device: device() })).json();
    expect((await post(`/api/rooms/${room.roomId}/keybox`, { receiverId: j.receiverId, keybox: keybox() }, room.ownerToken)).statusCode).toBe(409);
    const bad = await app.inject({ method: 'PUT', url: `/api/rooms/${room.roomId}/padlock`, payload: { padlock: 'abc' }, headers: auth(j.token) });
    expect(bad.statusCode).toBe(400);
  });

  it('enforces the per-receiver download budget', async () => {
    const room = await uploadedRoom([100 * KB], 1);
    const j = (await post(`/api/rooms/${room.roomId}/join`, { device: device() })).json();
    await app.inject({ method: 'PUT', url: `/api/rooms/${room.roomId}/padlock`, payload: { padlock: padlock() }, headers: auth(j.token) });
    await post(`/api/rooms/${room.roomId}/keybox`, { receiverId: j.receiverId, keybox: keybox() }, room.ownerToken);
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await post(`/api/rooms/${room.roomId}/download`, { file: 0, parts: [1, 2] }, j.token)).statusCode;
    expect(last).toBe(429);
  });
});

describe('limits and sweeper', () => {
  it('refuses rooms over the size limit and over total capacity', async () => {
    await app.close();
    await db.close();
    await setup({ maxRoomBytes: 1000 * KB, maxStoredBytes: 1500 * KB });
    expect((await post('/api/rooms', { files: [{ size: 2000 * KB }] })).statusCode).toBe(413);
    expect((await post('/api/rooms', { files: [{ size: 900 * KB }] })).statusCode).toBe(201);
    expect((await post('/api/rooms', { files: [{ size: 900 * KB }] })).statusCode).toBe(503);
  });

  it('burns expired rooms, stalled uploads, and rooms whose sender left before handing over a key', async () => {
    const expired = await uploadedRoom([10]);
    await db.query('UPDATE rooms SET fuse_ends_at=1 WHERE id=$1', [expired.roomId]);
    const stalled = (await post('/api/rooms', { files: [{ size: 10 }] })).json();
    await db.query('UPDATE rooms SET upload_deadline=1 WHERE id=$1', [stalled.roomId]);
    const left = await uploadedRoom([10]);
    await db.query('UPDATE rooms SET sender_seen_at=1 WHERE id=$1', [left.roomId]);
    await app.sweep();
    const reason = async (id: string) => (await app.inject(`/api/rooms/${id}`)).json().burn?.reason;
    expect(await reason(expired.roomId)).toBe('expired');
    expect(await reason(stalled.roomId)).toBe('upload-timeout');
    expect(await reason(left.roomId)).toBe('sender-left');
  });

  it('starts the delete timer only after the upload finishes', async () => {
    const r = (await post('/api/rooms', { fuse: '1h', files: [{ size: 10 }] })).json();
    expect((await app.inject(`/api/rooms/${r.roomId}`)).json().fuseEndsAt).toBeNull();
    expect((await post(`/api/rooms/${r.roomId}/finalize`, {}, r.ownerToken)).statusCode).toBe(409);
  });
});
