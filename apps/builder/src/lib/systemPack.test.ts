import { validateDefinition } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { FormDefinitionSchema, type IsoInstant } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { formFromTemplate, loadSystemPack } from '@/lib/systemPack';
import { blockOrder, blockText } from '@/lib/definition';

const USE = { idSeed: '6f1c2d3e-0000-4000-8000-000000000001', bindingIdSeed: 'bindings-1', now: '2026-10-18T00:00:00Z' as IsoInstant };

async function forms() {
  const pack = await loadSystemPack();
  return new Map(pack.templates.map((t) => [t.entry.slug, formFromTemplate(pack, t, USE).definition]));
}

describe('system pack in the builder', () => {
  it('verifies the bundled pack and lists the five templates', async () => {
    const pack = await loadSystemPack();
    expect(pack.signature.keyId).toBe('fORM-dev-2026');
    expect(pack.templates.map((t) => t.entry.slug)).toEqual(['core/contact', 'core/feedback', 'core/nps', 'core/job-application', 'core/event-registration']);
    expect(await loadSystemPack()).toBe(pack);
  });

  it('BL-117: instantiates each template offline into a v2 definition the builder edits as it is', async () => {
    for (const [slug, definition] of await forms()) {
      expect(FormDefinitionSchema.safeParse(definition).success, slug).toBe(true);
      expect(validateDefinition(definition, 'save', REGISTRY).filter((i) => i.severity === 'error'), slug).toEqual([]);
    }
    const all = await forms();
    const contact = all.get('core/contact');
    expect(contact?.title).toBe('Contact us');
    const blocks = blockOrder(contact!).map((id) => contact!.blocks[id]!);
    expect(blocks.map((b) => [b.type, blockText(b), 'required' in b ? b.required : null])).toEqual([
      ['heading', 'Contact us', null], ['paragraph', 'Tell us how we can help.', null],
      ['short_text', 'Full name', true], ['email', 'Email', true], ['long_text', 'Message', true],
    ]);
    const nps = all.get('core/nps');
    expect(nps?.pages.map((p) => p.children.map((id) => nps.blocks[id]?.type))).toEqual([['heading', 'nps'], ['long_text', 'email']]);
    const job = all.get('core/job-application');
    const role = Object.values(job!.blocks).find((b) => b?.type === 'single_choice');
    expect(role?.type === 'single_choice' && role.config.options.map((o) => [o.id, o.label, o.code])).toContainEqual(['role_engineering', 'Engineering', 'engineering']);
  });

  it('derives the same ids from the same seed, and new ones from another', async () => {
    const pack = await loadSystemPack();
    const [contact] = pack.templates;
    if (!contact) throw new Error('no template');
    const ids = (seed: string) => Object.keys(formFromTemplate(pack, contact, { ...USE, idSeed: seed }).definition.blocks);
    expect(ids(USE.idSeed)).toEqual(ids(USE.idSeed));
    expect(ids('another-seed').some((id) => ids(USE.idSeed).includes(id))).toBe(false);
  });
});
