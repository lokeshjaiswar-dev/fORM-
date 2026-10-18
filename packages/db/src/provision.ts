import pg from 'pg';
import { bootstrapDatabase, bootstrapRoles, ROLES, type RoleName, type RolePasswords } from './bootstrap.ts';
import { migrate, type MigrateResult } from './migrate.ts';

/** The URL of `database` on the server behind `serverUrl`, signed in as `role`. */
export function roleUrl(serverUrl: string, role: RoleName, password: string, database: string): string {
  const u = new URL(serverUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export interface ProvisionOptions {
  /** A superuser (or equivalent) connection to the server. */
  adminUrl: string;
  database: string;
  passwords: RolePasswords;
  /** Create or update the cluster roles first (default true). */
  roles?: boolean;
  /** Create the database when it does not exist (default false). */
  createDatabase?: boolean;
}

export interface ProvisionResult extends MigrateResult {
  urls: Record<RoleName, string>;
}

/** Roles, database ownership and grants, then migrations as fr_migrator: `pnpm dev:setup`, tests and installs. */
export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const admin = new pg.Client({ connectionString: options.adminUrl });
  await admin.connect();
  try {
    if (options.roles ?? true) await bootstrapRoles(admin, options.passwords);
    if (options.createDatabase) {
      const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [options.database]);
      if (!rowCount) await admin.query(`create database ${admin.escapeIdentifier(options.database)}`);
    }
    await bootstrapDatabase(admin, options.database);
  } finally {
    await admin.end();
  }

  const urls = {
    fr_migrator: roleUrl(options.adminUrl, ROLES.migrator, options.passwords.migrator, options.database),
    fr_app: roleUrl(options.adminUrl, ROLES.app, options.passwords.app, options.database),
    fr_template_seeder: roleUrl(options.adminUrl, ROLES.templateSeeder, options.passwords.templateSeeder, options.database),
    fr_system_agg: roleUrl(options.adminUrl, ROLES.systemAgg, options.passwords.systemAgg, options.database),
  };
  const migrator = new pg.Client({ connectionString: urls.fr_migrator });
  await migrator.connect();
  try {
    return { ...(await migrate(migrator)), urls };
  } finally {
    await migrator.end();
  }
}
