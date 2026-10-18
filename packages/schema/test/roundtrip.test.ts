import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as S from '../src/index.ts';
import { valid } from './arbitrary.ts';

/* toStrictEqual against the wire form also fails on a key that comes back as `undefined` instead of absent. */
const roundTrips = <T>(schema: z.ZodType<T>, runs: number) =>
  fc.assert(fc.property(valid(schema), (x) => {
    const wire = JSON.parse(JSON.stringify(x)) as unknown;
    const parsed = schema.parse(wire);
    expect(parsed).toStrictEqual(wire);
    expect(parsed).toEqual(x);
    expect(S.canonicalJson(parsed)).toBe(S.canonicalJson(x));
  }), { numRuns: runs });

describe('parse(JSON.parse(JSON.stringify(x))) ≡ x', () => {
  it('Block', () => roundTrips(S.BlockSchema, 300), 120_000);
  it('StoredBlock', () => roundTrips(S.StoredBlockSchema, 100), 120_000);
  it('FormDefinition', () => roundTrips(S.FormDefinitionSchema, 60), 240_000);
  it('TemplateVersionPayload', () => roundTrips(S.TemplateVersionPayloadSchema, 60), 240_000);
  it.each(S.TEMPLATE_KINDS)('%s template payload', (kind) => {
    roundTrips<unknown>(S.TEMPLATE_PAYLOAD_SCHEMAS[kind], kind === 'form' || kind === 'snippet' ? 20 : 60);
  }, 240_000);
  it('template parts', () => {
    roundTrips(S.TemplateVariableSchema, 100);
    roundTrips(S.LockSpecSchema, 100);
    roundTrips(S.TemplateRefSchema, 50);
    roundTrips(S.TemplateForkBindingSchema, 100);
    roundTrips(S.VarNodeSchema, 100);
    roundTrips(S.OriginSchema, 50);
    roundTrips(S.FormpackManifestSchema, 100);
    roundTrips(S.FormpackSignatureSchema, 50);
    roundTrips(S.FormpackAttestationSchema, 50);
    roundTrips(S.TemplateMigrationResultSchema, 30);
  }, 240_000);
  it('Expr, ConditionGroup and Rule', () => {
    roundTrips(S.ExprSchema, 200);
    roundTrips(S.ConditionGroupSchema, 200);
    roundTrips(S.RuleSchema, 100);
  }, 120_000);
  it('answers and submissions', () => {
    roundTrips(S.AnswersSchema, 100);
    roundTrips(S.StoredSubmissionSchema, 50);
    roundTrips(S.SubmitResultSchema, 100);
  }, 120_000);
  it('rich text', () => {
    roundTrips(S.RichDocSchema, 200);
    roundTrips(S.InlineDocSchema, 200);
    roundTrips(S.EmailDocSchema, 100);
  }, 120_000);
});
