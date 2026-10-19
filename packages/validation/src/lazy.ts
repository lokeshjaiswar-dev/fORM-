import { installRegexEngine, regexEngineInstalled } from './regex.ts';

export * from './api.ts';

let loading: Promise<void> | undefined;

/** Loads and installs re2js once (a separate chunk in a browser bundle); a failed load can be retried. */
export function loadRegexEngine(): Promise<void> {
  if (regexEngineInstalled()) return Promise.resolve();
  loading ??= import('re2js').then(
    (module) => installRegexEngine(module.RE2JS),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}
