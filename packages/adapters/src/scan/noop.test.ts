import { runAVScannerContract } from '@form/testkit';
import { createNoopScanner } from './noop.ts';

runAVScannerContract('no-op', () => ({ impl: createNoopScanner() }), { inspectsContent: false });
