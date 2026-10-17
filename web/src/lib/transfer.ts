// Upload and download engines. One streaming path for every size: memory stays flat
// (a few parts in flight), so 1 KB and 10 GB take the same route.
import { call, getBytes, putPart } from './api';
import { b64, decryptPart, encryptPart, fileCipherKey, openManifest, sealManifest, unb64, SealBrokenError, type Manifest } from './crypto';

export interface RoomFile {
  index: number;
  partSize: number;
  partCount: number;
}
export interface Progress {
  (file: number, doneBytes: number, totalBytes: number): void;
}

const PARALLEL = 4;

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/** Encrypt and upload every file, then the encrypted file list, then finalize the room. */
export async function uploadAll(
  roomId: string,
  ownerToken: string,
  fileKey: Uint8Array,
  files: File[],
  plan: RoomFile[],
  onProgress: Progress,
  cancelled: () => boolean,
): Promise<void> {
  const manifest: Manifest = { v: 2, files: [] };
  for (const [i, file] of files.entries()) {
    const p = plan[i];
    const prefix = crypto.getRandomValues(new Uint8Array(8));
    manifest.files.push({ name: file.name, type: file.type, size: file.size, partSize: p.partSize, partCount: p.partCount, ivPrefix: b64(prefix) });
    const key = await fileCipherKey(fileKey, i);
    const parts = Array.from({ length: p.partCount }, (_, k) => k + 1);
    const urls = new Map<number, string>();
    const fetchUrls = async (nums: number[]) => {
      const r = await call<{ urls: { part: number; url: string }[] }>('POST', `/rooms/${roomId}/files/${i}/parts`, { token: ownerToken, body: { parts: nums } });
      for (const u of r.urls) urls.set(u.part, u.url);
    };
    let done = 0;
    onProgress(i, 0, file.size);
    for (let b = 0; b < parts.length; b += 50) {
      const batch = parts.slice(b, b + 50);
      await fetchUrls(batch);
      await pool(batch, PARALLEL, async (part) => {
        if (cancelled()) throw new Error('cancelled');
        const start = (part - 1) * p.partSize;
        const plain = await file.slice(start, Math.min(start + p.partSize, file.size)).arrayBuffer();
        const cipher = await encryptPart(key, prefix, i, part, part === p.partCount, plain);
        await putPart(urls.get(part)!, cipher, async () => (await fetchUrls([part]), urls.get(part)!));
        done += plain.byteLength;
        onProgress(i, done, file.size);
      });
    }
    await call('POST', `/rooms/${roomId}/files/${i}/complete`, { token: ownerToken, body: {} });
    onProgress(i, file.size, file.size);
  }
  const sealed = await sealManifest(fileKey, manifest);
  const { url } = await call<{ url: string }>('POST', `/rooms/${roomId}/manifest`, { token: ownerToken, body: { size: sealed.length } });
  await putPart(url, sealed, async () => (await call<{ url: string }>('POST', `/rooms/${roomId}/manifest`, { token: ownerToken, body: { size: sealed.length } })).url);
  await call('POST', `/rooms/${roomId}/finalize`, { token: ownerToken, body: {} });
}

export async function fetchManifest(roomId: string, token: string, fileKey: Uint8Array): Promise<Manifest> {
  const { url } = await call<{ url: string }>('POST', `/rooms/${roomId}/download`, { token, body: { manifest: true } });
  return openManifest(fileKey, await getBytes(url));
}

/** Where decrypted bytes go. write() calls arrive in order. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Download, verify and decrypt one file part by part into a sink. */
export async function downloadFile(roomId: string, token: string, fileKey: Uint8Array, m: Manifest, i: number, sink: FileSink, onProgress: Progress) {
  const f = m.files[i];
  const key = await fileCipherKey(fileKey, i);
  const prefix = unb64(f.ivPrefix);
  let done = 0;
  onProgress(i, 0, f.size);
  for (let b = 1; b <= f.partCount; b += 8) {
    const nums = Array.from({ length: Math.min(8, f.partCount - b + 1) }, (_, k) => b + k);
    const { urls } = await call<{ urls: { part: number; url: string }[] }>('POST', `/rooms/${roomId}/download`, { token, body: { file: i, parts: nums } });
    // Fetch a few ahead, write strictly in order.
    const pending = urls.map((u) => getBytes(u.url));
    for (const [k, u] of urls.entries()) {
      const last = u.part === f.partCount;
      let plain: Uint8Array;
      try {
        plain = await decryptPart(key, prefix, i, u.part, last, await pending[k]);
      } catch (e) {
        if (!(e instanceof SealBrokenError)) throw e;
        // One honest retry from storage before calling it tampering.
        const again = await call<{ urls: { url: string }[] }>('POST', `/rooms/${roomId}/download`, { token, body: { file: i, parts: [u.part] } });
        plain = await decryptPart(key, prefix, i, u.part, last, await getBytes(again.urls[0].url));
      }
      await sink.write(plain);
      done += plain.length;
      onProgress(i, done, f.size);
    }
  }
  await sink.close();
}
