import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_EVENTS } from './catalogue.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const TEST_FILE = /\.test(-d)?\.tsx?$/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

/** Every `audit.append(...)` / `audit.appendDetached(...)` call in apps/*\/src and packages/*\/src with the action it names. */
function emitted(): Array<{ file: string; action: string | null }> {
  const files = ['apps', 'packages'].flatMap((top) =>
    readdirSync(path.join(root, top))
      .map((pkg) => path.join(root, top, pkg, 'src'))
      .filter((src) => statSync(src, { throwIfNoEntry: false })?.isDirectory())
      .flatMap(sources),
  );
  const calls: Array<{ file: string; action: string | null }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\baudit\.(append|appendDetached)\((?!\))/g)) {
      const end = text.indexOf('});', m.index);
      const call = text.slice(m.index, end === -1 ? undefined : end);
      calls.push({ file: path.relative(root, file).replace(/\\/g, '/'), action: /\baction: '([^']+)'/.exec(call)?.[1] ?? null });
    }
  }
  return calls;
}

describe('audit event catalogue', () => {
  const calls = emitted();

  it('finds the emitting call sites', () => {
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((c) => c.action === null)).toEqual([]);
  });

  it('lists every emitted code', () => {
    const unknown = calls.filter((c) => !AUDIT_ACTIONS.includes(c.action as never));
    expect(unknown).toEqual([]);
  });

  it('lists only codes something emits', () => {
    const used = new Set(calls.map((c) => c.action));
    expect(AUDIT_ACTIONS.filter((a) => !used.has(a))).toEqual([]);
  });

  it('describes each code with its outcomes', () => {
    for (const [action, spec] of Object.entries(AUDIT_EVENTS)) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(spec.outcomes.length, action).toBeGreaterThan(0);
      expect(spec.description.length, action).toBeGreaterThan(10);
    }
  });
});
