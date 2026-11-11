import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishLive } from '@/persistence/publishApi';

const api = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});

const live = { slug: 'live-form', versionId: 'v1', number: 1 };

describe('publishLive', () => {
  beforeEach(() => {
    api.mockReset();
    sessionStorage.clear();
  });

  it('publishes on the public route without an org header', async () => {
    api.mockResolvedValue(live);
    await expect(publishLive('f1', { title: 'Hi' }, 'Hi')).resolves.toEqual(live);
    expect(api).toHaveBeenCalledWith('POST', '/v1/p/publish', expect.anything(), { id: 'f1', draft: { title: 'Hi' }, media: {} });
    expect(sessionStorage.getItem('fr.live.f1')).toBe('live-form');
  });
});
