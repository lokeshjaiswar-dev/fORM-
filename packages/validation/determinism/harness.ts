/// <reference lib="dom" />
import { runCorpus } from '../test/corpus/determinism.ts';

declare global {
  interface Window {
    /** The validation corpus run in this engine, as the JSON the spec compares with Node's. */
    runValidationCorpus?: () => string;
  }
}

window.runValidationCorpus = () => JSON.stringify(runCorpus());
document.documentElement.dataset['ready'] = 'true';
