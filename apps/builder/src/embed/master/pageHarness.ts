import { render } from '@testing-library/react';
import { createElement } from 'react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@dmacq/ui';
import type { Classification, SessionContext } from '@/embed/contract';
import { DmsMasterPage } from '@/embed/master/DmsMasterPage';
import { installTestSession, TEST_API_BASE } from '@/embed/session/testing';
import { SubmissionsProvider } from '@/persistence/SubmissionsContext';
import { MemorySubmissions } from '@/test/fixtures';

/*
 * Test harness of the /embed/dms-master page tests (DmsMasterPage.test.tsx, DmsMasterPage.removal.test.tsx). Tests only: nothing in the app
 * imports this module. A test installs the session a successful ticket exchange would have (`installMaster`), renders the page, and answers
 * the page's requests with a `fetch` double: the session client maps the legacy paths the repository writes to the session group
 * (DESIGN 3.3), so `legacyOf` turns a requested URL back into the legacy name the fixtures use.
 */

export const MASTER = 'b9000000-0000-4000-8000-000000000001';
export const BASE = TEST_API_BASE;
export const RETURN = 'https://dms.example.test/dms/11111111-1111-4111-8111-111111111111/documents/master';
/** An origin the build does not list as a return origin: `returnUrl` is then null and the page ends on "Saved to DMS". */
export const ELSEWHERE = 'https://elsewhere.example.test/back';
export const READY = { timeout: 15_000 };

export interface MasterLaunch {
  /** Present = edit this master; absent = create. */
  masterId?: string;
  /** Create only: the wizard's seed. Defaults to `{name: 'Vendor', no doc types, no folders, classification null}`. */
  seed?: SessionContext['master_seed'];
  returnUrl?: string;
  /** `can.reveal_fields` of the launch context (default true: the creator). */
  reveal?: boolean;
  mode?: 'dms-master' | 'dms-record';
}

export const seedOf = (over: { name?: string; doctype_ids?: string[]; folder_ids?: string[]; classification?: Classification | null } = {}) => ({
  name: over.name ?? 'Vendor',
  doctype_ids: over.doctype_ids ?? [],
  folder_ids: over.folder_ids ?? [],
  classification: over.classification ?? null,
});

/** Installs the session of a launch, as the exchange would. */
export function installMaster(over: MasterLaunch = {}): SessionContext {
  const create = over.masterId === undefined;
  return installTestSession({
    apiBase: BASE,
    context: {
      mode: over.mode ?? 'dms-master',
      master_id: over.masterId ?? null,
      record_id: null,
      master_seed: create ? (over.seed === undefined ? seedOf() : over.seed) : null,
      return_url: over.returnUrl ?? RETURN,
      can: { reveal_fields: over.reveal ?? true },
    },
  });
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** `GET master/form/{id}` as dms-api answers it for a Forms+ master. */
export const shown = (fields: unknown, over: Record<string, unknown> = {}) => ({
  success: true,
  message: 'ok',
  data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1', doctype_ids: [], folder_ids: [], form_builder_fields: fields, ...over },
});

/** The legacy path of a session URL (`/dms/v1/formplus/s/master/form/x` is `/dms/v1/master/form/x`). */
export function legacyOf(url: string): string {
  const rest = url.replace(`${BASE}/dms/v1/formplus/s/`, '');
  return rest.startsWith('master/form') ? `/dms/v1/${rest}` : `/dms/${rest}`;
}

export interface Seen {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A `fetch` double that records what was asked and answers from `answer`. */
export function fakeFetch(answer: (call: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Seen = {
      method: init?.method ?? 'GET',
      url,
      path: legacyOf(url),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    seen.push(call);
    return answer(call);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, seen };
}

/** Renders the master page under a router, tooltips and an in-memory submissions store (what the app route supplies). */
export function renderMaster(navigate: (url: string) => void = vi.fn()) {
  const page = createElement(DmsMasterPage, { navigate });
  const router = createElement(MemoryRouter, { initialEntries: ['/embed/dms-master'] }, page);
  const tooltips = createElement(TooltipProvider, null, router);
  return { navigate, ...render(createElement(SubmissionsProvider, { repo: new MemorySubmissions(), children: tooltips })) };
}
