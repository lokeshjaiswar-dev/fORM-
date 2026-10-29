import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { noInjectedStyles } from './vite.ts';

type Transform = (this: { error: (m: string) => never }, code: string, id: string) => { code: string } | null;

const sonner = createRequire(import.meta.url).resolve('sonner').replace(/index\.js$/, 'index.mjs');
const transform = noInjectedStyles().transform as unknown as Transform;
const ctx = {
  error: (m: string): never => {
    throw new Error(m);
  },
};

describe('noInjectedStyles', () => {
  it('drops the installed sonner stylesheet injection and nothing else', () => {
    const code = readFileSync(sonner, 'utf8');
    const out = transform.call(ctx, code, sonner)?.code ?? '';
    expect(out).not.toMatch(/\n__insertCSS\(/);
    expect(out).toContain('function __insertCSS');
    expect(code.length - out.length).toBeGreaterThan(1000);
    expect(transform.call(ctx, code, '/x/node_modules/other/dist/index.mjs')).toBeNull();
  });

  it('fails the build when the call changes shape', () => {
    expect(() => transform.call(ctx, 'export const x = 1;', sonner)).toThrow(/expected one __insertCSS/);
  });
});
