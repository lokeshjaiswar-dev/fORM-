import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeSettings } from '@/components/builder/ThemeSettings';
import type { Ending, EndingId } from '@form/schema';
import { useDocumentStore } from '@/state/documentStore';
import { undo } from '@/state/history';
import { useOpsStore } from '@/state/opsStore';
import { block, doc, resetStore } from '@/test/fixtures';

beforeEach(() => resetStore([block('short_text', 'name')]));

function open() {
  render(<ThemeSettings open onOpenChange={() => {}} />);
  return userEvent.setup();
}

describe('ThemeSettings', () => {
  it('edits the v2 theme and behaviour: accent token, submit label, progress bar', async () => {
    const user = open();
    await user.click(screen.getByRole('button', { name: '#7c3aed' }));
    expect(doc().theme.tokens.colors.accent).toBe('#7c3aed');
    const submit = screen.getByRole('textbox', { name: 'Submit button' });
    await user.clear(submit);
    await user.type(submit, 'Send');
    expect(doc().behavior.submit.label).toBe('Send');
    await user.click(screen.getByRole('switch', { name: 'Progress bar' }));
    expect(doc().theme.tokens.progress).toBe('bar');
  });

  it('an https redirect becomes the default ending; clearing it restores the message ending (S6)', async () => {
    const user = open();
    const redirect = screen.getByRole('textbox', { name: 'Redirect after submit' });
    await user.type(redirect, 'http://insecure.example');
    expect(doc().endings.map((e) => e.kind)).toEqual(['message']);
    expect(screen.getByText('Use an https address')).toBeInTheDocument();
    await user.clear(redirect);
    await user.type(redirect, 'https://example.com/thanks');
    const ending = doc().endings.find((e) => e.id === doc().defaultEndingId);
    expect(ending).toMatchObject({ kind: 'redirect', url: ['https://example.com/thanks'] });
    await user.clear(redirect);
    expect(doc().endings.map((e) => e.kind)).toEqual(['message']);
    expect(doc().defaultEndingId).toBe(doc().endings[0]?.id);
  });

  it('the confetti switch sets the behaviour and the message ending in one undo step', async () => {
    const user = open();
    const confetti = () => [doc().behavior.successAnimation, doc().endings.find((e) => e.kind === 'message')?.confetti];
    expect(confetti()).toEqual([false, false]);
    await user.click(screen.getByRole('switch', { name: 'Confetti on submit' }));
    expect(confetti()).toEqual([true, true]);
    undo();
    expect(confetti()).toEqual([false, false]);
  });

  it('clearing the redirect of a form with no message ending brings the thank-you message back', async () => {
    const only: Ending = { id: 'go' as EndingId, kind: 'redirect', name: 'Go', url: ['https://example.com'] };
    useDocumentStore.setState({ doc: { ...doc(), endings: [only], defaultEndingId: only.id } });
    const user = open();
    const redirect = screen.getByRole('textbox', { name: 'Redirect after submit' });
    expect(redirect).toHaveValue('https://example.com');
    await user.clear(redirect);
    expect(doc().endings.map((e) => e.kind)).toEqual(['message']);
    expect(doc().defaultEndingId).toBe(doc().endings[0]?.id);
  });

  it('closing the form and its password are local FormOps, never in the definition (S5)', async () => {
    const user = open();
    await user.click(screen.getByRole('switch', { name: 'Close form' }));
    expect(useOpsStore.getState().open).toBe(false);
    await user.type(screen.getByLabelText('Password (optional)'), 'hunter2');
    expect(useOpsStore.getState().password).toBe('hunter2');
    expect(JSON.stringify(doc())).not.toContain('hunter2');
  });
});
