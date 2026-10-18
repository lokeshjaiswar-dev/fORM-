/// <reference lib="dom" />
import { runCorpus, runGraphemes } from '../test/corpus/determinism.ts';

declare global {
  interface Window {
    /** The corpus run in this engine, as the JSON the spec compares with Node's. */
    runDeterminismCorpus?: () => string;
  }
}

window.runDeterminismCorpus = () => JSON.stringify({ cases: runCorpus(), graphemes: runGraphemes() });
document.documentElement.dataset['ready'] = 'true';
