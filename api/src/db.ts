// One SQL layer, two engines: node-postgres in production (Render Postgres),
// in-process PGlite (real Postgres in WASM) for local dev and tests.
import pg from 'pg';

export type Query = <T = Record<string, any>>(sql: string, params?: unknown[]) => Promise<T[]>;
export interface Db {
  query: Query;
  tx<R>(fn: (q: Query) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id char(64) PRIMARY KEY,
  owner_hash text NOT NULL,
  max_receivers int NOT NULL,
  ask_first boolean NOT NULL DEFAULT false,
  fuse_ms bigint NOT NULL,
  created_at bigint NOT NULL,
  upload_deadline bigint NOT NULL,
  fuse_ends_at bigint,
  sender_seen_at bigint NOT NULL,
  state text NOT NULL,
  file_count int NOT NULL,
  total_bytes bigint NOT NULL,
  manifest_bytes int NOT NULL,
  manifest_done boolean NOT NULL DEFAULT false,
  burn_reason text,
  burned_at bigint,
  receipt jsonb,
  purged boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS receivers (
  id text PRIMARY KEY,
  room_id char(64) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_hash text NOT NULL,
  joined_at bigint NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  padlock text,
  keybox text,
  egress_bytes bigint NOT NULL DEFAULT 0,
  acked_at bigint,
  ack_ok boolean
);
CREATE INDEX IF NOT EXISTS receivers_room ON receivers(room_id);
CREATE TABLE IF NOT EXISTS objects (
  room_id char(64) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  idx int NOT NULL,
  s3_key text NOT NULL,
  upload_id text NOT NULL,
  plain_size bigint NOT NULL,
  part_size bigint NOT NULL,
  part_count int NOT NULL,
  cipher_bytes bigint NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, idx)
);
CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v bigint NOT NULL);
`;

export async function openDb(url: string): Promise<Db> {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: /sslmode=require|render\.com/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    const query: Query = async (sql, params) => (await pool.query(sql, params as any[])).rows;
    await query(SCHEMA);
    return {
      query,
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(async (sql, params) => (await c.query(sql, params as any[])).rows);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite();
  await lite.exec(SCHEMA);
  // PGlite runs one connection; serialize transactions so FOR UPDATE semantics hold.
  let chain: Promise<unknown> = Promise.resolve();
  const query: Query = async (sql, params) => (await lite.query(sql, params as any[])).rows as any[];
  return {
    query,
    tx(fn) {
      const run = chain.then(() => lite.transaction(async (t) => fn(async (sql, params) => (await t.query(sql, params as any[])).rows as any[])));
      chain = run.catch(() => undefined);
      return run;
    },
    close: () => lite.close(),
  };
}

export const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
