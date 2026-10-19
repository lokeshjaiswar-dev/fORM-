import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { migrateTemplatePayload, migrateUnknown } from '@form/schema';
import type * as S from '@form/schema';
import { V1_TEMPLATES, migrationContext } from '@form/schema/migration-fixtures';
import { instantiate } from '@form/templates-core';
import { describe, expect, it } from 'vitest';
import { DEV_TRUSTED_KEY, buildFormpack, localizationOf, packTemplateVersion, readFormpack, type Formpack } from '../src/index.ts';
import { devPrivateKey, devSigner, trustedKeyOf } from '../scripts/signer.ts';
import { systemCore } from './helpers.ts';

const NOW = '2026-10-18T00:00:00Z' as S.IsoInstant;
const SLUGS = ['core/contact', 'core/feedback', 'core/nps', 'core/job-application', 'core/event-registration'];

async function built(): Promise<{ bytes: Uint8Array; pack: Formpack }> {
  const result = await buildFormpack(systemCore(), devSigner());
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return { bytes: result.bytes, pack: await readFormpack(result.bytes, { trustedKeys: [DEV_TRUSTED_KEY] }) };
}

const context = (seed: string): S.InstantiateContext => ({
  newFormId: 'form_new' as S.FormId,
  idSeed: seed,
  bindingIdSeed: `${seed}/bindings`,
  locale: 'en-IN' as S.Locale,
  extraLocales: [],
  orgProfile: null,
  brandKit: null,
  variables: {},
  include: { theme: true, emails: true, endings: true, pdf: true, workflow: true },
  now: NOW,
});

const types = (def: S.FormDefinition) => def.pages.flatMap((p) => p.children.map((id) => def.blocks[id]?.type));

describe('system-core pack', () => {
  it('builds with no errors or warnings and lists the five templates', async () => {
    const result = await buildFormpack(systemCore(), devSigner());
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    if (!result.ok) return;
    expect(result.fileName).toBe('system-core-2026.10.0.formpack');
    expect(result.manifest.templates.map((t) => t.slug)).toEqual(SLUGS);
    expect(result.manifest.templates[0]).toMatchObject({
      kind: 'form', version: 1, path: 'templates/core/contact.v1.json', dependsOn: [],
      requiredFeatures: ['field:email', 'field:heading', 'field:long_text', 'field:paragraph', 'field:short_text'],
    });
  });

  it('builds the same bytes twice', async () => {
    const [a, b] = await Promise.all([built(), built()]);
    expect(a.bytes).toEqual(b.bytes);
  });

  it('reads back with the development key', async () => {
    const { pack } = await built();
    expect(pack.signature).toMatchObject({ alg: 'ed25519', keyId: 'fORM-dev-2026' });
    expect(pack.templates.map((t) => localizationOf(t.file, 'en-IN' as S.Locale)?.title)).toEqual(['Contact us', 'Customer feedback', 'NPS survey', 'Job application', 'Event registration']);
    expect(pack.categories.map((c) => c.slug)).toEqual(['general', 'feedback', 'events', 'hr']);
    expect(pack.attestations).toEqual([]);
  });

  it('trusts the key the development signer holds', () => {
    expect(trustedKeyOf(DEV_TRUSTED_KEY.keyId, devPrivateKey())).toEqual(DEV_TRUSTED_KEY);
  });

  it('keeps every source at the current schema (its own migrate() output)', () => {
    for (const { file } of systemCore().templates) {
      const payload = (file as { payload: unknown }).payload;
      const result = migrateTemplatePayload(payload);
      expect(result).toEqual({ ok: true, payload, notes: [] });
    }
  });

  it('ports the five builder templates: the same block types in the same order', () => {
    const port: Record<string, string> = { contact: 'core/contact', feedback: 'core/feedback', nps: 'core/nps', job: 'core/job-application', event: 'core/event-registration' };
    const sources = new Map(systemCore().templates.map((t) => [t.slug, (t.file as { payload: S.FormTemplatePayload }).payload.document]));
    for (const { name, doc } of V1_TEMPLATES) {
      const migrated = migrateUnknown(doc, migrationContext(REGISTRY)).definition;
      const source = sources.get(port[name] ?? '');
      expect(source && types(source), name).toEqual(types(migrated));
      expect(source?.pages.length, name).toBe(migrated.pages.length);
    }
  });

  it('instantiates every template into a draft that validates', async () => {
    const { pack } = await built();
    for (const template of pack.templates) {
      const version = packTemplateVersion(pack, template, NOW);
      expect(version).toMatchObject({ orgId: null, state: 'published', version: 1, packSignature: { keyId: 'fORM-dev-2026' } });
      const result = instantiate(version, context(`use:${template.entry.slug}`));
      expect(validateDefinition(result.definition, 'save', REGISTRY).filter((i) => i.severity === 'error'), template.entry.slug).toEqual([]);
      expect(result.warnings, template.entry.slug).toEqual([]);
      expect(Object.keys(result.definition.blocks)).toHaveLength(Object.keys(template.file.payload.kind === 'form' ? template.file.payload.document.blocks : {}).length);
    }
    const nps = pack.templates.find((t) => t.entry.slug === 'core/nps');
    expect(nps && packTemplateVersion(pack, nps, NOW).stats).toEqual({ fields: 3, pages: 2, estMinutes: 1, hasSensitive: false });
  });
});
