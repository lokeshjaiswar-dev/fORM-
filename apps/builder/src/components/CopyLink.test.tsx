import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyLink } from '@/components/CopyLink';

const LINK = 'http://192.168.1.121:5173/f/demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CopyLink', () => {
  it('copies with the clipboard API and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const onCopied = vi.fn();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<CopyLink link={LINK} label="Share link" onCopied={onCopied} />);
    expect(screen.queryByText(/to copy the link/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it('without a clipboard (http on a LAN IP) selects the link in a read-only field and tells the person to press Ctrl+C', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { clipboard: undefined, platform: 'Linux x86_64' });
    render(<CopyLink link={LINK} label="Share link" />);
    const field = screen.getByLabelText('Share link') as HTMLInputElement;
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(LINK.length);
    expect(screen.getByRole('status')).toHaveTextContent('Press Ctrl+C to copy the link.');
  });

  it('switches to the manual hint when the clipboard refuses', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, platform: 'Linux x86_64' });
    const onCopied = vi.fn();
    render(<CopyLink link={LINK} label="Share link" onCopied={onCopied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Press Ctrl+C to copy the link.');
    expect(screen.getByLabelText('Share link')).toHaveFocus();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
