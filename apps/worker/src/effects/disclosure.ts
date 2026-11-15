import { randomUUID } from 'node:crypto';
import { disclosures, type DisclosureRecipientKind, type Tx } from '@form/db';
import { headerOf, valueDefinition } from '@form/registry';
import type { BlockId, CompiledForm, DataClassification, FieldBlock, FormDefinition, StoredBlock, ValueFieldType } from '@form/schema';

/*
 * The one place that decides which answers may leave the system (WP-1.16 NOT-02/03, WP-1.17 EXP-01, WP-1.18 INT-01;
 * DPDP s.8(2), s.11(1)(b); CONTRIBUTING §5 rule 6). Notifications, webhooks and exports never read a stored answer
 * themselves: they ask `disclosableFields` for the answers of one response and render what comes back, so a field that
 * is out of purpose, omitted or masked cannot reach an email, a request body or a file by a path that forgot to check.
 */

/** What a protected value shows as: never a prefix, never its length. The same text the API's grid and detail show. */
export const MASK = '••••••';

/** Where the answers go. A webhook is an outside recipient like a notification, so it follows `inNotifications`. */
export type DisclosureChannel = 'notification' | 'webhook' | 'export';

type Level = 'include' | 'mask' | 'omit';

/** Stricter is bigger: a level can be raised by an override or by taint, never lowered by one. */
const RANK: Record<Level, number> = { include: 0, mask: 1, omit: 2 };
const stricter = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

const CLASS_RANK: Record<DataClassification, number> = { none: 0, personal: 1, sensitive: 2 };

export interface DisclosableFieldsInput {
  definition: FormDefinition;
  /** Only `taint` is read: the effective classification and purposes of derived values (I13). */
  compiled: Pick<CompiledForm, 'taint'>;
  /** The stored answers by block id (`submissions.answers`). A sealed answer (no readable `value`) is masked. */
  answers: Readonly<Record<string, unknown>>;
  /** The purposes this recipient is declared for (`notifications.purpose_ids`, `webhooks.purpose_ids`, or every purpose of the form for an export). */
  purposeIds: readonly string[];
  channel: DisclosureChannel;
  /** A webhook's `fieldKeys` when it is a list: narrows the result further, by field key. Never widens it. */
  fieldKeys?: readonly string[] | undefined;
  /** A notification's `sensitiveOverride`: only stricter than the fields' own `inNotifications`. */
  sensitiveOverride?: 'mask' | 'omit' | undefined;
  /** Export channel only (ignored elsewhere): shows the fields that would be masked. It never shows an omitted one. */
  includeSensitive?: boolean | undefined;
}

/** One answer that may be disclosed, or one that is shown as `MASK`. Answers that are not allowed at all are not in the list. */
export interface DisclosableField {
  blockId: BlockId;
  /** The field key (`FieldBlock.key`), the name a webhook payload and a merge tag use. */
  key: string;
  /** The field's label as plain text (its key when the label is blank). */
  label: string;
  type: ValueFieldType;
  /** The answer as one readable line (the registry's `export.text`), `MASK` when masked, '' when the field was not answered. */
  text: string;
  /** One cell per export column of the field (`export.cells`); `MASK` in each when masked, '' each when not answered. */
  cells: string[];
  /** The value is withheld: `text` and every cell are `MASK`. */
  masked: boolean;
  /** The field was answered. A masked field counts as answered; an unanswered one is listed so a table can show it blank. */
  answered: boolean;
  /** The stored value, only for an answered field that is not masked (a webhook sends it typed). */
  value?: unknown;
}

const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** The field blocks of a definition in document order: the pages, then each container's children depth-first. */
function fieldBlocksOf(definition: FormDefinition): FieldBlock[] {
  const out: FieldBlock[] = [];
  const seen = new Set<BlockId>();
  const visit = (id: BlockId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const block = definition.blocks[id];
    if (isField(block)) out.push(block);
    childrenOf(block).forEach(visit);
  };
  for (const page of definition.pages) page.children.forEach(visit);
  return out;
}

/** The verdict on one block, before its answer is looked at. `absent` means not in the result at all. */
type Verdict = { kind: 'absent' } | { kind: 'show' } | { kind: 'mask' };

function verdictOf(block: FieldBlock, input: DisclosableFieldsInput, seen: Set<BlockId> = new Set()): Verdict {
  const { definition, compiled, channel } = input;
  const taint = compiled.taint[`value:${block.id}`];
  const own = block.compliance;

  // 1. Purpose (DPDP s.5, s.6): a field that is personal, sensitive, tied to a purpose, or derived from such a field only
  //    goes to a recipient declared for one of its purposes. Only a field that is non-personal and tied to no purpose (and
  //    taints from none) is free of the check, so a form with no privacy configuration still sends its plain answers.
  const classification: DataClassification = taint && CLASS_RANK[taint.classification] > CLASS_RANK[own.classification] ? taint.classification : own.classification;
  const fieldPurposes = new Set<string>([...own.purposeIds, ...(taint?.purposeIds ?? [])]);
  if ((classification !== 'none' || fieldPurposes.size > 0) && !input.purposeIds.some((p) => fieldPurposes.has(p))) return { kind: 'absent' };

  // 2. The field's own setting for this channel, raised by taint: a value derived from a sensitive field is masked even
  //    when its own setting says include (I13).
  const taintedSensitive = taint?.classification === 'sensitive';
  let level: Level = channel === 'export' ? own.inExports : own.inNotifications;
  if (taintedSensitive) level = stricter(level, 'mask');
  const sensitive = own.classification === 'sensitive' || taintedSensitive || level !== 'include';

  // 3. An audited opt-in of an export shows what would be masked. It cannot show what is omitted.
  if (channel === 'export' && input.includeSensitive === true && level === 'mask') level = 'include';

  // 4. A notification's override applies to the sensitive fields and only ever makes the level stricter.
  if (input.sensitiveOverride !== undefined && sensitive) level = stricter(level, input.sensitiveOverride);

  if (level === 'omit') return { kind: 'absent' };
  let verdict: Verdict = level === 'mask' ? { kind: 'mask' } : { kind: 'show' };

  // 5. A repeating group's text is the text of its rows' values, so it is as strict as its strictest child: a group with a
  //    child that would be omitted, masked or out of purpose is masked as a whole, never shown in part.
  if (block.type === 'repeating_group' && verdict.kind === 'show' && !seen.has(block.id)) {
    seen.add(block.id);
    for (const childId of block.config.children) {
      const child = definition.blocks[childId];
      if (!isField(child)) continue;
      if (verdictOf(child, input, seen).kind !== 'show') {
        verdict = { kind: 'mask' };
        break;
      }
    }
  }
  return verdict;
}

type Stored = { type?: unknown; value?: unknown } | null | undefined;

const blanks = (n: number): string[] => Array.from({ length: n }, () => '');

/** Column count of a field's export, which a masked or blank row repeats so a row always lines up with its columns. */
function columnCount(block: FieldBlock): number {
  try {
    const columns = (valueDefinition(block.type).export.columns as (b: unknown) => unknown[])(block);
    return Math.max(1, columns.length);
  } catch {
    return 1;
  }
}

/** The text and cells the registry makes of a stored value; a value it cannot read (a corrupt answer) reads as blank. */
function readValue(block: FieldBlock, value: unknown): { text: string; cells: string[] } {
  try {
    const def = valueDefinition(block.type);
    const text = (def.export.text as (v: unknown, b: unknown) => string)(value, block);
    const cells = (def.export.cells as (v: unknown, b: unknown) => string[])(value, block);
    return { text: typeof text === 'string' ? text.trim() : '', cells: Array.isArray(cells) ? cells.map((c) => (typeof c === 'string' ? c : '')) : [] };
  } catch {
    return { text: '', cells: blanks(columnCount(block)) };
  }
}

function isBlankValue(block: FieldBlock, value: unknown): boolean {
  try {
    return (valueDefinition(block.type).isEmpty as (v: unknown) => boolean)(value);
  } catch {
    return true;
  }
}

/**
 * The answers of one response that a recipient may receive, in document order, each as readable text or `MASK`.
 *
 * What decides, in order:
 *  - Purpose: a personal or sensitive field (by its own classification or by taint) appears only when one of its purposes is
 *    in `purposeIds`; a field of classification `none` with no purposes counts as non-personal and always passes.
 *  - The field's own `inNotifications` (notification and webhook channels) or `inExports` (export): `omit` leaves the field
 *    out, `mask` shows `MASK`.
 *  - Taint (`compiled.taint`): a value derived from a sensitive field is `MASK` whatever its own setting says.
 *  - `sensitiveOverride` (notifications): for sensitive and masked fields, only stricter than the above.
 *  - `includeSensitive` (export channel only): shows the fields that would be `MASK`; never an omitted one.
 *  - `fieldKeys`: when given, only those keys.
 * A sealed answer (stored encrypted, WP-1.11) cannot be read here and is `MASK` even for `includeSensitive`.
 *
 * Consent is not checked here: Core drops the answers of a purpose whose consent was not given before they are stored
 * (WP-1.21 adds the consent record). Rows are for answered fields and for allowed fields left blank (`answered: false`).
 */
export function disclosableFields(input: DisclosableFieldsInput): DisclosableField[] {
  const only = input.fieldKeys === undefined ? undefined : new Set(input.fieldKeys);
  const out: DisclosableField[] = [];
  for (const block of fieldBlocksOf(input.definition)) {
    if (only && !only.has(block.key)) continue;
    const verdict = verdictOf(block, input);
    if (verdict.kind === 'absent') continue;
    const base = { blockId: block.id, key: block.key, label: headerOf(block as never), type: block.type };
    const stored = input.answers[block.id] as Stored;
    const columns = columnCount(block);

    if (stored === undefined || stored === null) {
      out.push({ ...base, text: '', cells: blanks(columns), masked: false, answered: false });
      continue;
    }
    // A sealed answer, or one whose type tag is not the field's, is not something this process can read: it never leaves.
    const readable = stored.type === block.type && 'value' in stored && stored.value !== undefined;
    if (readable && isBlankValue(block, stored.value)) {
      // Blank carries nothing to withhold: it is the same as no answer.
      out.push({ ...base, text: '', cells: blanks(columns), masked: false, answered: false });
      continue;
    }
    if (!readable || verdict.kind === 'mask') {
      out.push({ ...base, text: MASK, cells: Array.from({ length: columns }, () => MASK), masked: true, answered: true });
      continue;
    }
    const { text, cells } = readValue(block, stored.value);
    out.push({ ...base, text, cells, masked: false, answered: true, value: stored.value });
  }
  return out;
}

/** Every purpose id of the form: what an export (asked for by a member with `submissions.export`) passes as `purposeIds`. */
export const formPurposeIds = (definition: FormDefinition): string[] => definition.privacy.purposes.map((p) => p.id);

/**
 * The keys a disclosure row names: the fields whose value was sent. A masked field is left out (its value did not leave),
 * and so is a field that was not answered (nothing was sent for it). Pass `includeMasked` to name the masked ones too.
 */
export function disclosedFieldKeys(fields: readonly DisclosableField[], o: { includeMasked?: boolean } = {}): string[] {
  return fields.filter((f) => f.answered && (o.includeMasked === true || !f.masked)).map((f) => f.key);
}

export interface DisclosureRecord {
  orgId: string;
  submissionId: string;
  submissionReceivedAt: Date;
  recipient: { kind: DisclosureRecipientKind; id: string };
  /** What a person reads in the ledger: a masked address, a webhook host, "CSV export". Never a secret, never an answer. */
  displayName: string;
  /** Field keys, never values. */
  fieldKeys: readonly string[];
}

const MAX_DISPLAY_NAME = 320;

/**
 * Appends one row to the disclosures ledger (DPDP s.11(1)(b)): who received which fields of which response. Call it in the
 * transaction that sends or builds (the notification dispatch, the webhook delivery, each export batch), so there is no send
 * without a row. The table is append-only for `fr_app` and the row goes with its response; RLS holds `orgId` to the
 * transaction's org. Returns the new row's id.
 */
export async function recordDisclosure(tx: Tx, record: DisclosureRecord): Promise<string> {
  const displayName = record.displayName.trim().slice(0, MAX_DISPLAY_NAME);
  if (displayName === '') throw new TypeError('recordDisclosure: a disclosure needs a display name');
  const id = randomUUID();
  await tx.insert(disclosures).values({
    id,
    orgId: record.orgId,
    submissionId: record.submissionId,
    submissionReceivedAt: record.submissionReceivedAt,
    recipientKind: record.recipient.kind,
    recipientId: record.recipient.id,
    displayName,
    fieldKeys: [...new Set(record.fieldKeys)],
  });
  return id;
}
