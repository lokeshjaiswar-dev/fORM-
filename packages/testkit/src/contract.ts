import { afterAll, beforeAll, expect } from 'vitest';
import { isPortError, type ByteStream, type PortErrorCode } from '@form/ports';

export interface ContractSubject<T> {
  impl: T;
  dispose?: () => Promise<void> | void;
}

export type ContractSetup<S> = () => Promise<S> | S;

/** Sets the subject up once per suite and returns a getter for the tests. */
export function useSubject<S extends ContractSubject<unknown>>(setup: ContractSetup<S>): () => S {
  let subject: S | undefined;
  beforeAll(async () => {
    subject = await setup();
  });
  afterAll(async () => {
    await subject?.dispose?.();
  });
  return () => {
    if (!subject) throw new Error('contract subject is not set up');
    return subject;
  };
}

export async function expectPortError(p: Promise<unknown>, ...codes: PortErrorCode[]): Promise<void> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e, 'expected a PortError').toBeDefined();
  expect(isPortError(e), `expected a PortError, got ${String(e)}`).toBe(true);
  if (codes.length > 0 && isPortError(e)) expect(codes).toContain(e.code);
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export async function collectBytes(stream: ByteStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    length += chunk.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** A stream over `chunks` that records how many were read, to prove a consumer drained it. */
export function trackedStream(chunks: Uint8Array[]): { stream: ByteStream; consumed: () => number } {
  let consumed = 0;
  async function* gen() {
    for (const c of chunks) {
      consumed += 1;
      yield c;
    }
  }
  return { stream: gen(), consumed: () => consumed };
}

export function uniquePrefix(): string {
  return `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
