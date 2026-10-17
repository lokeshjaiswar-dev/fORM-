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
};

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
      from: {},
      to: { circular: true },
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
    ...Object.entries(ALLOWED).map(([name, allowed]) => ({
      name: `layer-${name}`,
      severity: 'error',
      from: { path: `^packages/${name}/` },
      to: { path: '^packages/', pathNot: only([name, ...allowed]) },
    })),
    ...Object.entries(APPS).map(([name, allowed]) => ({
      name: `layer-app-${name}`,
      severity: 'error',
      from: { path: `^apps/${name}/` },
      to: { path: '^packages/', pathNot: only(allowed) },
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
