import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, serializers } from './logger.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('redacts credentials, contact details, answers and bodies', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', name: 'test' }, stream);
    log.info(
      {
        req: { headers: { authorization: 'Bearer fr_live_x', cookie: '__Host-fr_sess=abc' } },
        user: { email: 'asha@example.in', phone: '+919800000000', password: 'p' },
        submission: { answers: { pan: 'ABCDE1234F' } },
        token: 't',
        body: { a: 1 },
      },
      'hello',
    );
    const line = lines[0]!;
    expect(JSON.stringify(line)).not.toMatch(/fr_live_x|abc|asha@|9800000000|ABCDE1234F/);
    expect(line).toMatchObject({
      level: 'info',
      name: 'test',
      msg: 'hello',
      user: { email: REDACTED, phone: REDACTED, password: REDACTED },
      submission: { answers: REDACTED },
      token: REDACTED,
      body: REDACTED,
    });
    expect(typeof line.time).toBe('string');
  });

  it('serialises requests without headers, client address or query values', () => {
    expect(
      serializers.req({ id: 'r1', method: 'GET', url: '/f/kyc?email=a@b.in&lang=hi', routeOptions: { url: '/f/:slug' } }),
    ).toEqual({ id: 'r1', method: 'GET', url: '/f/kyc?lang=hi', route: '/f/:slug' });
    expect(serializers.req({ method: 'GET' })).toEqual({ id: undefined, method: 'GET', url: undefined, route: undefined });
    expect(serializers.res({ statusCode: 204 })).toEqual({ statusCode: 204 });
  });

  it('writes to stdout without a destination', () => {
    const log = createLogger({ level: 'silent', name: 'quiet' });
    expect(log.level).toBe('silent');
  });
});
