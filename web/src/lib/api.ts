// API client. Retries through Render free-tier cold starts, sends the Turnstile
// token when configured, and streams events over fetch (token in a header, never a URL).
import type { Receipt } from './crypto';
import { humanToken } from './turnstile';

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface BurnInfo {
  reason: string;
  at: number;
  receipt: Receipt;
}
export interface PublicRoom {
  id: string;
  state: 'uploading' | 'ready' | 'burned';
  fileCount: number;
  totalBytes: number;
  maxReceivers: number;
  joined: number;
  askFirst: boolean;
  fuseEndsAt: number | null;
  senderOnline: boolean;
  burn: BurnInfo | null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  data: any;
  constructor(status: number, code: string, message: string, data: any = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

let wakingListener: ((waking: boolean) => void) | null = null;
export const onWaking = (fn: (waking: boolean) => void) => (wakingListener = fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with cold-start handling: network errors and 502/503/504 retry for up to ~75 s. */
async function send(url: string, init: RequestInit): Promise<Response> {
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (![502, 503, 504].includes(res.status) || res.headers.get('content-type')?.includes('json')) {
        if (attempt) wakingListener?.(false);
        return res;
      }
    } catch {
      /* server asleep or offline */
    }
    if (Date.now() - start > 75_000) {
      wakingListener?.(false);
      throw new ApiError(0, 'offline', 'Could not reach ZeroSight. Check your connection and try again.');
    }
    wakingListener?.(true);
    await sleep(Math.min(5000, 800 * (attempt + 1)));
  }
}

export async function call<T>(method: string, path: string, opts: { token?: string; body?: unknown; human?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.human) {
    const t = await humanToken();
    if (t) headers['x-turnstile'] = t;
  }
  const res = await send(`${API}/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'http', data.message ?? `Server answered ${res.status}.`, data);
  return data as T;
}

export const wake = () => send(`${API}/healthz`, { cache: 'no-store' }).catch(() => undefined);

/** Upload one presigned part. Retries transient failures; 403 means the URL expired. */
export async function putPart(url: string, body: Uint8Array, refresh: () => Promise<string>, onSent?: (n: number) => void): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', body: new Blob([body as BlobPart]), headers: { 'content-type': 'application/octet-stream' } });
      if (res.ok) return onSent?.(body.length);
      if (res.status === 403) url = await refresh();
      else if (res.status < 500) throw new ApiError(res.status, 'upload', `Storage refused a part (${res.status}).`);
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw new ApiError(0, 'upload', 'A part kept failing to upload. Check your connection and send again.');
}

export async function getBytes(url: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status < 500 && res.status !== 403) throw new ApiError(res.status, 'download', `Storage answered ${res.status}.`);
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw new ApiError(0, 'download', 'A part kept failing to download. Check your connection and try again.');
}

export type EventHandler = (event: string, data: any) => void;

/** Server-sent events over fetch, with reconnect. onOpen fires on every (re)connect. */
export function listen(roomId: string, token: string, on: EventHandler, onOpen?: () => void, onNet?: (ok: boolean) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  (async () => {
    for (let attempt = 0; !stopped; attempt++) {
      ctrl = new AbortController();
      try {
        const res = await fetch(`${API}/api/rooms/${roomId}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 403 || res.status === 404) return;
        if (!res.ok || !res.body) throw new Error('events');
        attempt = 0;
        onNet?.(true);
        onOpen?.();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (ev && data) on(ev, JSON.parse(data));
          }
        }
      } catch {
        /* reconnect below */
      }
      if (stopped) return;
      onNet?.(false);
      await sleep(Math.min(10_000, 1000 * 2 ** attempt));
    }
  })();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
