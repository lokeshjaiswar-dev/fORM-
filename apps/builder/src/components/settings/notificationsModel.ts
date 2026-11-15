import { defineMessages } from '@form/i18n';
import {
  canonicalJson,
  type BlockId,
  type EmailBodyNode,
  type EmailDoc,
  type FormDefinition,
  type PipeAttrs,
  type PlainTemplate,
  type PurposeId,
  type Recipient,
  type RichDoc,
  type StoredBlock,
  type UserId,
} from '@form/schema';
import { t } from '@/i18n';
import { blockOrder, blockText, isField } from '@/lib/definition';
import type { NotificationForm } from '@/persistence/notificationsApi';

/*
 * What the Emails tab knows about a notification and the form it belongs to, as pure functions: which purposes and fields
 * the form's draft offers, how a subject (a `PlainTemplate`) and a body (an `EmailDoc`) are edited, and the notification a
 * new email starts as. The panel and the editor only show these and write them back.
 */

const M = defineMessages('builder', {
  'notifications.default_name_owner': 'New response',
  'notifications.default_name_autoresponder': 'Thank you',
  'notifications.default_subject_owner': 'New response',
  'notifications.default_subject_autoresponder': 'Thanks for your response',
  'notifications.default_body_owner': 'Someone has submitted the form. Their answers are below.',
  'notifications.default_body_autoresponder': 'Thank you. We have received your response.',
});

/** A purpose the form declares: the only thing an email's `purposeIds` may name. */
export interface PurposeRef {
  id: string;
  name: string;
}

/** A value block of the form (one that holds an answer), as an email can refer to it. */
export interface FieldRef {
  id: string;
  /** What the author called it, else its key. */
  label: string;
  type: string;
}

/** What the form's saved draft offers an email: the purposes it declares and the fields that hold answers. */
export interface DraftFacts {
  purposes: PurposeRef[];
  fields: FieldRef[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The purposes and value blocks of a draft as the server holds it (`GET /v1/forms/:id/draft`), which is what a save is checked
 * against. The draft is read as data, never trusted as typed: a draft that is not the shape expected offers nothing. Layout
 * blocks (paragraphs, headings, section breaks, images) hold no answer and are left out, so an email cannot pipe one.
 */
export function factsOf(draft: Record<string, unknown> | null): DraftFacts {
  if (!draft) return { purposes: [], fields: [] };
  const privacy = isRecord(draft.privacy) ? draft.privacy : {};
  const purposes = Array.isArray(privacy.purposes)
    ? privacy.purposes.flatMap((p): PurposeRef[] => (isRecord(p) && typeof p.id === 'string' ? [{ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id }] : []))
    : [];
  const fields: FieldRef[] = [];
  if (isRecord(draft.blocks) && Array.isArray(draft.pages)) {
    const blocks = draft.blocks as Partial<Record<string, StoredBlock>>;
    let order: string[];
    try {
      order = blockOrder(draft as unknown as Pick<FormDefinition, 'blocks' | 'pages'>);
    } catch {
      order = Object.keys(blocks);
    }
    const seen = new Set<string>();
    for (const id of order) {
      const block = blocks[id];
      if (seen.has(id) || !isField(block)) continue;
      seen.add(id);
      fields.push({ id, label: blockText(block) || block.key || id, type: block.type });
    }
  }
  return { purposes, fields };
}

/** The fields an autoresponder can write to: the form's email fields. */
export const emailFields = (facts: DraftFacts): FieldRef[] => facts.fields.filter((f) => f.type === 'email');

// ---------------------------------------------------------------------------------------------------------------
// The subject: text and pipes, edited as alternating text and field chips
// ---------------------------------------------------------------------------------------------------------------

/** A part of a subject that is not text: an answer piped in (or a template variable, kept as it is). */
export type SubjectChip = Exclude<PlainTemplate[number], string>;

/**
 * A subject as the editor shows it: text at every even index (possibly empty) and a chip at every odd one, so the text
 * before, between and after the chips is always there to type into.
 */
export type Segments = Array<string | SubjectChip>;

/** The segments of a subject: adjacent text is joined and an empty piece of text is put between chips and at both ends. */
export function toSegments(parts: PlainTemplate): Segments {
  const out: Segments = [''];
  for (const part of parts) {
    if (typeof part === 'string') out[out.length - 1] = (out[out.length - 1] as string) + part;
    else out.push(part, '');
  }
  return out;
}

/** The subject the segments make: the empty pieces of text are dropped. */
export function fromSegments(segments: Segments): PlainTemplate {
  return segments.filter((s) => s !== '');
}

/** A caret in a subject: which text piece (an even index) and where in it. */
export interface Caret {
  index: number;
  offset: number;
}

/** The chip that pipes the answer of `blockId` into a subject. The fallback is left to the server's default (nothing). */
export const answerPipe = (blockId: string): SubjectChip => ({ pipe: { source: { kind: 'answer', blockId: blockId as BlockId } } satisfies PipeAttrs });

/** `chip` inserted at the caret (or at the end when the caret is not known). */
export function insertChip(segments: Segments, caret: Caret | null, chip: SubjectChip): Segments {
  const known = caret !== null && caret.index % 2 === 0 && caret.index < segments.length;
  const index = known ? caret.index : segments.length - 1;
  const text = segments[index] as string;
  const offset = known ? Math.min(Math.max(caret.offset, 0), text.length) : text.length;
  return [...segments.slice(0, index), text.slice(0, offset), chip, text.slice(offset), ...segments.slice(index + 1)];
}

/** The segments without the chip at `index` (an odd index); the text on both sides of it is joined. */
export function removeChip(segments: Segments, index: number): Segments {
  if (index % 2 === 0 || index >= segments.length) return segments;
  return [...segments.slice(0, index - 1), (segments[index - 1] as string) + (segments[index + 1] as string), ...segments.slice(index + 2)];
}

/** The text piece at `index` replaced. */
export function setText(segments: Segments, index: number, text: string): Segments {
  return segments.map((s, i) => (i === index ? text : s));
}

// ---------------------------------------------------------------------------------------------------------------
// The body: rich text, and the email-only nodes that sit beside it
// ---------------------------------------------------------------------------------------------------------------

type RichNode = RichDoc['content'][number];
const EMAIL_ONLY: ReadonlySet<string> = new Set<EmailBodyNode['type']>(['answersTable', 'button', 'brandBlock']);
const isEmailOnly = (node: EmailBodyNode): boolean => EMAIL_ONLY.has(node.type);

/** The rich text of a body: what the rich-text editor edits. The answers table, buttons and brand blocks are not part of it. */
export function richOf(body: EmailDoc): RichDoc {
  return { type: 'doc', content: body.content.filter((n): n is RichNode => !isEmailOnly(n)) };
}

/**
 * The body with its rich text replaced by `rich`. The email-only nodes stay: those that came before the first piece of rich
 * text (a header) stay before it, and the others (the answers table, a footer) come after all of it, in their order.
 */
export function withRich(body: EmailDoc, rich: RichDoc): EmailDoc {
  const firstRich = body.content.findIndex((n) => !isEmailOnly(n));
  const leading = firstRich < 0 ? body.content : body.content.slice(0, firstRich);
  const trailing = firstRich < 0 ? [] : body.content.slice(firstRich).filter(isEmailOnly);
  return { type: 'email_doc', content: [...leading, ...rich.content, ...trailing] };
}

/** Whether the body lists the answers. */
export const hasAnswersTable = (body: EmailDoc): boolean => body.content.some((n) => n.type === 'answersTable');

/** The table of all the answers that are in the email's purposes; empty answers are left out and sensitive ones masked. */
const ANSWERS_TABLE: EmailBodyNode = { type: 'answersTable', attrs: { include: 'all', hideEmpty: true, maskSensitive: true } };

/** The body with the answers table at its end, or without any. Turning it on twice adds one. */
export function withAnswersTable(body: EmailDoc, on: boolean): EmailDoc {
  if (on) return hasAnswersTable(body) ? body : { type: 'email_doc', content: [...body.content, ANSWERS_TABLE] };
  return { type: 'email_doc', content: body.content.filter((n) => n.type !== 'answersTable') };
}

// ---------------------------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------------------------

export const ROLE_RECIPIENTS = ['form_owner', 'org_admins'] as const;
export type RoleRecipient = (typeof ROLE_RECIPIENTS)[number];

/** The same person or address has the same key, so a list never holds one twice. */
export function recipientKey(r: Recipient): string {
  switch (r.kind) {
    case 'email':
      return `email:${r.address.toLowerCase()}`;
    case 'field':
      return `field:${r.blockId}`;
    case 'member':
      return `member:${r.userId}`;
    default:
      return `role:${r.role}`;
  }
}

/** `r` added to `list`, unless it is there already. */
export const addRecipient = (list: readonly Recipient[], r: Recipient): Recipient[] => (list.some((x) => recipientKey(x) === recipientKey(r)) ? [...list] : [...list, r]);

export const memberRecipient = (userId: string): Recipient => ({ kind: 'member', userId: userId as UserId });
export const fieldRecipient = (blockId: string): Recipient => ({ kind: 'field', blockId: blockId as BlockId });

// ---------------------------------------------------------------------------------------------------------------
// A new email, and whether an edited one differs from the saved one
// ---------------------------------------------------------------------------------------------------------------

const paragraph = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * A notification as a new email starts. Nothing is sent from it until it is saved with a purpose (there is none chosen for
 * the author: which answers leave the form is a decision), and the answers table is on for the team's email and off for the
 * respondent's thank-you.
 */
export function blankNotification(kind: NotificationForm['kind'], facts: DraftFacts): NotificationForm {
  const owner = kind === 'owner';
  const body: EmailDoc = { type: 'email_doc', content: [paragraph(t(owner ? M['notifications.default_body_owner'] : M['notifications.default_body_autoresponder']))] };
  const first = emailFields(facts)[0];
  return {
    name: t(owner ? M['notifications.default_name_owner'] : M['notifications.default_name_autoresponder']),
    kind,
    enabled: true,
    trigger: 'submitted',
    to: owner ? [{ kind: 'role', role: 'form_owner' }] : first ? [fieldRecipient(first.id)] : [],
    purposeIds: [],
    subject: [t(owner ? M['notifications.default_subject_owner'] : M['notifications.default_subject_autoresponder'])],
    body: owner ? withAnswersTable(body, true) : body,
    locale: 'respondent',
    includeWithdrawalLink: false,
  };
}

/** The recipients a notification of `kind` starts with when its kind changes: the old ones may not make sense for the new kind. */
export function recipientsFor(kind: NotificationForm['kind'], facts: DraftFacts): Recipient[] {
  return blankNotification(kind, facts).to;
}

/** A notification without the server's id (the editor holds that apart), as it would be saved. */
export function formOf(config: NotificationForm & { id?: unknown }): NotificationForm {
  const { id: _id, ...rest } = config;
  return rest;
}

/** Whether two notifications are not the same one: the same comparison the server makes (`canonicalJson`: key order does not count). */
export const differs = (a: NotificationForm, b: NotificationForm): boolean => canonicalJson(a) !== canonicalJson(b);

/** The purpose ids among `purposeIds` that the form does not declare: what a save would be refused for (422 `MISSING_PURPOSE`). */
export function undeclared(purposeIds: readonly PurposeId[], facts: DraftFacts): string[] {
  const known = new Set(facts.purposes.map((p) => p.id));
  return purposeIds.filter((id) => !known.has(id));
}
