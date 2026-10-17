// Where decrypted files go. One file: a normal download (streamed by the service
// worker when available, so big files never sit in memory). Several files or a
// folder: one .zip, which every phone and desktop browser can save.
import type { FileSink } from './transfer';

export const safeName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

export async function registerStreamWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    /* memory fallback */
  }
}

const SAFARI = /^((?!chrome|android|crios|fxios).)*safari/i;
export const canStream = () => !SAFARI.test(navigator.userAgent) && Boolean(navigator.serviceWorker?.controller);

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
}

export function streamSink(name: string, size: number): FileSink {
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  navigator.serviceWorker.controller!.postMessage({ type: 'zs-download', id, name: safeName(name), size }, [channel.port2]);
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/__zs_download/${id}`;
  document.body.append(frame);
  setTimeout(() => frame.remove(), 60 * 60_000);
  return {
    async write(c) {
      channel.port1.postMessage({ chunk: c }, [c.buffer]);
    },
    async close() {
      channel.port1.postMessage({ done: true });
    },
    async abort() {
      channel.port1.postMessage({ abort: true });
    },
  };
}

/** Collects one file's decrypted bytes in memory. */
export function collectSink(): FileSink & { chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    async write(c) {
      chunks.push(c.slice());
    },
    async close() {},
    async abort() {
      chunks.length = 0;
    },
  };
}
