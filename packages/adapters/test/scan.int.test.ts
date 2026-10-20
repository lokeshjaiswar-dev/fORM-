import { describe, it } from 'vitest';
import { clamAvEnabled, runAVScannerContract, startClamAv } from '@form/testkit';
import { createEgressGuard } from '../src/egress/index.ts';
import { createClamAvScanner } from '../src/scan/index.ts';

/**
 * The real ClamAV engine. Its image loads the full signature set on start (minutes), so this runs only with
 * FORM_TEST_CLAMAV=1 (the weekly `av-contract` workflow) or against FORM_TEST_CLAMAV_HOST; every run tests the fake clamd.
 */
if (clamAvEnabled()) {
  runAVScannerContract(
    'ClamAV container',
    async () => {
      const clamav = await startClamAv();
      return { impl: createClamAvScanner({ host: clamav.host, port: clamav.port, egress: createEgressGuard({ policy: 'none', trusted: [clamav.host] }), timeoutMs: 60_000 }), dispose: () => clamav.stop() };
    },
    { inspectsContent: true },
  );
} else {
  describe('ClamAV container', () => {
    it.skip('runs with FORM_TEST_CLAMAV=1 (see docs/platform/03-architecture.md §6)', () => {});
  });
}
