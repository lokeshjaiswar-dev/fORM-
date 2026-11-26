import { vi } from 'vitest';
import { ExchangeResponseSchema, type ExchangeResponse, type SessionContext } from '@/embed/contract';
import ticketFx from '@/embed/contract/__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import { resetLaunchMemo } from '@/embed/launch';
import { installSession } from './dmsSession';
import type { HandoffEnv } from './handoff';
import { resetReconnectForTests } from './reconnect';

/*
 * Test support for everything that runs under a session: the pages, the repositories, the lookup source. A test installs a session the
 * way a successful exchange would (`installTestSession`), so `currentLaunch()` and `createDmsClient()` behave as in the browser, and
 * resets it afterwards (`resetTestSession`). Test files only: nothing in the app imports this module, and it imports `vitest`.
 *
 * Values are the contract fixtures' made-up samples (`launch-ticket.fixtures.json`).
 */

export const TEST_API_BASE = 'https://dms.example.test/api';
/** The sample credential of the contract fixtures: a test searches requests for it, never for a real secret. */
export const TEST_CREDENTIAL = ticketFx.samples.credential;
const DMS_ORIGIN = 'https://dms.example.test';

export interface TestSessionOptions {
  /** Fields of the exchange `context` to override (mode, master_id, record_id, return_url, ...). Defaults to the fixture's master create. */
  context?: Partial<SessionContext>;
  credential?: string;
  apiBase?: string;
  /** The `fetch` the session's keep-alive and leave use. */
  fetch?: typeof fetch;
  /** Seconds, as the exchange reports them. */
  expiresIn?: number;
  absoluteExpiresIn?: number;
}

/** The base case of the fixtures: `dms-master` create. */
function sample(): ExchangeResponse {
  const found = ticketFx.exchangeResponse.find((c) => c.name === 'create');
  return ExchangeResponseSchema.parse(found?.input);
}

/** `HandoffEnv` of a test page: this page's origin, the DMS fixture origin as a return origin, one API base. */
export function testEnv(apiBase = TEST_API_BASE, over: Partial<HandoffEnv> = {}): HandoffEnv {
  return { origin: window.location.origin, returnOrigins: [DMS_ORIGIN], apiBases: [apiBase], devOverrides: false, legacyDescriptor: false, ...over };
}

/**
 * Installs a session as the exchange would, and stubs the build variables `currentLaunch` reads (`VITE_FP_DMS_API_BASE`,
 * `VITE_FP_RETURN_ORIGINS`). Returns the context the page runs under.
 */
export function installTestSession(options: TestSessionOptions = {}): SessionContext {
  const apiBase = options.apiBase ?? TEST_API_BASE;
  vi.stubEnv('VITE_FP_DMS_API_BASE', apiBase);
  vi.stubEnv('VITE_FP_RETURN_ORIGINS', DMS_ORIGIN);
  const base = sample();
  const response: ExchangeResponse = {
    ...base,
    credential: options.credential ?? base.credential,
    expires_in: options.expiresIn ?? base.expires_in,
    absolute_expires_in: options.absoluteExpiresIn ?? base.absolute_expires_in,
    context: { ...base.context, ...options.context },
  };
  installSession(response, apiBase, testEnv(apiBase), options.fetch);
  return response.context;
}

/** Back to a page that was never launched: session, resume hint, memo, reconnect, stubbed variables. */
export function resetTestSession(): void {
  resetReconnectForTests();
  resetLaunchMemo();
  vi.unstubAllEnvs();
}
