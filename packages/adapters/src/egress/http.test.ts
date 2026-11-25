import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPortError } from '@form/ports';
import { sendHttp } from './http.ts';

/*
 * `timeoutMs` bounds the whole exchange, not only the time between two bytes: an upstream that drips one byte now and then
 * stays under any size cap and would otherwise hold the request (and the lookup proxy's in-flight slot) open for good.
 */
describe('sendHttp total deadline (review: drip-feed upstream)', () => {
  let server: Server;
  let base: string;
  const open: ServerResponse[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      open.push(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/ok') return res.end('{"ok":true}');
      // Drip: one byte every 50 ms, never ending, so the socket is never idle for long.
      const timer = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const res of open) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a dripping answer fails as unavailable at the deadline, although no single gap reaches it', async () => {
    const started = Date.now();
    const err = await sendHttp(new URL(`${base}/drip`), { timeoutMs: 400 }).catch((e: unknown) => e);
    const took = Date.now() - started;
    expect(isPortError(err, 'unavailable')).toBe(true);
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(2000);
  }, 5000);

  it('a prompt answer is unaffected (and leaves no timer running)', async () => {
    const res = await sendHttp(new URL(`${base}/ok`), { timeoutMs: 400 });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
