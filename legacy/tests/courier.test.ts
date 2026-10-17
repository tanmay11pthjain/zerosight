import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-ignore: plain ESM courier module
import { handleApi } from '../server/app.mjs';
import { EntropyPool, buildEnvelope, forgeKey, freezeFile, makePadlock, sealKey, thawEnvelope, unb64, verifyReceipt } from '../src/lib/crypto';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handleApi(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const req = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.token ? { 'x-zs-token': init.token } : {}), ...(init.headers || {}) } });
const post = async (path: string, body: unknown, token?: string) =>
  (await req(path, { method: 'POST', token, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json();

describe('courier', () => {
  it('carries a crate end to end, then burns it with a signed receipt', async () => {
    const room = await post('/api/rooms', { fuse: '10m' });
    expect(room.id).toMatch(/^[A-Z2-9]{6}$/);

    const { recipientToken } = await post(`/api/rooms/${room.id}/join`, {});
    expect((await req(`/api/rooms/${room.id}/join`, { method: 'POST' })).status).toBe(409);

    const { padlock, secretKey } = makePadlock();
    expect((await req(`/api/rooms/${room.id}/padlock`, { method: 'PUT', token: room.ownerToken, body: padlock.slice() })).status).toBe(403);
    expect((await req(`/api/rooms/${room.id}/padlock`, { method: 'PUT', token: recipientToken, body: padlock.slice() })).status).toBe(200);

    const status = await (await req(`/api/rooms/${room.id}`)).json();
    expect(status.padlockVersion).toBe(1);

    const pool = new EntropyPool();
    pool.add(1, 2, 3, 4);
    const { key } = await forgeKey(pool);
    const plain = new TextEncoder().encode('quarterly numbers: do not leak');
    const frozen = await freezeFile({ name: 'q3.txt', type: 'text/plain', data: plain.buffer }, key);
    const { kemCt, wrapped } = await sealKey(key, unb64(status.padlock), room.id);
    const blob = buildEnvelope(frozen, kemCt, wrapped, status.padlockVersion);
    const up = await req(`/api/rooms/${room.id}/payload`, { method: 'PUT', token: room.ownerToken, body: blob });
    expect(up.status).toBe(200);
    expect((await req(`/api/rooms/${room.id}/payload`, { method: 'PUT', token: room.ownerToken, body: blob })).status).toBe(409);

    expect((await req(`/api/rooms/${room.id}/payload`, { token: room.ownerToken })).status).toBe(403);
    const got = new Uint8Array(await (await req(`/api/rooms/${room.id}/payload`, { token: recipientToken })).arrayBuffer());
    expect(Buffer.from(got).includes(Buffer.from('quarterly'))).toBe(false);

    const opened = await thawEnvelope(got, secretKey, room.id);
    expect(opened.name).toBe('q3.txt');
    expect(await opened.data.text()).toBe('quarterly numbers: do not leak');

    const burn = await post(`/api/rooms/${room.id}/ack`, { ok: true }, recipientToken);
    expect(burn.reason).toBe('delivered');
    expect(burn.receipt.body.ciphertextBytes).toBe(blob.size);
    expect(await verifyReceipt(burn.receipt)).toBe(true);

    const tampered = { ...burn.receipt, signed: burn.receipt.signed.replace('delivered', 'expired') };
    expect(await verifyReceipt(tampered)).toBe(false);

    expect((await req(`/api/rooms/${room.id}/payload`, { token: recipientToken })).status).toBe(410);
    const after = await (await req(`/api/rooms/${room.id}`)).json();
    expect(after.state).toBe('burned');
    expect(after.padlock).toBeNull();
    expect(after.hasPayload).toBe(false);
  });

  it('lets the sender burn a room, and returns 404 for unknown rooms', async () => {
    const room = await post('/api/rooms', { fuse: '1h' });
    const burn = await post(`/api/rooms/${room.id}/burn`, { reason: 'mismatch' }, room.ownerToken);
    expect(burn.reason).toBe('mismatch');
    expect((await req(`/api/rooms/${room.id}/join`, { method: 'POST' })).status).toBe(410);
    expect((await req('/api/rooms/NOPE99')).status).toBe(404);
  });

  it('rejects padlocks of the wrong size and unknown phases', async () => {
    const room = await post('/api/rooms', {});
    const { recipientToken } = await post(`/api/rooms/${room.id}/join`, {});
    expect((await req(`/api/rooms/${room.id}/padlock`, { method: 'PUT', token: recipientToken, body: new Uint8Array(10) })).status).toBe(400);
    const bad = await req(`/api/rooms/${room.id}/phase`, {
      method: 'POST',
      token: recipientToken,
      body: JSON.stringify({ phase: '<script>' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });
});
