import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextSerial, serialPeriod, withTenant, type NextSerialInput } from '../src/index.ts';
import { seedTwoOrgs, setupTestDb, type Seed, type TestDb } from './harness.ts';

let t: TestDb;
let seed: Seed;

beforeAll(async () => {
  t = await setupTestDb();
  seed = await seedTwoOrgs(t.owner);
});
afterAll(() => t?.close());

let requests = 0;
function issue(input: Omit<NextSerialInput, 'orgId' | 'formId'> & { formId?: string; orgId?: string }): Promise<number> {
  const orgId = input.orgId ?? seed.a.orgId;
  const formId = input.formId ?? seed.a.formIds[0];
  return withTenant(t.app.db, { orgId, actor: 'system', requestId: `serial-${++requests}` }, (tx) =>
    nextSerial(tx, { ...input, orgId, formId }),
  );
}

describe('nextSerial', () => {
  it('numbers submissions 1, 2, 3 from startAt', async () => {
    const field = { blockId: 'blk_sequential', period: '', startAt: 1 };
    expect([await issue(field), await issue(field), await issue(field)]).toEqual([1, 2, 3]);
  });

  it('starts at the configured startAt and keeps fields and forms apart', async () => {
    expect(await issue({ blockId: 'blk_start', period: '', startAt: 1000 })).toBe(1000);
    expect(await issue({ blockId: 'blk_start', period: '', startAt: 1000 })).toBe(1001);
    expect(await issue({ blockId: 'blk_other', period: '', startAt: 1 })).toBe(1);
    expect(await issue({ blockId: 'blk_start', period: '', startAt: 1000, formId: seed.a.formIds[1] })).toBe(1000);
  });

  it('jumps ahead when the owner raises startAt, and keeps counting when it is lowered', async () => {
    const blockId = 'blk_moved';
    expect(await issue({ blockId, period: '', startAt: 5 })).toBe(5);
    expect(await issue({ blockId, period: '', startAt: 50 })).toBe(50);
    expect(await issue({ blockId, period: '', startAt: 1 })).toBe(51);
  });

  it('starts again each month and each year', async () => {
    const zone = 'Asia/Kolkata';
    const nov = serialPeriod('month', new Date('2026-11-23T10:00:00Z'), zone);
    const dec = serialPeriod('month', new Date('2026-12-02T10:00:00Z'), zone);
    expect(await issue({ blockId: 'blk_month', period: nov, startAt: 1 })).toBe(1);
    expect(await issue({ blockId: 'blk_month', period: nov, startAt: 1 })).toBe(2);
    expect(await issue({ blockId: 'blk_month', period: dec, startAt: 1 })).toBe(1);
    // A late November submission still continues November's sequence.
    expect(await issue({ blockId: 'blk_month', period: nov, startAt: 1 })).toBe(3);

    const y2026 = serialPeriod('year', new Date('2026-12-31T18:00:00Z'), zone); // 23:30 in India
    const y2027 = serialPeriod('year', new Date('2026-12-31T19:00:00Z'), zone); // 00:30 in India
    expect(y2026).toBe('2026');
    expect(y2027).toBe('2027');
    expect(await issue({ blockId: 'blk_year', period: y2026, startAt: 1 })).toBe(1);
    expect(await issue({ blockId: 'blk_year', period: y2026, startAt: 1 })).toBe(2);
    expect(await issue({ blockId: 'blk_year', period: y2027, startAt: 1 })).toBe(1);
  });

  it('never gives two concurrent submissions the same number', async () => {
    const field = { blockId: 'blk_race', period: '', startAt: 1 };
    const values = await Promise.all(Array.from({ length: 24 }, () => issue(field)));
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it('gives a rolled-back submission its number back', async () => {
    const field = { blockId: 'blk_rollback', period: '', startAt: 1 };
    expect(await issue(field)).toBe(1);
    await expect(
      withTenant(t.app.db, { orgId: seed.a.orgId, actor: 'system', requestId: 'serial-rollback' }, async (tx) => {
        await nextSerial(tx, { ...field, orgId: seed.a.orgId, formId: seed.a.formIds[0] });
        throw new Error('insert failed');
      }),
    ).rejects.toThrow('insert failed');
    expect(await issue(field)).toBe(2);
  });

  it('counts each org on its own', async () => {
    const field = { blockId: 'blk_tenant', period: '', startAt: 1 };
    expect(await issue(field)).toBe(1);
    expect(await issue({ ...field, orgId: seed.b.orgId, formId: seed.b.formIds[0] })).toBe(1);
    expect(await issue(field)).toBe(2);
  });
});
