// ZeroSight courier: an in-memory, zero-knowledge relay.
// It only ever holds opaque bytes (the recipient's public padlock and a ciphertext
// envelope), relays presence/phase events over SSE, and burns each room on delivery,
// on request, or when its fuse runs out. Every burn produces an Ed25519-signed receipt.
import crypto from 'node:crypto';

export const FUSES = { '10m': 10 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 };
const PADLOCK_BYTES = 1184; // ML-KEM-768 public key
const MAX_PAYLOAD = 210 * 1024 * 1024;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
const PHASE_RE = /^[a-z][a-z-]{0,23}(:\d{1,3})?$/;
const BURN_REASONS = {
  sender: new Set(['sender-burned', 'mismatch']),
  recipient: new Set(['recipient-burned', 'lost-key']),
};

const signer = crypto.generateKeyPairSync('ed25519');
const serverJwk = signer.publicKey.export({ format: 'jwk' });

/** @type {Map<string, any>} */
const rooms = new Map();

function newId() {
  let id;
  do {
    id = '';
    for (const b of crypto.randomBytes(6)) id += ID_ALPHABET[b % 32];
  } while (rooms.has(id));
  return id;
}
const newToken = () => crypto.randomBytes(24).toString('base64url');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too-large', 'That is bigger than this courier carries.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 16 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-json', 'Malformed request.');
  }
}

function presence(room) {
  let sender = 0;
  let recipient = 0;
  for (const c of room.clients) {
    if (c.role === 'sender') sender++;
    if (c.role === 'recipient') recipient++;
  }
  return { senderOnline: sender > 0, recipientOnline: recipient > 0 };
}

function publicStatus(room) {
  return {
    id: room.id,
    state: room.state,
    fuse: room.fuse,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    hasRecipient: Boolean(room.recipientToken),
    padlock: room.padlock ? room.padlock.toString('base64') : null,
    padlockVersion: room.padlockVersion,
    hasPayload: Boolean(room.payload),
    payloadBytes: room.payloadBytes,
    phases: room.phases,
    burn: room.burn,
    ...presence(room),
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function emit(room, event, data) {
  for (const c of room.clients) send(c.res, event, data);
}

export function burnRoom(room, reason) {
  if (room.state === 'burned') return room.burn;
  const body = {
    v: 1,
    roomId: room.id,
    reason,
    burnedAt: new Date().toISOString(),
    ciphertextBytes: room.payloadBytes,
    ciphertextSha256: room.payloadSha256,
    statement:
      'The ZeroSight courier deleted every byte it held for this room: the ciphertext envelope and the recipient padlock. It never held a decryption key. This receipt cannot cover copies the recipient saved after opening the file.',
  };
  const signed = JSON.stringify(body);
  const signature = crypto.sign(null, Buffer.from(signed), signer.privateKey).toString('base64');
  room.payload = null;
  room.padlock = null;
  room.state = 'burned';
  room.burn = { at: body.burnedAt, reason, receipt: { body, signed, signature, alg: 'Ed25519', serverKey: serverJwk } };
  clearTimeout(room.timer);
  emit(room, 'burned', room.burn);
  return room.burn;
}

export function createRoom(fuseLabel) {
  const fuse = Object.hasOwn(FUSES, fuseLabel) ? fuseLabel : '24h';
  const now = Date.now();
  const room = {
    id: newId(),
    ownerToken: newToken(),
    recipientToken: null,
    fuse,
    createdAt: now,
    expiresAt: now + FUSES[fuse],
    state: 'open',
    padlock: null,
    padlockVersion: 0,
    payload: null,
    payloadBytes: 0,
    payloadSha256: null,
    uploading: false,
    phases: { sender: null, recipient: null },
    clients: new Set(),
    burn: null,
    timer: null,
  };
  room.timer = setTimeout(() => burnRoom(room, 'expired'), FUSES[fuse]);
  room.timer.unref?.();
  rooms.set(room.id, room);
  return room;
}

function requireOpen(room) {
  if (room.state === 'burned') throw new HttpError(410, 'burned', 'This room has burned.');
}

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', id, action]

  if (req.method === 'GET' && url.pathname === '/api/server-key') {
    return json(res, 200, { alg: 'Ed25519', jwk: serverJwk });
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const { fuse } = await readJson(req);
    const room = createRoom(fuse);
    return json(res, 201, { id: room.id, ownerToken: room.ownerToken, expiresAt: room.expiresAt, fuse: room.fuse });
  }
  if (parts[1] !== 'rooms' || !parts[2] || parts.length > 4) throw new HttpError(404, 'no-route', 'Unknown endpoint.');

  const room = rooms.get(parts[2].toUpperCase());
  if (!room) throw new HttpError(404, 'not-found', 'No room here.');
  const action = parts[3] || '';
  const token = url.searchParams.get('token') || req.headers['x-zs-token'] || '';
  const role = token && token === room.ownerToken ? 'sender' : token && token === room.recipientToken ? 'recipient' : null;
  const need = (...roles) => {
    if (!roles.includes(role)) throw new HttpError(403, 'forbidden', 'This link does not give you that power.');
  };

  switch (`${req.method} ${action}`) {
    case 'GET ':
      return json(res, 200, publicStatus(room));

    case 'POST join': {
      requireOpen(room);
      if (room.recipientToken) throw new HttpError(409, 'claimed', 'This room already has a recipient.');
      room.recipientToken = newToken();
      emit(room, 'joined', {});
      return json(res, 200, { recipientToken: room.recipientToken });
    }

    case 'PUT padlock': {
      need('recipient');
      requireOpen(room);
      if (room.payload || room.uploading) throw new HttpError(409, 'sealed', 'The crate is already sealed with your old padlock.');
      const body = await readBody(req, 4096);
      if (body.length !== PADLOCK_BYTES) throw new HttpError(400, 'bad-padlock', 'That is not an ML-KEM-768 padlock.');
      room.padlock = body;
      room.padlockVersion += 1;
      emit(room, 'padlock', { padlock: body.toString('base64'), version: room.padlockVersion });
      return json(res, 200, { version: room.padlockVersion });
    }

    case 'POST phase': {
      need('sender', 'recipient');
      requireOpen(room);
      const { phase } = await readJson(req);
      if (typeof phase !== 'string' || !PHASE_RE.test(phase)) throw new HttpError(400, 'bad-phase', 'Unknown phase.');
      room.phases[role] = { phase, at: Date.now() };
      emit(room, 'phase', { role, phase });
      res.writeHead(204).end();
      return;
    }

    case 'PUT payload': {
      need('sender');
      requireOpen(room);
      if (!room.padlock) throw new HttpError(409, 'no-padlock', 'The recipient has no padlock yet.');
      if (room.payload || room.uploading) throw new HttpError(409, 'already-sent', 'This room already holds a crate.');
      room.uploading = true;
      let body;
      try {
        body = await readBody(req, MAX_PAYLOAD);
      } finally {
        room.uploading = false;
      }
      if (room.state === 'burned') throw new HttpError(410, 'burned', 'The room burned while sending.');
      room.payload = body;
      room.payloadBytes = body.length;
      room.payloadSha256 = crypto.createHash('sha256').update(body).digest('hex');
      emit(room, 'payload', { bytes: room.payloadBytes, sha256: room.payloadSha256 });
      return json(res, 200, { bytes: room.payloadBytes, sha256: room.payloadSha256 });
    }

    case 'GET payload': {
      need('recipient');
      requireOpen(room);
      if (!room.payload) throw new HttpError(404, 'no-payload', 'Nothing has been sealed yet.');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': room.payload.length,
        'Cache-Control': 'no-store',
      });
      res.end(room.payload);
      return;
    }

    case 'POST ack': {
      need('recipient');
      requireOpen(room);
      if (!room.payload) throw new HttpError(409, 'no-payload', 'Nothing to acknowledge.');
      const { ok } = await readJson(req);
      return json(res, 200, burnRoom(room, ok === true ? 'delivered' : 'tampered'));
    }

    case 'POST burn': {
      need('sender', 'recipient');
      const { reason } = await readJson(req);
      if (room.state === 'burned') return json(res, 200, room.burn);
      if (!BURN_REASONS[role].has(reason)) throw new HttpError(400, 'bad-reason', 'Unknown burn reason.');
      return json(res, 200, burnRoom(room, reason));
    }

    case 'GET events': {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { res, role: role || 'viewer' };
      room.clients.add(client);
      send(res, 'status', publicStatus(room));
      emit(room, 'presence', presence(room));
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        room.clients.delete(client);
        emit(room, 'presence', presence(room));
      });
      return;
    }

    default:
      throw new HttpError(404, 'no-route', 'Unknown endpoint.');
  }
}

/** Connect/Node-style handler. Resolves true when the request was an API call. */
export async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://courier.local');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    await route(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[courier]', err);
    if (!res.headersSent) json(res, status, { error: err.code || 'server', message: status === 500 ? 'Courier error.' : err.message });
    else res.end();
  }
  return true;
}
