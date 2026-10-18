import { IsoInstantSchema, type CountryCode as SchemaCountryCode, type IsoInstant as SchemaIsoInstant } from '@form/schema';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CAPTCHA_PROVIDERS,
  FIRST_PARTY_CAPTCHA_PROVIDERS,
  JOBS,
  PortError,
  THIRD_PARTY_CAPTCHA_PROVIDERS,
  isPortError,
  isValidObjectKey,
  isValidObjectTags,
  toIsoInstant,
  type CountryCode,
  type IsoInstant,
  type JobData,
  type JobName,
  type JobRequest,
  type SystemJobName,
} from './index.ts';

describe('isValidObjectKey', () => {
  it.each(['u/org/form/2027/01/file-1', 'a', 'packs/system-core-2027.06.0.formpack', 'A_b-c.d'])('accepts %s', (key) => {
    expect(isValidObjectKey(key)).toBe(true);
  });

  it.each([
    '',
    '/abs',
    'trailing/',
    'a//b',
    '../escape',
    'a/../b',
    './a',
    '.hidden',
    'name.',
    'back\\slash',
    'sp ace',
    'colon:x',
    'nul\0',
    'x'.repeat(1025),
  ])('rejects %j', (key) => {
    expect(isValidObjectKey(key)).toBe(false);
  });
});

describe('isValidObjectTags', () => {
  it('follows the S3 tag rules', () => {
    expect(isValidObjectTags({})).toBe(true);
    expect(isValidObjectTags({ scan: 'pending', 'form:id': 'f_1', note: 'café 2027', empty: '' })).toBe(true);
    expect(isValidObjectTags(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, 'v'])))).toBe(false);
    expect(isValidObjectTags({ '': 'v' })).toBe(false);
    expect(isValidObjectTags({ ['k'.repeat(129)]: 'v' })).toBe(false);
    expect(isValidObjectTags({ k: 'v'.repeat(257) })).toBe(false);
    expect(isValidObjectTags({ k: 'a\r\nb' })).toBe(false);
    expect(isValidObjectTags({ k: '<pending>' })).toBe(false);
    expect(isValidObjectTags({ 'AWS:managed': 'v' })).toBe(false);
  });
});

describe('PortError', () => {
  it('carries a code and narrows', () => {
    const e: unknown = new PortError('not_found', 'missing', { cause: 'x' });
    expect(isPortError(e)).toBe(true);
    expect(isPortError(e, 'not_found')).toBe(true);
    expect(isPortError(e, 'conflict')).toBe(false);
    expect(isPortError(new Error('x'))).toBe(false);
    expect((e as PortError).cause).toBe('x');
  });
});

describe('job contracts', () => {
  it('declares a scope for every queue', () => {
    expectTypeOf<keyof typeof JOBS>().toEqualTypeOf<JobName>();
    for (const [name, { scope }] of Object.entries(JOBS)) expect(['org', 'system', 'any'], name).toContain(scope);
  });

  it('types the org of an envelope by scope', () => {
    expectTypeOf<JobRequest<'file.inspect'>['orgId']>().toEqualTypeOf<string>();
    expectTypeOf<JobRequest<'retention.sweep'>['orgId']>().toEqualTypeOf<null>();
    expectTypeOf<JobRequest<'email.send'>['orgId']>().toEqualTypeOf<string | null>();
    expectTypeOf<'retention.sweep'>().toExtend<SystemJobName>();
    expectTypeOf<'file.inspect'>().not.toExtend<SystemJobName>();
  });

  it('keeps payloads to ids', () => {
    expectTypeOf<JobData['file.inspect']>().toEqualTypeOf<{ fileId: string }>();
    // @ts-expect-error a cron tick carries no data
    const tick: JobData['retention.sweep'] = { orgId: 'o' };
    expect(tick).toBeDefined();
  });
});

describe('schema brands', () => {
  it('are the @form/schema brands, and toIsoInstant makes a valid one', () => {
    expectTypeOf<IsoInstant>().toEqualTypeOf<SchemaIsoInstant>();
    expectTypeOf<CountryCode>().toEqualTypeOf<SchemaCountryCode>();
    const instant = toIsoInstant(new Date(Date.UTC(2027, 0, 31, 10)));
    expect(instant).toBe('2027-01-31T10:00:00.000Z');
    expect(IsoInstantSchema.safeParse(instant).success).toBe(true);
  });
});

describe('captcha providers', () => {
  it('keeps first- and third-party providers apart', () => {
    for (const p of FIRST_PARTY_CAPTCHA_PROVIDERS) expect(THIRD_PARTY_CAPTCHA_PROVIDERS as readonly string[]).not.toContain(p);
    expect(CAPTCHA_PROVIDERS).toHaveLength(FIRST_PARTY_CAPTCHA_PROVIDERS.length + THIRD_PARTY_CAPTCHA_PROVIDERS.length);
  });
});
