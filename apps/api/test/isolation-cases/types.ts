import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import type { MembershipRole } from '@form/db';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Res = LightMyRequestResponse;

/** An org B member the case acts as: a fresh user with a live session, made for this one request. */
export interface Actor {
  id: string;
  email: string;
  /** The org the actor belongs to (org B). */
  orgId: string;
  /** The actor's own session, which is what the session routes act on. */
  sessionId: string;
}

/**
 * The seeded orgs. Org A is the victim: every id here is org A's, and the suite sends them as org B's member. Org B is
 * the caller. `secrets` is everything that identifies org A or its rows; a success answer to org B that carries one of
 * them (other than one the request itself named) is a leak.
 */
export interface Fixture {
  a: {
    orgId: string;
    slug: string;
    name: string;
    ownerId: string;
    ownerEmail: string;
    /** A second active member, so member routes have a target that is not the owner. */
    memberId: string;
    memberEmail: string;
    /** A form with a draft and a live version, a response and an uploaded file. */
    formId: string;
    formTitle: string;
    /** A second form with a draft (the merge routes name two). */
    secondFormId: string;
    versionId: string;
    /** The public address of the live form. */
    formSlug: string;
    submissionId: string;
    fileId: string;
    /** An open invite, for the address in `inviteEmail`. */
    inviteId: string;
    inviteToken: string;
    inviteEmail: string;
    /** A live session of org A's owner. */
    sessionId: string;
  };
  b: {
    orgId: string;
    slug: string;
    ownerId: string;
    formId: string;
  };
  /** The current account privacy notice, which `POST /v1/me/notice` has to name. */
  notice: { version: string; hash: string };
  /** Values a domain's `seed` added, by name. */
  extra: Record<string, string>;
  secrets: string[];
}

/** What a seed can use: the migrator's handle and the API as a member of an org. */
export interface SeedEnv {
  app: FastifyInstance;
  /** The migrator's connection: it bypasses RLS, so it seeds rows and checks that org A's are unchanged. Never a request handler's. */
  owner: pg.Pool;
  /** A request as a member of an org (the development header), with the headers a browser sends. */
  as(userId: string, orgId: string, method: Method, url: string, body?: unknown): Promise<Res>;
}

export interface Call {
  /** Path and query, with org A's ids. */
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A refusal or a refusal-shaped answer must be on the record: the audit event that carries the request's id. */
export interface AuditExpect {
  /** `platform`: the chain for a caller who is not in the org they named; `a`: org A's chain. */
  orgKey: 'platform' | 'a';
  action: string;
  outcome: 'denied' | 'error';
  reason?: string;
  /** Fields the event's metadata must have. */
  metadata?: Record<string, unknown>;
}

export interface Answer {
  status: number;
  /** The problem+json `code` of a refusal. */
  code?: string;
  audit?: AuditExpect | ((f: Fixture, actor: Actor) => AuditExpect);
  /** Further checks on the answer (a list holds only org B's rows, a write changed only org B's). */
  check?: (res: Res, f: Fixture, actor: Actor) => void | Promise<void>;
}

export interface IsolationCase {
  /** `METHOD /v1/pattern`, exactly as Fastify registers the route (parameters as `:name`). */
  route: string;
  /** The org B member's role; owner by default, so a refusal is never for want of a permission. */
  role?: MembershipRole;
  /** The request, aimed at org A's ids (or at nothing of org A's, for a route that takes none). */
  call(f: Fixture, actor: Actor): Call;
  /**
   * What org B's member gets, naming org B (an `account` route names no org): 404 by default, because row-level
   * security makes org A's rows not exist for them. A route that takes no id of org A's says what it does answer.
   * An `auth: 'user'` route also gets the same request naming org A, which the suite expects to be 403 and audited.
   */
  own?: Answer;
  /** Why the case looks the way it does, for the next person to read. */
  note?: string;
}

/**
 * One domain's part of the suite. A work package that adds a route adds its case to its domain's file and, if the case
 * needs org A rows that the core fixture does not have, a `seed` (through the API or `env.owner`) that returns them by
 * name in `f.extra`.
 */
export interface IsolationDomain {
  cases: IsolationCase[];
  seed?: (env: SeedEnv, f: Fixture) => Promise<Record<string, string>>;
}
