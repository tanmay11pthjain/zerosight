// ZeroSight client crypto (v2). Runs only in the browser. The server never sees
// the file key, the link secret, file names, or a single readable byte.
//
//   fileKey  = SHA-256(120 mouse points + CPU timing samples) XOR getRandomValues(32)
//   per file = HKDF(fileKey, "zs/v2/file/<i>")  -> AES-256-GCM per part
//              IV = 8 random bytes (per file) || part number; AAD binds file, part, last flag
//   manifest = AES-256-GCM under HKDF(fileKey, "zs/v2/manifest"): names, types, sizes
//   keybox   = ML-KEM-768 encapsulate(receiver padlock) -> shared secret
//              wrapKey = HKDF(sharedSecret || linkSecret, salt = roomId || SHA-256(padlock))
//              keybox  = kemCiphertext (1088) || iv (12) || AES-GCM(fileKey) (48)
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { WORDS } from './words';

export const MOUSE_POINTS = 120;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class SealBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealBrokenError';
  }
}

// ---------- bytes ----------
export function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
export function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
export const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (u: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', buf(u)));

/** 256-bit secret that lives only in the link fragment (#...), never sent to the server. */
export const makeLinkSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// ---------- key generation: mouse + CPU ----------
export class EntropyPool {
  private seen = new Set<string>();
  private mouse: number[] = [];
  private cpu: number[] = [];
  /** Adds a pointer sample; returns the number of distinct points so far. */
  addPoint(x: number, y: number, t: number): number {
    const k = `${Math.round(x)},${Math.round(y)}`;
    if (!this.seen.has(k) && this.seen.size < MOUSE_POINTS) {
      this.seen.add(k);
      this.mouse.push(x, y, t);
    }
    return this.seen.size;
  }
  addCpu(sample: number) {
    if (this.cpu.length < 4096) this.cpu.push(sample);
  }
  get points() {
    return this.seen.size;
  }
  get cpuSamples() {
    return this.cpu.length;
  }
  /** CPU timing jitter: how long short hash runs actually take on this machine right now. */
  async sampleCpu(runs = 64) {
    const block = crypto.getRandomValues(new Uint8Array(4096));
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await crypto.subtle.digest('SHA-256', block);
      this.addCpu(performance.now() - t0);
    }
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(new Float64Array([...this.mouse, ...this.cpu]).buffer);
    this.mouse.fill(0);
    this.cpu.fill(0);
    return out;
  }
}

/** The browser's random generator carries the 256-bit guarantee; mouse + CPU data is mixed on top. */
export async function forgeKey(pool: EntropyPool): Promise<Uint8Array> {
  const raw = pool.bytes();
  const digest = await sha256(raw);
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = digest[i] ^ rnd[i];
  raw.fill(0);
  digest.fill(0);
  rnd.fill(0);
  return key;
}

async function hkdfKey(ikm: Uint8Array, salt: Uint8Array, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, usages);
}
const NO_SALT = new Uint8Array(32);
export const fileCipherKey = (fileKey: Uint8Array, index: number) => hkdfKey(fileKey, NO_SALT, `zs/v2/file/${index}`, ['encrypt', 'decrypt']);
const manifestKey = (fileKey: Uint8Array) => hkdfKey(fileKey, NO_SALT, 'zs/v2/manifest', ['encrypt', 'decrypt']);

// ---------- parts ----------
function partIv(prefix: Uint8Array, part: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, part);
  return iv;
}
const partAad = (file: number, part: number, last: boolean) => enc.encode(`zs/v2|f${file}|p${part}|${last ? 1 : 0}`);

export async function encryptPart(key: CryptoKey, prefix: Uint8Array, file: number, part: number, last: boolean, plain: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: partIv(prefix, part), additionalData: partAad(file, part, last) }, key, plain));
}
export async function decryptPart(key: CryptoKey, prefix: Uint8Array, file: number, part: number, last: boolean, cipher: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: partIv(prefix, part), additionalData: partAad(file, part, last) }, key, buf(cipher)));
  } catch {
    throw new SealBrokenError(`Part ${part} of file ${file + 1} failed its integrity check.`);
  }
}

// ---------- manifest ----------
export interface ManifestFile {
  name: string;
  type: string;
  size: number;
  partSize: number;
  partCount: number;
  ivPrefix: string;
}
export interface Manifest {
  v: 2;
  files: ManifestFile[];
}
export async function sealManifest(fileKey: Uint8Array, m: Manifest): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('zs/v2|manifest') }, await manifestKey(fileKey), enc.encode(JSON.stringify(m))));
  return concat(iv, ct);
}
export async function openManifest(fileKey: Uint8Array, bytes: Uint8Array): Promise<Manifest> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(bytes.subarray(0, 12)), additionalData: enc.encode('zs/v2|manifest') },
      await manifestKey(fileKey),
      buf(bytes.subarray(12)),
    );
    const m = JSON.parse(dec.decode(plain)) as Manifest;
    if (m.v !== 2 || !Array.isArray(m.files)) throw new Error('version');
    return m;
  } catch {
    throw new SealBrokenError('The file list failed its integrity check.');
  }
}

// ---------- padlock (receiver's ML-KEM-768 key pair) + keybox ----------
export function makePadlock(): { padlock: Uint8Array; secretKey: Uint8Array } {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { padlock: publicKey, secretKey };
}

/** Six words from the padlock fingerprint. Both sides see the same words if nobody swapped it. */
export async function checkWords(padlock: Uint8Array): Promise<string[]> {
  return Array.from((await sha256(padlock)).subarray(0, 6), (b) => WORDS[b]);
}

async function wrapKeyFor(sharedSecret: Uint8Array, linkSecret: string, roomId: string, padlock: Uint8Array) {
  const ikm = concat(sharedSecret, unb64url(linkSecret));
  const salt = concat(enc.encode(roomId), await sha256(padlock));
  const k = await hkdfKey(ikm, salt, 'zs/v2/seal', ['encrypt', 'decrypt']);
  ikm.fill(0);
  return k;
}

export async function sealKeybox(fileKey: Uint8Array, padlock: Uint8Array, linkSecret: string, roomId: string): Promise<Uint8Array> {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(padlock);
  const k = await wrapKeyFor(sharedSecret, linkSecret, roomId, padlock);
  sharedSecret.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf(fileKey)));
  return concat(cipherText, iv, ct);
}

export async function openKeybox(keybox: Uint8Array, secretKey: Uint8Array, padlock: Uint8Array, linkSecret: string, roomId: string): Promise<Uint8Array> {
  if (keybox.length !== 1148) throw new SealBrokenError('The key box is damaged.');
  try {
    const ss = ml_kem768.decapsulate(keybox.subarray(0, 1088), secretKey.slice());
    const k = await wrapKeyFor(ss, linkSecret, roomId, padlock);
    ss.fill(0);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(keybox.subarray(1088, 1100)) }, k, buf(keybox.subarray(1100))));
  } catch {
    throw new SealBrokenError('The key box did not open. The link may be wrong, or someone swapped your padlock.');
  }
}

// ---------- receipts ----------
export interface Receipt {
  body: { v: 1; roomId: string; reason: string; burnedAt: string; fileCount: number; ciphertextBytes: number; statement: string };
  signed: string;
  signature: string;
  alg: 'Ed25519';
  serverKey: JsonWebKey;
}
/** true = valid, false = invalid, null = this browser can't check Ed25519. */
export async function verifyReceipt(r: Receipt): Promise<boolean | null> {
  try {
    const k = await crypto.subtle.importKey('jwk', r.serverKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, k, buf(unb64(r.signature)), enc.encode(r.signed));
  } catch {
    return null;
  }
}
