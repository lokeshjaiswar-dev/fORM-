import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRemoteSubmission, listRemoteSubmissions } from '@/persistence/submissionsApi';

const api = vi.fn();
const orgApi = vi.fn();
let session: { status: string } = { status: 'signed_in' };

vi.mock('@/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/client')>();
  return {
    ...actual,
    api: (...args: unknown[]) => api(...args),
    orgApi: (...args: unknown[]) => orgApi(...args),
    ensureSession: () => Promise.resolve(session),
  };
});

describe('submissionsApi', () => {
  beforeEach(() => {
    api.mockReset();
    orgApi.mockReset();
    session = { status: 'signed_in' };
  });

  it('lists the responses of a form in the active org, never on a public route', async () => {
    orgApi.mockResolvedValue({ items: [{ id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 }] });
    await expect(listRemoteSubmissions('f1')).resolves.toEqual([
      { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', fieldCount: 2 },
    ]);
    expect(orgApi).toHaveBeenCalledWith('GET', '/v1/forms/f1/submissions', expect.anything());
    expect(api).not.toHaveBeenCalled();
  });

  it('reads one response through the org route', async () => {
    const row = { id: 's1', formId: 'f1', submittedAt: '2026-01-01T00:00:00.000Z', answers: {}, fields: [] };
    orgApi.mockResolvedValue(row);
    await expect(getRemoteSubmission('f1', 's1')).resolves.toEqual(row);
    expect(orgApi).toHaveBeenCalledWith('GET', '/v1/forms/f1/submissions/s1', expect.anything());
    expect(api).not.toHaveBeenCalled();
  });

  it('asks the API nothing while signed out', async () => {
    session = { status: 'signed_out' };
    await expect(listRemoteSubmissions('f1')).resolves.toBeNull();
    await expect(getRemoteSubmission('f1', 's1')).resolves.toBeNull();
    expect(orgApi).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it('treats a refusal as no remote responses', async () => {
    orgApi.mockRejectedValue(new Error('forbidden'));
    await expect(listRemoteSubmissions('f1')).resolves.toBeNull();
  });
});
