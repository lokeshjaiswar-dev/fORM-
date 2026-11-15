import { describe, expect, it } from 'vitest';
import { newRouting, warningsOf } from './notifications.ts';

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const pipe = (blockId: string) => ({ type: 'pipe', attrs: { source: { kind: 'answer', blockId } } });
const BLOCKS: ReadonlySet<string> = new Set(['name', 'email']);

describe('warningsOf', () => {
  it('finds a field recipient, a merge tag in the subject and the body, a table row and a delay that name a block the form lacks', () => {
    const warnings = warningsOf(
      {
        to: [{ kind: 'field', blockId: 'gone_to' }, { kind: 'field', blockId: 'email' }, { kind: 'email', address: 'x@y.test' }],
        cc: [{ kind: 'field', blockId: 'gone_cc' }],
        replyTo: { kind: 'field', blockId: 'gone_reply' },
        subject: ['Hi ', { pipe: { source: { kind: 'answer', blockId: 'gone_subject' } } }, { pipe: { source: { kind: 'answer', blockId: 'name' } } }],
        body: { type: 'email_doc', content: [para({ type: 'text', text: 'x' }, pipe('gone_body'), pipe('name')), { type: 'answersTable', attrs: { include: ['name', 'gone_table'], hideEmpty: true, maskSensitive: true } }] },
        variants: [{ id: 'v', name: 'hi', subject: [{ pipe: { source: { kind: 'answer', blockId: 'gone_variant' } } }], body: { type: 'email_doc', content: [] } }],
        delay: { kind: 'relative_to_field', blockId: 'gone_delay', offsetMinutes: 5 },
        attachments: { uploads: 'none', pdf: { password: { fromBlockId: 'gone_pdf' } } },
      },
      BLOCKS,
    );
    expect(warnings.map((w) => `${w.code} ${w.blockId} ${w.path}`)).toEqual([
      'unknown_recipient_field gone_to /to/0',
      'unknown_recipient_field gone_cc /cc/0',
      'unknown_recipient_field gone_reply /replyTo',
      expect.stringMatching(/^unknown_merge_tag_block gone_subject \/subject\/1\//),
      expect.stringMatching(/^unknown_merge_tag_block gone_body \/body\/content\/0\/content\/1\//),
      expect.stringMatching(/^unknown_merge_tag_block gone_table \/body\/content\/1\/attrs\/include\/1/),
      expect.stringMatching(/^unknown_merge_tag_block gone_variant /),
      expect.stringMatching(/^unknown_merge_tag_block gone_delay /),
      expect.stringMatching(/^unknown_merge_tag_block gone_pdf /),
    ]);
  });

  it('warns once per block and kind, and says nothing for a notification whose blocks all exist', () => {
    const twice = warningsOf({ to: [], subject: [pipe('gone'), pipe('gone')].map((p) => ({ pipe: p.attrs })), body: { type: 'email_doc', content: [para(pipe('gone'))] } }, BLOCKS);
    expect(twice).toHaveLength(1);
    expect(warningsOf({ to: [{ kind: 'field', blockId: 'email' }], subject: [{ pipe: { source: { kind: 'answer', blockId: 'name' } } }], body: { type: 'email_doc', content: [para(pipe('email'))] } }, BLOCKS)).toEqual([]);
  });

  it('reads a config an older version wrote: missing keys and wrong shapes are skipped, not thrown on', () => {
    expect(warningsOf({}, BLOCKS)).toEqual([]);
    expect(warningsOf({ to: 'x', cc: [null, 4, { kind: 'field' }], replyTo: 3, body: null, subject: 'plain' }, BLOCKS)).toEqual([]);
  });

  it('stops at 50 warnings', () => {
    const to = Array.from({ length: 80 }, (_, i) => ({ kind: 'field', blockId: `gone_${i}` }));
    expect(warningsOf({ to }, BLOCKS)).toHaveLength(50);
  });
});

describe('newRouting', () => {
  const ext = (path: string, key: string) => ({ path, key, external: true });
  const inside = (path: string, key: string) => ({ path, key, external: false });
  const withTo = (...to: Array<Record<string, unknown>>) => ({ to });
  const mail = (address: string) => ({ kind: 'email', address });

  it('needs data.route for every outside recipient of a new notification, and for none that is inside', () => {
    expect(newRouting({ before: null, beforePurposes: [], after: withTo(mail('a@b.test')), afterPurposes: ['p'], routed: [ext('/to/0', 'email:a@b.test')] })).toHaveLength(1);
    expect(newRouting({ before: null, beforePurposes: [], after: withTo({ kind: 'field', blockId: 'email' }), afterPurposes: ['p'], routed: [inside('/to/0', 'field:email')] })).toEqual([]);
  });

  it('names the place of the recipient, never the address', () => {
    const [reason] = newRouting({ before: null, beforePurposes: [], after: withTo(mail('secret@b.test')), afterPurposes: ['p'], routed: [ext('/to/0', 'email:secret@b.test')] });
    expect(reason).toContain('/to/0');
    expect(reason).not.toContain('secret@b.test');
  });

  it('treats an outside recipient that was already there as nothing new, whatever case the address is in', () => {
    const before = withTo(mail('A@B.test'));
    expect(newRouting({ before, beforePurposes: ['p'], after: withTo(mail('a@b.test')), afterPurposes: ['p'], routed: [ext('/to/0', 'email:a@b.test')] })).toEqual([]);
  });

  it('needs data.route for more purposes while an outside recipient is there, and not for fewer or the same', () => {
    const before = withTo(mail('a@b.test'));
    const routed = [ext('/to/0', 'email:a@b.test')];
    expect(newRouting({ before, beforePurposes: ['p'], after: before, afterPurposes: ['p', 'q'], routed })).toHaveLength(1);
    expect(newRouting({ before, beforePurposes: ['p', 'q'], after: before, afterPurposes: ['p'], routed })).toEqual([]);
    expect(newRouting({ before, beforePurposes: ['p'], after: before, afterPurposes: ['p'], routed })).toEqual([]);
    // More purposes with nobody outside the people who may read answers is no disclosure.
    expect(newRouting({ before: withTo({ kind: 'role', role: 'org_admins' }), beforePurposes: ['p'], after: withTo({ kind: 'role', role: 'org_admins' }), afterPurposes: ['p', 'q'], routed: [inside('/to/0', 'role:org_admins')] })).toEqual([]);
  });

  it('needs data.route for the respondent’s files or a PDF that the stored notification did not carry', () => {
    const none = { ...withTo({ kind: 'role', role: 'org_admins' }), attachments: { uploads: 'none' } };
    const routed = [inside('/to/0', 'role:org_admins')];
    expect(newRouting({ before: none, beforePurposes: ['p'], after: { ...none, attachments: { uploads: 'attach' } }, afterPurposes: ['p'], routed })).toHaveLength(1);
    expect(newRouting({ before: none, beforePurposes: ['p'], after: { ...none, attachments: { uploads: 'none', pdf: {} } }, afterPurposes: ['p'], routed })).toHaveLength(1);
    // A static asset is the org's own file, not an answer; files that were already carried stay free to keep.
    expect(newRouting({ before: none, beforePurposes: ['p'], after: { ...none, attachments: { uploads: 'none', staticAsset: { id: 'a' } } }, afterPurposes: ['p'], routed })).toEqual([]);
    const had = { ...none, attachments: { uploads: 'links' } };
    expect(newRouting({ before: had, beforePurposes: ['p'], after: had, afterPurposes: ['p'], routed })).toEqual([]);
  });
});
