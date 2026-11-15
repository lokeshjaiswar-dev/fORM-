import type { Answers, BlockId, PublicFormDefinition } from '@form/schema';

/** Block types whose value the form makes itself: a respondent's word for them is never taken, so there is nothing to carry. */
const SERVER_OWNED: ReadonlySet<string> = new Set(['hidden', 'calculation', 'context', 'unique_id']);

/** The stable name of a field (`FieldKey`), or undefined for a block that holds no answer (text, image, divider). */
const keyOf = (block: { key?: unknown } | undefined): string | undefined => (typeof block?.key === 'string' ? block.key : undefined);

/**
 * The answers of a form that was republished while someone filled it in, for the new version: each answer goes to the
 * field of the new version that has the same `FieldKey` (the machine name, FND-07), because block ids are the draft's
 * and an author may have rebuilt a field under a new one. An answer stays only when the new field is the same type: a
 * date typed into what is now a number would be an answer to another question. Fields the new version does not have,
 * and ones the server makes (hidden, calculation, context, unique id), are dropped; the new page asks for them again.
 */
export function carryAnswers(from: PublicFormDefinition, to: PublicFormDefinition, answers: Answers): Answers {
  const idByKey = new Map<string, BlockId>();
  for (const block of Object.values(to.blocks)) {
    const key = keyOf(block as { key?: unknown });
    if (key !== undefined && block && !SERVER_OWNED.has(block.type)) idByKey.set(key, block.id);
  }
  const carried: Answers = {};
  for (const [blockId, answer] of Object.entries(answers) as Array<[BlockId, Answers[BlockId]]>) {
    const old = from.blocks[blockId];
    const key = keyOf(old as { key?: unknown } | undefined);
    if (!old || key === undefined || answer === undefined) continue;
    const targetId = idByKey.get(key);
    const target = targetId === undefined ? undefined : to.blocks[targetId];
    if (!target || targetId === undefined || target.type !== old.type || answer.type !== target.type) continue;
    carried[targetId] = answer;
  }
  return carried;
}
