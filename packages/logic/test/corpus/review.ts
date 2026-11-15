import type * as S from '@form/schema';
import { applicableUnits, evaluate, reviewUnitAnswersHash, visibleBlocksForReviewer } from '../../src/index.ts';
import { META, a, ans, bid, choices, cond, field, form, heading, hide, id, opts, page, pid, rule, text, versionOf } from '../build.ts';
import { rng } from './generate.ts';

/*
 * Review units (WP-2.33) in the determinism corpus: one form with a section_break unit that crosses a page, one that
 * ends at the next break, and a page unit; the applicability, unit answer hashes (sha256 of RFC 8785 JSON) and
 * `own_unit` redaction of seeded answer sets must be byte-identical in every browser engine and in Node.
 */

export const sectionBreak = (blockId: string, name = blockId): S.PlainBlockOf<'section_break'> => ({
  id: bid(blockId),
  type: 'section_break',
  config: { name, showInNav: true, showHeading: false },
});

export const sectionOf = (blockId: string, children: string[]): S.PlainBlockOf<'section'> => ({
  id: bid(blockId),
  type: 'section',
  config: { children: children.map(bid), collapsible: false },
});

export const reviewUnit = (unitId: string, target: S.ReviewUnitTarget, name: S.LabelText = unitId): S.ReviewUnit => ({ id: id<S.ReviewUnitId>(unitId), name, target });
export const pageTarget = (pageId: string): S.ReviewUnitTarget => ({ kind: 'page', pageId: pid(pageId) });
export const breakTarget = (blockId: string): S.ReviewUnitTarget => ({ kind: 'section_break', blockId: bid(blockId) });

export const assign = (unitId: string, groupId: string, order: number, visibility: S.ReviewVisibility = 'own_unit', required = true): S.ReviewUnitAssignment => ({
  unitId: id<S.ReviewUnitId>(unitId), groupId: id<S.ReviewGroupId>(groupId), order, required, visibility,
});
export const groups = (...ids: string[]): S.ReviewGroupId[] => ids.map((g) => id<S.ReviewGroupId>(g));

/**
 * Three pages, three units, one block outside them all:
 *   p1  intro | brk_a | applicant, has_bank          p2  address | brk_b | contact{ email, phone }          p3  brk_c | bank, ifsc
 *   u_applicant = brk_a …, up to brk_b (crosses p1 → p2)   u_contact = brk_b …, up to brk_c   u_bank = page p3
 * `skip` as the applicant's name hides page 2 (u_contact is not applicable); `has_bank` = no hides page 3 (u_bank is not).
 */
export function reviewForm(): S.FormDefinition {
  return form([
    heading('intro'),
    sectionBreak('brk_a', 'Applicant'),
    field('short_text', 'applicant'),
    field('single_choice', 'has_bank', { config: { display: 'radio', options: choices('yes', 'no') } }),
    field('long_text', 'address'),
    sectionBreak('brk_b', 'Contact'),
    sectionOf('contact', ['email', 'phone']),
    field('email', 'email'),
    field('phone', 'phone'),
    sectionBreak('brk_c', 'Bank'),
    field('short_text', 'bank'),
    field('short_text', 'ifsc'),
  ], [
    page('p1', ['intro', 'brk_a', 'applicant', 'has_bank']),
    page('p2', ['address', 'brk_b', 'contact']),
    page('p3', ['brk_c', 'bank', 'ifsc']),
  ], [
    rule('skip_contact', cond(ans('applicant'), 'eq', text('skip')), [hide('p2')]),
    rule('no_bank', cond(ans('has_bank'), 'eq', opts('has_bank', 'no')), [hide('p3')]),
  ], {
    review: {
      units: [
        reviewUnit('u_applicant', breakTarget('brk_a'), 'Applicant details'),
        reviewUnit('u_contact', breakTarget('brk_b'), 'Contact details'),
        reviewUnit('u_bank', pageTarget('p3'), 'Bank details'),
      ],
    },
  });
}

export const REVIEW_ASSIGNMENTS: S.ReviewUnitAssignment[] = [
  assign('u_applicant', 'g_applicant', 1, 'own_unit'),
  assign('u_contact', 'g_contact', 1, 'whole_submission'),
  assign('u_bank', 'g_bank', 2, 'own_unit'),
];

/** Who is looking, for the redaction part of each case. */
const CALLERS: string[][] = [[], ['g_applicant'], ['g_contact'], ['g_bank'], ['g_applicant', 'g_contact'], ['g_contact', 'g_bank'], ['g_unknown']];

function answerSets(): S.Answers[] {
  const r = rng(2_033);
  return Array.from({ length: 40 }, () => {
    const out: Record<string, S.AnswerValue> = {};
    if (r.chance(0.8)) out['applicant'] = a.text(r.pick(['Asha', 'skip', 'Ravi Kumar', 'ऋतु', 'Zoë']));
    if (r.chance(0.8)) out['has_bank'] = a.single(r.pick(['yes', 'no']));
    if (r.chance(0.6)) out['address'] = a.long(r.pick(['12 Park Road', 'Flat 4B, Salt Lake', 'पुणे']));
    if (r.chance(0.5)) out['email'] = a.email(r.pick(['a@example.com', 'ravi@example.org']));
    if (r.chance(0.5)) out['phone'] = { type: 'phone', value: { e164: r.pick(['+919876543210', '+911234567890']), country: id<S.CountryCode>('IN') } };
    if (r.chance(0.5)) out['bank'] = a.text(r.pick(['HDFC', 'SBI', 'Kotak']));
    if (r.chance(0.3)) out['ifsc'] = a.text(r.pick(['HDFC0001234', 'SBIN0000001']));
    return out as S.Answers;
  });
}

/** The corpus entries: for each answer set, which units apply, each unit's answers hash, and what each caller may see. */
export function reviewCases(): Array<{ name: string; json: string }> {
  const def = reviewForm();
  const version = versionOf(def);
  const unitIds = Object.keys(version.compiled.reviewUnits ?? {}).sort();
  return answerSets().map((answers, n) => {
    const state = evaluate(version, answers, META, n % 2 ? 'server' : 'client');
    const json = JSON.stringify({
      reviewUnits: version.compiled.reviewUnits,
      applicable: applicableUnits(version.compiled, state),
      hashes: Object.fromEntries(unitIds.map((u) => [u, reviewUnitAnswersHash(version.compiled, u as S.ReviewUnitId, state.values)])),
      seen: CALLERS.map((g) => {
        const set = visibleBlocksForReviewer(version.compiled, { units: REVIEW_ASSIGNMENTS }, groups(...g));
        return set === null ? null : [...set];
      }),
    });
    return { name: `review#${n}`, json };
  });
}
