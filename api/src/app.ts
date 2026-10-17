// ZeroSight API. Coordinates rooms; never sees plaintext, file keys or the link secret.
// File bytes go browser <-> storage through presigned URLs.
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as edSign, type KeyObject } from "node:crypto";
type JsonWebKey = Record<string, unknown>;
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { partPlan, type Config } from './config.ts';
import { n, type Db, type Query } from './db.ts';
import type { MemoryStorage } from './storage/memory.ts';
import type { Storage } from './storage/types.ts';

const FUSES: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000 };
const ROOM_RE = /^[0-9a-f]{64}$/;
const PADLOCK_B64_LEN = 1580; // 1,184 bytes
const KEYBOX_B64_LEN = 1532; // 1,088 KEM ciphertext + 12 IV + 48 sealed key
const MAX_MANIFEST = 1024 * 1024;

type Role = { kind: 'owner' } | { kind: 'receiver'; id: string };
class HttpError extends Error {
  status: number;
  code: string;
  extra?: object;
  constructor(status: number, code: string, message: string, extra?: object) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const month = () => new Date().toISOString().slice(0, 7);

// ---------------- events (single instance, in-process fan-out) ----------------
type Client = { role: Role; write: (event: string, data: unknown) => void };
class Hub {
  private rooms = new Map<string, Set<Client>>();
  add(id: string, c: Client) {
    if (!this.rooms.has(id)) this.rooms.set(id, new Set());
    this.rooms.get(id)!.add(c);
    return () => {
      const s = this.rooms.get(id);
      s?.delete(c);
      if (s && !s.size) this.rooms.delete(id);
    };
  }
  emit(id: string, event: string, data: unknown, to?: (r: Role) => boolean) {
    for (const c of this.rooms.get(id) ?? []) if (!to || to(c.role)) c.write(event, data);
  }
  ownerOnline(id: string) {
    return [...(this.rooms.get(id) ?? [])].some((c) => c.role.kind === 'owner');
  }
}

// ---------------- receipts ----------------
function loadSigner(pem: string | undefined, warn: (m: string) => void): { priv: KeyObject; jwk: JsonWebKey } {
  let priv: KeyObject;
  if (pem) {
    const text = pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf8');
    priv = createPrivateKey(text);
  } else {
    warn('RECEIPT_SIGNING_KEY not set: using a temporary key. Receipts will not verify after a restart.');
    priv = generateKeyPairSync('ed25519').privateKey;
  }
  return { priv, jwk: createPublicKey(priv).export({ format: 'jwk' }) as JsonWebKey };
}

export interface Deps {
  config: Config;
  db: Db;
  storage: Storage;
  verifyHuman?: (token: string | undefined, ip: string) => Promise<boolean>;
  /** Built web app (web/dist). When present, one server serves the app and the API on one URL. */
  webDist?: string;
}

export async function buildApp({ config, db, storage, verifyHuman, webDist }: Deps): Promise<FastifyInstance & { sweep: () => Promise<void> }> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization'],
      serializers: { req: (r: FastifyRequest) => ({ method: r.method, url: r.url.split('?')[0] }) },
    },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  const hub = new Hub();
  const signer = loadSigner(config.receiptKey, (m) => app.log.warn(m));

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin) || config.allowedOrigins.includes('*')),
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['content-type', 'authorization', 'x-turnstile'],
    maxAge: 600,
  });
  await app.register(rateLimit, { global: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_r, body, done) => done(null, body));

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate-limited', message: 'Too many requests. Wait a minute and try again.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad-request', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'server', message: 'Something went wrong on our side.' });
  });

  // ---------------- helpers ----------------
  const human = async (req: FastifyRequest) => {
    if (!verifyHuman) return;
    if (!(await verifyHuman(req.headers['x-turnstile'] as string | undefined, req.ip))) throw new HttpError(403, 'not-human', 'Human check failed. Reload the page and try again.');
  };
  const roomId = (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    if (!ROOM_RE.test(id)) throw new HttpError(404, 'not-found', 'This link does not match any transfer.');
    return id;
  };
  async function getRoom(q: Query, id: string, lock = false) {
    const r = (await q(`SELECT * FROM rooms WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]))[0];
    if (!r) throw new HttpError(404, 'not-found', 'This link does not match any transfer.');
    return r;
  }
  async function auth(req: FastifyRequest, id: string): Promise<Role> {
    const h = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!h) throw new HttpError(401, 'no-token', 'Missing access token.');
    const hash = sha(h);
    const room = (await db.query('SELECT owner_hash FROM rooms WHERE id=$1', [id]))[0];
    if (room && room.owner_hash === hash) return { kind: 'owner' };
    const rec = (await db.query('SELECT id FROM receivers WHERE room_id=$1 AND token_hash=$2', [id, hash]))[0];
    if (rec) return { kind: 'receiver', id: rec.id };
    throw new HttpError(403, 'forbidden', 'This link does not give you access.');
  }
  const need = <K extends Role['kind']>(r: Role, kind: K): Extract<Role, { kind: K }> => {
    if (r.kind !== kind) throw new HttpError(403, 'forbidden', 'Not allowed.');
    return r as Extract<Role, { kind: K }>;
  };
  const open = (room: any) => {
    if (room.state === 'burned') throw new HttpError(410, 'burned', 'This transfer has been destroyed.', { burn: burnInfo(room) });
  };
  const burnInfo = (room: any) => (room.state === 'burned' ? { reason: room.burn_reason, at: n(room.burned_at), receipt: room.receipt } : null);
  const publicRoom = async (room: any) => {
    const joined = n((await db.query('SELECT count(*) AS c FROM receivers WHERE room_id=$1', [room.id]))[0].c);
    return {
      id: room.id,
      state: room.state,
      fileCount: room.file_count,
      totalBytes: n(room.total_bytes),
      maxReceivers: room.max_receivers,
      joined,
      askFirst: room.ask_first,
      fuseEndsAt: room.fuse_ends_at ? n(room.fuse_ends_at) : null,
      senderOnline: hub.ownerOnline(room.id),
      burn: burnInfo(room),
    };
  };

  /** Marks the room burned inside the caller's transaction. Returns true if it changed. */
  async function burnTx(q: Query, room: any, reason: string) {
    if (room.state === 'burned') return false;
    const body = {
      v: 1,
      roomId: room.id,
      reason,
      burnedAt: new Date().toISOString(),
      fileCount: room.file_count,
      ciphertextBytes: n(room.total_bytes),
      statement:
        'The ZeroSight server deleted every stored byte for this transfer (encrypted file parts, file list, receiver keys). It never held a key that could decrypt them. This record cannot cover copies a receiver saved.',
    };
    const signed = JSON.stringify(body);
    const receipt = { body, signed, signature: edSign(null, Buffer.from(signed), signer.priv).toString('base64'), alg: 'Ed25519', serverKey: signer.jwk };
    await q(`UPDATE rooms SET state='burned', burn_reason=$2, burned_at=$3, receipt=$4 WHERE id=$1`, [room.id, reason, Date.now(), JSON.stringify(receipt)]);
    await q(`UPDATE receivers SET padlock=NULL, keybox=NULL WHERE room_id=$1`, [room.id]);
    room.state = 'burned';
    room.burn_reason = reason;
    room.burned_at = Date.now();
    room.receipt = receipt;
    return true;
  }
  /** After commit: tell everyone, then delete storage (retried by the sweeper if it fails). */
  async function afterBurn(room: any) {
    hub.emit(room.id, 'burned', burnInfo(room));
    await purge(room.id);
  }
  async function purge(id: string) {
    try {
      await storage.deletePrefix(`rooms/${id}/`);
      await db.query('UPDATE rooms SET purged=true WHERE id=$1', [id]);
    } catch (e) {
      app.log.error({ err: e, room: id.slice(0, 8) }, 'purge failed, will retry');
    }
  }
  async function burn(id: string, reason: string) {
    const room = await db.tx(async (q) => {
      const r = await getRoom(q, id, true);
      return (await burnTx(q, r, reason)) ? r : null;
    });
    if (room) await afterBurn(room);
    return room;
  }
  async function addEgress(bytes: number) {
    const key = `egress:${month()}`;
    const v = n((await db.query(`INSERT INTO meta(k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = meta.v + $2 RETURNING v`, [key, bytes]))[0].v);
    if (v > config.monthlyEgressLimitGb * 1024 ** 3) throw new HttpError(503, 'capacity', 'ZeroSight has reached its download limit for this month.');
  }

  // ---------------- routes ----------------
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ maxRoomBytes: config.maxRoomBytes, maxFiles: config.maxFiles, maxReceivers: config.maxReceivers, receiptKey: signer.jwk }));

  app.post('/api/rooms', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    await human(req);
    const b = (req.body ?? {}) as { maxReceivers?: number; fuse?: string; askFirst?: boolean; files?: { size: number }[] };
    // Product rule: exactly one recipient, exactly one download. Not configurable.
    const maxReceivers = 1;
    const fuseMs = FUSES[b.fuse ?? '1h'];
    if (!fuseMs) throw new HttpError(400, 'bad-fuse', 'Unknown delete timer.');
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length || files.length > config.maxFiles) throw new HttpError(400, 'bad-files', `Choose 1 to ${config.maxFiles} files.`);
    if (files.some((f) => !Number.isSafeInteger(f?.size) || f.size < 0)) throw new HttpError(400, 'bad-files', 'Bad file size.');
    const plans = files.map((f) => partPlan(f.size, config.minPartSize));
    const total = plans.reduce((s, p) => s + p.cipherBytes, 0);
    if (total > config.maxRoomBytes) throw new HttpError(413, 'too-big', `This transfer is ${(total / 1024 ** 3).toFixed(2)} GB. The limit is ${(config.maxRoomBytes / 1024 ** 3).toFixed(1)} GB.`);
    const stored = n((await db.query(`SELECT coalesce(sum(total_bytes),0) AS s FROM rooms WHERE purged=false`))[0].s);
    if (stored + total > config.maxStoredBytes) throw new HttpError(503, 'capacity', 'ZeroSight is at capacity right now. Try again later.');

    const id = randomBytes(32).toString('hex');
    const owner = token();
    const now = Date.now();
    // Upload deadline: 20 minutes plus one minute per 50 MB, capped at 6 hours.
    const deadline = now + Math.min(6 * 3_600_000, 20 * 60_000 + Math.ceil(total / (50 * 1024 * 1024)) * 60_000);
    const uploads = await Promise.all(plans.map((_, i) => storage.createMultipart(`rooms/${id}/${i}.enc`)));
    await db.tx(async (q) => {
      await q(
        `INSERT INTO rooms(id, owner_hash, max_receivers, ask_first, fuse_ms, created_at, upload_deadline, sender_seen_at, state, file_count, total_bytes, manifest_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'uploading',$8,$9,0)`,
        [id, sha(owner), maxReceivers, false, fuseMs, now, deadline, files.length, total],
      );
      for (const [i, p] of plans.entries()) {
        await q(`INSERT INTO objects(room_id, idx, s3_key, upload_id, plain_size, part_size, part_count, cipher_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          id,
          i,
          `rooms/${id}/${i}.enc`,
          uploads[i],
          files[i].size,
          p.partSize,
          p.partCount,
          p.cipherBytes,
        ]);
      }
    });
    reply.code(201);
    return { roomId: id, ownerToken: owner, files: plans.map((p, i) => ({ index: i, partSize: p.partSize, partCount: p.partCount })) };
  });

  app.get('/api/rooms/:id', async (req) => publicRoom(await getRoom(db.query, roomId(req))));

  // Owner: presigned URLs for upload parts.
  app.post('/api/rooms/:id/files/:idx/parts', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    const room = await getRoom(db.query, id);
    open(room);
    const idx = Number((req.params as { idx: string }).idx);
    const obj = (await db.query('SELECT * FROM objects WHERE room_id=$1 AND idx=$2', [id, idx]))[0];
    if (!obj) throw new HttpError(404, 'no-file', 'Unknown file.');
    const parts = ((req.body as { parts?: number[] })?.parts ?? []).slice(0, 100);
    const sizes = cipherPartSizes(obj);
    const urls = await Promise.all(
      parts.map((p) => {
        if (!Number.isInteger(p) || p < 1 || p > sizes.length) throw new HttpError(400, 'bad-part', 'Bad part number.');
        return storage.presignPart(obj.s3_key, obj.upload_id, p, sizes[p - 1]).then((url) => ({ part: p, url }));
      }),
    );
    return { urls };
  });

  app.post('/api/rooms/:id/files/:idx/complete', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    open(await getRoom(db.query, id));
    const idx = Number((req.params as { idx: string }).idx);
    const obj = (await db.query('SELECT * FROM objects WHERE room_id=$1 AND idx=$2', [id, idx]))[0];
    if (!obj) throw new HttpError(404, 'no-file', 'Unknown file.');
    if (!obj.completed) {
      try {
        await storage.completeMultipart(obj.s3_key, obj.upload_id, cipherPartSizes(obj));
      } catch (e) {
        throw new HttpError(409, 'incomplete', (e as Error).message);
      }
      await db.query('UPDATE objects SET completed=true WHERE room_id=$1 AND idx=$2', [id, idx]);
    }
    return { ok: true };
  });

  app.post('/api/rooms/:id/manifest', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    open(await getRoom(db.query, id));
    const size = Number((req.body as { size?: number })?.size);
    if (!Number.isInteger(size) || size < 28 || size > MAX_MANIFEST) throw new HttpError(400, 'bad-manifest', 'Bad manifest size.');
    await db.query('UPDATE rooms SET manifest_bytes=$2 WHERE id=$1', [id, size]);
    return { url: await storage.presignPut(`rooms/${id}/manifest.enc`, size) };
  });

  // Owner: everything uploaded. The delete timer starts now.
  app.post('/api/rooms/:id/finalize', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    const room = await getRoom(db.query, id);
    open(room);
    if (room.state === 'ready') return { ok: true, fuseEndsAt: n(room.fuse_ends_at) };
    const pending = n((await db.query('SELECT count(*) AS c FROM objects WHERE room_id=$1 AND completed=false', [id]))[0].c);
    if (pending) throw new HttpError(409, 'incomplete', 'Some files have not finished uploading.');
    const msize = await storage.size(`rooms/${id}/manifest.enc`);
    if (msize === null || msize !== room.manifest_bytes) throw new HttpError(409, 'incomplete', 'The file list has not been uploaded.');
    const fuseEndsAt = Date.now() + n(room.fuse_ms);
    await db.query(`UPDATE rooms SET state='ready', manifest_done=true, fuse_ends_at=$2 WHERE id=$1 AND state='uploading'`, [id, fuseEndsAt]);
    hub.emit(id, 'ready', { fuseEndsAt });
    return { ok: true, fuseEndsAt };
  });

  // Receiver: the counted login. One extra login destroys the room (Red Alert).
  app.post('/api/rooms/:id/join', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = roomId(req);
    await human(req);
    const device = String((req.body as { device?: string })?.device ?? '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(device)) throw new HttpError(400, 'bad-device', 'Bad device id.');
    const tok = token();
    const out = await db.tx(async (q) => {
      const room = await getRoom(q, id, true);
      if (room.state === 'burned') return { kind: 'burned' as const, room };
      const same = (await q('SELECT id FROM receivers WHERE room_id=$1 AND device_hash=$2', [id, sha(device)]))[0];
      if (same) return { kind: 'same' as const };
      const count = n((await q('SELECT count(*) AS c FROM receivers WHERE room_id=$1', [id]))[0].c);
      if (count < room.max_receivers) {
        const rid = randomUUID();
        await q('INSERT INTO receivers(id, room_id, token_hash, device_hash, joined_at) VALUES ($1,$2,$3,$4,$5)', [rid, id, sha(tok), sha(device), Date.now()]);
        return { kind: 'joined' as const, rid, joined: count + 1, max: room.max_receivers };
      }
      await burnTx(q, room, 'red-alert');
      return { kind: 'alert' as const, room };
    });
    if (out.kind === 'joined') {
      hub.emit(id, 'joined', { receiverId: out.rid, joined: out.joined, max: out.max });
      return { receiverId: out.rid, token: tok };
    }
    if (out.kind === 'same') throw new HttpError(409, 'same-device', 'This browser already opened the link.');
    if (out.kind === 'burned') {
      hub.emit(id, 'late-open', { at: Date.now() }, (r) => r.kind === 'owner');
      throw new HttpError(410, 'burned', 'This transfer has been destroyed.', { burn: burnInfo(out.room) });
    }
    void afterBurn(out.room);
    reply.code(423);
    return { error: 'red-alert', message: 'This link was opened more times than the sender allowed. Everything was destroyed.', burn: burnInfo(out.room) };
  });

  // Receiver: post the ML-KEM-768 public key ("padlock").
  app.put('/api/rooms/:id/padlock', async (req) => {
    const id = roomId(req);
    const me = need(await auth(req, id), 'receiver');
    open(await getRoom(db.query, id));
    const padlock = String((req.body as { padlock?: string })?.padlock ?? '');
    if (padlock.length !== PADLOCK_B64_LEN || !/^[A-Za-z0-9+/=]+$/.test(padlock)) throw new HttpError(400, 'bad-padlock', 'That is not an ML-KEM-768 public key.');
    const r = (await db.query('SELECT keybox FROM receivers WHERE id=$1', [me.id]))[0];
    if (r.keybox) throw new HttpError(409, 'keyed', 'Your key was already delivered.');
    await db.query('UPDATE receivers SET padlock=$2 WHERE id=$1', [me.id, padlock]);
    hub.emit(id, 'padlock', { receiverId: me.id, padlock }, (x) => x.kind === 'owner');
    return { ok: true };
  });

  // Owner: deliver a receiver's sealed key (also = approval in ask-first mode).
  app.post('/api/rooms/:id/keybox', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    open(await getRoom(db.query, id));
    const { receiverId, keybox } = (req.body ?? {}) as { receiverId?: string; keybox?: string };
    if (String(keybox ?? '').length !== KEYBOX_B64_LEN) throw new HttpError(400, 'bad-keybox', 'Bad key box.');
    const r = (await db.query('SELECT * FROM receivers WHERE id=$1 AND room_id=$2', [receiverId, id]))[0];
    if (!r || !r.padlock || r.blocked) throw new HttpError(409, 'no-padlock', 'That receiver is not ready.');
    await db.query('UPDATE receivers SET keybox=$2 WHERE id=$1', [receiverId, keybox]);
    hub.emit(id, 'keybox', { keybox }, (x) => x.kind === 'receiver' && x.id === receiverId);
    hub.emit(id, 'keyed', { receiverId }, (x) => x.kind === 'owner');
    return { ok: true };
  });

  // Owner (ask-first): refuse a receiver. Destroys the transfer.
  app.post('/api/rooms/:id/block', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    await burn(id, 'blocked');
    return { ok: true };
  });

  app.post('/api/rooms/:id/heartbeat', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    await db.query('UPDATE rooms SET sender_seen_at=$2 WHERE id=$1', [id, Date.now()]);
    return { ok: true };
  });

  // Owner or receiver: everything they are allowed to know right now.
  app.get('/api/rooms/:id/me', async (req) => {
    const id = roomId(req);
    const role = await auth(req, id);
    const room = await getRoom(db.query, id);
    const base = await publicRoom(room);
    if (role.kind === 'owner') {
      const rs = await db.query('SELECT id, padlock, keybox IS NOT NULL AS keyed, acked_at FROM receivers WHERE room_id=$1 ORDER BY joined_at', [id]);
      return { ...base, role: 'owner', receivers: rs.map((r) => ({ id: r.id, padlock: r.padlock, keyed: r.keyed, done: Boolean(r.acked_at) })) };
    }
    const r = (await db.query('SELECT keybox, padlock IS NOT NULL AS has_padlock FROM receivers WHERE id=$1', [role.id]))[0];
    return { ...base, role: 'receiver', receiverId: role.id, keybox: r.keybox, hasPadlock: r.has_padlock };
  });

  // Receiver: presigned GETs (manifest or file parts), within the egress budget.
  app.post('/api/rooms/:id/download', async (req) => {
    const id = roomId(req);
    const me = need(await auth(req, id), 'receiver');
    const room = await getRoom(db.query, id);
    open(room);
    if (room.state !== 'ready') throw new HttpError(409, 'not-ready', 'The files are still arriving.');
    const r = (await db.query('SELECT keybox, egress_bytes FROM receivers WHERE id=$1', [me.id]))[0];
    if (!r.keybox) throw new HttpError(409, 'no-key', 'Waiting for the sender to hand over your key.');
    const b = (req.body ?? {}) as { manifest?: boolean; file?: number; parts?: number[] };
    if (b.manifest) {
      await addEgress(room.manifest_bytes);
      return { url: await storage.presignGet(`rooms/${id}/manifest.enc`), size: room.manifest_bytes };
    }
    const obj = (await db.query('SELECT * FROM objects WHERE room_id=$1 AND idx=$2', [id, b.file]))[0];
    if (!obj) throw new HttpError(404, 'no-file', 'Unknown file.');
    const sizes = cipherPartSizes(obj);
    const parts = (b.parts ?? []).slice(0, 100);
    if (parts.some((p) => !Number.isInteger(p) || p < 1 || p > sizes.length)) throw new HttpError(400, 'bad-part', 'Bad part number.');
    const bytes = parts.reduce((s, p) => s + sizes[p - 1], 0);
    const budget = Math.ceil(n(room.total_bytes) * 1.2) + 1024 * 1024;
    const used = n((await db.query('UPDATE receivers SET egress_bytes = egress_bytes + $2 WHERE id=$1 RETURNING egress_bytes', [me.id, bytes]))[0].egress_bytes);
    if (used > budget) throw new HttpError(429, 'budget', 'Download limit for this transfer reached.');
    await addEgress(bytes);
    return { urls: await Promise.all(parts.map(async (p) => ({ part: p, size: sizes[p - 1], url: await storage.presignGet(obj.s3_key, p) }))) };
  });

  // Receiver: finished (ok) or found tampering (not ok).
  app.post('/api/rooms/:id/ack', async (req) => {
    const id = roomId(req);
    const me = need(await auth(req, id), 'receiver');
    const ok = (req.body as { ok?: boolean })?.ok === true;
    const room = await db.tx(async (q) => {
      const r = await getRoom(q, id, true);
      if (r.state === 'burned') return null;
      await q('UPDATE receivers SET acked_at=$2, ack_ok=$3 WHERE id=$1', [me.id, Date.now(), ok]);
      if (!ok) return (await burnTx(q, r, 'tampered')) ? r : null;
      const done = n((await q('SELECT count(*) AS c FROM receivers WHERE room_id=$1 AND ack_ok=true', [id]))[0].c);
      if (done >= r.max_receivers) return (await burnTx(q, r, 'delivered')) ? r : null;
      return null;
    });
    hub.emit(id, 'done', { receiverId: me.id, ok }, (x) => x.kind === 'owner');
    if (room) await afterBurn(room);
    return { ok: true, burned: Boolean(room) };
  });

  app.post('/api/rooms/:id/burn', async (req) => {
    const id = roomId(req);
    need(await auth(req, id), 'owner');
    await burn(id, 'sender');
    return { ok: true };
  });

  app.post('/api/rooms/:id/report', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    app.log.warn({ room: roomId(req).slice(0, 12), note: String((req.body as { note?: string })?.note ?? '').slice(0, 500) }, 'abuse report');
    return { ok: true };
  });

  app.post('/api/admin/rooms/:id/burn', async (req) => {
    if (!config.adminToken || req.headers['x-admin-token'] !== config.adminToken) throw new HttpError(403, 'forbidden', 'Not allowed.');
    await burn(roomId(req), 'admin');
    return { ok: true };
  });

  // Live events over SSE. Auth by header, so tokens never appear in URLs or logs.
  app.get('/api/rooms/:id/events', async (req, reply) => {
    const id = roomId(req);
    const role = await auth(req, id);
    const origin = req.headers.origin;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin && (config.allowedOrigins.includes(origin) || config.allowedOrigins.includes('*')) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const off = hub.add(id, { role, write });
    write('hello', { role: role.kind });
    if (role.kind === 'owner') {
      hub.emit(id, 'sender', { online: true }, (r) => r.kind === 'receiver');
      void db.query('UPDATE rooms SET sender_seen_at=$2 WHERE id=$1', [id, Date.now()]);
    }
    const ping = setInterval(() => {
      res.write(': ping\n\n');
      if (role.kind === 'owner') void db.query('UPDATE rooms SET sender_seen_at=$2 WHERE id=$1', [id, Date.now()]).catch(() => undefined);
    }, 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
      if (role.kind === 'owner' && !hub.ownerOnline(id)) hub.emit(id, 'sender', { online: false }, (r) => r.kind === 'receiver');
    });
  });

  // Local storage endpoints (STORAGE_TYPE=memory only): same presigned-URL contract as S3.
  if (storage.kind === 'memory') {
    const mem = storage as MemoryStorage;
    app.put('/api/local-store', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        mem.handlePut(req.query as Record<string, string>, req.body as Buffer);
      } catch (e) {
        throw new HttpError(403, 'storage', (e as Error).message);
      }
      return reply.code(200).header('ETag', '"local"').send();
    });
    app.get('/api/local-store', async (req, reply) => {
      try {
        return reply.type('application/octet-stream').send(mem.handleGet(req.query as Record<string, string>));
      } catch (e) {
        throw new HttpError(404, 'storage', (e as Error).message);
      }
    });
  }

  // ---------------- the web app (single-origin deploy) ----------------
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    const root = resolve(webDist);
    const TYPES: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.json': 'application/json',
    };
    const CSP =
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    app.get('/*', async (req, reply) => {
      const path = decodeURIComponent(req.url.split('?')[0]);
      if (path.startsWith('/api/')) throw new HttpError(404, 'no-route', 'Unknown endpoint.');
      let file = resolve(root, '.' + path);
      if ((file !== root && !file.startsWith(root + sep)) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
      const ext = extname(file);
      reply
        .header('Content-Type', TYPES[ext] ?? 'application/octet-stream')
        .header('Content-Security-Policy', CSP)
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.send(createReadStream(file));
    });
  }

  // ---------------- sweeper ----------------
  async function sweep() {
    const now = Date.now();
    const expired = await db.query(`SELECT id FROM rooms WHERE state='ready' AND fuse_ends_at < $1`, [now]);
    for (const r of expired) await burn(r.id, 'expired');
    const stalled = await db.query(`SELECT id FROM rooms WHERE state='uploading' AND upload_deadline < $1`, [now]);
    for (const r of stalled) await burn(r.id, 'upload-timeout');
    // Sender gone, nobody holds a key yet: the file key died with the sender's tab.
    const gone = await db.query(
      `SELECT r.id FROM rooms r WHERE r.state <> 'burned' AND r.sender_seen_at < $1
         AND NOT EXISTS (SELECT 1 FROM receivers x WHERE x.room_id = r.id AND x.keybox IS NOT NULL)`,
      [now - config.senderGraceMs],
    );
    for (const r of gone) if (!hub.ownerOnline(r.id)) await burn(r.id, 'sender-left');
    const unpurged = await db.query(`SELECT id FROM rooms WHERE state='burned' AND purged=false`);
    for (const r of unpurged) await purge(r.id);
    await db.query(`DELETE FROM rooms WHERE state='burned' AND purged=true AND burned_at < $1`, [now - 7 * 86_400_000]);
  }

  return Object.assign(app, { sweep }) as FastifyInstance & { sweep: () => Promise<void> };
}

/** Ciphertext size of each part: plaintext part + 16-byte GCM tag; the last part holds the remainder. */
export function cipherPartSizes(obj: Record<string, any>): number[] {
  const plain = n(obj.plain_size);
  const ps = n(obj.part_size);
  const count = n(obj.part_count);
  return Array.from({ length: count }, (_, i) => Math.min(ps, Math.max(0, plain - i * ps)) + 16);
}
