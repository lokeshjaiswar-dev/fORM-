import { describe, expect, it } from 'vitest';
import {
  AnyErrorEnvelopeSchema,
  BRIDGE_V2,
  BRIDGE_V2_CHILD_TYPES,
  BRIDGE_V2_PARENT_TYPES,
  BRIDGE_V2_WINDOW_TYPES,
  ERROR_CODES,
  ErrorCodeRowSchema,
  ErrorEnvelopeSchema,
  ExchangeRequestSchema,
  ExchangeResponseSchema,
  FieldUsageSchema,
  FpBridgeV2MessageSchema,
  LinkExpiredBodySchema,
  SCOPES,
  SCOPES_BY_MODE,
  SESSION_ROUTE_MAP,
  SHARE_TOKEN_LEGACY_RE,
  SHARE_TOKEN_V2_RE,
  SessionContextSchema,
  SharePayloadSchema,
  TicketRequestSchema,
  TicketResponseSchema,
  checkLaunchUrl,
  evaluateIssuance,
  parseReturnParams,
  parseTicketFragment,
  shareLinkOutcome,
  shareTokenExpiry,
  shareTokenShape,
  type LaunchUrlPolicy,
  type ShareExpiryConfig,
  type ShareLinkState,
} from './index';
import ticketFx from './__fixtures__/launch-ticket.fixtures.json' with { type: 'json' };
import sessionFx from './__fixtures__/fp-session.fixtures.json' with { type: 'json' };
import errorsFx from './__fixtures__/fp-errors.fixtures.json' with { type: 'json' };
import returnFx from './__fixtures__/formplus-return.fixtures.json' with { type: 'json' };
import bridgeFx from './__fixtures__/fp-bridge-v2.fixtures.json' with { type: 'json' };
import usageFx from './__fixtures__/field-usage.fixtures.json' with { type: 'json' };
import shareFx from './__fixtures__/share-link.fixtures.json' with { type: 'json' };
import masterFx from '../master/__fixtures__/dms-master-form.fixtures.json' with { type: 'json' };
import recordFx from '../record/__fixtures__/dms-record.fixtures.json' with { type: 'json' };

/** The shape every fixture case has (the contract note in each file's `$comment`). */
interface Case<I = unknown> {
  name: string;
  input: I;
  expect: { valid: boolean; status?: number; code?: string; why?: string; [k: string]: unknown };
  requires?: 'server';
  [k: string]: unknown;
}
const cases = <I,>(list: unknown): Case<I>[] => list as Case<I>[];

describe('every case is named, unique per list, and carries expect.valid', () => {
  const lists: Array<[string, unknown]> = [
    ['ticket.issuance', ticketFx.issuance],
    ['ticket.issuanceResponse', ticketFx.issuanceResponse],
    ['ticket.exchangeRequest', ticketFx.exchangeRequest],
    ['ticket.exchangeResponse', ticketFx.exchangeResponse],
    ['ticket.exchangeOutcomes', ticketFx.exchangeOutcomes],
    ['ticket.context', ticketFx.context],
    ['ticket.launchUrls', ticketFx.launchUrls],
    ['ticket.fragments', ticketFx.fragments],
    ['ticket.pkce', ticketFx.pkce],
    ['session.failures', sessionFx.failures],
    ['errors.envelopes', errorsFx.envelopes],
    ['errors.envelopesAnyCode', errorsFx.envelopesAnyCode],
    ['return.cases', returnFx.cases],
    ['bridge.cases', bridgeFx.cases],
    ['usage.cases', usageFx.cases],
    ['share.tokens', shareFx.tokens],
    ['share.outcomes', shareFx.outcomes],
    ['share.payloads', shareFx.payloads],
    ['share.expired', shareFx.expired],
  ];
  it.each(lists)('%s', (_label, list) => {
    const all = cases(list);
    expect(all.length).toBeGreaterThan(0);
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of all) {
      expect(typeof c.name).toBe('string');
      expect(c).toHaveProperty('input');
      expect(typeof c.expect.valid).toBe('boolean');
    }
  });
});

describe('launch ticket: issuance', () => {
  const policy = ticketFx.policy as LaunchUrlPolicy;
  const all = cases<{ headers?: { Origin?: string }; bearer_scopes?: string[]; body: unknown }>(ticketFx.issuance);

  it.each(all.filter((c) => c.requires !== 'server').map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const body = c.input.body;
    const shape = TicketRequestSchema.safeParse(body).success;
    const mode = (body as { mode?: string }).mode;
    if (mode !== 'dms-upload') expect(shape).toBe(c.expect.valid);
    const outcome = evaluateIssuance(c.input, policy);
    expect(outcome.status).toBe(c.expect.status);
    if (c.expect.code !== undefined) expect(outcome).toMatchObject({ code: c.expect.code });
    else expect(outcome).toEqual({ status: 201 });
  });

  it('the server-only cases have a valid body shape and name the user they run as', () => {
    const server = all.filter((c) => c.requires === 'server');
    expect(server.length).toBeGreaterThanOrEqual(6);
    for (const c of server) {
      expect(TicketRequestSchema.safeParse(c.input.body).success).toBe(true);
      expect(typeof (c.input as unknown as { as: string }).as).toBe('string');
      expect(c.expect.status).toBeGreaterThanOrEqual(201);
    }
  });

  it('a ticket request carries no tenant or workspace: they are not even accepted keys', () => {
    expect(Object.keys(TicketRequestSchema.shape)).not.toEqual(expect.arrayContaining(['tenant_id']));
    expect(Object.keys(TicketRequestSchema.shape)).not.toEqual(expect.arrayContaining(['workspace_id']));
  });
});

describe('launch ticket: responses, context, exchange', () => {
  it.each(cases(ticketFx.issuanceResponse).map((c) => [c.name, c] as const))('issuance response %s', (_n, c) => {
    expect(TicketResponseSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it.each(cases(ticketFx.exchangeRequest).map((c) => [c.name, c] as const))('exchange request %s', (_n, c) => {
    expect(ExchangeRequestSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it.each(cases(ticketFx.exchangeResponse).map((c) => [c.name, c] as const))('exchange response %s', (_n, c) => {
    expect(ExchangeResponseSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it.each(cases(ticketFx.context).map((c) => [c.name, c] as const))('context %s', (_n, c) => {
    expect(SessionContextSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it('every exchange failure is the same 401 FP_TICKET_INVALID', () => {
    for (const c of cases(ticketFx.exchangeOutcomes)) {
      expect(c.requires).toBe('server');
      expect(c.expect).toMatchObject({ status: 401, code: 'FP_TICKET_INVALID' });
    }
  });
  it('the PKCE pairs are S256 of the verifier', async () => {
    const s256 = async (verifier: string): Promise<string> => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    for (const c of cases<{ verifier: string; challenge: string }>(ticketFx.pkce)) {
      expect((await s256(c.input.verifier)) === c.input.challenge).toBe(c.expect.valid);
    }
    expect(await s256(ticketFx.samples.verifier)).toBe(ticketFx.samples.challenge);
  });
});

describe('launch ticket: return and reconnect URLs', () => {
  it.each(cases<{ kind: string; url: string; policy: LaunchUrlPolicy }>(ticketFx.launchUrls).map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const res = checkLaunchUrl(c.input.url, c.input.policy);
    expect(res.ok).toBe(c.expect.valid);
    if (!res.ok) expect(res.reason).toBe(c.expect.reason);
  });
});

describe('launch ticket: fragment grammar', () => {
  it.each(cases<{ hash: string; apiBases: string[]; devOverrides: boolean }>(ticketFx.fragments).map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const res = parseTicketFragment(c.input.hash, { apiBases: c.input.apiBases, devOverrides: c.input.devOverrides });
    expect(res.ok).toBe(c.expect.valid);
    if (res.ok) {
      expect(res.ticket).toBe(c.expect.ticket);
      expect(res.api).toBe(c.expect.api);
      expect(res.verifier).toBe(c.expect.verifier);
    } else expect(res.reason).toBe(c.expect.reason);
  });
});

describe('error contract', () => {
  const rows = errorsFx.codes as Array<{ code: string }>;
  it('lists every code once, in the DESIGN 3.4 order', () => {
    expect(rows.map((r) => r.code)).toEqual([...ERROR_CODES]);
  });
  it.each(rows.map((r) => [r.code, r] as const))('%s is a well-formed row', (_c, row) => {
    expect(ErrorCodeRowSchema.safeParse(row).success).toBe(true);
  });
  it('a code that asks for a reconnect is a 401 and is never retryable as is', () => {
    for (const r of errorsFx.codes) {
      if (r.reconnect) {
        expect(r.status).toBe(401);
        expect(r.retryable).toBe(false);
      }
    }
  });
  it('the throttle and the store outage are the retryable ones, with their statuses', () => {
    const by = Object.fromEntries(errorsFx.codes.map((r) => [r.code, r]));
    expect(by.RATE_LIMITED).toMatchObject({ status: 429, retryable: true });
    expect(by.LAUNCH_STORE_UNAVAILABLE).toMatchObject({ status: 503, retryable: true });
    expect(by.LINK_EXPIRED).toMatchObject({ status: 410 });
    expect(by.REMOVAL_COUNT_CHANGED).toMatchObject({ status: 409 });
    expect(by.MASTER_CHANGED).toMatchObject({ status: 409 });
  });
  it.each(cases(errorsFx.envelopes).map((c) => [c.name, c] as const))('envelope %s', (_n, c) => {
    expect(ErrorEnvelopeSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it.each(cases(errorsFx.envelopesAnyCode).map((c) => [c.name, c] as const))('envelope with any code %s', (_n, c) => {
    expect(AnyErrorEnvelopeSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
});

describe('return parameters', () => {
  it.each(cases<{ search: string }>(returnFx.cases).map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const parsed = parseReturnParams(c.input.search);
    expect(parsed !== null).toBe(c.expect.valid);
    if (parsed !== null) {
      expect(parsed).toEqual(c.expect.params);
      if (parsed.fp_code !== undefined) expect(ERROR_CODES.includes(parsed.fp_code as (typeof ERROR_CODES)[number])).toBe(c.expect.knownCode);
    }
  });
});

describe('session routes and scopes', () => {
  it('the route table of the fixture is SESSION_ROUTE_MAP', () => {
    expect(sessionFx.routes.map(({ name, method, legacy, session, scope }) => ({ name, method, legacy, session, scope }))).toEqual(
      SESSION_ROUTE_MAP.map((r) => ({ ...r })),
    );
  });
  it('the scope sets of the fixture are SCOPES_BY_MODE, and use known scopes only', () => {
    expect(sessionFx.scopesByMode).toEqual(SCOPES_BY_MODE);
    for (const route of SESSION_ROUTE_MAP) expect([...SCOPES, 'any']).toContain(route.scope);
    for (const variants of Object.values(SCOPES_BY_MODE)) for (const set of Object.values(variants)) for (const s of set) expect(SCOPES).toContain(s);
  });
  it('every route a mode needs is covered by that mode scopes, and nothing outside them is mapped', () => {
    const needs = (set: readonly string[]) => SESSION_ROUTE_MAP.filter((r) => r.scope !== 'any' && set.includes(r.scope)).map((r) => r.name);
    expect(needs(SCOPES_BY_MODE['dms-record'].add)).toEqual(['fp.s.master-form.show', 'fp.s.masters.show', 'fp.s.master-records.index', 'fp.s.master-records.store']);
    expect(needs(SCOPES_BY_MODE['dms-master'].create)).toEqual(['fp.s.master-form.store', 'fp.s.masters.show', 'fp.s.master-records.index']);
  });
  it('legacy paths are unique per method and every session path is under the session prefix', () => {
    const seen = new Set<string>();
    for (const r of SESSION_ROUTE_MAP) {
      if (r.legacy !== null) {
        const key = `${r.method} ${r.legacy}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      expect(r.session.startsWith('dms/v1/formplus/s/')).toBe(true);
    }
  });
  it('every session failure names a code of the error table', () => {
    for (const c of cases(sessionFx.failures)) expect(ERROR_CODES).toContain(c.expect.code);
  });
});

describe('fp-bridge/2', () => {
  const all = cases(bridgeFx.cases);
  it.each(all.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(FpBridgeV2MessageSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it('covers every message type with at least one valid and one invalid case', () => {
    const types = [...BRIDGE_V2_WINDOW_TYPES, ...BRIDGE_V2_CHILD_TYPES, ...BRIDGE_V2_PARENT_TYPES];
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) {
      const own = all.filter((c) => (c.input as { type?: string }).type === type);
      expect(own.some((c) => c.expect.valid), `valid ${type}`).toBe(true);
      expect(own.some((c) => !c.expect.valid), `invalid ${type}`).toBe(true);
    }
  });
  it('hello and port are the window messages, and everything valid names the protocol', () => {
    for (const c of all) {
      if (c.expect.valid) expect((c.input as { protocol: string }).protocol).toBe(BRIDGE_V2);
      const type = (c.input as { type?: string }).type;
      if (type === 'hello' || type === 'port') expect(c.via).toBe('window');
    }
  });
  it('only `collected` can carry values and `state` cannot', () => {
    const valid = all.filter((c) => c.expect.valid).map((c) => c.input as Record<string, unknown>);
    for (const m of valid) if (m.type !== 'collected' && m.type !== 'init') expect(m).not.toHaveProperty('values');
  });
});

describe('field usage', () => {
  it.each(cases<{ status: number; body: { data: unknown } }>(usageFx.cases).map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(FieldUsageSchema.safeParse(c.input.body.data).success).toBe(c.expect.valid);
  });
});

describe('share links', () => {
  const cfg = shareFx.config as ShareExpiryConfig;
  it('the two token regexes are the ones in the fixture', () => {
    expect(shareFx.regex.v2).toBe(SHARE_TOKEN_V2_RE.source);
    expect(shareFx.regex.legacy).toBe(SHARE_TOKEN_LEGACY_RE.source);
  });
  it.each(cases<{ token: string }>(shareFx.tokens).map((c) => [c.name, c] as const))('token %s', (_n, c) => {
    expect(shareTokenShape(c.input.token)).toBe(c.expect.shape);
    expect(shareTokenShape(c.input.token) !== 'other').toBe(c.expect.valid);
    if (c.expect.expiry !== undefined) expect(shareTokenExpiry(c.input.token)).toBe(c.expect.expiry);
  });
  it.each(cases<{ link: ShareLinkState; now: number; config: ShareExpiryConfig }>(shareFx.outcomes).map((c) => [c.name, c] as const))('outcome %s', (_n, c) => {
    expect(shareLinkOutcome(c.input.link, c.input.now, c.input.config ?? cfg)).toBe(c.expect.outcome);
  });
  it.each(cases(shareFx.payloads).map((c) => [c.name, c] as const))('payload %s', (_n, c) => {
    expect(SharePayloadSchema.safeParse(c.input).success).toBe(c.expect.valid);
  });
  it('the payloads cover all 7 element types', () => {
    const p = SharePayloadSchema.parse(cases(shareFx.payloads)[0]!.input);
    expect(p.form_builders.map((e) => e.type).sort()).toEqual(['date', 'dropdown', 'email', 'multilineinput', 'numberinput', 'phonenumber', 'textinput']);
  });
  it.each(cases<{ status: number; body: unknown }>(shareFx.expired).map((c) => [c.name, c] as const))('expired %s', (_n, c) => {
    expect(LinkExpiredBodySchema.safeParse(c.input.body).success).toBe(c.expect.valid);
  });
});

describe('additive cases in the existing fixtures (v2Cases)', () => {
  type V2Case = { name: string; request: { method: string; path: string; body?: unknown }; response: { status: number; body: { code?: string; success?: boolean } } };
  const master = (masterFx as unknown as { v2Cases: { cases: V2Case[] } }).v2Cases.cases;
  const record = (recordFx as unknown as { v2Cases: { cases: V2Case[] } }).v2Cases.cases;
  const KNOWN = ['dms-master-form', 'dms-record'];
  it.each([
    ['dms-master-form', master],
    ['dms-record', record],
  ] as const)('%s v2Cases are unique, replayable and use known codes', (label, list) => {
    expect(KNOWN).toContain(label);
    expect(list.length).toBeGreaterThan(5);
    expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
    for (const c of list) {
      expect(['GET', 'POST', 'PATCH']).toContain(c.request.method);
      expect(c.response.status).toBeGreaterThanOrEqual(200);
      if (c.response.body.code !== undefined) expect(ERROR_CODES).toContain(c.response.body.code);
    }
  });
  it('the master cases cover every new code of DESIGN 3.1', () => {
    const codes = new Set(master.map((c) => c.response.body.code));
    for (const code of ['FIELD_OMITTED', 'UNKNOWN_FIELD', 'REMOVAL_NOT_CONFIRMED', 'REMOVAL_COUNT_CHANGED', 'FIELD_VISIBILITY_FORBIDDEN', 'PRIMARY_CANNOT_BE_HIDDEN']) expect(codes.has(code), code).toBe(true);
    expect(master.some((c) => c.request.method === 'PATCH' && c.request.body !== undefined && !('form_builder_fields' in (c.request.body as object)))).toBe(true);
    expect(master.some((c) => JSON.stringify(c.request.body ?? {}).includes('"remove"'))).toBe(true);
  });
  it('the record cases cover the mask, the hidden key and the partial PATCH', () => {
    const codes = new Set(record.map((c) => c.response.body.code));
    expect(codes.has('SECRET_MASK_NOT_ALLOWED')).toBe(true);
    expect(codes.has('HIDDEN_FIELD_NOT_WRITABLE')).toBe(true);
    expect(JSON.stringify(record)).toContain('__masked');
  });
});
