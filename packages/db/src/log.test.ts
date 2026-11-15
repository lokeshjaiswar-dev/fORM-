import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { loggableError } from './log.ts';

/** What node-postgres throws for a NUL in a jsonb parameter, and what Drizzle wraps it in. */
function failedInsert(): Error {
  const pgError = Object.assign(new Error('unsupported Unicode escape sequence'), {
    length: 150,
    severity: 'ERROR',
    code: '22P05',
    detail: String.raw`\u0000 cannot be converted to text.`,
    where: 'JSON data, line 1: {"pan":"ABCDE1234F-SECRET-PII","x":"a...',
    schema: undefined,
    routine: 'json_errsave_error',
  });
  return new DrizzleQueryError('insert into "form_submissions" ("id", "answers") values ($1, $2)', ['id-1', '{"pan":"ABCDE1234F-SECRET-PII"}'], pgError);
}

describe('loggableError', () => {
  it('keeps the SQLSTATE, the place and the SQL text of a failed query, and drops every bound value', () => {
    const logged = loggableError(failedInsert()) as Record<string, unknown>;
    expect(logged).toMatchObject({
      type: 'DrizzleQueryError',
      code: '22P05',
      severity: 'ERROR',
      routine: 'json_errsave_error',
      query: 'insert into "form_submissions" ("id", "answers") values ($1, $2)',
      message: 'Failed query: unsupported Unicode escape sequence',
    });
    expect(JSON.stringify(logged)).not.toMatch(/SECRET-PII|ABCDE1234F|id-1|cannot be converted/);
    expect(logged).not.toHaveProperty('params');
    expect(logged).not.toHaveProperty('detail');
    expect(logged).not.toHaveProperty('where');
    expect(String(logged['stack'])).toMatch(/^DrizzleQueryError: Failed query: unsupported Unicode escape sequence\n\s+at /);
  });

  it('cuts the offending value off pg messages that quote it, and a unique violation’s detail', () => {
    const syntax = Object.assign(new Error('invalid input syntax for type uuid: "asha@example.in"'), { severity: 'ERROR', code: '22P02' });
    expect(loggableError(syntax)).toMatchObject({ message: 'invalid input syntax for type uuid: [redacted]', code: '22P02' });
    const unique = Object.assign(new Error('duplicate key value violates unique constraint "users_email_norm_key"'), {
      severity: 'ERROR',
      code: '23505',
      constraint: 'users_email_norm_key',
      table: 'users',
      detail: 'Key (email_norm)=(asha@example.in) already exists.',
    });
    const logged = loggableError(unique) as Record<string, unknown>;
    expect(logged).toMatchObject({ code: '23505', constraint: 'users_email_norm_key', table: 'users' });
    expect(JSON.stringify(logged)).not.toContain('asha@example.in');
  });

  it('leaves other errors readable: message, stack, code, status', () => {
    const err = Object.assign(new Error('connection to 10.0.0.5 refused'), { code: 'ECONNREFUSED', statusCode: 503 });
    const logged = loggableError(err) as Record<string, unknown>;
    expect(logged).toMatchObject({ type: 'Error', message: 'connection to 10.0.0.5 refused', code: 'ECONNREFUSED', statusCode: 503 });
    expect(String(logged['stack'])).toContain('connection to 10.0.0.5 refused');
  });

  it('follows a cause chain without looping, and passes non-errors through', () => {
    const a = new Error('outer');
    const b = new Error('inner');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect((loggableError(a) as { message: string }).message).toBe('outer: inner');
    expect(loggableError('plain')).toBe('plain');
    expect(loggableError(undefined)).toBeUndefined();
  });
});
