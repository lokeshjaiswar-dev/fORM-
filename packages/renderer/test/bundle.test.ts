import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * Bundle size (WP-0.10 acceptance: "≤ 90 KB gz excluding React and catalogue"). Measured as the spec words it:
 * everything the renderer entry loads up front, the shared engines included (schema twins, registry, logic@2,
 * validation, i18n), React and the message catalogues excluded. re2js is a separate chunk that only forms with a
 * pattern, preset or mask fetch (BL-099).
 *
 * The 90 KB criterion is NOT met, and no renderer change can meet it (BL-129, for the spec owner): the shared
 * engines the renderer has to run (logic evaluation checks answers with the zod twins, decimal.js full build, the ICU
 * parser) load about 96 KB on their own, before the renderer and react-hook-form (about 33 KB). Until the spec
 * owner decides, the initial load and the engines are held to ratchets so they cannot grow.
 */

const KB = 1024;
const SPEC_BUDGET = 90 * KB;
const INITIAL_RATCHET = 132 * KB;
const ENGINES_RATCHET = 97 * KB;
const REGEX_CHUNK_CEILING = 50 * KB;

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const REACT = /^(react|react-dom|scheduler)(\/|$)/;
const ENGINES = /^(@form\/(schema|registry|logic|validation|i18n)|zod|re2js|decimal\.js|intl-messageformat|@formatjs\/|unicode-segmenter|canonicalize|@noble\/hashes|htmlparser2)(\/|$)/;

/** What the renderer imports from the shared engines, and nothing of its own. */
const ENGINES_ENTRY = 'renderer-engines';
const ENGINES_MODULE = '\0renderer-engines';
const enginesEntry: Plugin = {
  name: 'renderer-engines',
  enforce: 'pre',
  /* Vite resolves a lib entry against the root first. */
  resolveId: (id) => (id === ENGINES_ENTRY || id.split('\\').join('/').endsWith(`/${ENGINES_ENTRY}`) ? ENGINES_MODULE : null),
  load: (id) =>
    id === ENGINES_MODULE
      ? [
          "export { createEvaluator } from '@form/logic';",
          "export { loadRegexEngine, needsRegexEngine, normalizeAnswer, validateAnswers } from '@form/validation/lazy';",
          "export { EN_IN, createI18n, defineMessages, graphemeLength } from '@form/i18n';",
          "export { CALLING_CODE_REGIONS, acceptsFile, callingCodeOf, isAvailable, rankCount, valueDefinition, wordCount } from '@form/registry';",
          "export { isSafeUrl, tokenVar } from '@form/schema';",
        ].join('\n')
      : null,
};

/** The catalogues load per locale at runtime: measured as empty modules. */
const noCatalogues: Plugin = {
  name: 'no-catalogues',
  enforce: 'pre',
  load: (id) => (/[\\/]i18n[\\/]locales[\\/].+\.json$/.test(id) ? '{}' : null),
};

interface Chunk { entry: boolean; gz: number; modules: string[] }

async function chunks(entry: string, external: (id: string) => boolean): Promise<Chunk[]> {
  const output = (await build({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    plugins: [noCatalogues, enginesEntry],
    build: {
      write: false,
      minify: true,
      lib: { entry, formats: ['es'], fileName: 'renderer' },
      rollupOptions: { external },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((o) => o.output).flatMap((file) =>
    file.type === 'chunk' ? [{ entry: file.isEntry, gz: gzipSync(file.code).length, modules: Object.keys(file.modules).map((m) => m.split('\\').join('/')) }] : [],
  );
}

const sum = (list: Chunk[]) => list.reduce((total, chunk) => total + chunk.gz, 0);
const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB gz`;
const isRegex = (module: string) => /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?re2js\//.test(module);

describe('bundle size', () => {
  let all: Chunk[] = [];
  beforeAll(async () => {
    all = await chunks(ENTRY, (id) => REACT.test(id));
  }, 120_000);

  it(`renderer code and react-hook-form stay within ${SPEC_BUDGET / KB} KB`, async () => {
    const own = sum((await chunks(ENTRY, (id) => REACT.test(id) || ENGINES.test(id))).filter((c) => c.entry));
    console.info(`renderer own: ${kb(own)}`);
    expect(own).toBeLessThanOrEqual(SPEC_BUDGET);
  }, 120_000);

  it('loads re2js only on demand, in its own chunk', () => {
    const initial = all.filter((c) => c.entry);
    const lazy = all.filter((c) => !c.entry);
    expect(initial.flatMap((c) => c.modules).filter(isRegex)).toEqual([]);
    const regex = lazy.filter((c) => c.modules.some(isRegex));
    expect(regex).toHaveLength(1);
    console.info(`re2js chunk: ${kb(sum(regex))}`);
    expect(sum(regex)).toBeLessThanOrEqual(REGEX_CHUNK_CEILING);
  });

  it(`the shared engines the renderer runs stay under the ${ENGINES_RATCHET / KB} KB ratchet`, async () => {
    const engines = sum((await chunks(ENGINES_ENTRY, (id) => REACT.test(id))).filter((c) => c.entry));
    console.info(`shared engines alone: ${kb(engines)} (WP-0.10 budget for everything ${kb(SPEC_BUDGET)})`);
    expect(engines).toBeLessThanOrEqual(ENGINES_RATCHET);
  }, 120_000);

  it(`the initial load (engines included) stays under the ${INITIAL_RATCHET / KB} KB ratchet`, () => {
    const initial = sum(all.filter((c) => c.entry));
    console.info(`initial load: ${kb(initial)} (WP-0.10 budget ${kb(SPEC_BUDGET)}, ${kb(initial - SPEC_BUDGET)} over)`);
    expect(initial).toBeLessThanOrEqual(INITIAL_RATCHET);
  });
});
