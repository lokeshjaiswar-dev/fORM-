import { describe, expect, it } from 'vitest';
import { bodyOnSave } from './webhooks.ts';

/*
 * PUT /v1/forms/:formId/webhooks/:id and the custom body: a client that does not send `bodyFormat` / `payloadMapping` (a
 * builder tab loaded before they existed, or an API script) keeps what is stored instead of silently resetting the receiver
 * to the standard JSON payload. `payloadMapping: null` still clears the mapping. The int suite covers the route end to end.
 */
describe('bodyOnSave', () => {
  const mapping = { root: 'order', entries: [{ path: 'customer.name', source: { kind: 'answer' as const, key: 'name' } }] };
  const stored = { bodyFormat: 'xml' as const, payloadMapping: mapping };

  it('keeps the stored format and mapping when the keys are left out', () => {
    expect(bodyOnSave({}, stored)).toEqual(stored);
    expect(bodyOnSave({ bodyFormat: undefined, payloadMapping: undefined }, stored)).toEqual(stored);
  });

  it('takes what the save sends, and null clears the mapping', () => {
    expect(bodyOnSave({ payloadMapping: null }, stored)).toEqual({ bodyFormat: 'xml', payloadMapping: null });
    expect(bodyOnSave({ bodyFormat: 'json' }, stored)).toEqual({ bodyFormat: 'json', payloadMapping: mapping });
    const other = { entries: [{ path: 'ref', source: { kind: 'meta' as const, name: 'submissionId' as const } }] };
    expect(bodyOnSave({ bodyFormat: 'json', payloadMapping: other }, stored)).toEqual({ bodyFormat: 'json', payloadMapping: other });
  });
});
