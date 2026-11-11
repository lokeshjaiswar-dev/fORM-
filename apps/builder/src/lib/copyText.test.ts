import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '@/lib/copyText';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText('http://192.168.1.121:5173/f/demo');
    expect(writeText).toHaveBeenCalledWith('http://192.168.1.121:5173/f/demo');
  });

  it('falls back to execCommand when the clipboard API is blocked (http on a LAN IP)', async () => {
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: undefined });
    await copyText('http://192.168.1.121:5173/f/demo');
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('falls back when writeText throws', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(true) });
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyText('x')).resolves.toBeUndefined();
  });
});
