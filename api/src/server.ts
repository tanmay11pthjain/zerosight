import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { memoryStorage } from './storage/memory.ts';

const config = loadConfig();
const db = await openDb(config.databaseUrl);
// The AWS SDK is only loaded when S3 is actually used (saves memory on small servers).
const storage = config.storageType === 's3' ? (await import('./storage/s3.ts')).s3Storage(config.awsRegion, config.bucket) : memoryStorage(config.publicUrl);
await storage.check();

const verifyHuman = config.turnstileSecret
  ? async (token: string | undefined, ip: string) => {
      if (!token) return false;
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: config.turnstileSecret!, response: token, remoteip: ip }),
      });
      return Boolean(((await res.json()) as { success?: boolean }).success);
    }
  : undefined;

const webDist = process.env.WEB_DIST ?? resolve(import.meta.dirname, '../../web/dist');
const app = await buildApp({ config, db, storage, verifyHuman, webDist });
const timer = setInterval(() => app.sweep().catch((e) => app.log.error(e, 'sweep failed')), config.sweepEveryMs);
void app.sweep().catch(() => undefined); // free tier wakes from sleep: catch up immediately

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`ZeroSight API on :${config.port} · storage=${storage.kind} · db=${config.databaseUrl ? 'postgres' : 'pglite (in-memory)'}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    await db.close();
    process.exit(0);
  });
}
