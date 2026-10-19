import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TemplateModal } from '@/components/builder/TemplateModal';
import * as systemPack from '@/lib/systemPack';
import { labelText } from '@/lib/v1html';
import { useUiStore } from '@/state/uiStore';
import { doc, resetStore } from '@/test/fixtures';

beforeEach(() => {
  resetStore();
});

describe('TemplateModal', () => {
  it('lists the five pack templates and instantiates the chosen one offline', async () => {
    useUiStore.setState({ started: false });
    const formId = doc().id;
    const onOpenChange = vi.fn();
    render(<TemplateModal open onOpenChange={onOpenChange} />);
    for (const title of ['Contact us', 'Customer feedback', 'NPS survey', 'Job application', 'Event registration']) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('NPS survey'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const form = doc();
    const { started } = useUiStore.getState();
    expect(started).toBe(true);
    expect(form.id).toBe(formId);
    expect(form.title).toBe('How likely are you to recommend us?');
    expect(form.blocks.map((b) => labelText(b.label))).toContain('How likely are you to recommend us to a friend or colleague?');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says so when the pack does not verify', async () => {
    vi.spyOn(systemPack, 'loadSystemPack').mockRejectedValue(new Error('bad_signature'));
    render(<TemplateModal open onOpenChange={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  });
});
