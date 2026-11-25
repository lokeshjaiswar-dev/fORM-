import { describe, expect, it } from 'vitest';
import { apiCheckValue } from '../src/remote/index.ts';

describe('apiCheckValue', () => {
  it('keeps scalars and treats empty as nothing to check', () => {
    expect(apiCheckValue('short_text', 'x')).toBe('x');
    expect(apiCheckValue('number', '12.5')).toBe('12.5');
    expect(apiCheckValue('short_text', '  ')).toBeUndefined();
    expect(apiCheckValue('email', null)).toBeUndefined();
    expect(apiCheckValue('email', { address: '' })).toBeUndefined();
    expect(apiCheckValue('multi_choice', { optionIds: [] })).toBeUndefined();
  });
  it('reduces structured answers to one string', () => {
    expect(apiCheckValue('email', { address: 'a@b.in', otpProof: 'p' })).toBe('a@b.in');
    expect(apiCheckValue('phone', { e164: '+91', country: 'IN' })).toBe('+91');
    expect(apiCheckValue('single_choice', { optionId: 'a' })).toBe('a');
    expect(apiCheckValue('multi_choice', { optionIds: ['a'], other: 'z' })).toBe('["a","z"]');
    expect(apiCheckValue('time', { start: '09:00' })).toBe('09:00');
    expect(apiCheckValue('address', { line1: 'x', city: 'y' })).toBe('{"line1":"x","city":"y"}');
  });
});
