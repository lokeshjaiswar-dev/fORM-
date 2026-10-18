import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapRoles, type RolePasswords } from '@form/db';
import { startPostgres } from '@form/testkit';

export const TEST_PASSWORDS: RolePasswords = {
  migrator: 'fr_migrator_test',
  app: 'fr_app_test',
  templateSeeder: 'fr_template_seeder_test',
  systemAgg: 'fr_system_agg_test',
};

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
