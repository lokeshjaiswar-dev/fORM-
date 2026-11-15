import { create } from 'zustand';
import { z } from 'zod';
import { RichDocSchema, type RichDoc } from '@form/schema';

/*
 * The FormOps (schema §14) the builder keeps in this browser. A form's open/closed state, closed screen and password
 * are live settings on the server since WP-1.07 (`PUT /v1/forms/:id/access`, the Access panel), where the password is
 * hashed and nothing can read it back. This store stays as the slot for a setting that never leaves the browser;
 * autosave saves it beside the draft, outside undo history.
 *
 * What older builds kept here (`open`, `closedMessage`, `password`) is read once, by `legacyAccessOf`, when such a form
 * opens: `openForm.ts` sends it to the API and clears the local copy (BL-145). If the server cannot take the closed
 * state yet, it waits in `pendingAccess`, the one key this store holds: autosave writes the whole store on every save,
 * so a value kept anywhere else would be overwritten by the author's first edit. A password never waits there (BL-273).
 */

/**
 * What an earlier open could not send to the server yet: the closed state and the screen the author wrote for it. It is
 * written back with every save until the server takes it or refuses it for good. There is no password in it, in the
 * type or on disk: a plaintext password lives only as long as the request that sends it (see `LegacyAccess`).
 */
export interface PendingAccess {
  closed: boolean;
  closedMessage?: RichDoc | undefined;
}

export interface LocalOps {
  pendingAccess?: PendingAccess | undefined;
}

/** The shape a pending setting is saved in; read back strictly, like the rest of the stored ops. */
const PendingAccessSchema = z.strictObject({ closed: z.boolean(), closedMessage: RichDocSchema.optional() });
/**
 * What the slot may hold when it is read: a copy saved by a build that still kept the password beside the closed state
 * has a `password` key. It is read once so the password can be sent, and is never written back (`PendingAccess` has no such key).
 */
const StoredPendingSchema = PendingAccessSchema.extend({ password: z.string().optional() });

export const LocalOpsSchema = z.strictObject({ pendingAccess: StoredPendingSchema.optional() });

export const defaultOps = (): LocalOps => ({});

export const useOpsStore = create<LocalOps>()(() => defaultOps());

export const currentOps = (): LocalOps => useOpsStore.getState();

export function updateOps(patch: Partial<LocalOps>): void {
  useOpsStore.setState(patch);
}

export function loadOps(ops: LocalOps): void {
  useOpsStore.setState(ops, true);
}

/** `ops` holding `pending` as the access still to be sent, or none (null): the one place the key is added or removed. */
export function withPendingAccess(ops: LocalOps, pending: PendingAccess | null): LocalOps {
  const { pendingAccess: _replaced, ...rest } = ops;
  return pending ? { ...rest, pendingAccess: pending } : rest;
}

/** The shape older builds saved in a stored form's `ops`, read leniently: every key is optional and a bad one is ignored. */
const LegacyOpsSchema = z.object({
  open: z.boolean().catch(true),
  closedMessage: RichDocSchema.optional().catch(undefined),
  password: z.string().catch(''),
});

/**
 * Access settings a form still holds from before they lived on the server: a password, and/or being switched off with its
 * closed screen. It exists only in memory, while a form opens: what it holds is sent, and what the server could not take
 * is kept as a `PendingAccess` (`pendingOf`), which has no password.
 */
export interface LegacyAccess {
  /** Plaintext, from a browser that kept it (or a v1 file); empty for none. It lives as long as the request that sends it, and no longer. */
  password: string;
  closed: boolean;
  /** The closed screen the author wrote; undefined when the form was closed with the standard wording. */
  closedMessage?: RichDoc | undefined;
}

/** Whether a document has text of its own: a closed message nobody wrote is an empty paragraph. */
const hasText = (doc: RichDoc): boolean => doc.content.some((node) => node.type !== 'paragraph' || (node.content?.length ?? 0) > 0);

/** What may wait for a later open: the closed state and its screen. The password is left out, always (BL-273). */
export function pendingOf(legacy: LegacyAccess): PendingAccess | null {
  return legacy.closed ? { closed: true, closedMessage: legacy.closedMessage } : null;
}

/** What is left to move once the checks are done: nothing for an open form with no password. */
function accessOf(password: string, closed: boolean, closedMessage: RichDoc | undefined): LegacyAccess | null {
  if (!closed && password === '') return null;
  return { password, closed, closedMessage: closed && closedMessage && hasText(closedMessage) ? closedMessage : undefined };
}

/**
 * What a stored form's `ops` hold that now belongs on the server, or null when there is nothing to move (no password and
 * not closed). Two shapes are read: the keys an older build saved, and this build's `pendingAccess` slot, which holds what
 * an earlier open could not send. The closed message counts only for a closed form: an open form's was never shown.
 */
export function legacyAccessOf(ops: unknown): LegacyAccess | null {
  if (typeof ops !== 'object' || ops === null) return null;
  const pending = StoredPendingSchema.safeParse((ops as { pendingAccess?: unknown }).pendingAccess);
  if (pending.success) return accessOf(pending.data.password ?? '', pending.data.closed, pending.data.closedMessage);
  const parsed = LegacyOpsSchema.safeParse(ops);
  if (!parsed.success) return null;
  const { open, closedMessage, password } = parsed.data;
  return accessOf(password, !open, closedMessage);
}
