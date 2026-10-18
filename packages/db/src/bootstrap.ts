import type pg from 'pg';

/** Database roles (architecture §2.1). `fr_platform` arrives with the platform surface (P1). */
export const ROLES = {
  migrator: 'fr_migrator',
  app: 'fr_app',
  templateSeeder: 'fr_template_seeder',
  systemAgg: 'fr_system_agg',
} as const;

export type RoleKey = keyof typeof ROLES;
export type RoleName = (typeof ROLES)[RoleKey];
export type RolePasswords = Record<RoleKey, string>;

const BASE = 'login nosuperuser nocreatedb nocreaterole noreplication';

/**
 * fr_migrator owns the schema and the definer functions; it bypasses RLS so those functions can read across
 * orgs. fr_app and fr_template_seeder never bypass RLS. fr_system_agg bypasses RLS but is granted SELECT only
 * on rollup sources, which arrive with their tables.
 */
const ATTRIBUTES: Record<RoleName, string> = {
  fr_migrator: `${BASE} bypassrls`,
  fr_app: `${BASE} nobypassrls noinherit`,
  fr_template_seeder: `${BASE} nobypassrls noinherit`,
  fr_system_agg: `${BASE} bypassrls noinherit`,
};

/** Creates or updates the cluster roles. Runs as a superuser (or a role allowed to grant BYPASSRLS), once per cluster. */
export async function bootstrapRoles(admin: pg.ClientBase, passwords: RolePasswords): Promise<void> {
  for (const key of Object.keys(ROLES) as RoleKey[]) {
    const role = ROLES[key];
    const password = passwords[key];
    if (!password) throw new Error(`bootstrap: a password for ${role} is required`);
    const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
    await admin.query(`${rowCount ? 'alter' : 'create'} role ${role} with ${ATTRIBUTES[role]} password ${admin.escapeLiteral(password)}`);
  }
}

/** Hands a database to fr_migrator (it then owns `public`) and lets only the platform roles connect. */
export async function bootstrapDatabase(admin: pg.ClientBase, database: string): Promise<void> {
  const db = admin.escapeIdentifier(database);
  await admin.query(`alter database ${db} owner to ${ROLES.migrator}`);
  await admin.query(`revoke all on database ${db} from public`);
  await admin.query(`grant connect on database ${db} to ${ROLES.app}, ${ROLES.templateSeeder}, ${ROLES.systemAgg}`);
}
