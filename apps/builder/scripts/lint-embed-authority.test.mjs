/*
 * T-DMSINT-53 (SEC-DESIGN 10.3): a file under src/embed/ that uses document.cookie, localStorage, indexedDB, or sessionStorage outside
 * session/handoff.ts makes the lint fail, and the real tree passes. Run: `node --test scripts/lint-embed-authority.test.mjs`
 * (from apps/builder), and the same check runs in the root `pnpm lint`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, lintEmbedAuthority } from './lint-embed-authority.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '__fixtures__', 'lint-embed-authority');
const BAD = path.join(FIXTURES, 'bad');
const GOOD = path.join(FIXTURES, 'good');
const SCRIPT = path.join(HERE, 'lint-embed-authority.mjs');

/** file (relative to bad/) -> the rule that must fire on it; null = the file itself is allowed (it is there so the imports resolve). */
const EXPECTED = {
  'cookie-read.ts': 'cookie',
  'cookie-bracket.ts': 'cookie',
  'cookie-window.ts': 'cookie',
  'cookie-destructure.ts': 'cookie',
  'cookie-store.ts': 'cookie',
  'local-storage.ts': 'localStorage',
  'local-storage-window.ts': 'localStorage',
  'local-storage-bracket.ts': 'localStorage',
  'indexed-db.ts': 'indexedDB',
  'session-storage.ts': 'sessionStorage',
  'session/not-handoff.ts': 'sessionStorage',
  'legacy/cookieToken.ts': null,
  'legacy/indexed-db.ts': 'indexedDB',
  'legacy/session-storage.ts': 'sessionStorage',
  'legacy-static-import.ts': 'legacy-reach',
  'legacy-alias-import.ts': 'legacy-reach',
  'legacy-reexport.ts': 'legacy-reach',
  'legacy-unguarded-dynamic.ts': 'legacy-reach',
  'legacy-wrong-guard.ts': 'legacy-reach',
  'legacy-loose-guard.ts': 'legacy-reach',
  'legacy-in-else.ts': 'legacy-reach',
  'legacy-or-guard.ts': 'legacy-reach',
};

describe('the real tree', () => {
  it('src/embed/** passes (no cookie, localStorage or indexedDB; sessionStorage only in session/handoff.ts; legacy only behind the flag)', () => {
    const found = lintEmbedAuthority(DEFAULT_ROOT);
    assert.deepEqual(found, [], found.map((v) => `${v.file}:${v.line} ${v.rule}`).join('\n'));
  });
});

describe('fixture files that must fail', () => {
  const found = lintEmbedAuthority(BAD);
  const byFile = Map.groupBy(found, (v) => v.file);

  for (const [file, rule] of Object.entries(EXPECTED)) {
    it(`${file}: ${rule ?? 'allowed'}`, () => {
      const rules = (byFile.get(file) ?? []).map((v) => v.rule);
      if (rule === null) assert.deepEqual(rules, []);
      else assert.ok(rules.includes(rule), `expected rule ${rule}, got [${rules.join(', ')}]`);
    });
  }

  it('every fixture file is accounted for (a new bad file needs an expectation)', () => {
    const flagged = [...byFile.keys()].sort();
    const expected = Object.entries(EXPECTED).filter(([, r]) => r !== null).map(([f]) => f).sort();
    assert.deepEqual(flagged, expected);
  });

  it('reports file, line and column', () => {
    const v = found.find((x) => x.file === 'cookie-read.ts');
    assert.ok(v && v.line === 1 && v.column > 1);
  });
});

describe('fixture files that must pass', () => {
  it('handoff.ts may use sessionStorage; legacy/** may read cookies and localStorage; a guarded dynamic import and a type-only import are fine; comments, strings and member names do not count; test files and __fixtures__ are skipped', () => {
    const found = lintEmbedAuthority(GOOD);
    assert.deepEqual(found, [], found.map((v) => `${v.file}:${v.line} ${v.rule}`).join('\n'));
  });
});

describe('the command line', () => {
  const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });

  it('exits 1 and lists every violation on a bad tree', () => {
    const r = run(BAD);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cookie-read\.ts:1:\d+ {2}cookie/);
    assert.match(r.stderr, /legacy-static-import\.ts:1:\d+ {2}legacy-reach/);
    assert.match(r.stderr, /violation\(s\)/);
  });

  it('exits 0 on a clean tree', () => {
    const r = run(GOOD);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok/);
  });

  it('exits 0 on the default root (the real tree)', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('exits 2 on bad usage', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status, 2);
  });
});
