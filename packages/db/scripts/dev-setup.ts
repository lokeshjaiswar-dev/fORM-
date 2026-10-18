import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { provision, type RolePasswords } from '../src/index.ts';

/**
 * `pnpm dev:setup`: roles, migrations and a demo seed on the compose Postgres (deploy/docker/compose.dev.yaml).
 * Development only; the passwords are fixed dev values unless overridden.
 */
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('db:setup is for development databases only\n');
  process.exit(1);
}

const { values } = parseArgs({ options: { 'env-out': { type: 'string' } } });
const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/form';
const database = decodeURIComponent(new URL(adminUrl).pathname.slice(1)) || 'form';
const passwords: RolePasswords = {
  migrator: process.env.FR_MIGRATOR_PASSWORD ?? 'fr_migrator_dev',
  app: process.env.FR_APP_PASSWORD ?? 'fr_app_dev',
  templateSeeder: process.env.FR_TEMPLATE_SEEDER_PASSWORD ?? 'fr_template_seeder_dev',
  systemAgg: process.env.FR_SYSTEM_AGG_PASSWORD ?? 'fr_system_agg_dev',
};

const { applied, version, urls } = await provision({ adminUrl, database, passwords });
process.stdout.write(applied.length ? `migrations: applied ${applied.join(', ')}\n` : `migrations: up to date at ${version}\n`);

/** Fixed ids, so the dev auth headers below stay valid across resets. */
const DEMO = {
  org: '01970000-0000-7000-8000-000000000001',
  user: '01970000-0000-7000-8000-000000000002',
  team: '01970000-0000-7000-8000-000000000003',
  otherOrg: '01970000-0000-7000-8000-000000000011',
  otherUser: '01970000-0000-7000-8000-000000000012',
  otherTeam: '01970000-0000-7000-8000-000000000013',
};

const owner = new pg.Client({ connectionString: urls.fr_migrator });
await owner.connect();
try {
  await owner.query('begin');
  await owner.query(
    `insert into orgs (id, slug, name) values ($1, 'demo', 'Demo Org'), ($2, 'other', 'Other Org') on conflict (id) do nothing`,
    [DEMO.org, DEMO.otherOrg],
  );
  await owner.query(
    `insert into users (id, email, email_norm, name) values ($1, 'dev@form.local', 'dev@form.local', 'Dev User'),
       ($2, 'other@form.local', 'other@form.local', 'Other User') on conflict (id) do nothing`,
    [DEMO.user, DEMO.otherUser],
  );
  await owner.query(
    `insert into memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner') on conflict do nothing`,
    [DEMO.org, DEMO.user, DEMO.otherOrg, DEMO.otherUser],
  );
  const forms = [
    ['01970000-0000-7000-8000-000000000101', DEMO.org, DEMO.team, DEMO.user, 'Customer feedback'],
    ['01970000-0000-7000-8000-000000000102', DEMO.org, DEMO.team, DEMO.user, 'Event registration'],
    ['01970000-0000-7000-8000-000000000111', DEMO.otherOrg, DEMO.otherTeam, DEMO.otherUser, 'Other org: job application'],
  ];
  for (const f of forms) {
    await owner.query('insert into forms (id, org_id, team_id, owner_user_id, title) values ($1, $2, $3, $4, $5) on conflict (id) do nothing', f);
  }
  await owner.query('commit');
} catch (err) {
  await owner.query('rollback');
  throw err;
} finally {
  await owner.end();
}
process.stdout.write(`seed: demo org ${DEMO.org}, user ${DEMO.user}\n`);

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
        'DEPLOYMENT_MODE=onprem',
        'EGRESS_POLICY=allowlist',
        `DATABASE_URL=${urls.fr_app}`,
        'PUBLIC_BUILDER_URL=http://localhost:5173',
        'AUTH_DEV_HEADERS=true',
        'LOG_LEVEL=info',
        '# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
        '# NTP_SERVERS=time.nplindia.org',
        '',
      ].join('\n'),
    );
    process.stdout.write(`env: wrote ${target}\n`);
  }
}
process.stdout.write(
  `try: curl -H 'X-FR-Dev-User: ${DEMO.user}' -H 'X-FR-Org: ${DEMO.org}' http://127.0.0.1:8080/v1/forms\n`,
);
