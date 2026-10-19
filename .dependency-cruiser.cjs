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
  templates: ['templates-core', 'validation', 'logic', 'registry', ...L0],
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

/** Packages whose tests may also read a sibling's constants (ADR-0002 §6: i18n checks the schema's SYSTEM_MESSAGE_KEYS). */
const TEST_ALLOWED = { i18n: ['schema'] };

/** Test files, and helpers in a test/ directory (global setup, harnesses), may also use @form/testkit; nothing else may. */
const TESTS = '(\\.test(-d)?\\.tsx?|/test/.+\\.tsx?)$';

const APPS = {
  builder: ['renderer', 'ui', 'sdk', 'templates-core', 'templates', ...L1, ...L0],
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
      comment: 'Build-time generators in scripts/ (the logic case-fold table) may use Node; nothing they emit does.',
      severity: 'error',
      from: { path: `^packages/(${PURE.join('|')})/`, pathNot: `^packages/(${PURE.join('|')})/scripts/` },
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
      name: 'renderer-store-independent',
      comment: 'FormRenderer takes everything as props (WP-0.10): no builder store library in @form/renderer.',
      severity: 'error',
      from: { path: '^packages/renderer/' },
      to: { path: ['(^|/)node_modules/(zustand|zundo)/', '^(zustand|zundo)(/|$)'] },
    },
    {
      name: 'renderer-lazy-regex',
      comment: 'The renderer loads re2js only for forms that need it (BL-129): it imports @form/validation/lazy, never the eager entry or re2js itself.',
      severity: 'error',
      from: { path: '^packages/renderer/src/' },
      to: { path: ['^packages/validation/src/index\\.ts$', '(^|/)node_modules/re2js/', '^re2js(/|$)'] },
    },
    {
      name: 'html-parsing-only-in-schema-richtext',
      comment: 'HTML is read in one place: the @form/schema fromHtml allowlist (WP-0.08). No sanitiser shims, no second parser.',
      severity: 'error',
      from: { pathNot: '^packages/schema/src/richtext/' },
      to: { path: ['(^|/)node_modules/(htmlparser2|dompurify|isomorphic-dompurify|sanitize-html|parse5|domhandler)/', '^(htmlparser2|dompurify|isomorphic-dompurify|sanitize-html|parse5|domhandler)(/|$)'] },
    },
    {
      name: 'schema-test-fixtures-only-from-tests',
      comment: '@form/schema/test-fixtures (XSS corpus, paste samples) and @form/schema/migration-fixtures (the v1 migration corpus) are test data: unit tests and e2e specs only.',
      severity: 'error',
      from: { pathNot: [TESTS, '^apps/[^/]+/e2e/', '^packages/schema/test/'] },
      to: { path: '^packages/schema/test/' },
    },
    {
      name: 'i18n-test-fixtures-only-from-tests',
      comment: '@form/i18n/test-fixtures (the golden grapheme corpus) is test data: unit tests and the logic determinism corpus only.',
      severity: 'error',
      from: { pathNot: [TESTS, '^packages/i18n/test/'] },
      to: { path: '^packages/i18n/test/' },
    },
    {
      name: 'no-deep-import',
      comment: 'Import @form/* packages through their exports, never their src/ files. A package stylesheet export (@form/renderer/styles.css) and the lazy validation entry (@form/validation/lazy) are entry points too.',
      severity: 'error',
      from: { path: '^(?:apps|packages)/([^/]+)/' },
      to: { path: '^packages/[^/]+/src/', pathNot: ['^packages/$1/', '^packages/[^/]+/src/index\\.ts$', '^packages/[^/]+/src/styles\\.css$', '^packages/validation/src/lazy\\.ts$'] },
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
      comment: 'Composition roots wire real adapters: the api and worker main modules, the CLI, worker setup scripts and app integration tests.',
      severity: 'error',
      from: {
        pathNot: ['^apps/api/src/main\\.ts$', '^apps/worker/src/main\\.ts$', '^apps/worker/scripts/', '^apps/[^/]+/test/', '^apps/cli/', '^packages/adapters/'],
      },
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
      to: { path: '^packages/', pathNot: only([name, ...allowed, ...(TEST_ALLOWED[name] ?? []), 'testkit']) },
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
    /* Workspace build output only: npm packages ship their code in dist/ and must stay visible to the rules. */
    exclude: { path: ['^(apps|packages)/[^/]+/(dist|coverage)/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: path.join(__dirname, 'apps/builder/tsconfig.app.json') },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
