import { describe, expect, it, vi } from 'vitest';
import type { SafeUrl } from '@form/schema';
import { postFieldApi } from '../src/controls/apiValidation.ts';

describe('postFieldApi', () => {
  it('POSTs JSON with the field key and typed value', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postFieldApi('https://hr.example.com/names' as SafeUrl, 'emp_name', 'Lokesh')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://hr.example.com/names', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ emp_name: 'Lokesh' }),
    });
    vi.unstubAllGlobals();
  });

  it('uses the API message when ok is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'Name not found' }), { status: 200 })));
    await expect(postFieldApi('https://hr.example.com/names' as SafeUrl, 'emp_name', 'Nope')).resolves.toEqual({
      ok: false,
      message: 'Name not found',
    });
    vi.unstubAllGlobals();
  });
});
