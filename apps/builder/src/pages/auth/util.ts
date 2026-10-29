import type { FormEvent } from 'react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, ApiUnreachable } from '@/auth/client';

const M = defineMessages('builder', {
  'auth.unreachable': 'The server cannot be reached. Check your connection and try again.',
  'auth.failed': 'Something went wrong. Try again.',
  'auth.rate_limited': 'Too many attempts. Wait a few minutes and try again.',
});

/** The sentence to show for a failed call: the server's own for a refusal, a generic one otherwise. */
export function problemText(err: unknown): string {
  if (err instanceof ApiProblem) {
    if (err.code === 'RATE_LIMITED') return err.message || t(M['auth.rate_limited']);
    return err.message || t(M['auth.failed']);
  }
  if (err instanceof ApiUnreachable) return t(M['auth.unreachable']);
  return t(M['auth.failed']);
}

/** `onSubmit` without a page reload. */
export const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};
