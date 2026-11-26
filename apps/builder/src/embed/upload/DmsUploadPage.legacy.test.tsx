import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures } from '../bridge/fixtures.ts';

/*
 * The switch of SEC-DESIGN 3.5 (BD-07): a default build speaks fp-bridge/2 only; the M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1) also
 * answers `fp_v=1` with the retired /1 page. The constant is read once, when DmsUploadPage is loaded, so each case loads a fresh copy
 * (and a fresh React with it: Testing Library is imported after the reset).
 */

const ORIGIN = window.location.origin;
let parentWin: Window;
let posts: Array<[unknown, unknown]>;

beforeEach(() => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  parentWin = iframe.contentWindow as Window;
  posts = [];
  vi.spyOn(parentWin, 'postMessage').mockImplementation(((message: unknown, target: unknown) => void posts.push([message, target])) as never);
  Object.defineProperty(window, 'parent', { configurable: true, value: parentWin });
  vi.stubEnv('VITE_FP_EMBED_PARENTS', ORIGIN);
});
afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'parent');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function load(legacy: string, search: string) {
  vi.stubEnv('VITE_FP_LEGACY_DESCRIPTOR', legacy);
  window.history.replaceState({}, '', `/embed/dms-upload${search}`);
  vi.resetModules();
  const { render, waitFor } = await import('@testing-library/react');
  const { default: DmsUploadPage } = await import('./DmsUploadPage.tsx');
  render(<DmsUploadPage />);
  return { waitFor };
}

describe('DmsUploadPage', () => {
  it('legacy build + fp_v=1 and an allowlisted fp_parent: the retired /1 page says ready to that origin', async () => {
    const { waitFor } = await load('1', `?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1`);
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]![0]).toMatchObject({ protocol: 'fp-bridge/1', type: 'ready' });
    expect(posts[0]![1]).toBe(ORIGIN);
    expect(fixtures.handshake[0]).toMatchObject({ type: 'ready' });
  });

  it('legacy build + fp_v=2 (or none): still /2, hello with target "*"', async () => {
    await load('1', '?fp_v=2');
    expect(posts).toEqual([[{ protocol: 'fp-bridge/2', type: 'hello' }, '*']]);
  });

  it('default build + fp_v=1: /2 only, the /1 page is not even loaded', async () => {
    await load('', `?fp_parent=${encodeURIComponent(ORIGIN)}&fp_v=1`);
    expect(posts).toEqual([[{ protocol: 'fp-bridge/2', type: 'hello' }, '*']]);
  });
});
