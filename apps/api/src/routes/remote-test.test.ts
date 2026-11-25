import { describe, expect, it } from 'vitest';
import { remoteTestBucket } from './remote-test.ts';

describe('author route budgets (review note: the preview starved the Test buttons)', () => {
  it('a preview call spends auth_remote_preview; a Test call (or one with no purpose) spends auth_remote_test', () => {
    expect(remoteTestBucket('preview')).toBe('auth_remote_preview');
    expect(remoteTestBucket('test')).toBe('auth_remote_test');
    expect(remoteTestBucket(undefined)).toBe('auth_remote_test');
  });
});
