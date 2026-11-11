import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRemoteSubmission, listRemoteSubmissions, postRemoteSubmission } from '@/persistence/submissionsApi';

const api = vi.fn();
const orgApi = vi.fn();

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return {
    ...actual,
    api: (...args: unknown[]) => api(...args),
    orgApi: (...args: unknown[]) => orgApi(...args),
  };
});

describe('submissionsApi', () => {
  beforeEach(() => {
    api.mockReset();
    orgApi.mockReset();
  });

  it('lists published submissions without an org', async () => {
    api.mockResolvedValue({ items: [{ id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 }] });
    await expect(listRemoteSubmissions('f1')).resolves.toEqual([
      { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 },
    ]);
    expect(api).toHaveBeenCalledWith('GET', '/v1/p/by-form/f1/submissions', expect.anything());
    expect(orgApi).not.toHaveBeenCalled();
  });

  it('stores a preview submission on the public route', async () => {
    api.mockResolvedValue({ id: 's1' });
    await expect(
      postRemoteSubmission('f1', {
        id: 'local',
        formId: 'f1',
        submittedAt: '2026-01-01T00:00:00.000Z',
        answers: {},
        fields: [],
      }),
    ).resolves.toBe('s1');
    expect(api).toHaveBeenCalledWith('POST', '/v1/p/by-form/f1/submissions', expect.anything(), {
      answers: {},
      fields: [],
      locale: 'en-IN',
    });
  });

  it('reads one published submission', async () => {
    const row = { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', answers: {}, fields: [] };
    api.mockResolvedValue(row);
    await expect(getRemoteSubmission('f1', 's1')).resolves.toEqual(row);
    expect(api).toHaveBeenCalledWith('GET', '/v1/p/by-form/f1/submissions/s1', expect.anything());
  });
});
