import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { startPostgres } from '@form/testkit';
import { bootstrapRoles } from '../src/index.ts';
import { TEST_PASSWORDS } from './passwords.ts';

/** One Postgres per run; roles are cluster-wide, so they are created once here. Each test file gets its own database. */
export default async function setup(project: TestProject) {
  const server = await startPostgres();
  const admin = new pg.Client({ connectionString: server.adminUrl() });
  await admin.connect();
  try {
    await bootstrapRoles(admin, TEST_PASSWORDS);
  } finally {
    await admin.end();
  }
  project.provide('pgAdminUrl', server.adminUrl());
  return () => server.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
