import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** Postgres 18 (architecture §2), pinned by digest. Override with FORM_TEST_PG_IMAGE to check the ≥ 16 floor. */
export const POSTGRES_IMAGE = 'postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

export interface PostgresServer {
  /** Superuser URL of `database` (default `postgres`). */
  adminUrl(database?: string): string;
  stop(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/**
 * A Postgres server for integration tests: a Testcontainers container, or the server behind
 * FORM_TEST_DATABASE_ADMIN_URL (a superuser URL) when set. Durability is off; the data is throwaway.
 */
export async function startPostgres(options: { image?: string } = {}): Promise<PostgresServer> {
  const external = process.env.FORM_TEST_DATABASE_ADMIN_URL;
  if (external) return { adminUrl: (db = 'postgres') => withDatabase(external, db), stop: async () => {} };

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(options.image ?? process.env.FORM_TEST_PG_IMAGE ?? POSTGRES_IMAGE)
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    // Every test file of a package shares this one server and opens its own pools (the API's default is 10), and a few
    // tests race dozens of transactions on purpose; the default of 100 clients ran out once the files ran side by side.
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=500'])
    .start();
  const base = container.getConnectionUri();
  return {
    adminUrl: (db = 'postgres') => withDatabase(base, db),
    stop: async () => {
      await container.stop();
    },
  };
}

/** A fresh, uniquely named database on the server behind `adminUrl`; test files never share one. */
export async function createTestDatabase(adminUrl: string, prefix = 'fr_test'): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }
  return name;
}
