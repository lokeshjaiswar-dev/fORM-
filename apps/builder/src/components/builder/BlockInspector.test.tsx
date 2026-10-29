import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlockId, ChoiceOption, IsoInstant, OptionId } from '@form/schema';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { previewVersion } from '@/lib/preview';
import { useUiStore } from '@/state/uiStore';
import { block, doc, resetStore, rule, text } from '@/test/fixtures';

const get = (id: string) => doc().blocks[id as BlockId] as unknown as { config: Record<string, unknown> } & Record<string, unknown>;
const options = () => get('color').config['options'] as ChoiceOption[];

async function pick(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function open(id: string) {
  useUiStore.getState().openInspector(id as BlockId);
  render(<BlockInspector />);
  return userEvent.setup();
}

beforeEach(() => {
  resetStore([
    block('single_choice', 'color', {
      label: 'Color',
      config: {
        display: 'radio',
        options: [
          { id: 'o1' as OptionId, label: 'Option 1', code: 'option_1' },
          { id: 'o2' as OptionId, label: 'Option 2', code: 'option_2' },
          { id: 'o3' as OptionId, label: 'Option 3', code: 'option_3' },
        ],
      },
    }),
  ]);
});

describe('BlockInspector sections', () => {
  it('shows the registry sections a block has: General, Options, Validation, Logic, Privacy', async () => {
    open('color');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Options', 'Validation', 'Logic', 'Privacy']);
  });

  it('content blocks have General and Logic only', () => {
    resetStore([block('heading', 'h')]);
    open('h');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Logic']);
  });

  it('edits the field key, refusing a key that is taken or malformed', async () => {
    resetStore([block('short_text', 'name'), block('email', 'mail')]);
    const user = open('name');
    const key = screen.getByRole('textbox', { name: 'Field key' });
    await user.clear(key);
    await user.type(key, 'full_name');
    expect(get('name')['key']).toBe('full_name');
    await user.clear(key);
    await user.type(key, 'mail');
    expect(get('name')['key']).toBe('mai');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a free key');
  });
});

describe('BlockInspector options', () => {
  const tab = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('tab', { name: 'Options' }));

  it('adds an option with a fresh id, numbered after the current count', async () => {
    const user = open('color');
    await tab(user);
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(options().at(-1)).toMatchObject({ label: 'Option 4' });
    expect(options().at(-1)).not.toHaveProperty('code');
  });

  it('removes an option', async () => {
    const user = open('color');
    await tab(user);
    await user.click(screen.getByRole('button', { name: 'Remove option 2' }));
    expect(options().map((o) => o.id)).toEqual(['o1', 'o3']);
  });

  it('renames an option label', async () => {
    const user = open('color');
    await tab(user);
    const input = screen.getByRole('textbox', { name: 'Label of option 1' });
    await user.clear(input);
    await user.type(input, 'Red');
    expect(options()[0]?.label).toBe('Red');
  });

  it('B15: renaming an option keeps its id and its export code', async () => {
    const user = open('color');
    await tab(user);
    const input = screen.getByRole('textbox', { name: 'Label of option 1' });
    await user.clear(input);
    await user.type(input, 'Red');
    expect(options()[0]).toEqual({ id: 'o1', label: 'Red', code: 'option_1' });
  });

  it('B15: the export code is edited on its own and never derived from the label', async () => {
    const user = open('color');
    await tab(user);
    const code = screen.getByRole('textbox', { name: 'Export code of option 2' });
    await user.clear(code);
    await user.type(code, 'GRN');
    expect(options()[1]).toEqual({ id: 'o2', label: 'Option 2', code: 'GRN' });
  });

  it('B16: option ids stay unique after delete then add', async () => {
    const user = open('color');
    await tab(user);
    await user.click(screen.getByRole('button', { name: 'Remove option 2' }));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    const ids = options().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(options().map((o) => o.label)).toEqual(['Option 1', 'Option 3', 'Option 2', 'Option 4']);
  });

  it('moves options and toggles Other', async () => {
    const user = open('color');
    await tab(user);
    await user.click(screen.getByRole('button', { name: 'Move option 1 down' }));
    expect(options().map((o) => o.id)).toEqual(['o2', 'o1', 'o3']);
    await user.click(screen.getByRole('switch', { name: 'Add an “Other” option' }));
    expect(get('color').config['other']).toEqual({ enabled: true, textRequired: false });
  });
});

describe('BlockInspector validation', () => {
  it("B12: an invalid pattern '[' shows an inline error and does not crash", async () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    const user = open('name');
    await user.click(screen.getByRole('tab', { name: 'Validation' }));
    const pattern = screen.getByRole('textbox', { name: 'Pattern (regular expression)' });
    await user.type(pattern, '[[');
    expect(get('name').config['pattern']).toEqual({ source: '[' });
    expect(screen.getByText(/This pattern is ignored until fixed/)).toBeInTheDocument();
    await user.type(pattern, ']]a');
    expect(screen.queryByText(/This pattern is ignored until fixed/)).not.toBeInTheDocument();
  });

  it('required and read-only are toggles; both together warn (B27)', async () => {
    resetStore([block('short_text', 'name')]);
    const user = open('name');
    await user.click(screen.getByRole('tab', { name: 'Validation' }));
    await user.click(screen.getByRole('switch', { name: 'Required' }));
    expect(get('name')['required']).toBe(true);
    await user.click(screen.getByRole('switch', { name: /Read-only/ }));
    expect(get('name')['readOnly']).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('read-only field needs a default value');
  });

  it('a number limit is written only once it is a decimal', async () => {
    resetStore([block('number', 'n')]);
    const user = open('n');
    await user.click(screen.getByRole('tab', { name: 'Validation' }));
    const min = screen.getByRole('textbox', { name: 'Minimum' });
    await user.type(min, '1.');
    expect(get('n').config['min']).toBe('1');
    await user.type(min, '5');
    expect(get('n').config['min']).toBe('1.5');
  });

  it('B28: the rating point count is a choice of 1 to 10', async () => {
    resetStore([block('rating', 'stars', { label: 'Stars' })]);
    const user = open('stars');
    await user.click(screen.getByRole('combobox', { name: 'Number of points' }));
    expect(screen.getByRole('option', { name: '1' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '11' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '10' }));
    expect(get('stars').config['max']).toBe(10);
  });
});

describe('BlockInspector logic', () => {
  it('writes a form-level rule with a typed operand and marks the target hidden until it matches (D2)', async () => {
    resetStore([block('single_choice', 'attending', { label: 'Attending?' }), block('short_text', 'reason', { label: 'Reason' })]);
    const user = open('reason');
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    const [ruleOne] = doc().logic.rules;
    expect(ruleOne).toMatchObject({
      enabled: true,
      when: { combinator: 'all', children: [{ left: { kind: 'ref', ref: { kind: 'answer', blockId: 'attending' } }, op: 'eq', right: { kind: 'options', blockId: 'attending', optionIds: ['option_1'] } }] },
      then: [{ type: 'show', targets: ['reason'] }],
    });
    expect(get('reason')['initiallyHidden']).toBe(true);
    expect(screen.getByText('Hidden until a rule shows it')).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'Options' })).getByRole('radio', { name: 'Option 2' }));
    expect(doc().logic.rules[0]?.when.children[0]).toMatchObject({ right: { optionIds: ['option_2'] } });
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(doc().logic.rules).toEqual([]);
    expect(get('reason')).not.toHaveProperty('initiallyHidden');
  });

  it('two rules reading one single-choice source keep their own radio groups', async () => {
    resetStore([block('single_choice', 'attending', { label: 'Attending?' }), block('short_text', 'reason', { label: 'Reason' })]);
    const user = open('reason');
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    const [first, second] = screen.getAllByRole('group', { name: 'Options' });
    await user.click(within(second as HTMLElement).getByRole('radio', { name: 'Option 2' }));
    expect(within(first as HTMLElement).getByRole('radio', { name: 'Option 1' })).toBeChecked();
    expect(within(second as HTMLElement).getByRole('radio', { name: 'Option 2' })).toBeChecked();
    expect(doc().logic.rules.map((r) => r.when.children[0])).toMatchObject([{ right: { optionIds: ['option_1'] } }, { right: { optionIds: ['option_2'] } }]);
  });

  it('a text source takes a text literal; only earlier questions can be read (I8)', async () => {
    resetStore([block('short_text', 'country', { label: 'Country' }), block('short_text', 'state', { label: 'State' }), block('short_text', 'later', { label: 'Later' })]);
    const user = open('state');
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'IN');
    expect(doc().logic.rules[0]?.when.children[0]).toMatchObject({ op: 'eq', right: text('IN') });
    await user.click(screen.getByRole('combobox', { name: 'When' }));
    expect(screen.getByRole('option', { name: 'Country' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Later' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'State' })).not.toBeInTheDocument();
  });

  it.each([
    ['date', 'is before', '2026-01-31', { type: 'date', value: '2026-01-31' }],
    ['time', 'is after', '09:30', { type: 'time', value: '09:30' }],
  ] as const)('a %s source takes a typed value, and the form still previews at every step', async (type, opName, typed, value) => {
    resetStore([block(type, 'when', { label: 'When' }), block('short_text', 'why', { label: 'Why' })]);
    const previews = () => previewVersion(doc(), { state: 'open' }, '2026-10-18T10:00:00.000Z' as IsoInstant);
    const user = open('why');
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    expect(doc().logic.rules[0]?.when.children[0]).toMatchObject({ op: 'eq', right: { kind: 'literal', value: { type } } });
    expect(previews().ok).toBe(true);
    await pick(user, 'Condition', opName);
    expect(previews().ok).toBe(true);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: typed } });
    expect(doc().logic.rules[0]?.when.children[0]).toMatchObject({ right: { kind: 'literal', value } });
    expect(previews().ok).toBe(true);
  });

  it('lists a rule it cannot edit instead of rewriting it', async () => {
    const complex = rule('r1', 'a', 'is_answered', undefined, 'show', ['b']);
    complex.when.children.push({ kind: 'condition', id: 'c2' as never, left: { kind: 'ref', ref: { kind: 'answer', blockId: 'a' as BlockId } }, op: 'is_not_answered' });
    resetStore([block('short_text', 'a'), block('short_text', 'b')], [complex]);
    const user = open('b');
    await user.click(screen.getByRole('tab', { name: 'Logic' }));
    expect(screen.getByText(/A rule with 2 conditions acts on this block/)).toBeInTheDocument();
  });
});

describe('BlockInspector look', () => {
  it('a half-typed hex code leaves the stored colour alone; a full one or an empty box writes', async () => {
    resetStore([block('short_text', 'name', { label: 'Name', style: { labelColor: '#ff0000' } })]);
    const user = open('name');
    const box = screen.getByRole('textbox', { name: 'Question colour hex code' });
    await user.type(box, '{Backspace}');
    expect(box).toHaveValue('#ff000');
    expect(get('name')['style']).toEqual({ labelColor: '#ff0000' });
    await user.type(box, '8');
    expect(get('name')['style']).toEqual({ labelColor: '#ff0008' });
    await user.clear(box);
    expect(get('name')).not.toHaveProperty('style');
    for (const ch of '#00ff0') {
      await user.type(box, ch);
      expect(get('name')).not.toHaveProperty('style');
    }
    await user.type(box, '0');
    expect(get('name')['style']).toEqual({ labelColor: '#00ff00' });
  });
});
