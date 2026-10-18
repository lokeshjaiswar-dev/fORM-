import type { MigrationContext } from '../../src/index.ts';
import projection from './registry-en-IN.json';

/**
 * The parts of @form/registry that migration reads (en-IN default config, default compliance, answer paths and
 * operators) for every v1 value type. The schema package cannot depend on the registry, so its tests read this
 * projection; @form/logic's test/migrate.test.ts regenerates registry-en-IN.json from the real registry and fails
 * when it drifts.
 */
export const REGISTRY_STANDIN = Object.fromEntries(Object.entries(projection).map(([type, p]) => [type, {
  defaultConfig: () => JSON.parse(JSON.stringify(p.defaultConfig)) as unknown,
  defaultCompliance: p.defaultCompliance,
  paths: p.paths,
  operators: p.operators,
}])) as unknown as MigrationContext['registry'];
