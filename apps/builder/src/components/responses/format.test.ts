import { describe, expect, it } from 'vitest';
import { describeFailure, isInvalidCursor } from '@/components/responses/errors';
import { formatBytes, formatWhen, statusLabel, versionLabel } from '@/components/responses/format';
import { ApiProblem, ApiUnreachable } from '@/auth/client';

describe('statusLabel', () => {
  it('names every processing state the database knows', () => {
    expect(['complete', 'spam', 'pending_payment', 'payment_failed', 'pending_scan', 'pending_guardian_consent', 'archived', 'trashed'].map(statusLabel)).toEqual([
      'Complete',
      'Spam',
      'Awaiting payment',
      'Payment failed',
      'Checking files',
      'Awaiting guardian consent',
      'Archived',
      'In trash',
    ]);
  });

  it('shows a state it does not know as the API named it', () => {
    expect(statusLabel('pending_review')).toBe('pending_review');
  });
});

describe('versionLabel', () => {
  it('is v and the number, "Unpublished" for the stand-in of a form never published, and "Unknown" when the API could not say', () => {
    expect(versionLabel(3)).toBe('v3');
    expect(versionLabel(0)).toBe('Unpublished');
    expect(versionLabel(null)).toBe('Unknown');
  });
});

describe('formatWhen', () => {
  it('writes a moment for the reader, and leaves text that is not a date as it came', () => {
    expect(formatWhen('2026-11-15T10:00:00.000Z')).toMatch(/15 Nov 2026/);
    expect(formatWhen('not a date')).toBe('not a date');
  });
});

describe('formatBytes', () => {
  it('writes a size in the unit people read it in', () => {
    expect(formatBytes(840)).toMatch(/^840\s?B$/);
    expect(formatBytes(12_400)).toMatch(/^12\.4\s?kB$/);
    expect(formatBytes(3_200_000)).toMatch(/^3\.2\s?MB$/);
  });
});

describe('describeFailure', () => {
  /** A caller's own sentence for the action that failed. */
  const fallback = 'builder:responses.version_unknown' as const;

  it('says why a refusal that has a reason was refused, and not the server’s own words', () => {
    expect(describeFailure(new ApiProblem(409, 'SUBMISSION_NOT_TRASHED', 'internal detail'), fallback)).toBe('Only responses in the trash can be deleted forever. Nothing was deleted.');
    expect(describeFailure(new ApiProblem(409, 'SUBMISSION_HELD', 'internal detail'), fallback)).toBe('A response under a hold cannot be deleted. Nothing was deleted.');
    expect(describeFailure(new ApiProblem(403, 'FORBIDDEN', 'Requires submissions.delete.'), fallback)).toBe('Your role in this organisation does not allow that.');
    expect(describeFailure(new ApiProblem(404, 'NOT_FOUND', 'x'), fallback)).toBe('That form or response is no longer here.');
    expect(describeFailure(new ApiProblem(503, 'UNAVAILABLE', 'x'), fallback)).toBe('This is not available right now. Try again in a moment.');
  });

  it('says the server cannot be reached when it cannot, and the action’s own sentence for anything else', () => {
    expect(describeFailure(new ApiUnreachable(), fallback)).toMatch(/cannot be reached/);
    // The caller's sentence for the action, or a general one when the caller gave none.
    expect(describeFailure(new ApiProblem(500, 'INTERNAL', 'x'), fallback)).toBe('Unknown');
    expect(describeFailure(new Error('boom'), fallback)).toBe('Unknown');
    expect(describeFailure(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});

describe('isInvalidCursor', () => {
  it('is true only for the API’s refusal of a cursor', () => {
    expect(isInvalidCursor(new ApiProblem(400, 'INVALID_CURSOR', 'x'))).toBe(true);
    expect(isInvalidCursor(new ApiProblem(400, 'VALIDATION', 'x'))).toBe(false);
    expect(isInvalidCursor(new Error('x'))).toBe(false);
  });
});
