import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { noInjectedStyles } from './vite.ts';

type Transform = (this: { error: (m: string) => never }, code: string, id: string) => { code: string } | null;

const resolve = (from: string, id: string) => createRequire(from).resolve(id);
const sonner = resolve(import.meta.url, 'sonner').replace(/index\.js$/, 'index.mjs');
/* Radix and react-style-singleton arrive through the design system, so they resolve from its folder. */
const ui = realpathSync(path.resolve(import.meta.dirname, '../node_modules/@dmacq/ui/package.json'));
const select = resolve(ui, '@radix-ui/react-select').replace(/index\.js$/, 'index.mjs');
const scrollArea = resolve(ui, '@radix-ui/react-scroll-area').replace(/index\.js$/, 'index.mjs');
const singleton = resolve(resolve(select, 'react-remove-scroll'), 'react-style-singleton').replace(/es5[\\/]index\.js$/, 'es2015/singleton.js');

const transform = noInjectedStyles().transform as unknown as Transform;
const ctx = {
  error: (m: string): never => {
    throw new Error(m);
  },
};
const run = (file: string) => {
  const code = readFileSync(file, 'utf8');
  return { code, out: transform.call(ctx, code, file)?.code ?? '' };
};

describe('noInjectedStyles', () => {
  it('drops the installed sonner stylesheet injection and nothing else', () => {
    const { code, out } = run(sonner);
    expect(out).not.toMatch(/\n__insertCSS\(/);
    expect(out).toContain('function __insertCSS');
    expect(code.length - out.length).toBeGreaterThan(1000);
    expect(transform.call(ctx, code, '/x/node_modules/other/dist/index.mjs')).toBeNull();
  });

  it.each([
    ['Select', select, '[data-radix-select-viewport]'],
    ['ScrollArea', scrollArea, '[data-radix-scroll-area-viewport]'],
  ])('renders nothing for the Radix %s viewport <style>', (_name, file, selector) => {
    const { code, out } = run(file);
    expect(code).toContain('dangerouslySetInnerHTML');
    expect(out).not.toContain('dangerouslySetInnerHTML');
    expect(out).not.toContain(`${selector}{scrollbar-width`);
  });

  it('never makes the react-style-singleton <style> tag', () => {
    const { out } = run(singleton);
    expect(out).toContain('if ((stylesheet = null)) {');
    expect(out).not.toMatch(/stylesheet = makeStyleTag\(\)/);
  });

  it('fails the build when a required module never passed through (another entry was bundled)', () => {
    const plugin = noInjectedStyles() as unknown as { buildStart: () => void; transform: Transform; buildEnd: (this: typeof ctx, e?: Error) => void };
    plugin.buildStart();
    plugin.transform.call(ctx, readFileSync(sonner, 'utf8'), sonner);
    expect(() => plugin.buildEnd.call(ctx)).toThrow(/never saw .*react-select.*react-style-singleton/);
    plugin.transform.call(ctx, readFileSync(select, 'utf8'), select);
    plugin.transform.call(ctx, readFileSync(singleton, 'utf8'), singleton);
    expect(() => plugin.buildEnd.call(ctx)).not.toThrow();
    expect(() => plugin.buildEnd.call(ctx, new Error('earlier failure'))).not.toThrow();
  });

  it('fails the build when a call changes shape', () => {
    expect(() => transform.call(ctx, 'export const x = 1;', sonner)).toThrow(/sonner __insertCSS.*expected one injected stylesheet/);
    expect(() => transform.call(ctx, 'export const x = 1;', select)).toThrow(/react-select viewport <style>: expected one/);
    expect(() => transform.call(ctx, 'export const x = 1;', singleton)).toThrow(/react-style-singleton <style> tag: expected one/);
  });
});
