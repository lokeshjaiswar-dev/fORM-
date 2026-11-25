// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormRenderer } from '../src/index.ts';
import { corpus, kitchenSink, props, rich, runtime, type Fixture } from './build.ts';

/*
 * SSR-ready from the start (WP-0.10): every fixture renders on the server with renderToString and hydrates in the
 * browser without a mismatch. The HTML is parsed with DOMParser, never assigned as markup (CI forbids HTML sinks).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sink = runtime(kitchenSink());
const FIXTURES: Fixture[] = [
  ...corpus(),
  { name: 'kitchen sink', version: sink },
  { name: 'closed status', version: runtime(kitchenSink(), { state: 'closed', screen: rich('Closed for the season.') }) },
  { name: 'password status', version: runtime(kitchenSink(), { state: 'password', screen: { type: 'doc', content: [] } }) },
  { name: 'welcome screen', version: runtime({ ...kitchenSink(), welcome: { enabled: true, content: rich('Welcome!') } }) },
];

const roots: Array<{ unmount(): void }> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

/** Server HTML for `server`, hydrated with `client`; returns the container and everything React reported. */
async function hydrate(server: ReactElement, client: ReactElement) {
  const html = renderToString(server);
  const container = document.createElement('div');
  container.append(...new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.childNodes);
  document.body.append(container);
  const before = container.textContent;
  const errors: unknown[] = [];
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
  await act(async () => {
    roots.push(hydrateRoot(container, client, { onRecoverableError: (error) => void errors.push(error) }));
  });
  consoleError.mockRestore();
  return { html, before, container, errors };
}

describe('server rendering and hydration', () => {
  it('covers the migrated corpus and the extra fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(39);
  });

  it.each(FIXTURES)('$name renders to a string and hydrates without a mismatch', async ({ version }) => {
    const element = <FormRenderer {...props(version)} />;
    const { html, before, container, errors } = await hydrate(element, element);
    expect(html).toContain('fr-root');
    expect(errors).toEqual([]);
    expect(container.textContent).toBe(before);
  });

  it('notices a mismatch (sensitivity check)', async () => {
    const other = runtime({ ...kitchenSink(), title: 'Another title' });
    const { errors } = await hydrate(<FormRenderer {...props(sink)} />, <FormRenderer {...props(other)} />);
    expect(errors.length).toBeGreaterThan(0);
  });
});
