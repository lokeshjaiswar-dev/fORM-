import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { installQueueSchema } from '@form/adapters';
import { ROLES, roleUrl } from '@form/db';

/**
 * `pnpm dev:setup`, after `@form/db db:setup`: installs the pg-boss schema and queues as fr_migrator and
 * grants fr_app row access. Development only; the role passwords default to the db:setup dev values.
 */
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('worker dev:setup is for development databases only\n');
  process.exit(1);
}

const { values } = parseArgs({ options: { 'env-out': { type: 'string' } } });
const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/form';
const database = decodeURIComponent(new URL(adminUrl).pathname.slice(1)) || 'form';
const migratorUrl = roleUrl(adminUrl, ROLES.migrator, process.env.FR_MIGRATOR_PASSWORD ?? 'fr_migrator_dev', database);
const appUrl = roleUrl(adminUrl, ROLES.app, process.env.FR_APP_PASSWORD ?? 'fr_app_dev', database);

const { queues } = await installQueueSchema({ connectionString: migratorUrl, appRole: ROLES.app });
process.stdout.write(`queue: ${queues.length} pg-boss queues ready (including dead-letter queues)\n`);

const envOut = values['env-out'];
if (envOut) {
  const target = path.resolve(envOut);
  if (existsSync(target)) {
    process.stdout.write(`env: ${target} exists, left unchanged\n`);
  } else {
    writeFileSync(
      target,
      [
        '# Written by pnpm dev:setup. Development only.',
        'NODE_ENV=development',
        `DATABASE_URL=${appUrl}`,
        `JOB_SIGNING_KEYS=dev:${randomBytes(32).toString('base64url')}`,
        'LOG_LEVEL=info',
        '# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
        '',
      ].join('\n'),
    );
    process.stdout.write(`env: wrote ${target}\n`);
  }
}
