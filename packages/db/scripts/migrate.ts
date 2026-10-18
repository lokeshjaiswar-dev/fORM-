import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../src/index.ts';

/** `pnpm --filter @form/db db:migrate`: applies pending migrations as fr_migrator (DATABASE_MIGRATOR_URL or _FILE). */
const file = process.env.DATABASE_MIGRATOR_URL_FILE;
const url = file ? readFileSync(file, 'utf8').trim() : process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  process.stderr.write('db:migrate: set DATABASE_MIGRATOR_URL or DATABASE_MIGRATOR_URL_FILE\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { applied, version } = await migrate(client);
  process.stdout.write(applied.length ? `applied ${applied.join(', ')}; now at ${version}\n` : `up to date at ${version}\n`);
} finally {
  await client.end();
}
