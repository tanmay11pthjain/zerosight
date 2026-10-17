// Streams decrypted files to disk as a normal browser download, so large files
// never have to fit in memory. Pages send chunks over a MessagePort.
const streams = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'zs-download') return;
  const port = e.ports[0];
  const stream = new ReadableStream({
    start(ctrl) {
      port.onmessage = ({ data }) => {
        if (data.chunk) ctrl.enqueue(new Uint8Array(data.chunk));
        else if (data.done) ctrl.close();
        else if (data.abort) ctrl.error(new Error('aborted'));
      };
    },
  });
  streams.set(d.id, { stream, name: d.name, size: d.size });
  setTimeout(() => streams.delete(d.id), 60_000);
});

self.addEventListener('fetch', (e) => {
  const m = /\/__zs_download\/([\w-]+)$/.exec(new URL(e.request.url).pathname);
  if (!m) return;
  const s = streams.get(m[1]);
  if (!s) return e.respondWith(new Response('Download expired', { status: 404 }));
  streams.delete(m[1]);
  e.respondWith(
    new Response(s.stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(s.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(s.name)}`,
      },
    }),
  );
});
