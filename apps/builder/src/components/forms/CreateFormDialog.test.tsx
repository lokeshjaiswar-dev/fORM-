import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CreateFormDialog } from '@/components/forms/CreateFormDialog';

describe('CreateFormDialog', () => {
  it('asks how to start, with each choice explained', () => {
    render(<CreateFormDialog open onOpenChange={() => {}} onBlank={() => {}} onTemplate={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Create a form' })).toHaveAccessibleDescription('Choose how you want to start. You can edit everything later.');
    expect(screen.getByRole('button', { name: 'Start from scratch' })).toHaveAccessibleDescription(/Begin with a blank form/);
    expect(screen.getByRole('button', { name: 'Start from a template' })).toHaveAccessibleDescription(/Pick a ready-made form/);
  });

  it('starts a blank form from scratch', () => {
    const onBlank = vi.fn();
    render(<CreateFormDialog open onOpenChange={() => {}} onBlank={onBlank} onTemplate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start from scratch' }));
    expect(onBlank).toHaveBeenCalledOnce();
  });

  it('moves to the templates in the same window, and Back returns to the choice', async () => {
    render(<CreateFormDialog open onOpenChange={() => {}} onBlank={() => {}} onTemplate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template' }));
    expect(screen.getByRole('dialog', { name: 'Choose a template' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Create a form' })).toBeInTheDocument();
  });

  it('opens straight on the templates when asked (Browse templates)', () => {
    render(<CreateFormDialog open initialStep="templates" onOpenChange={() => {}} onBlank={() => {}} onTemplate={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Choose a template' })).toBeInTheDocument();
  });
});
