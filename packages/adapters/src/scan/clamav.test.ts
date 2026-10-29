import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { eicarSample, runAVScannerContract, startFakeClamd, trackedStream, utf8 } from '@form/testkit';
import { createEgressGuard } from '../egress/guard.ts';
import { createClamAvScanner, parseClamVersion } from './clamav.ts';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const egress = createEgressGuard({ policy: 'none', trusted: ['127.0.0.1'] });

runAVScannerContract(
  'ClamAV → fake clamd',
  async () => {
    const clamd = await startFakeClamd();
    const port = await closedPort();
    return {
      impl: createClamAvScanner({ host: clamd.host, port: clamd.port, egress, chunkBytes: 7 }),
      unreachable: () => createClamAvScanner({ host: '127.0.0.1', port, egress, timeoutMs: 2000 }),
      dispose: () => clamd.close(),
    };
  },
  { inspectsContent: true },
);

describe('ClamAV scanner', () => {
  it('reads the engine and signature versions', () => {
    expect(parseClamVersion('ClamAV 1.5.3/27791/Mon Oct 19 08:24:01 2026')).toEqual({ engineVersion: '1.5.3/27791', signaturesUpdatedAt: '2026-10-19T08:24:01.000Z' });
    expect(parseClamVersion('ClamAV 1.5.3')).toEqual({ engineVersion: '1.5.3' });
  });

  it('answers error, not clean, when clamd refuses an oversized stream, and drains the rest', async () => {
    const clamd = await startFakeClamd({ streamMaxBytes: 10 });
    try {
      const chunks = Array.from({ length: 50 }, () => utf8('0123456789'));
      const { stream, consumed } = trackedStream(chunks);
      const r = await createClamAvScanner({ host: clamd.host, port: clamd.port, egress }).scan(stream, { fileId: 'f', bytes: 500 });
      expect(r.verdict).toBe('error');
      expect(consumed()).toBe(50);
    } finally {
      await clamd.close();
    }
  });

  it('never sends a file to a clamd the egress guard denies, and answers error', async () => {
    const clamd = await startFakeClamd();
    try {
      const deny = createEgressGuard({ policy: 'none', allowlist: ['clamav.internal'] });
      const { stream, consumed } = trackedStream([eicarSample()]);
      const scanner = createClamAvScanner({ host: clamd.host, port: clamd.port, egress: deny });
      expect((await scanner.scan(stream, { fileId: 'f', bytes: 68 })).verdict).toBe('error');
      expect(consumed()).toBe(1);
      expect((await scanner.health()).ok).toBe(false);
      expect(clamd.connections).toBe(0);
    } finally {
      await clamd.close();
    }
  });
});
