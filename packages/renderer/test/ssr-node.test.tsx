import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormRenderer } from '../src/index.ts';
import { kitchenSink, props, rich, runtime } from './build.ts';

/* In Node there is no window or document: importing and server-rendering the renderer must not reach for either. */
describe('server rendering without a DOM', () => {
  it('has no window or document in this environment', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it.each([
    ['open', runtime(kitchenSink())],
    ['closed', runtime(kitchenSink(), { state: 'closed', screen: rich('Closed.') })],
    ['password', runtime(kitchenSink(), { state: 'password', screen: { type: 'doc', content: [] } })],
  ])('renders the %s status', (_name, version) => {
    const html = renderToString(<FormRenderer {...props(version)} />);
    expect(html).toMatch(/^<div class="fr-root"/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('renders the first page with ids from useId, the same on every render', () => {
    const version = runtime(kitchenSink());
    const a = renderToString(<FormRenderer {...props(version)} />);
    const b = renderToString(<FormRenderer {...props(version)} />);
    expect(a).toBe(b);
    expect(a).toContain('short_text question');
    expect(a).not.toContain('date question');
  });
});
