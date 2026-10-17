import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageError, type Storage } from './types.ts';

const EXPIRES = 900; // 15 minutes
const SIGN_LENGTH = { expiresIn: EXPIRES, signableHeaders: new Set(['content-length']) };

export function s3Storage(region: string, bucket: string): Storage {
  if (!bucket) throw new StorageError('AWS_S3_BUCKET_NAME is required when STORAGE_TYPE=s3');
  // WHEN_REQUIRED: otherwise newer SDKs bake an empty-body checksum into presigned PUT URLs.
  const s3 = new S3Client({ region, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const B = { Bucket: bucket };

  return {
    kind: 's3',
    async check() {
      const v = await s3.send(new GetBucketVersioningCommand(B));
      if (v.Status) throw new StorageError(`Bucket versioning is ${v.Status}. ZeroSight refuses to run: deleted files would survive as old versions.`);
    },
    async createMultipart(key) {
      const r = await s3.send(new CreateMultipartUploadCommand({ ...B, Key: key, ContentType: 'application/octet-stream' }));
      if (!r.UploadId) throw new StorageError('No UploadId from S3');
      return r.UploadId;
    },
    presignPart: (key, uploadId, partNumber, size) =>
      getSignedUrl(s3, new UploadPartCommand({ ...B, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: size }), SIGN_LENGTH),
    async completeMultipart(key, uploadId, expected) {
      const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
      let marker: string | undefined;
      do {
        const r = await s3.send(new ListPartsCommand({ ...B, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
        for (const p of r.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: Number(p.Size) });
        marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      } while (marker);
      parts.sort((a, b) => a.PartNumber - b.PartNumber);
      if (parts.length !== expected.length || parts.some((p, i) => p.PartNumber !== i + 1 || p.Size !== expected[i])) {
        throw new StorageError('Uploaded parts do not match the declared file size.');
      }
      await s3.send(
        new CompleteMultipartUploadCommand({
          ...B,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
        }),
      );
    },
    presignPut: (key, size) => getSignedUrl(s3, new PutObjectCommand({ ...B, Key: key, ContentLength: size }), SIGN_LENGTH),
    async size(key) {
      try {
        return Number((await s3.send(new HeadObjectCommand({ ...B, Key: key }))).ContentLength);
      } catch {
        return null;
      }
    },
    presignGet: (key, partNumber) => getSignedUrl(s3, new GetObjectCommand({ ...B, Key: key, PartNumber: partNumber }), { expiresIn: EXPIRES }),
    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ ...B, Prefix: prefix, ContinuationToken: token }));
        const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) await s3.send(new DeleteObjectsCommand({ ...B, Delete: { Objects: keys, Quiet: true } }));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      let km: string | undefined;
      let um: string | undefined;
      do {
        const r = await s3.send(new ListMultipartUploadsCommand({ ...B, Prefix: prefix, KeyMarker: km, UploadIdMarker: um }));
        for (const u of r.Uploads ?? []) await s3.send(new AbortMultipartUploadCommand({ ...B, Key: u.Key!, UploadId: u.UploadId! }));
        km = r.IsTruncated ? r.NextKeyMarker : undefined;
        um = r.IsTruncated ? r.NextUploadIdMarker : undefined;
      } while (km);
    },
  };
}
