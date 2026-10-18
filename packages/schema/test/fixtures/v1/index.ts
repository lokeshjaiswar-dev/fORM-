/*
 * The WP-0.05 v1 corpus, exported as `@form/schema/migration-fixtures`: the five apps/builder/src/data/templates.ts
 * forms (`templates/`, as createBlock built them at e1be409, with fixed ids) and 30 hand-made forms (`forms/`), each
 * named after the bug it exercises, with the MigrationContext the corpus tests use. Loaded with Vite's
 * import.meta.glob, so only Vite-typed test programs (schema, logic) import it.
 */

export { isSafePatternForTests, migrationContext, seededIds } from '../migration.ts';

export interface V1Fixture { name: string; doc: unknown }

const load = (files: Record<string, unknown>): V1Fixture[] =>
  Object.entries(files)
    .map(([path, doc]) => ({ name: path.replace(/^.*\//, '').replace(/\.json$/, ''), doc }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const V1_TEMPLATES: readonly V1Fixture[] = load(import.meta.glob<unknown>('./templates/*.json', { eager: true, import: 'default' }));
export const V1_FORMS: readonly V1Fixture[] = load(import.meta.glob<unknown>('./forms/*.json', { eager: true, import: 'default' }));
/** The templates (named `template-<id>`), then the forms: 35 in all. */
export const V1_FIXTURES: readonly V1Fixture[] = [...V1_TEMPLATES.map((f) => ({ ...f, name: `template-${f.name}` })), ...V1_FORMS];
