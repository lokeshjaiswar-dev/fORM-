import { describe, expect, it } from 'vitest';
import { REGISTRY } from '@form/registry';
import { V1_VALUE_TYPES, migrateUnknown, migrateV1ToV2, parseV1 } from '@form/schema';
import type { BlockType, PublishIssue, ValueFieldType } from '@form/schema';
import { V1_FIXTURES, migrationContext } from '@form/schema/migration-fixtures';
import { compile, validateDefinition } from '../src/index.ts';
import { EN_IN } from './build.ts';

/*
 * WP-0.05 acceptance against the real registry and logic@2: every migrated fixture passes
 * validateDefinition(…, 'save') with no error, compiles, and every block config passes its registry
 * configSchema (the cross-field checks the twins do not make). @form/schema's own migration tests run
 * with a stand-in registry, test/fixtures/registry-en-IN.json there, which the first test keeps equal to this one.
 */

const migrated = V1_FIXTURES.map(({ name, doc }) => {
  const parsed = parseV1(doc);
  if (!parsed.success) throw new Error(`${name}: ${parsed.error}`);
  return { name, result: migrateV1ToV2(parsed.data, migrationContext(REGISTRY)) };
});

/** Draft warnings a migrated form may carry: B21 sources (dangling until the author fixes the rule). */
const ALLOWED_WARNINGS: ReadonlySet<PublishIssue['code']> = new Set(['dangling_ref']);

describe('v1 → v2 migration with the registry', () => {
  it('the schema tests run against this registry (registry-en-IN.json is its projection)', async () => {
    const types = [...new Set(Object.values(V1_VALUE_TYPES))].sort() as ValueFieldType[];
    const projection = Object.fromEntries(types.map((type) => {
      const definition = REGISTRY[type];
      return [type, { defaultConfig: definition.defaultConfig(EN_IN), defaultCompliance: definition.defaultCompliance, paths: definition.paths, operators: definition.operators }];
    }));
    await expect(`${JSON.stringify(projection, null, 2)}\n`).toMatchFileSnapshot('../../schema/test/fixtures/registry-en-IN.json');
  });

  it.each(migrated)('$name passes validateDefinition(…, save), compiles and fits every config schema', ({ result }) => {
    const def = result.definition;
    const issues = validateDefinition(def, 'save', REGISTRY);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => !ALLOWED_WARNINGS.has(i.code))).toEqual([]);
    const compiled = compile(def, REGISTRY);
    expect(compiled.ok ? [] : compiled.issues).toEqual([]);
    for (const block of Object.values(def.blocks)) {
      if (!block || block.type === 'unsupported') continue;
      const parsed = REGISTRY[block.type as BlockType].configSchema.safeParse(block.config);
      expect(parsed.success ? null : parsed.error, `${block.id} config`).toBeNull();
    }
  });

  it('migrating a migrated document changes nothing', () => {
    for (const { result } of migrated) {
      const again = migrateUnknown(JSON.parse(JSON.stringify(result.definition)), migrationContext(REGISTRY, 'again'));
      expect(again).toEqual({ definition: result.definition, notes: [] });
    }
  });
});
