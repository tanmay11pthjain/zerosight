// All runtime settings come from environment variables (Render dashboard / render.yaml).
const env = process.env;
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);
const MiB = 1024 * 1024;

export interface Config {
  port: number;
  storageType: 'memory' | 's3';
  awsRegion: string;
  bucket: string;
  databaseUrl: string;
  allowedOrigins: string[];
  publicUrl: string;
  maxRoomBytes: number;
  maxStoredBytes: number;
  monthlyEgressLimitGb: number;
  maxFiles: number;
  maxReceivers: number;
  minPartSize: number;
  receiptKey: string | undefined;
  turnstileSecret: string | undefined;
  adminToken: string | undefined;
  senderGraceMs: number;
  sweepEveryMs: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = num('PORT', 8787);
  return {
    port,
    storageType: env.STORAGE_TYPE === 's3' ? 's3' : 'memory',
    awsRegion: env.AWS_REGION ?? 'eu-north-1',
    bucket: env.AWS_S3_BUCKET_NAME ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicUrl: env.PUBLIC_API_URL ?? '', // '' = storage URLs are relative to the page (single-origin deploy)
    maxRoomBytes: num('MAX_ROOM_BYTES', (env.STORAGE_TYPE === 's3' ? 2048 : 1024) * MiB),
    maxStoredBytes: num('MAX_STORED_BYTES', (env.STORAGE_TYPE === 's3' ? 4096 : 2048) * MiB),
    monthlyEgressLimitGb: num('MONTHLY_EGRESS_LIMIT_GB', 90),
    maxFiles: num('MAX_FILES', 100),
    maxReceivers: 1,
    minPartSize: num('MIN_PART_SIZE', 8 * MiB),
    receiptKey: env.RECEIPT_SIGNING_KEY,
    turnstileSecret: env.TURNSTILE_SECRET,
    adminToken: env.ADMIN_TOKEN,
    senderGraceMs: num('SENDER_GRACE_MS', 10 * 60_000),
    sweepEveryMs: num('SWEEP_EVERY_MS', 60_000),
    ...overrides,
  };
}

/** Part size for a file: at least minPartSize (S3 needs >= 5 MiB), and <= 9,000 parts per file. */
export function partPlan(plainSize: number, minPartSize: number) {
  const need = Math.ceil(plainSize / 9000);
  const partSize = need <= minPartSize ? minPartSize : Math.ceil(need / MiB) * MiB;
  const partCount = Math.max(1, Math.ceil(plainSize / partSize));
  return { partSize, partCount, cipherBytes: plainSize + 16 * partCount };
}
