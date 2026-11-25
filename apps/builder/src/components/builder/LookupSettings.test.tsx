import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LookupSettings } from '@/components/builder/LookupSettings';
import { block, doc, resetStore } from '@/test/fixtures';

beforeEach(() => resetStore([block('short_text', 'emp')]));

describe('LookupSettings (review B1, N3)', () => {
  it('a new API starts with no URL, offers no Authorization, warns that every respondent gets the list, and is stored only with a URL', async () => {
    render(<LookupSettings />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an API' }));
    const url = screen.getByRole('textbox', { name: 'API URL' });
    expect(url).toHaveValue('');
    expect(doc().lookups).toBeUndefined();
    expect(screen.queryByRole('combobox', { name: 'Authorization' })).not.toBeInTheDocument();
    expect(screen.getByText(/receives the full response list/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(url, { target: { value: 'https://hr.example.com/directory' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(doc().lookups).toEqual([expect.objectContaining({ url: 'https://hr.example.com/directory', name: 'API 1', enabled: false })]);
    expect(JSON.stringify(doc().lookups)).not.toContain('localhost');
  });
});
