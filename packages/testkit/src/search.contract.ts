import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toIsoInstant, type SearchDocument, type SearchIndex } from '@form/ports';
import { expectPortError, useSubject, type ContractSetup, type ContractSubject } from './contract.ts';

/**
 * What every SearchIndex does (architecture §2.4, §6): word search within one form of one org, accents folded,
 * Indian scripts matched as written, replaced and removed documents gone at once, stable cursor pagination.
 * Documents get `receivedAt` within the last minute, so a partitioned store needs the current month's partition.
 */
export function runSearchIndexContract(label: string, setup: ContractSetup<ContractSubject<SearchIndex>>): void {
  describe(`SearchIndex contract: ${label}`, () => {
    const subject = useSubject(setup);
    const search = () => subject().impl;
    const org = randomUUID();
    const otherOrg = randomUUID();
    const form = randomUUID();
    const otherForm = randomUUID();
    let n = 0;
    const doc = (text: string[], o: Partial<SearchDocument> = {}): SearchDocument => ({
      submissionId: randomUUID(),
      receivedAt: toIsoInstant(new Date(Date.now() - 60_000 + (n += 7))),
      formId: form,
      locale: 'en-IN',
      text,
      ...o,
    });
    const ids = async (text: string, o: { orgId?: string; formId?: string } = {}) =>
      (await search().query(o.orgId ?? org, { formId: o.formId ?? form, text, limit: 100 })).hits.map((h) => h.submissionId).sort();

    it('finds a document by any of its words, within its form and org only', async () => {
      const a = doc(['Asha Rao', 'Pune, Maharashtra']);
      const b = doc(['Ravi Kumar', 'Chennai']);
      const elsewhere = doc(['Asha Patel'], { formId: otherForm });
      await search().upsert(org, [a, b, elsewhere]);
      await search().upsert(otherOrg, [doc(['Asha Iyer'])]);
      expect(await ids('asha')).toEqual([a.submissionId]);
      expect(await ids('pune')).toEqual([a.submissionId]);
      expect(await ids('chennai')).toEqual([b.submissionId]);
      expect(await ids('asha', { formId: otherForm })).toEqual([elsewhere.submissionId]);
      expect(await ids('rao', { orgId: otherOrg })).toEqual([]);
      const hit = (await search().query(org, { formId: form, text: 'Asha', limit: 10 })).hits[0];
      expect(hit).toEqual({ submissionId: a.submissionId, receivedAt: a.receivedAt, rank: expect.any(Number) });
    });

    it('folds accents and matches Indian scripts as written', async () => {
      const latin = doc(['Café Société']);
      const hindi = doc(['नमस्ते दुनिया', 'பெங்களூரு']);
      await search().upsert(org, [latin, hindi]);
      expect(await ids('cafe')).toEqual([latin.submissionId]);
      expect(await ids('SOCIÉTÉ')).toEqual([latin.submissionId]);
      expect(await ids('नमस्ते')).toEqual([hindi.submissionId]);
      expect(await ids('பெங்களூரு')).toEqual([hindi.submissionId]);
    });

    it('understands phrases and exclusions', async () => {
      const a = doc(['blue mango orchard']);
      const b = doc(['mango blue sky']);
      await search().upsert(org, [a, b]);
      expect(await ids('"blue mango"')).toEqual([a.submissionId]);
      expect(await ids('mango -sky')).toEqual([a.submissionId]);
    });

    it('replaces a document on upsert and forgets it on remove', async () => {
      const d = doc(['tamarind']);
      await search().upsert(org, [d]);
      await search().upsert(org, [{ ...d, text: ['jackfruit'] }]);
      expect(await ids('tamarind')).toEqual([]);
      expect(await ids('jackfruit')).toEqual([d.submissionId]);
      await search().remove(org, [{ submissionId: d.submissionId, receivedAt: d.receivedAt }]);
      expect(await ids('jackfruit')).toEqual([]);
      await search().remove(org, []);
      await search().upsert(org, []);
    });

    it('ranks closer matches first and pages through every hit exactly once', async () => {
      const strong = doc(['guava guava guava orchard']);
      const rest = Array.from({ length: 6 }, (_, i) => doc([`guava field ${i}`, 'plain text '.repeat(i + 1)]));
      await search().upsert(org, [strong, ...rest]);
      const seen: string[] = [];
      let after: string | undefined;
      let first: number | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await search().query(org, { formId: form, text: 'guava', limit: 3, ...(after ? { after } : {}) });
        if (page === 0) first = r.hits[0]?.rank;
        if (page === 0) expect(r.hits[0]?.submissionId).toBe(strong.submissionId);
        for (let i = 1; i < r.hits.length; i++) expect(r.hits[i]!.rank).toBeLessThanOrEqual(r.hits[i - 1]!.rank);
        seen.push(...r.hits.map((h) => h.submissionId));
        if (!r.next) break;
        after = r.next;
      }
      expect(first).toBeGreaterThan(0);
      expect(seen.sort()).toEqual([strong, ...rest].map((d) => d.submissionId).sort());
    });

    it('validates its arguments', async () => {
      const q = { formId: form, text: 'x', limit: 10 };
      await expectPortError(search().query(org, { ...q, limit: 0 }), 'invalid_argument');
      await expectPortError(search().query(org, { ...q, limit: 101 }), 'invalid_argument');
      await expectPortError(search().query(org, { ...q, text: '   ' }), 'invalid_argument');
      await expectPortError(search().query(org, { ...q, after: 'not-a-cursor' }), 'invalid_argument');
      await expectPortError(search().query('org-1', q), 'invalid_argument');
      await expectPortError(search().query(org, { ...q, formId: 'form-1' }), 'invalid_argument');
      await expectPortError(search().upsert(org, [doc(['x'], { submissionId: 'sub-1' })]), 'invalid_argument');
      await expectPortError(search().upsert(org, [doc(['x'], { locale: 'not a locale' })]), 'invalid_argument');
      await expectPortError(search().remove(org, [{ submissionId: randomUUID(), receivedAt: 'yesterday' as SearchDocument['receivedAt'] }]), 'invalid_argument');
    });
  });
}
