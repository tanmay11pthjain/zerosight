// Local stand-in for S3 with the same presigned-URL contract, served by the API
// at /api/local-store. Used for development and tests (STORAGE_TYPE unset).
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StorageError, type Storage } from './types.ts';

interface Upload {
  key: string;
  parts: Map<number, Buffer>;
}

export interface MemoryStorage extends Storage {
  handlePut(query: Record<string, string>, body: Buffer): void;
  handleGet(query: Record<string, string>): Buffer;
}

export function memoryStorage(publicUrl: string): MemoryStorage {
  const secret = randomBytes(32);
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Buffer[]>(); // key -> parts (single-part for plain PUT)
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('base64url');
  const url = (params: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, exp: String(Date.now() + 900_000) });
    q.set('sig', sign(q.toString()));
    return `${publicUrl}/api/local-store?${q}`;
  };
  const verify = (query: Record<string, string>) => {
    const { sig, ...rest } = query;
    const expect = Buffer.from(sign(new URLSearchParams(rest).toString()));
    const got = Buffer.from(sig ?? '');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new StorageError('Bad signature');
    if (Number(rest.exp) < Date.now()) throw new StorageError('URL expired');
    return rest;
  };

  return {
    kind: 'memory',
    async check() {},
    async createMultipart(key) {
      const id = randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return id;
    },
    async presignPart(key, uploadId, partNumber, size) {
      return url({ op: 'part', key, upload: uploadId, part: String(partNumber), size: String(size) });
    },
    async completeMultipart(key, uploadId, expected) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new StorageError('Unknown upload');
      const parts = expected.map((size, i) => {
        const p = u.parts.get(i + 1);
        if (!p || p.length !== size) throw new StorageError('Uploaded parts do not match the declared file size.');
        return p;
      });
      objects.set(key, parts);
      uploads.delete(uploadId);
    },
    async presignPut(key, size) {
      return url({ op: 'put', key, size: String(size) });
    },
    async size(key) {
      const o = objects.get(key);
      return o ? o.reduce((s, p) => s + p.length, 0) : null;
    },
    async presignGet(key, partNumber) {
      return url({ op: 'get', key, part: String(partNumber ?? 0) });
    },
    async deletePrefix(prefix) {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
      for (const [id, u] of uploads) if (u.key.startsWith(prefix)) uploads.delete(id);
    },
    handlePut(query, body) {
      const q = verify(query);
      if (body.length !== Number(q.size)) throw new StorageError('Content length does not match the signed size');
      if (q.op === 'part') {
        const u = uploads.get(q.upload);
        if (!u || u.key !== q.key) throw new StorageError('Unknown upload');
        u.parts.set(Number(q.part), body);
      } else if (q.op === 'put') {
        objects.set(q.key, [body]);
      } else throw new StorageError('Bad op');
    },
    handleGet(query) {
      const q = verify(query);
      const o = objects.get(q.key);
      if (!o || q.op !== 'get') throw new StorageError('Not found');
      const part = Number(q.part);
      return part ? (o[part - 1] ?? Buffer.alloc(0)) : Buffer.concat(o);
    },
  };
}
