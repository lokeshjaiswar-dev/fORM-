import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipboardAvailable, copyText } from '@/lib/copyText';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('http://192.168.1.121:5173/f/demo')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('http://192.168.1.121:5173/f/demo');
  });

  it('reports false, without a hidden-textarea fallback, when the clipboard API is blocked (http on a LAN IP)', async () => {
    const append = vi.spyOn(document.body, 'appendChild');
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: undefined });
    expect(clipboardAvailable()).toBe(false);
    await expect(copyText('http://192.168.1.121:5173/f/demo')).resolves.toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('reports false when writeText is refused', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyText('x')).resolves.toBe(false);
  });
});
