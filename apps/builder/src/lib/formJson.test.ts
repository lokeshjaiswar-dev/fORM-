import { describe, expect, it } from 'vitest';
import type { FormDefinition, IsoInstant } from '@form/schema';
import { blankDefinition } from '@/lib/definition';
import { formFileName, parseFormJson, serializeForm } from '@/lib/formJson';

const NOW = '2026-11-18T00:00:00.000Z' as IsoInstant;

function sampleDoc(): FormDefinition {
  return { ...blankDefinition('src'), title: 'Leave Request' };
}

describe('form JSON export and import', () => {
  it('round-trips an exported form through the envelope', () => {
    const doc = sampleDoc();
    const text = serializeForm(doc, new Date(NOW));
    const parsed = parseFormJson(text, 'new-id', NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.title).toBe('Leave Request');
    expect(parsed.doc.formId).toBe('new-id');
    expect(parsed.doc.blocks).toEqual(doc.blocks);
  });

  it('accepts a bare v2 definition', () => {
    const parsed = parseFormJson(JSON.stringify(sampleDoc()), 'x', NOW);
    expect(parsed.ok).toBe(true);
  });

  it('refuses invalid JSON with a readable reason', () => {
    const parsed = parseFormJson('{ nope', 'x', NOW);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/not valid JSON/);
  });

  it('refuses a JSON value that is not an object', () => {
    const parsed = parseFormJson('[1,2,3]', 'x', NOW);
    expect(parsed.ok).toBe(false);
  });

  it('refuses a definition that fails the schema', () => {
    const broken = { ...sampleDoc(), schemaVersion: 99 };
    const parsed = parseFormJson(JSON.stringify(broken), 'x', NOW);
    expect(parsed.ok).toBe(false);
  });

  it('refuses an envelope with an unknown version', () => {
    const text = JSON.stringify({ format: 'dmacq-form', version: 9, definition: sampleDoc() });
    const parsed = parseFormJson(text, 'x', NOW);
    expect(parsed.ok).toBe(false);
  });

  it('builds a safe file name from the title', () => {
    expect(formFileName('Leave Request!')).toBe('leave-request.form.json');
    expect(formFileName('   ')).toBe('form.form.json');
  });
});
