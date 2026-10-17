// Real-bucket check. Run with the same env as Render:
//   AWS_REGION=eu-north-1 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_S3_BUCKET_NAME=... npm run smoke:s3
import { randomBytes } from 'node:crypto';
import { s3Storage } from '../src/storage/s3.ts';

const s3 = s3Storage(process.env.AWS_REGION ?? 'eu-north-1', process.env.AWS_S3_BUCKET_NAME ?? '');
const key = `rooms/smoke-${Date.now()}/0.enc`;
const ok = (m: string) => console.log(`✓ ${m}`);

await s3.check();
ok('bucket reachable, versioning never enabled');

const sizes = [5 * 1024 * 1024 + 16, 1000];
const upload = await s3.createMultipart(key);
ok('multipart upload created');

const wrong = await fetch(await s3.presignPart(key, upload, 1, sizes[0]), { method: 'PUT', body: randomBytes(100) });
if (wrong.ok) throw new Error('S3 accepted a part with the wrong length: content-length is not bound to the URL');
ok(`wrong-size part refused (${wrong.status})`);

const parts = sizes.map((n) => randomBytes(n));
for (const [i, body] of parts.entries()) {
  const res = await fetch(await s3.presignPart(key, upload, i + 1, body.length), { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
  if (!res.ok) throw new Error(`part ${i + 1} failed: ${res.status} ${await res.text()}`);
}
ok('two parts uploaded through presigned URLs');

await s3.completeMultipart(key, upload, sizes);
ok('multipart completed (sizes checked with ListParts)');

const got = Buffer.from(await (await fetch(await s3.presignGet(key, 2))).arrayBuffer());
if (!got.equals(parts[1])) throw new Error('part 2 download did not match');
ok('partNumber download matches');

await s3.deletePrefix(key.slice(0, key.lastIndexOf('/') + 1));
if ((await s3.size(key)) !== null) throw new Error('object still exists after delete');
ok('deleted and verified gone');
console.log('\nS3 is ready for ZeroSight.');
