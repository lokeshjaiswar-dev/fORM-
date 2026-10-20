import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { installEgressTripwire } from './egress-tripwire.ts';

describe('egress tripwire', () => {
  it('records connections and lookups, and flags everything outside loopback', async () => {
    const wire = installEgressTripwire();
    try {
      const server = net.createServer((s) => s.end());
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as net.AddressInfo;
      await new Promise<void>((r) => net.connect({ host: '127.0.0.1', port }).on('close', () => r()).on('error', () => r()));
      server.close();
      net.connect({ host: '192.0.2.1', port: 9 }).on('error', () => {}).destroy();
      await lookup('form-tripwire.invalid').catch(() => undefined);
      expect(wire.connections).toEqual([`127.0.0.1:${port}`, '192.0.2.1:9']);
      expect(wire.violations()).toEqual(['connect 192.0.2.1:9', 'lookup form-tripwire.invalid']);
    } finally {
      wire.uninstall();
    }
  });
});
