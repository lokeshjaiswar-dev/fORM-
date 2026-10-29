import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateKeyfileContent } from '@form/adapters/kms';
import { installQueueSchema } from '@form/adapters/queue';
import { ROLES, roleUrl } from '@form/db';

/**
 * `pnpm dev:setup`, after `@form/db db:setup`: installs the pg-boss schema and queues as fr_migrator and
 * grants fr_app row access, then creates the development master keyfile (audit checkpoint signing) under
 * `.data`. Development only; the role passwords default to the db:setup dev values.
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

const keyfile = path.resolve('.data/form-master.key');
if (!existsSync(keyfile)) {
  mkdirSync(path.dirname(keyfile), { recursive: true });
  writeFileSync(keyfile, generateKeyfileContent(), { mode: 0o600 });
  process.stdout.write(`kms: wrote the development keyfile ${keyfile}\n`);
}

const envOut = values['env-out'];
if (envOut) {
  const target = path.resolve(envOut);
  if (existsSync(target)) {
    process.stdout.write(`env: ${target} exists, left unchanged (the worker needs DEPLOYMENT_MODE, and KMS_KEYFILE_PATH=${keyfile} for audit checkpoints)\n`);
  } else {
    writeFileSync(
      target,
      [
        '# Written by pnpm dev:setup. Development only.',
        'NODE_ENV=development',
        'DEPLOYMENT_MODE=onprem',
        `DATABASE_URL=${appUrl}`,
        `JOB_SIGNING_KEYS=dev:${randomBytes(32).toString('base64url')}`,
        'LOG_LEVEL=info',
        `KMS_KEYFILE_PATH=${keyfile}`,
        'STORAGE_DRIVER=filesystem',
        `STORAGE_ROOT=${path.resolve('.data/storage')}`,
        '# AUDIT_SYSLOG_URL=tcp://127.0.0.1:5514',
        '# The dev stack S3 API (SeaweedFS): STORAGE_DRIVER=s3 STORAGE_ENDPOINT=http://127.0.0.1:8333 STORAGE_REGION=us-east-1',
        '# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
        '',
      ].join('\n'),
    );
    process.stdout.write(`env: wrote ${target}\n`);
  }
}
