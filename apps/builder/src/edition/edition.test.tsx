import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { editionSummary, loadEditionConfig } from '@form/config';
import { EDITION_CACHE_KEY, fetchEdition, loadEdition, useEditionStore } from '@/edition/edition';
import { EditionBadge } from '@/edition/EditionBadge';
import { editionLabel } from '@/edition/labels';

const SAAS = editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'saas' }));
const AIR = editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' }));

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

beforeEach(() => {
  localStorage.clear();
  useEditionStore.setState({ summary: null, source: 'unknown' });
});

describe('fetchEdition', () => {
  it('reads and checks the summary', async () => {
    const fetcher = vi.fn(async () => json(SAAS));
    expect(await fetchEdition(fetcher, 'https://api.form.test')).toEqual(SAAS);
    expect(fetcher).toHaveBeenCalledWith('https://api.form.test/v1/meta/edition', expect.anything());
  });

  it('gives null for anything else: the SPA fallback page, a bad shape, an error status, no network', async () => {
    expect(await fetchEdition(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))).toBeNull();
    expect(await fetchEdition(async () => json({ ...SAAS, airGapped: true }))).toBeNull();
    expect(await fetchEdition(async () => json(SAAS, { status: 503 }))).toBeNull();
    expect(await fetchEdition(async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
  });
});

describe('loadEdition', () => {
  it('stores the server answer and keeps it for the next offline load', async () => {
    await loadEdition(async () => json(AIR));
    expect(useEditionStore.getState()).toEqual({ summary: AIR, source: 'server' });
    useEditionStore.setState({ summary: null, source: 'unknown' });
    await loadEdition(async () => Promise.reject(new TypeError('offline')));
    expect(useEditionStore.getState()).toEqual({ summary: AIR, source: 'cached' });
  });

  it('ignores a damaged cache and blocked storage', async () => {
    localStorage.setItem(EDITION_CACHE_KEY, '{"deploymentMode":"cloud"}');
    await loadEdition(async () => Promise.reject(new TypeError('offline')));
    expect(useEditionStore.getState().source).toBe('unknown');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await loadEdition(async () => json(SAAS));
    expect(useEditionStore.getState()).toEqual({ summary: SAAS, source: 'server' });
  });
});

describe('EditionBadge', () => {
  it.each([
    [{ DEPLOYMENT_MODE: 'saas' }, 'SaaS'],
    [{ DEPLOYMENT_MODE: 'saas', EGRESS_POLICY: 'allowlist' }, 'SaaS · egress allowlist'],
    [{ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'open' }, 'On-premises'],
    [{ DEPLOYMENT_MODE: 'onprem' }, 'On-premises · egress allowlist'],
    [{ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' }, 'On-premises · air-gapped'],
  ])('%o is shown as %s', (env, label) => {
    expect(editionLabel(editionSummary(loadEditionConfig(env)))).toBe(label);
  });

  it('says when the edition is unknown or only last known', () => {
    const { rerender } = render(<EditionBadge />);
    expect(screen.getByRole('note', { name: 'Edition' })).toHaveTextContent('Edition unknown');
    expect(editionLabel(null)).toBe('Edition unknown');
    useEditionStore.setState({ summary: AIR, source: 'cached' });
    rerender(<EditionBadge />);
    expect(screen.getByRole('note', { name: 'Edition' })).toHaveAttribute('title', expect.stringMatching(/are off on this installation\. Last known/));  });
});
