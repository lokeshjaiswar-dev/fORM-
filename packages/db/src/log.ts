/*
 * Errors for log lines. A database error is the one error whose text can carry what respondents typed:
 *
 *  - Drizzle's DrizzleQueryError puts every bound parameter in its `message`, its `stack` header and its `params`
 *    property ("Failed query: insert into form_submissions ...\nparams: <id>,<org>,{"pan":{"value":"ABCDE1234F"}}").
 *  - node-postgres' DatabaseError carries `detail` ("Key (email)=(asha@example.in) already exists."), `where` ("JSON
 *    data, line 1: ...") and `internalQuery`, which quote the offending values.
 *
 * `loggableError` keeps what an operator needs to find the fault (the type, the SQLSTATE, the constraint, the table,
 * the SQL text with its `$1` placeholders, the stack) and drops what quotes data. It is the `err` serializer of every
 * logger of the API and the worker, so no call site has to remember to scrub.
 */

const MAX_MESSAGE = 300;
const MAX_QUERY = 500;
const MAX_DEPTH = 5;

/** The pg fields that name a place, never a value. */
const PG_PLACE = ['severity', 'code', 'schema', 'table', 'column', 'dataType', 'constraint', 'routine'] as const;

/** Properties that quote data, dropped from any error that carries them. */
const DATA_PROPS = new Set(['params', 'parameters', 'detail', 'where', 'internalQuery', 'internalPosition', 'hint', 'values', 'query', 'cause', 'stack', 'message', 'errors']);

/** pg messages that end in the offending value: `invalid input syntax for type uuid: "asha@example.in"`. */
const VALUE_TAIL = /((?:invalid input syntax for|invalid input value for|value) [^:]*: ).*$/s;

function isError(value: unknown): value is Error {
  return value instanceof Error || (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string' && typeof (value as { stack?: unknown }).stack === 'string');
}

/** A node-postgres DatabaseError: it has a severity and a five-character SQLSTATE. */
function isPgError(err: Error): boolean {
  const e = err as unknown as { severity?: unknown; code?: unknown };
  return typeof e.severity === 'string' && typeof e.code === 'string' && e.code.length === 5;
}

/** Drizzle's wrapper of a failed query: the SQL and the bound values. */
function isQueryError(err: Error): err is Error & { query: string; params: unknown[] } {
  const e = err as unknown as { query?: unknown; params?: unknown };
  return typeof e.query === 'string' && Array.isArray(e.params);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function messageOf(err: Error): string {
  if (isQueryError(err)) return 'Failed query';
  return clip(isPgError(err) ? err.message.replace(VALUE_TAIL, '$1[redacted]') : err.message, MAX_MESSAGE);
}

/** A stack without its header line: the header repeats the message, which may hold the parameters. */
function frames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const at = stack.search(/^\s+at /m);
  return at < 0 ? undefined : stack.slice(at);
}

function* chain(err: Error): Generator<Error> {
  const seen = new Set<unknown>();
  let next: unknown = err;
  for (let depth = 0; depth < MAX_DEPTH && isError(next) && !seen.has(next); depth++) {
    seen.add(next);
    yield next;
    next = (next as { cause?: unknown }).cause;
  }
}

export function loggableError(err: unknown): unknown {
  if (!isError(err)) return err;
  const out: Record<string, unknown> = { type: err.constructor?.name && err.constructor.name !== 'Object' ? err.constructor.name : err.name };
  const messages: string[] = [];
  for (const link of chain(err)) {
    messages.push(messageOf(link));
    if (isQueryError(link)) out['query'] = clip(link.query, MAX_QUERY);
    if (isPgError(link)) {
      for (const key of PG_PLACE) {
        const value = (link as unknown as Record<string, unknown>)[key];
        if (value !== undefined && out[key] === undefined) out[key] = value;
      }
    }
    // Other properties (a Fastify error's statusCode, a problem's code) are kept unless they quote data.
    for (const key of Object.keys(link)) {
      if (DATA_PROPS.has(key) || out[key] !== undefined) continue;
      if (isPgError(link) || isQueryError(link)) continue;
      const value = (link as unknown as Record<string, unknown>)[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
  }
  out['message'] = messages.join(': ');
  const stack = frames(err.stack);
  if (stack) out['stack'] = `${out['type'] as string}: ${out['message'] as string}\n${stack.replace(/^\n/, '')}`;
  return out;
}
