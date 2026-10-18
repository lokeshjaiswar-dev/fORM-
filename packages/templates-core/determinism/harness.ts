/// <reference lib="dom" />
import { runCorpus } from '../test/corpus.ts';

declare global {
  interface Window {
    /** The corpus run in this engine, as the JSON the spec compares with Node's. */
    runTemplatesCorpus?: () => string;
  }
}

window.runTemplatesCorpus = () => JSON.stringify(runCorpus());
document.documentElement.dataset['ready'] = 'true';
