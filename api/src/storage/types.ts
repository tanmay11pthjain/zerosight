export interface Storage {
  readonly kind: 'memory' | 's3';
  /** Refuse to run on a bucket that ever had versioning (deleted files would survive). */
  check(): Promise<void>;
  createMultipart(key: string): Promise<string>;
  /** Presigned PUT for one part, bound to its exact byte length. */
  presignPart(key: string, uploadId: string, partNumber: number, size: number): Promise<string>;
  /** Completes using the server's own part listing; throws if any part size is wrong. */
  completeMultipart(key: string, uploadId: string, expected: number[]): Promise<void>;
  presignPut(key: string, size: number): Promise<string>;
  /** Size of a stored object, or null. */
  size(key: string): Promise<number | null>;
  presignGet(key: string, partNumber?: number): Promise<string>;
  /** Delete every object and abort every open multipart upload under prefix. */
  deletePrefix(prefix: string): Promise<void>;
}

export class StorageError extends Error {}
