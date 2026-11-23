import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlockId, ChoiceOption, ConditionId, IsoInstant, OptionId, Rule, RuleId } from '@form/schema';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { SUBMIT_INSPECTOR_ID } from '@/components/builder/SubmitInspector';
import { TITLE_INSPECTOR_ID } from '@/components/builder/TitleInspector';
import { labelString } from '@/fields/style';
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
  it('has three tabs, General, Design and Logic, with the options, validation and privacy on General', () => {
    open('color');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Design', 'Logic']);
    const panel = screen.getByRole('tabpanel');
    const headings = within(panel).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Options', 'Customization', 'Validation', 'Advanced', 'Privacy']);
    expect(within(panel).getByRole('button', { name: 'Add option' })).toBeInTheDocument();
  });

  it('content blocks have General, Design and Logic only', () => {
    resetStore([block('heading', 'h')]);
    open('h');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Design', 'Logic']);
  });

  it('a hidden field has no Design tab: it never shows on the form', () => {
    resetStore([block('hidden', 'utm')]);
    open('utm');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'Logic']);
  });

  it('keeps the field key folded under Advanced until opened', async () => {
    resetStore([block('short_text', 'name')]);
    const user = open('name');
    expect(screen.queryByRole('textbox', { name: 'Field key' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Field key' })).toBeInTheDocument();
  });

  it('edits the field key, refusing a key that is taken or malformed', async () => {
    resetStore([block('short_text', 'name'), block('email', 'mail')]);
    const user = open('name');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
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
  /* The options are on General: nothing to open first. */
  const tab = async (_user: ReturnType<typeof userEvent.setup>) => undefined;

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

  it('enables API options with a GET URL', async () => {
    const user = open('color');
    await tab(user);
    await user.click(screen.getByRole('switch', { name: 'Load options from an API' }));
    expect(get('color').apiOptions).toEqual({ url: 'http://localhost:3001/cities', method: 'GET', parser: 'json' });
    fireEvent.change(screen.getByRole('textbox', { name: 'API URL' }), { target: { value: 'https://hr.example.com/cities' } });
    expect(get('color').apiOptions).toEqual({ url: 'https://hr.example.com/cities', method: 'GET', parser: 'json' });
  });

  it('moves options and toggles Other', async () => {
    const user = open('color');
    await tab(user);
    expect(screen.queryByRole('button', { name: /Move option/ })).not.toBeInTheDocument();
    const handle = screen.getByRole('button', { name: /Reorder option 1/ });
    handle.focus();
    await user.keyboard('{ArrowDown}');
    expect(options().map((o) => o.id)).toEqual(['o2', 'o1', 'o3']);
    await user.keyboard('{ArrowUp}');
    expect(options().map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
    await user.click(screen.getByRole('switch', { name: 'Add an “Other” option' }));
    expect(get('color').config['other']).toEqual({ enabled: true, textRequired: false });
  });
});

describe('BlockInspector validation', () => {
  it("B12: an invalid pattern '[' shows an inline error and does not crash", async () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    const user = open('name');
    const pattern = screen.getByRole('textbox', { name: 'Pattern (regular expression)' });
    await user.type(pattern, '[[');
    expect(get('name').config['pattern']).toEqual({ source: '[' });
    expect(screen.getByText(/This pattern is ignored until fixed/)).toBeInTheDocument();
    await user.type(pattern, ']]a');
    expect(screen.queryByText(/This pattern is ignored until fixed/)).not.toBeInTheDocument();
  });

  it('explains that RE2 does not support lookahead', async () => {
    resetStore([block('short_text', 'name', { label: 'Name' })]);
    const user = open('name');
    expect(screen.getByText(/RE2, not JavaScript or Python/)).toBeInTheDocument();
    const pattern = screen.getByRole('textbox', { name: 'Pattern (regular expression)' });
    await user.type(pattern, '(?=a)a');
    expect(get('name').config['pattern']).toEqual({ source: '(?=a)a' });
    expect(screen.getByText(/Lookahead and lookbehind are not supported in RE2/)).toBeInTheDocument();
  });

  it('required and read-only are field type toggles on General; both together warn (B27)', async () => {
    resetStore([block('short_text', 'name')]);
    const user = open('name');
    await user.click(screen.getByRole('button', { name: 'Required' }));
    expect(get('name')['required']).toBe(true);
    expect(screen.getByRole('button', { name: 'Required' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Read-only' }));
    expect(get('name')['readOnly']).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('read-only field needs a default value');
  });

  it('Hidden is a third field type toggle: it conceals the field from respondents (PROP-07) and warns when required', async () => {
    resetStore([block('short_text', 'ref')]);
    const user = open('ref');
    const hidden = screen.getByRole('button', { name: 'Hidden' });
    await user.click(hidden);
    expect(get('ref')['concealed']).toBe(true);
    expect(hidden).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Required' }));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot fill a hidden field');
    await user.click(hidden);
    expect(get('ref')).not.toHaveProperty('concealed');
    expect(get('ref')['required']).toBe(true);
  });

  it('writes a unique constraint', async () => {
    resetStore([block('short_text', 'code')]);
    const user = open('code');
    expect(screen.queryByRole('textbox', { name: 'Input mask' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Must be unique on this form' }));
    expect(get('code')['unique']).toEqual({ normalize: 'trim_lower' });
  });

  it('counts long text in words', async () => {
    resetStore([block('long_text', 'bio')]);
    const user = open('bio');
    await pick(user, 'Count', 'Words');
    const min = screen.getByRole('textbox', { name: 'Minimum characters' });
    await user.type(min, '10');
    expect(get('bio').config['limit']).toEqual({ unit: 'words', min: 10 });
  });

  it('toggles email confirmation and allowed domains', async () => {
    resetStore([block('email', 'mail')]);
    const user = open('mail');
    await user.click(screen.getByRole('switch', { name: 'Ask the respondent to type the email twice' }));
    await user.type(screen.getByRole('textbox', { name: 'Allowed domains' }), 'acme.com');
    expect(get('mail').config['confirm']).toBe(true);
    expect(get('mail').config['allowedDomains']).toEqual(['acme.com']);
  });

  it('enables API validation and stores an https URL', async () => {
    resetStore([block('short_text', 'emp_name')]);
    const user = open('emp_name');
    await user.click(screen.getByRole('switch', { name: 'Validate with an API' }));
    expect(get('emp_name').apiValidation).toEqual({ url: 'http://localhost:3001/verify-name', method: 'POST', parser: 'json' });
    fireEvent.change(screen.getByRole('textbox', { name: 'API URL' }), { target: { value: 'https://hr.example.com/names' } });
    expect(get('emp_name').apiValidation).toEqual({ url: 'https://hr.example.com/names', method: 'POST', parser: 'json' });
    await user.click(screen.getByRole('radio', { name: 'GET' }));
    expect((get('emp_name') as { apiValidation?: { method?: string } }).apiValidation?.method).toBe('GET');
  });

  it('enables API validation on any answer field', async () => {
    resetStore([block('email', 'mail')]);
    const user = open('mail');
    await user.click(screen.getByRole('switch', { name: 'Validate with an API' }));
    expect(get('mail').apiValidation).toEqual({ url: 'http://localhost:3001/verify-name', method: 'POST', parser: 'json' });
  });

  it('sets a minimum age on a date field', async () => {
    resetStore([block('date', 'dob')]);
    const user = open('dob');
    await user.type(screen.getByRole('textbox', { name: 'Minimum age' }), '18');
    expect(get('dob').config['limits']).toEqual({ age: { min: 18 } });
  });

  it('a number limit is written only once it is a decimal', async () => {
    resetStore([block('number', 'n')]);
    const user = open('n');
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

describe('BlockInspector matrix labels', () => {
  it('lets the author clear a row or column label and type a new one', async () => {
    resetStore([block('matrix', 'grid', { label: 'Table' })]);
    const user = open('grid');
    const row = screen.getByDisplayValue('Row 1');
    await user.clear(row);
    expect(row).toHaveValue('');
    expect((get('grid').config['rows'] as Array<{ label: string }>)[0]?.label).toBe('');
    await user.type(row, 'Age');
    expect((get('grid').config['rows'] as Array<{ label: string }>)[0]?.label).toBe('Age');
    const col = screen.getByDisplayValue('Column 1');
    await user.clear(col);
    expect(col).toHaveValue('');
    await user.type(col, 'Yes');
    expect((get('grid').config['columns'] as Array<{ label: string }>)[0]?.label).toBe('Yes');
  });
});

describe('BlockInspector form title', () => {
  it('opens settings for colour, size, alignment and weight', async () => {
    resetStore([block('short_text', 'name')]);
    const user = userEvent.setup();
    useUiStore.getState().openInspector(TITLE_INSPECTOR_ID);
    render(<BlockInspector />);
    expect(screen.getByText('Form title')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Center' }));
    expect(doc().titleStyle).toEqual({ align: 'center' });
    await user.clear(screen.getByRole('spinbutton', { name: 'Title size' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Title size' }), '52');
    await user.keyboard('{Enter}');
    expect(doc().titleStyle).toMatchObject({ align: 'center', sizePx: 52 });
    await user.click(screen.getByRole('combobox', { name: 'Weight' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Normal' }));
    expect(doc().titleStyle).toMatchObject({ weight: 'normal' });
  });
});

describe('BlockInspector submit', () => {
  it('opens settings for label, alignment, and print', async () => {
    resetStore([block('short_text', 'name')]);
    const user = userEvent.setup();
    useUiStore.getState().openInspector(SUBMIT_INSPECTOR_ID);
    render(<BlockInspector />);
    expect(screen.getByText('Submit button')).toBeInTheDocument();
    const label = screen.getByRole('textbox', { name: 'Button label' });
    await user.clear(label);
    await user.type(label, 'Send');
    expect(labelString(doc().behavior.submit.label)).toBe('Send');
    await user.click(screen.getByRole('radio', { name: 'Full width' }));
    expect(doc().behavior.submit.align).toBe('full');
    await user.click(screen.getByRole('combobox', { name: 'Size' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Large' }));
    expect(doc().behavior.submit.size).toBe('lg');
    await user.click(screen.getByRole('combobox', { name: 'Shape' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Pill' }));
    expect(doc().behavior.submit.shape).toBe('pill');
  });
});

describe('BlockInspector look', () => {
  it('a half-typed hex code leaves the stored colour alone; a full one or an empty box writes', async () => {
    resetStore([block('short_text', 'name', { label: 'Name', style: { labelColor: '#ff0000' } })]);
    const user = open('name');
    await user.click(screen.getByRole('tab', { name: 'Design' }));
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

describe('formula fields from a filled option value', () => {
  const fill: Rule = {
    id: 'fill' as RuleId,
    enabled: true,
    when: { kind: 'group', id: 'fill_g' as ConditionId, combinator: 'all', children: [] },
    then: [{
      type: 'set_value',
      target: 'price' as BlockId,
      value: { k: 'call', fn: 'option_code', args: [{ k: 'ref', ref: { kind: 'answer', blockId: 'item' as BlockId } }] },
    }],
  };

  beforeEach(() => {
    resetStore([
      block('repeating_group', 'items', { label: 'Items', config: { children: ['item', 'price', 'line'] as BlockId[] } }),
      block('single_choice', 'item', {
        label: 'Item',
        config: { display: 'dropdown', options: [{ id: 'burger' as OptionId, label: 'Burger', code: '40' }] },
      }),
      block('short_text', 'price', { label: 'Price' }),
      block('calculation', 'line', { label: 'Line' }),
      block('number', 'tax', { label: 'Tax' }),
      block('calculation', 'total', { label: 'Total' }),
    ], [fill]);
  });

  it('inserts that row’s price when the formula sits inside the list', () => {
    open('line');
    expect(screen.getByRole('button', { name: 'Price' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sum(Price)' })).not.toBeInTheDocument();
  });

  it('inserts the sum of every row’s price when the formula sits outside the list', () => {
    open('total');
    expect(screen.getByRole('button', { name: 'sum(Price)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Price' })).not.toBeInTheDocument();
  });
});

describe('dropdown fill toggle', () => {
  beforeEach(() => {
    resetStore([
      block('single_choice', 'menu', {
        label: 'Menu',
        config: { display: 'dropdown', options: [{ id: 'burger' as OptionId, label: 'Burger', code: '467' }] },
      }),
    ]);
  });

  it('turns on and adds an empty field filled from the option value', async () => {
    const user = open('menu');
    const toggle = screen.getByRole('switch', { name: 'Fill a field from the selected option' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(doc().logic.rules).toHaveLength(1);
    expect(doc().logic.rules[0]?.then[0]).toMatchObject({ type: 'set_value', value: { k: 'call', fn: 'option_code' } });
    const target = doc().logic.rules[0]?.then[0];
    const valueId = target && 'target' in target ? target.target : '';
    expect((doc().blocks['menu' as BlockId] as { layout?: unknown } | undefined)?.layout).toMatchObject({ width: 'half' });
    expect(valueId ? (doc().blocks[valueId] as { layout?: unknown } | undefined)?.layout : undefined).toMatchObject({ width: 'half' });
  });
});
