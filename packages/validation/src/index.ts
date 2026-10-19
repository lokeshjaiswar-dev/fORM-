import { RE2JS } from 're2js';
import { installRegexEngine } from './regex.ts';

/* The eager entry (servers, the builder): re2js is installed on import. Browsers rendering forms use ./lazy. */
installRegexEngine(RE2JS);

export * from './api.ts';

/** The engine is already installed; kept so both entries have the same API. */
export const loadRegexEngine = (): Promise<void> => Promise.resolve();
