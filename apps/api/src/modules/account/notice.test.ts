import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTICE_TEMPLATE, NOTICE_VERSION, renderNotice } from './notice.ts';

const privacy = { fiduciaryName: 'Acme Hospital', contactEmail: 'privacy@acme.example', contactName: 'the Grievance Officer, Asha Rao' };
const doc = readFileSync(new URL('../../../../../docs/legal/platform-privacy-notice.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('platform privacy notice (CMP-21)', () => {
  it('says word for word what docs/legal/platform-privacy-notice.md says, under the same version', () => {
    expect(doc).toContain(`# ${NOTICE_TEMPLATE.title}`);
    expect(doc).toContain(`**Version ${NOTICE_VERSION} ·`);
    for (const s of NOTICE_TEMPLATE.sections) {
      expect(doc).toContain(`## ${s.heading}`);
      for (const p of s.paragraphs) expect(doc, p).toContain(` ${p} `);
      for (const item of s.items) expect(doc, item).toContain(`- ${item} `);
    }
  });

  it('fills in the operator and the privacy contact, leaving no placeholder', () => {
    const n = renderNotice(privacy);
    const text = JSON.stringify(n.sections);
    expect(text).not.toMatch(/\{[a-z]+\}/);
    expect(text).toContain('Acme Hospital runs this service and is the Data Fiduciary');
    expect(text).toContain('Write to the Grievance Officer, Asha Rao at privacy@acme.example');
    expect(text).toContain(`This is version ${NOTICE_VERSION}.`);
    expect(n).toMatchObject({ version: NOTICE_VERSION, locale: 'en-IN', fiduciary: 'Acme Hospital', contact: { name: privacy.contactName, email: privacy.contactEmail } });
    expect(renderNotice({ ...privacy, contactName: null }).sections.find((s) => s.id === 'contact')?.paragraphs[0]).toMatch(/^Write to our privacy contact at /);
  });

  it('hashes the text as shown: the same settings give the same hash, other contact details another', () => {
    const a = renderNotice(privacy);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(renderNotice({ ...privacy }).hash).toBe(a.hash);
    expect(renderNotice({ ...privacy, contactEmail: 'dpo@acme.example' }).hash).not.toBe(a.hash);
  });

  it('itemises what DPDP Rule 3 asks for: the data, the purposes, withdrawal, rights and the Board', () => {
    expect(NOTICE_TEMPLATE.sections.map((s) => s.id)).toEqual(['who', 'data', 'purposes', 'sharing', 'retention', 'rights', 'contact', 'changes']);
    const text = JSON.stringify(NOTICE_TEMPLATE);
    for (const phrase of ['withdraws your consent', 'Data Protection Board of India', 'Nominate someone', 'within 90 days', 'at least five different organisations']) {
      expect(text).toContain(phrase);
    }
  });
});
