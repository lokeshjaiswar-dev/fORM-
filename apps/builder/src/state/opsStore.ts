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

/** One key the destination API expects. `path` may be nested (`customer.name`, `items.0.sku`). */
export interface SubmissionApiKey {
  path: string;
  /** Form field key that fills this path. Empty until the author picks one. */
  fieldKey: string;
  /** `column:Item`, `summary:Total`, `name:first`, or empty for the whole field. */
  part: string;
  required: boolean;
}

export interface SubmissionApi {
  enabled: boolean;
  url: string;
  format: 'json' | 'xml';
  keys: SubmissionApiKey[];
}

export interface LocalOps {
  /** `FormOps.access.enabled`: false shows the closed screen. */
  open: boolean;
  closedMessage: RichDoc;
  /** Empty: no password. */
  password: string;
  /** Where answers are forwarded after a successful submit. */
  submissionApi: SubmissionApi;
}

const SubmissionApiSchema = z.strictObject({
  enabled: z.boolean(),
  url: z.string().max(2000),
  format: z.enum(['json', 'xml']),
  keys: z.array(z.strictObject({
    path: z.string().max(200),
    fieldKey: z.string().max(64),
    part: z.string().max(80).default(''),
    required: z.boolean(),
  })).max(100),
});

export const defaultSubmissionApi = (): SubmissionApi => ({ enabled: false, url: '', format: 'json', keys: [] });

export const LocalOpsSchema = z.strictObject({
  open: z.boolean(),
  closedMessage: RichDocSchema,
  password: z.string().max(200),
  submissionApi: SubmissionApiSchema.default(defaultSubmissionApi),
});

export const defaultOps = (): LocalOps => ({ open: true, closedMessage: closedMessage(), password: '', submissionApi: defaultSubmissionApi() });

export const useOpsStore = create<LocalOps>()(() => defaultOps());

export const currentOps = (): LocalOps => useOpsStore.getState();

export function updateOps(patch: Partial<LocalOps>): void {
  useOpsStore.setState(patch);
}

export function loadOps(ops: LocalOps): void {
  useOpsStore.setState(ops, true);
}
