import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { REGISTRY } from '@form/registry';
import type { IsoInstant } from '@form/schema';
import { PreviewPane } from '@/components/preview/PreviewPane';
import { previewDraft } from '@/lib/preview';
import { block, formWith } from '@/test/fixtures';

const NOW = '2026-10-19T04:30:00Z' as IsoInstant;
const draftOf = (blocks: Parameters<typeof formWith>[0], settings = {}) => {
  const form = formWith(blocks);
  form.settings = { ...form.settings, ...settings };
  return previewDraft(form, NOW);
};

describe('PreviewPane', () => {
  it('renders the compiled draft in the device frame and switches devices', async () => {
    const draft = draftOf([block('text', { id: 'name', label: 'Name' })]);
    render(<PreviewPane definition={draft.definition} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('unlocks a password-protected form only with its password', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    const draft = draftOf([block('text', { id: 'name', label: 'Name' })], { password: 'hunter2' });
    render(<PreviewPane definition={draft.definition} status={draft.status} password={draft.password} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(error).toHaveBeenCalledWith('Incorrect password');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('shows the closed screen of a closed form', () => {
    const draft = draftOf([block('text', { id: 'name', label: 'Name' })], { closed: true, closedMessage: 'Registrations are closed.' });
    render(<PreviewPane definition={draft.definition} status={draft.status} />);
    expect(screen.getByRole('heading', { name: 'Registrations are closed.' })).toBeInTheDocument();
  });

  it('lists the issues when the engine refuses the draft', () => {
    const { definition } = draftOf([block('text', { id: 'name', label: 'Name' })]);
    const page = definition.pages[0]!;
    const broken = { ...definition, blocks: { ...definition.blocks, grid: { id: 'grid', type: 'image', config: REGISTRY.image.defaultConfig('en-IN' as never) } as never }, pages: [{ ...page, children: [...page.children, 'grid' as never] }] };
    render(<PreviewPane definition={broken} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This form cannot be previewed yet.');
  });
});
