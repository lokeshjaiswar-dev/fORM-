/** Layer rules from docs/platform/03-architecture.md §1.3. */

const path = require('node:path');

const PURE = ['schema', 'registry', 'logic', 'validation', 'templates-core'];

const L0 = ['schema', 'i18n'];
const L1 = ['registry', 'logic', 'validation'];

const ALLOWED = {
  schema: [],
  i18n: [],
  registry: [...L0],
  logic: ['registry', ...L0],
  validation: ['logic', 'registry', ...L0],
  'templates-core': ['validation', 'logic', 'registry', ...L0],
  renderer: [...L1, ...L0, 'ui'],
  ui: [],
  sdk: ['schema'],
  ports: ['schema'],
  crypto: ['schema'],
  config: ['ports', 'crypto', 'schema'],
  observability: [],
  db: ['schema', 'crypto', 'config'],
  adapters: ['ports', 'crypto', 'config'],
  email: ['renderer', 'schema'],
  testkit: ['ports', 'schema', 'db'],
};

/** Test files may also use @form/testkit; nothing else may. */
const TESTS = '\\.test(-d)?\\.tsx?$';

const APPS = {
  builder: ['renderer', 'ui', 'sdk', 'templates-core', ...L1, ...L0],
  runtime: ['renderer', 'sdk', 'config', 'observability', ...L1, ...L0],
  api: ['ports', 'crypto', 'config', 'observability', 'db', 'adapters', 'templates-core', 'email', ...L1, ...L0],
  worker: ['ports', 'crypto', 'config', 'observability', 'db', 'adapters', 'templates-core', 'email', 'renderer', ...L1, ...L0],
  cli: ['db', 'config', 'crypto', 'adapters', 'templates-core'],
};

const only = (names) => names.map((n) => `^packages/${n}/`);

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: { pathNot: '^packages/schema/src/v2/' },
      to: { circular: true },
    },
    {
      name: 'no-circular-schema-runtime',
      comment: 'The schema v2 section files import types from one another (the contract is mutually recursive); those imports are erased at compile time. Runtime cycles still fail.',
      severity: 'error',
      from: { path: '^packages/schema/src/v2/' },
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'pure-no-react-or-node',
      comment: 'schema, registry, logic, validation and templates-core run anywhere: no React, no DOM renderer, no Node built-ins.',
      severity: 'error',
      from: { path: `^packages/(${PURE.join('|')})/` },
      to: { path: ['(^|/)node_modules/(react|react-dom)/', '^(react|react-dom)(/|$)'] },
    },
    {
      name: 'pure-no-node-builtins',
      severity: 'error',
      from: { path: `^packages/(${PURE.join('|')})/` },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'i18n-core-portable',
      comment: 'i18n core runs in the browser, the server and the logic engine: no React, no Node built-ins (scripts/ may use Node).',
      severity: 'error',
      from: { path: '^packages/i18n/src/' },
      to: { path: ['(^|/)node_modules/(react|react-dom)/', '^(react|react-dom)(/|$)'] },
    },
    {
      name: 'i18n-core-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/i18n/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-deep-import',
      comment: 'Import @form/* packages through their exports, never their src/ files.',
      severity: 'error',
      from: { path: '^(?:apps|packages)/([^/]+)/' },
      to: { path: '^packages/[^/]+/src/', pathNot: ['^packages/$1/', '^packages/[^/]+/src/index\\.ts$'] },
    },
    {
      name: 'no-deep-import-unresolved',
      severity: 'error',
      from: {},
      to: { path: '^@form/[^/]+/src(/|$)' },
    },
    {
      name: 'no-package-to-app',
      comment: 'Packages never depend on apps.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-app-to-app',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'adapters-only-from-composition-roots',
      severity: 'error',
      from: { pathNot: ['^apps/api/src/main\\.ts$', '^apps/worker/src/main\\.ts$', '^apps/cli/', '^packages/adapters/'] },
      to: { path: '^packages/adapters/' },
    },
    {
      name: 'ports-zero-deps',
      comment: 'packages/ports holds interfaces only: no npm packages, no Node built-ins. Workspace packages are left to layer-ports (schema only).',
      severity: 'error',
      from: { path: '^packages/ports/src/', pathNot: TESTS },
      to: { dependencyTypesNot: ['local'], pathNot: ['^packages/', '^@form/schema$'] },
    },
    {
      name: 'testkit-only-from-tests',
      severity: 'error',
      from: { pathNot: [TESTS, '^packages/testkit/'] },
      to: { path: ['^packages/testkit/', '^@form/testkit(/|$)'] },
    },
    ...Object.entries(ALLOWED).map(([name, allowed]) => ({
      name: `layer-${name}`,
      severity: 'error',
      from: { path: `^packages/${name}/`, pathNot: TESTS },
      to: { path: '^packages/', pathNot: only([name, ...allowed]) },
    })),
    ...Object.entries(ALLOWED).map(([name, allowed]) => ({
      name: `layer-${name}-tests`,
      severity: 'error',
      from: { path: `^packages/${name}/.*${TESTS}` },
      to: { path: '^packages/', pathNot: only([name, ...allowed, 'testkit']) },
    })),
    ...Object.entries(APPS).map(([name, allowed]) => ({
      name: `layer-app-${name}`,
      severity: 'error',
      from: { path: `^apps/${name}/` },
      to: { path: '^packages/', pathNot: only([...allowed, 'testkit']) },
    })),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['(^|/)dist/', '(^|/)coverage/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: path.join(__dirname, 'apps/builder/tsconfig.app.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
