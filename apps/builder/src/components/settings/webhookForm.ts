import { plainLabelText, type InlineDoc } from '@form/schema';

/** A purpose the form declares: what a webhook may name in `purposeIds`. */
export interface FormPurpose {
  id: string;
  name: string;
}

/** A field of the form: what a webhook may pick in `fieldKeys`. */
export interface FormField {
  key: string;
  label: string;
}

/** What the webhook editor offers from the form: its declared purposes and its fields, in the order of the form. */
export interface FormFacts {
  purposes: FormPurpose[];
  fields: FormField[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The purposes and fields of a form's draft as the server holds it. Read leniently, as the API does when it checks the
 * purposes of a webhook (`declaredPurposeIds`): a draft that is half edited still names what it has, and anything that is
 * not a purpose with a string id, or not a field with a string key, is left out. The API checks again on every save, so
 * this only decides what the editor offers.
 */
export function factsOf(draft: unknown): FormFacts {
  const doc = isRecord(draft) ? draft : {};
  const privacy = isRecord(doc.privacy) ? doc.privacy : {};
  const purposes = (Array.isArray(privacy.purposes) ? privacy.purposes : []).flatMap((p): FormPurpose[] =>
    isRecord(p) && typeof p.id === 'string' ? [{ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id }] : [],
  );

  const blocks = isRecord(doc.blocks) ? doc.blocks : {};
  const fields: FormField[] = [];
  const seen = new Set<string>();
  const visit = (id: unknown): void => {
    if (typeof id !== 'string' || seen.has(id)) return;
    seen.add(id);
    const block = blocks[id];
    if (!isRecord(block)) return;
    if ('compliance' in block && typeof block.key === 'string') {
      fields.push({ key: block.key, label: plainLabelText(block.label as InlineDoc | undefined).trim() || block.key });
    }
    const config = isRecord(block.config) ? block.config : {};
    // A section and a repeating group hold other blocks; the page lists only the top level.
    if (Array.isArray(config.children)) config.children.forEach(visit);
  };
  for (const page of Array.isArray(doc.pages) ? doc.pages : []) {
    if (isRecord(page) && Array.isArray(page.children)) page.children.forEach(visit);
  }
  return { purposes, fields };
}
