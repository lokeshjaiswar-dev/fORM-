import type { StoredBlock } from '@form/schema';
import type { DmsElement } from './types.ts';

/*
 * v2 contract stub (DESIGN-v2 section 3, contract/openform-to-dms-v1.fixtures.json `legacyMarker`).
 *
 * The one-time OpenForm -> classic conversion (dms-api `formplus:migrate-openform`) maps every OpenForm block onto one
 * of the seven dms-v1 types. Blocks with no lossless target keep their column and values and carry
 * `legacy: { from, readOnly: true }` on the element. The key is not modelled by fORM-, so it rides in `x-dms` and
 * round-trips unchanged. Rules:
 *   - builder: type, options and the marker are locked; rename, reorder and delete stay allowed;
 *   - guard: a readOnly legacy block that is required or primary is an error (`LEGACY_READ_ONLY_REQUIRED`,
 *     `LEGACY_READ_ONLY_PRIMARY`);
 *   - record mode: rendered read-only with the raw stored string, never sent on create or update.
 * Bodies are filled by lane `form-core`; lane `form-record` only calls these.
 */

export const LEGACY_KEY = 'legacy';

export interface DmsLegacyMarker {
  /** The OpenForm block type the field came from (`files`, `rich_text`, `multi_select`, ...). */
  from: string;
  readOnly: true;
}

/** The legacy marker of a DMS element, or `null` when it has none or it is malformed. */
export function legacyOfElement(element: DmsElement): DmsLegacyMarker | null {
  void element;
  throw new Error('dms-v1 legacyOfElement: not implemented (lane form-core)');
}

/** The legacy marker a block carries in `x-dms`, or `null`. */
export function legacyOfBlock(block: StoredBlock): DmsLegacyMarker | null {
  void block;
  throw new Error('dms-v1 legacyOfBlock: not implemented (lane form-core)');
}

/** True when the block must render read-only and must never be written (record mode, upload step 2). */
export function isLegacyReadOnly(block: StoredBlock): boolean {
  void block;
  throw new Error('dms-v1 isLegacyReadOnly: not implemented (lane form-core)');
}
