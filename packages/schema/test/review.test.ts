import { describe, expect, it } from 'vitest';
import * as S from '../src/index.ts';
import { definition, id, ids } from './fixtures.ts';

/* WP-2.33 slice 1: review units in the definition, the server-stored settings, and the statuses they add. */

const unit = (unitId: string, target: S.ReviewUnit['target'], name: S.LabelText = unitId): S.ReviewUnit => ({ id: id<S.ReviewUnitId>(unitId), name, target });
const pageUnit = (unitId: string, pageId: S.PageId = ids.page1) => unit(unitId, { kind: 'page', pageId });
const withReview = (units: S.ReviewUnit[]): S.FormDefinition => ({ ...definition(), review: { units } });

const assignment = (extra: Partial<S.ReviewUnitAssignment> = {}): S.ReviewUnitAssignment => ({
  unitId: id<S.ReviewUnitId>('u1'),
  groupId: id<S.ReviewGroupId>('g1'),
  order: 1,
  required: true,
  visibility: 'own_unit',
  ...extra,
});

describe('FormDefinition.review', () => {
  it('still parses a definition without a review key, and does not add one', () => {
    const def = definition();
    expect('review' in def).toBe(false);
    const parsed = S.FormDefinitionSchema.parse(JSON.parse(JSON.stringify(def)));
    expect('review' in parsed).toBe(false);
  });

  it('parses page and section_break units and round-trips them byte for byte', () => {
    const def = withReview([pageUnit('u_page'), unit('u_break', { kind: 'section_break', blockId: ids.heading }, ['Part ', 'two'])]);
    const wire = JSON.parse(JSON.stringify(def)) as unknown;
    const parsed = S.FormDefinitionSchema.parse(wire);
    expect(parsed).toStrictEqual(wire);
    expect(S.canonicalJson(parsed)).toBe(S.canonicalJson(def));
  });

  it('accepts an empty unit list (a form can hold the key and no units)', () => {
    expect(S.FormDefinitionSchema.safeParse(withReview([])).success).toBe(true);
  });

  it('refuses a section container target until WP-2.09', () => {
    const target = { kind: 'section', blockId: ids.section };
    expect(S.ReviewUnitTargetSchema.safeParse(target).success).toBe(false);
    expect(S.FormDefinitionSchema.safeParse({ ...definition(), review: { units: [{ id: 'u1', name: 'Unit', target }] } }).success).toBe(false);
  });

  it('is strict: unknown keys on the review, a unit or a target are refused', () => {
    const base = { id: 'u1', name: 'Unit', target: { kind: 'page', pageId: 'page_1' } };
    expect(S.ReviewUnitSchema.safeParse(base).success).toBe(true);
    expect(S.ReviewUnitSchema.safeParse({ ...base, groupId: 'g1' }).success).toBe(false);
    expect(S.ReviewUnitSchema.safeParse({ ...base, target: { ...base.target, extra: 1 } }).success).toBe(false);
    expect(S.FormReviewDefinitionSchema.safeParse({ units: [base], enabled: true }).success).toBe(false);
    expect(S.ReviewUnitTargetSchema.safeParse({ kind: 'page', blockId: 'b' }).success).toBe(false);
    expect(S.ReviewUnitTargetSchema.safeParse({ kind: 'section_break', pageId: 'p' }).success).toBe(false);
  });

  it('refuses ids that name Object.prototype members and a unit list past the bound', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect(S.ReviewUnitIdSchema.safeParse(reserved).success).toBe(false);
      expect(S.ReviewGroupIdSchema.safeParse(reserved).success).toBe(false);
    }
    expect(S.ReviewUnitIdSchema.safeParse('unit-1_A').success).toBe(true);
    expect(S.ReviewUnitIdSchema.safeParse('has space').success).toBe(false);
    const units = (n: number) => Array.from({ length: n }, (_, i) => pageUnit(`u${i}`));
    expect(S.FormReviewDefinitionSchema.safeParse({ units: units(S.MAX_REVIEW_UNITS) }).success).toBe(true);
    expect(S.FormReviewDefinitionSchema.safeParse({ units: units(S.MAX_REVIEW_UNITS + 1) }).success).toBe(false);
  });

  it('keeps a unit name static: template variables may stay, answer pipes may not', () => {
    const pipe = { pipe: { source: { kind: 'answer', blockId: 'name_1' } } };
    const variable = { var: { name: 'org.legal_name' } };
    const named = (name: unknown) => S.ReviewUnitSchema.safeParse({ id: 'u1', name, target: { kind: 'page', pageId: 'page_1' } });
    expect(named('Applicant details').success).toBe(true);
    expect(named(['Details of ', 'the applicant']).success).toBe(true);
    expect(named(['Details of ', variable]).success).toBe(true);
    const refused = named(['Details of ', pipe]);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toMatch(/cannot pipe an answer/);
  });
});

describe('ReviewSettings (server-stored assignment, not part of the definition)', () => {
  const settings = (units: S.ReviewUnitAssignment[] = [assignment()]): S.ReviewSettings => ({ enabled: true, distinctCheckers: false, units });

  it('parses an assignment per unit and keeps the order', () => {
    const value = settings([assignment(), assignment({ unitId: id<S.ReviewUnitId>('u2'), groupId: id<S.ReviewGroupId>('g2'), order: 2, required: false, visibility: 'whole_submission' })]);
    expect(S.ReviewSettingsSchema.parse(JSON.parse(JSON.stringify(value)))).toStrictEqual(value);
  });

  it('needs an integer order of at least 1 and a known visibility', () => {
    const ok = (a: unknown) => S.ReviewSettingsSchema.safeParse({ enabled: true, distinctCheckers: true, units: [a] }).success;
    expect(ok(assignment({ order: 1 }))).toBe(true);
    expect(ok(assignment({ order: 7 }))).toBe(true);
    expect(ok(assignment({ order: 0 }))).toBe(false);
    expect(ok(assignment({ order: -1 }))).toBe(false);
    expect(ok(assignment({ order: 1.5 }))).toBe(false);
    expect(ok({ ...assignment(), visibility: 'everything' })).toBe(false);
    expect(ok({ ...assignment(), onReturn: 'respondent' })).toBe(false);
  });

  it('refuses the settings keys the first slice leaves out (no return flow, no notes)', () => {
    const base = { enabled: true, distinctCheckers: false, units: [] };
    expect(S.ReviewSettingsSchema.safeParse(base).success).toBe(true);
    expect(S.ReviewSettingsSchema.safeParse({ ...base, onReturn: 'maker' }).success).toBe(false);
    expect(S.ReviewSettingsSchema.safeParse({ ...base, units: Array.from({ length: S.MAX_REVIEW_UNITS + 1 }, () => assignment()) }).success).toBe(false);
  });
});

describe('reason codes', () => {
  it('are the fixed catalogue and nothing else', () => {
    expect([...S.REVIEW_REASON_CODES]).toEqual(['incomplete', 'incorrect', 'missing_document', 'duplicate', 'other']);
    for (const code of S.REVIEW_REASON_CODES) expect(S.ReviewReasonCodeSchema.safeParse(code).success).toBe(true);
    expect(S.ReviewReasonCodeSchema.safeParse('free text').success).toBe(false);
    expect([...S.REVIEW_VISIBILITIES]).toEqual(['own_unit', 'whole_submission']);
  });
});

describe('statuses and publish issues the review adds', () => {
  it('SubmissionStatus and SubmitResult.held know pending_review, and rejected is a status only', () => {
    expect(S.SubmissionStatusSchema.safeParse('pending_review').success).toBe(true);
    expect(S.SubmissionStatusSchema.safeParse('rejected').success).toBe(true);
    const held = (value: string) => S.SubmitResultSchema.safeParse({ ok: true, submissionId: 'sub_1', endingId: 'ending_1', held: value }).success;
    expect(held('pending_review')).toBe(true);
    expect(held('rejected')).toBe(false);
    expect(held('pending_scan')).toBe(true);
  });

  it.each(['review_unit_empty', 'review_unit_overlap', 'review_unit_contains_payment', 'review_unit_dangling_target'])('PublishIssue code %s', (code) => {
    expect(S.PUBLISH_ISSUE_CODES).toContain(code);
    expect(S.PublishIssueSchema.safeParse({ severity: 'error', code, path: '/review/units/0', message: 'x' }).success).toBe(true);
  });
});

describe('compiled and runtime shapes', () => {
  const compiled = (extra: Record<string, unknown> = {}) => ({
    engine: 'logic@2', requires: [], documentOrder: [], parentOf: {}, pageOf: {}, plan: [], reads: {}, dataInventory: [], taint: {},
    definitionHash: 'a'.repeat(64), ...extra,
  });

  it('CompiledForm.reviewUnits is optional, so versions published before WP-2.33 still parse', () => {
    expect(S.CompiledFormSchema.safeParse(compiled()).success).toBe(true);
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnits: { u1: ['name_1'] } })).success).toBe(true);
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnits: { u1: 'name_1' } })).success).toBe(false);
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnits: JSON.parse('{"__proto__":["a"]}') as unknown })).success).toBe(false);
  });

  it('CompiledForm.reviewUnitMarkers is optional and holds one block id per unit', () => {
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnits: { u1: ['brk_1', 'name_1'] }, reviewUnitMarkers: { u1: 'brk_1' } })).success).toBe(true);
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnitMarkers: { u1: ['brk_1'] } })).success).toBe(false);
    expect(S.CompiledFormSchema.safeParse(compiled({ reviewUnitMarkers: JSON.parse('{"__proto__":"a"}') as unknown })).success).toBe(false);
  });

  it('the runtime form version carries no reviewUnits, and its definition holds unit ids and names only', () => {
    const runtime = S.RuntimeFormVersionSchema.shape;
    const { dataInventory: _d, taint: _t, plan: _p, ...client } = compiled();
    expect(runtime.compiled.safeParse({ ...client, plan: [] }).success).toBe(true);
    expect(runtime.compiled.safeParse({ ...client, plan: [], reviewUnits: { u1: ['name_1'] } }).success).toBe(false);
    expect(runtime.compiled.safeParse({ ...client, plan: [], reviewUnitMarkers: { u1: 'brk_1' } }).success).toBe(false);

    const base = { ...definition(), review: { units: [{ id: 'u1', name: 'Unit' }] } };
    expect(S.PublicFormDefinitionSchema.safeParse(base).success).toBe(true);
    const target = { kind: 'page', pageId: 'page_1' };
    expect(S.PublicFormDefinitionSchema.safeParse({ ...base, review: { units: [{ id: 'u1', name: 'Unit', target }] } }).success).toBe(false);
    expect(S.PublicFormDefinitionSchema.safeParse({ ...base, review: { units: [{ id: 'u1', name: 'Unit', groupId: 'g1' }] } }).success).toBe(false);
  });
});
