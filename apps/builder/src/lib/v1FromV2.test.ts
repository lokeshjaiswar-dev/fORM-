import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { formFromTemplate, loadSystemPack } from '@/lib/systemPack';
import { v1FromV2 } from '@/lib/v1FromV2';
import { labelText } from '@/lib/v1html';
import { instantiate } from '@form/templates-core';
import { packTemplateVersion } from '@form/templates';

const NOW = '2026-10-18T00:00:00Z' as S.IsoInstant;
const doc = (text: string): S.InlineDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const field = (id: string, type: S.ValueFieldType, config: object, extra: object = {}) =>
  ({ id, type, key: id, label: doc(id), required: false, compliance: { classification: 'none', purposeIds: [] }, config, ...extra }) as unknown as S.StoredBlock;

async function contactDefinition(): Promise<S.FormDefinition> {
  const pack = await loadSystemPack();
  const contact = pack.templates[0];
  if (!contact) throw new Error('no template');
  expect(formFromTemplate(pack, contact, { idSeed: 'seed', bindingIdSeed: 'b', now: NOW }).skipped).toBe(0);
  return instantiate(packTemplateVersion(pack, contact, NOW), {
    newFormId: 'f' as S.FormId, idSeed: 'seed', bindingIdSeed: 'b', locale: 'en-IN' as S.Locale, extraLocales: [], orgProfile: null, brandKit: null,
    variables: {}, include: { theme: true, emails: true, endings: true, pdf: true, workflow: true }, now: NOW,
  }).definition;
}

describe('v1FromV2', () => {
  it('maps what the v1 store can hold and counts what it cannot', async () => {
    const def = await contactDefinition();
    const blocks: Array<[string, S.StoredBlock]> = [
      ['h2', { id: 'h2', type: 'heading', config: { level: 2, text: doc('Part two') } } as unknown as S.StoredBlock],
      ['h3', { id: 'h3', type: 'heading', config: { level: 3, text: doc('Detail') } } as unknown as S.StoredBlock],
      ['radio', field('radio', 'single_choice', { display: 'radio', options: [{ id: 'a', label: 'A' }], other: { enabled: true, label: 'Other', textRequired: false }, shuffle: { keepLast: 0 } })],
      ['boxes', field('boxes', 'multi_choice', { display: 'checkbox', options: [{ id: 'x', label: 'X', code: 'x1' }] })],
      ['multi', field('multi', 'multi_choice', { display: 'dropdown', options: [] })],
      ['scale', field('scale', 'linear_scale', { min: 0, max: 7, lowLabel: 'Low' })],
      ['files', field('files', 'file_upload', { maxFiles: 3 }, { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PDF only' }] }] }, hideLabel: true })],
      ['group', { id: 'group', type: 'section', config: { children: [] } } as unknown as S.StoredBlock],
      ['legacy', { id: 'legacy' as S.BlockId, type: 'unsupported', originalType: 'matrix_v0', raw: {} }],
    ];
    const page2 = { id: 'page_2' as S.PageId, title: ['Step ', { var: { name: 'custom.step' as S.TemplateVariableName, fallback: 'two' } }, { pipe: { source: { kind: 'answer', blockId: 'radio' }, fallback: '!' } }], children: [...blocks.map(([id]) => id as S.BlockId), 'gone' as S.BlockId] } as S.Page;
    const ending: S.Ending = { id: 'redirect' as S.EndingId, kind: 'redirect', name: 'Away', url: ['https://example.org'] };
    const { form, skipped } = v1FromV2({
      ...def,
      description: undefined,
      blocks: { ...def.blocks, ...Object.fromEntries(blocks) },
      pages: [...def.pages, page2],
      endings: [ending],
      defaultEndingId: ending.id,
      logic: { ...def.logic, rules: [{ id: 'r' } as unknown as S.Rule] },
      behavior: { ...def.behavior, submit: { ...def.behavior.submit, label: '' } },
      theme: { ...def.theme, tokens: { ...def.theme.tokens, progress: 'bar', colors: { accent: { token: 'brand' } } as unknown as S.Theme['tokens']['colors'] } },
    });
    expect(skipped).toBe(4);
    const rest = form.blocks.slice(5);
    expect(rest.map((b) => b.type)).toEqual(['page_break', 'heading_2', 'heading_3', 'multiple_choice', 'checkbox', 'multi_select', 'linear_scale', 'file_upload']);
    expect(labelText(rest[0]?.label ?? '')).toBe('Step two!');
    expect(rest[3]?.customize).toMatchObject({ otherOption: true, randomize: true });
    expect(rest[4]?.options).toEqual([{ id: 'x', label: 'X', value: 'x1' }]);
    expect(rest[6]?.customize).toMatchObject({ scaleMin: 0, scaleMax: 7, scaleMinLabel: 'Low', scaleMaxLabel: '' });
    expect(rest[7]?.customize).toMatchObject({ allowMultiple: true, hideLabel: true });
    expect(labelText(rest[7]?.helpText ?? '')).toBe('PDF only');
    expect(form.description).toBe('');
    expect(form.settings).toMatchObject({ successMessage: 'Thanks for your response!', submitButtonText: 'Submit', accentColor: '#2383e2', progressBar: true });
  });
});
