import { create } from 'zustand';
import { z } from 'zod';
import { RichDocSchema, type RichDoc } from '@form/schema';
import { closedMessage } from '@/lib/definition';

/*
 * The parts of FormOps (schema §14) the offline builder keeps: whether the form is open, its closed screen and its
 * password. FormOps are live settings, not part of the definition or of a version, so they live in their own store:
 * outside undo history, saved next to the draft. The API takes them over in WP-1.06 and hashes the password then
 * (S5); until that, the password stays in this browser and only the local preview compares it.
 */

export interface LocalOps {
  /** `FormOps.access.enabled`: false shows the closed screen. */
  open: boolean;
  closedMessage: RichDoc;
  /** Empty: no password. */
  password: string;
}

export const LocalOpsSchema = z.strictObject({
  open: z.boolean(),
  closedMessage: RichDocSchema,
  password: z.string().max(200),
});

export const defaultOps = (): LocalOps => ({ open: true, closedMessage: closedMessage(), password: '' });

export const useOpsStore = create<LocalOps>()(() => defaultOps());

export const currentOps = (): LocalOps => useOpsStore.getState();

export function updateOps(patch: Partial<LocalOps>): void {
  useOpsStore.setState(patch);
}

export function loadOps(ops: LocalOps): void {
  useOpsStore.setState(ops, true);
}
