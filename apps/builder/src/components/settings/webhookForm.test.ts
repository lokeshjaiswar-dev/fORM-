import { describe, expect, it } from 'vitest';
import { factsOf } from '@/components/settings/webhookForm';

const field = (id: string, key: string, label: unknown, config: Record<string, unknown> = {}) => ({ id, type: 'short_text', key, label, compliance: { classification: 'personal' }, config });

describe('factsOf', () => {
  it('reads the declared purposes and the fields in the order of the form, containers’ children included once', () => {
    const facts = factsOf({
      privacy: { purposes: [{ id: 'purpose_ops', name: ' Order handling ' }, { id: 'purpose_bare' }] },
      pages: [{ children: ['name', 'group'] }, { children: ['email', 'name'] }],
      blocks: {
        name: field('name', 'full_name', ['Full name']),
        group: { id: 'group', type: 'section', config: { children: ['city'] } },
        city: field('city', 'city', ['City']),
        email: field('email', 'email', []),
        // A heading is content, not a field: it has no key and no compliance.
        heading: { id: 'heading', type: 'heading', config: {} },
      },
    });
    expect(facts.purposes).toEqual([{ id: 'purpose_ops', name: 'Order handling' }, { id: 'purpose_bare', name: 'purpose_bare' }]);
    // A field with no label is listed by its key, and a block on two pages is listed once.
    expect(facts.fields).toEqual([
      { key: 'full_name', label: 'Full name' },
      { key: 'city', label: 'City' },
      { key: 'email', label: 'email' },
    ]);
  });

  it('is empty, and does not throw, for a draft that is half edited or not a form at all', () => {
    expect(factsOf(null)).toEqual({ purposes: [], fields: [] });
    expect(factsOf({ privacy: 'x', pages: [null, { children: 'oops' }, { children: [1, 'missing'] }], blocks: { a: 5 } })).toEqual({ purposes: [], fields: [] });
    expect(factsOf({ privacy: { purposes: [null, { id: 3 }, 'x'] } }).purposes).toEqual([]);
  });
});
