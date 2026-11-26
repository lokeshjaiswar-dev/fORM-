import { describe, expect, it } from 'vitest';
import type { ChoiceOption, OptionId } from '@form/schema';
import { isDropdown, withoutForbidden } from '@/fields/dropdownChoices';

const option = (id: string, label: string, code?: string): ChoiceOption => ({ id: id as OptionId, label, ...(code !== undefined ? { code } : {}) });

describe('dropdown choices without "&"', () => {
  it('takes "&" out of labels and codes, dropping a code that becomes empty', () => {
    const plain = option('a', 'Sales');
    const out = withoutForbidden([plain, option('b', 'R&D', 'r&d'), option('c', 'Q & A', '&')]);
    expect(out[0]).toBe(plain);
    expect(out[1]).toEqual({ id: 'b', label: 'RD', code: 'rd' });
    expect(out[2]).toEqual({ id: 'c', label: 'Q  A' });
  });

  it('applies to choice questions shown as a dropdown only', () => {
    expect(isDropdown({ type: 'single_choice', config: { display: 'dropdown' } })).toBe(true);
    expect(isDropdown({ type: 'multi_choice', config: { display: 'dropdown' } })).toBe(true);
    expect(isDropdown({ type: 'single_choice', config: { display: 'radio' } })).toBe(false);
    expect(isDropdown({ type: 'ranking', config: { display: 'dropdown' } })).toBe(false);
  });
});
