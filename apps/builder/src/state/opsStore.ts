import { create } from 'zustand';
import { z } from 'zod';
import { RichDocSchema, type RichDoc } from '@form/schema';

/*
 * The FormOps (schema §14) the builder keeps in this browser: none. A form's open/closed state, closed screen and
 * password are live settings on the server since WP-1.07 (`PUT /v1/forms/:id/access`, the Access panel), where the
 * password is hashed and nothing can read it back. This store stays as the slot for a setting that never leaves the
 * browser; autosave still saves it beside the draft, outside undo history.
 *
 * What older builds kept here (`open`, `closedMessage`, `password`) is read once, by `legacyAccessOf`, when such a form
 * opens: `openForm.ts` sends it to the API and clears the local copy (BL-145).
 */

export type LocalOps = Record<never, never>;

export const LocalOpsSchema = z.strictObject({});

export const defaultOps = (): LocalOps => ({});

export const useOpsStore = create<LocalOps>()(() => defaultOps());

export const currentOps = (): LocalOps => useOpsStore.getState();

export function updateOps(patch: Partial<LocalOps>): void {
  useOpsStore.setState(patch);
}

export function loadOps(ops: LocalOps): void {
  useOpsStore.setState(ops, true);
}

/** The shape older builds saved in a stored form's `ops`, read leniently: every key is optional and a bad one is ignored. */
const LegacyOpsSchema = z.object({
  open: z.boolean().catch(true),
  closedMessage: RichDocSchema.optional().catch(undefined),
  password: z.string().catch(''),
});

/** Access settings a form still holds from before they lived on the server: a password, and/or being switched off with its closed screen. */
export interface LegacyAccess {
  /** Plaintext, from a browser that kept it (or a v1 file); empty for none. It goes to the API once and is dropped. */
  password: string;
  closed: boolean;
  /** The closed screen the author wrote; undefined when the form was closed with the standard wording. */
  closedMessage: RichDoc | undefined;
}

/** Whether a document has text of its own: a closed message nobody wrote is an empty paragraph. */
const hasText = (doc: RichDoc): boolean => doc.content.some((node) => node.type !== 'paragraph' || (node.content?.length ?? 0) > 0);

/**
 * What a stored form's `ops` hold that now belongs on the server, or null when there is nothing to move (no password and
 * not closed). The closed message counts only for a closed form: an open form's was never shown.
 */
export function legacyAccessOf(ops: unknown): LegacyAccess | null {
  if (typeof ops !== 'object' || ops === null) return null;
  const parsed = LegacyOpsSchema.safeParse(ops);
  if (!parsed.success) return null;
  const { open, closedMessage, password } = parsed.data;
  if (open && password === '') return null;
  return { password, closed: !open, closedMessage: !open && closedMessage && hasText(closedMessage) ? closedMessage : undefined };
}
