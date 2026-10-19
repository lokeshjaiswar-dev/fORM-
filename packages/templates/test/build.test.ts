import { describe, expect, it } from 'vitest';
import { DEV_TRUSTED_KEY, buildFormpack, readFormpack, validatePackSource, type BuildIssue, type PackSource } from '../src/index.ts';
import { devSigner } from '../scripts/signer.ts';
import { edit, fixture, single, systemCore } from './helpers.ts';

const contact = (): unknown => systemCore().templates[0]?.file;
const codes = (issues: BuildIssue[]) => issues.map((i) => `${i.at} ${i.code}${i.path ? ` ${i.path}` : ''}`);

async function errors(source: PackSource): Promise<string[]> {
  const result = await buildFormpack(source, devSigner());
  return result.ok ? [] : codes(result.issues);
}

describe('templates:build validation', () => {
  it('fails on a registry issue (negative fixture)', async () => {
    expect(await errors(single(fixture('registry-issue.json')))).toEqual(['core/fixture@1 required_and_disabled /payload/document/blocks/name/required']);
  });

  it('fails on a logic issue (negative fixture)', async () => {
    const issues = await errors(single(fixture('logic-issue.json')));
    expect(issues).toEqual(['core/fixture@1 operator_type_mismatch /payload/document/logic/rules/0/when/children/0/op']);
  });

  it('reports publish warnings without failing', async () => {
    const file = edit(contact(), { '/payload/document/blocks/message/initiallyHidden': true });
    const result = await buildFormpack(single(file), devSigner());
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(['core/fixture@1 initially_hidden_never_shown /payload/document/blocks/message/initiallyHidden']);
  });

  it('checks gallery texts, categories, variables, the data inventory and refs', async () => {
    const localization = { locale: 'hi-IN', title: 'Contact', summary: '', fieldLabels: '', completeness: 100 };
    const file = edit(contact(), {
      '/localizations': [localization, localization],
      '/categorySlugs': ['nope'],
      '/payload/document/blocks/intro/config/content/content/0/content/1': { type: 'var', attrs: { name: 'custom.team' } },
      '/payload/dataInventory/0/fieldSourceIds': ['name', 'heading'],
      '/payload/dataInventory/0/classification': 'sensitive',
      '/payload/dataInventory/0/encrypted': true,
      '/payload/dataInventory/1': { purposeName: 'Marketing', fieldSourceIds: [], classification: 'none', encrypted: false },
      '/payload/refs': { theme: { templateId: 'tpl_theme', versionId: 'tplv_theme' } },
    });
    expect(await errors(single(file))).toEqual([
      'core/fixture@1 localization_missing /localizations',
      'core/fixture@1 localization_duplicate /localizations',
      'core/fixture@1 category_unknown /categorySlugs/0',
      'core/fixture@1 ref_not_inline /payload/refs/theme',
      'core/fixture@1 variable_undeclared /payload/variables',
      'core/fixture@1 inventory_mismatch /payload/dataInventory/0',
      'core/fixture@1 inventory_mismatch /payload/dataInventory/0',
      'core/fixture@1 inventory_mismatch /payload/dataInventory/0',
      'core/fixture@1 inventory_mismatch /payload/dataInventory/0',
      'core/fixture@1 inventory_mismatch /payload/dataInventory/1',
    ]);
    expect(await errors(single(edit(contact(), { '/payload/dataInventory': [] })))).toEqual(['core/fixture@1 inventory_mismatch /payload/dataInventory']);
  });

  it('needs sources at the current schema, valid files and unique slugs', async () => {
    expect(await errors(single(edit(contact(), { '/payload/document': { title: 'Contact', blocks: [] } })))).toEqual(['core/fixture@1 document_migration_unavailable /payload/document']);
    expect(await errors(single(edit(contact(), { '/owner': 'me' })))).toEqual(['core/fixture@1 invalid_file']);
    expect(await errors(single('contact'))).toEqual(['core/fixture@1 invalid_file']);
    expect(await errors(single(contact(), 'Core/Contact'))).toEqual(['Core/Contact@1 invalid_slug']);
    const core = systemCore();
    const twice = { ...core, templates: [...core.templates, { ...core.templates[0]!, version: 2 }] };
    expect(await errors(twice)).toEqual(['core/contact@2 slug_duplicate']);
  });

  it('checks pack.json, categories.json and attestations.json', async () => {
    const core = systemCore();
    expect(await errors({ ...core, pack: { ...core.pack, version: 'latest' } })).toEqual(['pack.json invalid_file /version']);
    expect(await errors({ ...core, categories: [{ slug: 'x' }] })).toContain('categories.json invalid_file /0/facet');
    const categories = [
      { facet: 'use_case', slug: 'general', names: {}, kinds: ['form'], sort: 1 },
      { facet: 'use_case', slug: 'general', names: {}, kinds: ['form'], sort: 2, parentSlug: 'missing' },
    ];
    const issues = codes(validatePackSource({ ...core, categories }).issues);
    expect(issues.filter((i) => i.startsWith('categories.json'))).toEqual(['categories.json category_duplicate /1/slug', 'categories.json category_unknown /1/parentSlug']);
    const attestation = { slug: 'core/contact', version: 1, locale: 'en-IN', reviewer: 'Legal', reviewedAt: '2026-10-01', scope: 'consent notice en-IN' };
    expect(await errors({ ...core, attestations: [{ ...attestation, locale: 'hi-IN' }, { ...attestation, version: 9 }] })).toEqual([
      'attestations.json attestation_unknown /0/locale',
      'attestations.json attestation_unknown /1',
    ]);
    expect(await errors({ ...core, attestations: [{ slug: 'core/contact' }] })).toContain('attestations.json invalid_file /0/version');
    const result = await buildFormpack({ ...core, attestations: [attestation] }, devSigner());
    if (!result.ok) throw new Error('did not build');
    expect(result.manifest.attestations?.path).toBe('attestations.json');
    expect((await readFormpack(result.bytes, { trustedKeys: [DEV_TRUSTED_KEY] })).attestations).toEqual([attestation]);
  });
});
