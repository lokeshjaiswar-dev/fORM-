import { describe, expect, it } from 'vitest';
import { callUpstream, UpstreamError, type TenantHttp } from './upstream.ts';

/* callUpstream without a credential touches no database, so the parse path is checked here with a stub transport. */
const answer = (text: string): TenantHttp => async () => ({ status: 200, text: () => text });
const call = (text: string, parser: 'json' | 'xml') =>
  callUpstream({ db: {} as never, tenantHttp: answer(text) }, { orgId: '00000000-0000-4000-8000-000000000001', config: { url: 'https://api.example.test/x' as never, method: 'GET', parser } });

describe('callUpstream parses a hostile answer in bounded time and fails as unparsable (review blocker)', () => {
  it('1 MiB of repeated XML siblings answers within about a second', async () => {
    const xml = `<r>${'<a>1</a>'.repeat(130_000)}</r>`;
    const started = performance.now();
    await expect(call(xml, 'xml')).rejects.toMatchObject({ reason: 'unparsable' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('deep XML or JSON nesting is an UpstreamError (the fixed 502), never a RangeError (a 500)', async () => {
    const deep = `${'<a>'.repeat(200_000)}x${'</a>'.repeat(200_000)}`;
    const err = await call(deep, 'xml').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).reason).toBe('unparsable');
    await expect(call(`${'['.repeat(200_000)}${']'.repeat(200_000)}`, 'json')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('a normal XML answer still parses to the same tree', async () => {
    await expect(call('<r><ok>true</ok><i>a</i><i>b</i></r>', 'xml')).resolves.toEqual({ data: { ok: true, i: ['a', 'b'] }, status: 200 });
  });
});
