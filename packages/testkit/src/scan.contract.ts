import { describe, expect, it } from 'vitest';
import type { AVScanner } from '@form/ports';
import { trackedStream, useSubject, utf8, type ContractSetup, type ContractSubject } from './contract.ts';

/** The EICAR test file, assembled at runtime so no file in the repo trips a desktop antivirus. */
export function eicarSample(): Uint8Array {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-', 'FILE!$H+H*'];
  return utf8(parts.join(''));
}

export interface ScannerContractOptions {
  /** false for the no-op scanner: it must answer `skipped`, never `clean`. */
  inspectsContent: boolean;
}

export function runAVScannerContract(label: string, setup: ContractSetup<ContractSubject<AVScanner>>, o: ScannerContractOptions): void {
  describe(`AVScanner contract: ${label}`, () => {
    const subject = useSubject(setup);
    const scanner = () => subject().impl;
    const meta = (bytes: number) => ({ fileId: 'file-1', bytes, contentType: 'application/octet-stream', filename: 'sample.bin' });

    it('reports health and an engine version', async () => {
      const h = await scanner().health();
      expect(h.ok).toEqual(expect.any(Boolean));
      expect(h.engineVersion.length).toBeGreaterThan(0);
    });

    it(o.inspectsContent ? 'passes clean content' : 'never claims content is clean', async () => {
      const { stream, consumed } = trackedStream([utf8('plain '), utf8('content')]);
      const r = await scanner().scan(stream, meta(13));
      expect(r.verdict).toBe(o.inspectsContent ? 'clean' : 'skipped');
      expect(r.engineVersion.length).toBeGreaterThan(0);
      expect(consumed()).toBe(2);
    });

    it(o.inspectsContent ? 'detects the EICAR test file' : 'skips the EICAR test file', async () => {
      const sample = eicarSample();
      const { stream, consumed } = trackedStream([sample.subarray(0, 20), sample.subarray(20)]);
      const r = await scanner().scan(stream, meta(sample.byteLength));
      expect(consumed()).toBe(2);
      if (o.inspectsContent) {
        expect(r.verdict).toBe('infected');
        expect(r.signature).toEqual(expect.any(String));
      } else {
        expect(r.verdict).toBe('skipped');
      }
    });

    it('scans an empty file', async () => {
      let drained = false;
      const empty: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            drained = true;
            return { done: true, value: undefined };
          },
        }),
      };
      expect((await scanner().scan(empty, meta(0))).verdict).toBe(o.inspectsContent ? 'clean' : 'skipped');
      expect(drained).toBe(true);
    });
  });
}
