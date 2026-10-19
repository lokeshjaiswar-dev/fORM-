import type { IsoInstant } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { formFromTemplate, loadSystemPack } from '@/lib/systemPack';
import { labelText } from '@/lib/v1html';

const USE = { idSeed: '6f1c2d3e-0000-4000-8000-000000000001', bindingIdSeed: 'bindings-1', now: '2026-10-18T00:00:00Z' as IsoInstant };

async function forms() {
  const pack = await loadSystemPack();
  return new Map(pack.templates.map((t) => [t.entry.slug, formFromTemplate(pack, t, USE)]));
}

describe('system pack in the builder', () => {
  it('verifies the bundled pack and lists the five templates', async () => {
    const pack = await loadSystemPack();
    expect(pack.signature.keyId).toBe('fORM-dev-2026');
    expect(pack.templates.map((t) => t.entry.slug)).toEqual(['core/contact', 'core/feedback', 'core/nps', 'core/job-application', 'core/event-registration']);
    expect(await loadSystemPack()).toBe(pack);
  });

  it('instantiates each template offline into the v1 store shape', async () => {
    const all = await forms();
    for (const [slug, { form, skipped }] of all) {
      expect(skipped, slug).toBe(0);
      expect(form.blocks.map((b) => b.order), slug).toEqual(form.blocks.map((_, i) => i));
    }
    const contact = all.get('core/contact')?.form;
    expect(contact?.title).toBe('Contact us');
    expect(contact?.blocks.map((b) => [b.type, labelText(b.label), b.validation?.required])).toEqual([
      ['heading', 'Contact us', false], ['paragraph', 'Tell us how we can help.', false],
      ['text', 'Full name', true], ['email', 'Email', true], ['long_text', 'Message', true],
    ]);
    expect(all.get('core/nps')?.form.blocks.map((b) => b.type)).toEqual(['heading', 'nps', 'page_break', 'long_text', 'email']);
    const role = all.get('core/job-application')?.form.blocks.find((b) => b.type === 'dropdown');
    expect(role?.options?.map((o) => [o.id, o.label, o.value])).toContainEqual(['role_engineering', 'Engineering', 'engineering']);
    const guests = all.get('core/event-registration')?.form.blocks.find((b) => b.type === 'number');
    expect(guests?.validation).toMatchObject({ min: 0, max: 10 });
    expect(all.get('core/feedback')?.form.blocks.find((b) => b.type === 'rating')?.customize?.ratingMax).toBe(5);
    expect(contact?.settings).toMatchObject({ successMessage: 'Thanks — we received your response.', accentColor: '#2383e2', submitButtonText: 'Submit' });
  });

  it('derives the same ids from the same seed, and new ones from another', async () => {
    const pack = await loadSystemPack();
    const [contact] = pack.templates;
    if (!contact) throw new Error('no template');
    const ids = (seed: string) => formFromTemplate(pack, contact, { ...USE, idSeed: seed }).form.blocks.map((b) => b.id);
    expect(ids(USE.idSeed)).toEqual(ids(USE.idSeed));
    expect(ids('another-seed').some((id) => ids(USE.idSeed).includes(id))).toBe(false);
  });
});
