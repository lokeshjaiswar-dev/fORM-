import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { definitionToElements, elementsToDefinition, visibilityOfBlock, type DmsElement } from '@form/registry/profiles/dms-v1';
import type { BlockId, FieldBlock } from '@form/schema';
import { DmsVisibilitySettings } from '@/components/builder/DmsVisibilitySettings';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { RevealCtx } from '@/embed/master/revealContext';
import { ProfileProvider } from '@/embed/profile';
import { installTestSession, resetTestSession } from '@/embed/session/testing';
import { currentDoc } from '@/state/documentStore';
import { loadDocument } from '@/state/history';
import { loadOps, defaultOps } from '@/state/opsStore';
import { resetUi, useUiStore } from '@/state/uiStore';
import { TooltipProvider } from '@dmacq/ui';

/*
 * The hidden / secret toggles of a DMS field (SEC-DESIGN 5.2-5.3, DESIGN 5.2): only for a user who may change them (`can.reveal_fields`),
 * stored as the first-class x-dms keys, written to DMS with the field. A non-revealer never sees them.
 */

const U = (n: number) => `c4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const el = (n: number, type: string, name: string, extra: Record<string, unknown> = {}): DmsElement => ({ id: U(n), type, name, value: name, label: name, required: false, placeholder: '', ...extra });

const ELEMENTS: DmsElement[] = [
  el(1, 'textinput', 'Vendor Name', { primary: true, numeric: true, specialChars: true }),
  el(2, 'textinput', 'Tax Id', { numeric: true, specialChars: true, is_hidden: false, is_secret: true }),
  el(3, 'email', 'Mail'),
  el(4, 'numberinput', 'Code'),
  el(5, 'phonenumber', 'Phone'),
  el(6, 'multilineinput', 'Notes'),
  el(7, 'dropdown', 'Tier', { options: [{ name: 'Gold', value: 'Gold' }] }),
  el(8, 'date', 'Joined'),
];

beforeEach(() => {
  loadDocument(elementsToDefinition(ELEMENTS, { formId: 'f', title: 'Vendor', locale: 'en-IN' }));
  loadOps(defaultOps());
  resetUi({ started: true });
});
afterEach(() => resetTestSession());

const blockOf = (n: number) => currentDoc().blocks[U(n) as BlockId] as FieldBlock;
const flagsOf = (n: number) => visibilityOfBlock(blockOf(n));

describe('DmsVisibilitySettings', () => {
  it('without can.reveal_fields the toggles are not offered at all (the launch context says no)', () => {
    installTestSession({ context: { can: { reveal_fields: false } } });
    render(<DmsVisibilitySettings block={blockOf(1)} />);
    expect(screen.queryByTestId('dms-visibility-settings')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('with no session and no answer from DMS the toggles stay hidden (unknown means no)', () => {
    render(<DmsVisibilitySettings block={blockOf(1)} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('can.reveal_fields from the launch context shows two switches that reflect the stored flags', () => {
    installTestSession({ context: { can: { reveal_fields: true } } });
    render(<DmsVisibilitySettings block={blockOf(2)} />);
    expect(screen.getByRole('switch', { name: 'Hidden field' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Secret field' })).toBeChecked();
  });

  it('the master answer (can.reveal_fields of GET master/form) wins over the launch context, both ways', () => {
    installTestSession({ context: { can: { reveal_fields: true } } });
    const { unmount } = render(
      <RevealCtx.Provider value={false}>
        <DmsVisibilitySettings block={blockOf(1)} />
      </RevealCtx.Provider>,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    resetTestSession();
    installTestSession({ context: { can: { reveal_fields: false } } });
    render(
      <RevealCtx.Provider value={true}>
        <DmsVisibilitySettings block={blockOf(1)} />
      </RevealCtx.Provider>,
    );
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('toggling Secret writes both flags into x-dms as one undoable step, and they reach the element DMS receives', async () => {
    installTestSession({ context: { can: { reveal_fields: true } } });
    const view = render(<DmsVisibilitySettings block={blockOf(3)} />);
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Secret field' }));
    expect(flagsOf(3)).toEqual({ hidden: false, secret: true });
    const sent = definitionToElements(currentDoc()).find((e) => e.id === U(3))!;
    expect(sent).toMatchObject({ is_hidden: false, is_secret: true });
    view.rerender(<DmsVisibilitySettings block={blockOf(3)} />);
    expect(screen.getByRole('switch', { name: 'Secret field' })).toBeChecked();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Hidden field' }));
    expect(flagsOf(3)).toEqual({ hidden: true, secret: true });
    // The inspector re-renders with the block the store now holds; each toggle keeps the other flag.
    view.rerender(<DmsVisibilitySettings block={blockOf(3)} />);
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Secret field' }));
    expect(flagsOf(3)).toEqual({ hidden: true, secret: false });
  });

  it('a field nobody toggled writes neither key (the canonical create fixture stays as it is)', () => {
    const sent = definitionToElements(currentDoc());
    expect(sent.find((e) => e.id === U(3))).not.toHaveProperty('is_hidden');
    expect(sent.find((e) => e.id === U(3))).not.toHaveProperty('is_secret');
    expect(sent.find((e) => e.id === U(2))).toMatchObject({ is_hidden: false, is_secret: true });
  });
});

describe('the inspector of each of the seven DMS field types (profile dms-v1)', () => {
  function inspect(n: number, reveal: boolean | null) {
    resetTestSession();
    installTestSession({ context: { can: { reveal_fields: reveal ?? false } } });
    useUiStore.getState().openInspector(U(n) as BlockId);
    return render(
      <TooltipProvider>
        <ProfileProvider profile="dms-v1">
          <BlockInspector />
        </ProfileProvider>
      </TooltipProvider>,
    );
  }

  it.each([
    [1, 'short text'],
    [3, 'email'],
    [4, 'number'],
    [5, 'phone'],
    [6, 'long text'],
    [7, 'dropdown'],
    [8, 'date'],
  ] as const)('%i (%s): the two switches are in the General tab for a revealer and absent for anyone else', (n, _label) => {
    const a = inspect(n, true);
    expect(screen.getByRole('switch', { name: 'Hidden field' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Secret field' })).toBeInTheDocument();
    a.unmount();
    const b = inspect(n, false);
    expect(screen.queryByRole('switch', { name: 'Hidden field' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Secret field' })).toBeNull();
    b.unmount();
  });

  it('the full builder profile never shows them', () => {
    installTestSession({ context: { can: { reveal_fields: true } } });
    useUiStore.getState().openInspector(U(3) as BlockId);
    render(
      <TooltipProvider>
        <BlockInspector />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('switch', { name: 'Hidden field' })).toBeNull();
  });
});
