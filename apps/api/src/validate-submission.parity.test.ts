import { compile, createEvaluator, projectForRuntime, stepKey, type Evaluator } from '@form/logic';
import {
  META, V1_FORMS, a, ans, bid, cond, field, form, hide, id, num, page, randomAnswers, randomForm, rng, rule, toV2, toV2Answers, v1AnswerSets, versionOf,
} from '@form/logic/test-corpus';
import { REGISTRY } from '@form/registry';
import { COMPUTED_FIELD_TYPES } from '@form/schema';
import type { Answers, AnswerValue, BlockId, EvalMeta, EvalState, FieldError, FormVersion, Locale, PlanStep, RuntimeFormVersion, ServerAction } from '@form/schema';
import { normalizeAnswers, validateAnswers, type RawAnswers } from '@form/validation';
import { describe, expect, it } from 'vitest';
import { checkAnswers, todayIn } from './validate-submission.ts';

/*
 * WP-1.12 parity: "client/server EvalState parity on the corpus". The respondent's browser evaluates the form it was sent
 * (the runtime projection) in client scope and validates the answers as the renderer's resolver does; the answers then cross
 * the wire as JSON and the API runs `checkAnswers` (normalizeAnswers, then server scope, then validateAnswers) on the full
 * stored version. For every form and answer set of the logic corpus (@form/logic/test-corpus, the forms and seeds the
 * determinism job pins) the two must agree on what is visible, required, enabled and answered, on the page path, on the
 * ending, and on the errors. Server-scoped steps are the only thing allowed to make them differ, and the only output of
 * a server-scoped step is `serverEffects` (route_email, tag_submission, ...): no server action writes a visibility, required,
 * enabled, value, page or ending cell. So the comparison below is exact, and the server-only output is checked on its own.
 *
 * The submission pipeline (WP-1.12) moves `checkAnswers`; this test must stay green when it does. The `serverEvaluation`
 * helper below mirrors the evaluation `checkAnswers` runs (its `values` are asserted equal to the real function's) because
 * `Checked` does not return the state: when the pipeline exposes it, use that and drop the mirror. When it starts passing
 * the client's meta (pageUrl, device, urlParams) to the evaluator, give the client side below the same meta.
 */

const ANSWER_SETS = 200;
const RANDOM_FORMS = 20;
const NOW = new Date(META.now);
const LOCALE = 'en-IN' as Locale;
const PUBLIC_CONFIG: RuntimeFormVersion['publicConfig'] = {
  edition: 'saas',
  upload: { presignUrl: 'https://api.example/v1/uploads', maxFileBytes: 10_000_000 },
  branding: true,
  thirdPartyTrackingAllowed: false,
};
const COMPUTED: ReadonlySet<string> = new Set(COMPUTED_FIELD_TYPES);

/** Everything the two sides must agree on, as plain sorted data. */
interface Observed {
  visible: string[];
  required: string[];
  enabled: string[];
  /** Answers after defaults and captures, without the computed fields (calculation, context, unique_id), which only the server produces. */
  values: Array<[string, AnswerValue]>;
  path: string[];
  endingId: string;
  errors: string[];
}

function observe(version: Pick<FormVersion, 'definition'>, state: EvalState, errors: readonly FieldError[]): Observed {
  const { blocks } = version.definition;
  const typeOf = (key: string) => blocks[key as BlockId]?.type ?? '';
  const isField = (key: string) => {
    const block = blocks[key as BlockId];
    return block !== undefined && 'key' in block;
  };
  return {
    visible: [...state.visible].sort(),
    required: [...state.required].sort(),
    enabled: Object.keys(blocks).filter((key) => isField(key) && !state.disabled.has(key as BlockId)).sort(),
    values: Object.entries(state.values).filter(([key]) => !COMPUTED.has(typeOf(key))).sort(([x], [y]) => (x < y ? -1 : 1)) as Array<[string, AnswerValue]>,
    path: [...state.path],
    endingId: state.endingId,
    errors: errors.map((e) => JSON.stringify(e)).sort(),
  };
}

/** The fields on which `client` and `server` differ, with both values; empty when they agree. */
function differences(client: Observed, server: Observed): string[] {
  return (Object.keys(client) as Array<keyof Observed>).flatMap((key) =>
    JSON.stringify(client[key]) === JSON.stringify(server[key]) ? [] : [`${key}: client ${JSON.stringify(client[key])}, server ${JSON.stringify(server[key])}`]);
}

/**
 * The renderer's side (packages/renderer EvalSession + rhfResolver): the runtime projection, evaluated incrementally in client
 * scope as the respondent's answers change, then validated for Submit. One session per form, answer set after answer set.
 */
function clientSession(version: FormVersion) {
  const runtime = projectForRuntime(version, { state: 'open' }, PUBLIC_CONFIG);
  const meta: EvalMeta = { ...META, shuffleSeed: 'a-different-session-seed' };
  const evaluator: Evaluator = createEvaluator(runtime, meta, 'client');
  evaluator.evaluate({});
  let previous: Answers = {};
  return (raw: RawAnswers): { state: EvalState; errors: FieldError[] } => {
    const normalised = normalizeAnswers(raw);
    const next: Record<string, AnswerValue> = {};
    const changed = new Set<BlockId>();
    for (const [key, value] of Object.entries(normalised)) {
      if (value === undefined) continue;
      const before = previous[key as BlockId];
      next[key] = before !== undefined && JSON.stringify(before) === JSON.stringify(value) ? before : value;
      if (next[key] !== before) changed.add(key as BlockId);
    }
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) changed.add(key as BlockId);
    previous = next as Answers;
    const state = evaluator.update(previous, changed);
    const errors = validateAnswers(runtime, state, raw, { scope: 'submit', locale: LOCALE, today: todayIn(META.now, META.timeZone) });
    return { state, errors };
  };
}

/** The evaluation `checkAnswers` runs on the wire answers (see the header): normalizeAnswers, then server scope with the server's clock. */
function serverEvaluation(version: FormVersion, versionId: string, wire: Record<string, unknown>): EvalState {
  const meta: EvalMeta = {
    now: NOW.toISOString() as EvalMeta['now'],
    timeZone: version.definition.behavior.timeZone,
    locale: LOCALE,
    urlParams: {},
    isPreview: false,
    shuffleSeed: `${versionId}:server`,
  };
  return createEvaluator(version, meta, 'server').evaluate(normalizeAnswers(wire as RawAnswers));
}

interface Fixture { name: string; version: FormVersion; sets: Answers[] }

const v1Fixtures = (): Fixture[] =>
  V1_FORMS.map((f, i) => ({ name: f.name, version: versionOf(toV2(f)), sets: v1AnswerSets(f, ANSWER_SETS, 7_000 + i).map((values) => toV2Answers(f, values)) }));

/** The random P0 forms of the determinism corpus (the ones that compile), each with 200 seeded answer sets. */
const randomFixtures = (): Fixture[] =>
  Array.from({ length: RANDOM_FORMS }, (_, i) => {
    const def = randomForm(900 + i);
    if (!compile(def, REGISTRY).ok) return [];
    const r = rng(9_000 + i);
    return [{ name: `random_${i + 1}`, version: versionOf(def), sets: Array.from({ length: ANSWER_SETS }, () => randomAnswers(r, def)) }];
  }).flat();

const VERSION_ID = 'version_1';

/** Runs every answer set of `fixture` through both sides; returns the differences and what the sets exercised. */
function replay(fixture: Fixture) {
  const client = clientSession(fixture.version);
  const mismatches: string[] = [];
  const seen = { hidden: 0, required: 0, errors: 0, multiPage: 0, answered: 0, serverEffects: 0 };
  fixture.sets.forEach((answers, n) => {
    const wire = JSON.parse(JSON.stringify(answers)) as Record<string, unknown>;
    const theirs = client(answers);
    const checked = checkAnswers(fixture.version, VERSION_ID, wire, LOCALE, NOW);
    const state = serverEvaluation(fixture.version, VERSION_ID, wire);
    /* The mirror is the real evaluation: `checkAnswers` returns the same values. */
    if (JSON.stringify(checked.values) !== JSON.stringify(state.values)) mismatches.push(`set ${n}: checkAnswers values differ from the server evaluation`);
    const diff = differences(observe(fixture.version, theirs.state, theirs.errors), observe(fixture.version, state, checked.errors));
    if (diff.length) mismatches.push(`set ${n} (${JSON.stringify(wire)}): ${diff.join('; ')}`);
    if (theirs.state.serverEffects.length || state.serverEffects.length) seen.serverEffects += 1;
    const blocks = Object.keys(fixture.version.definition.blocks).length + fixture.version.definition.pages.length;
    if (state.visible.size < blocks) seen.hidden += 1;
    if (state.required.size) seen.required += 1;
    if (checked.errors.length) seen.errors += 1;
    if (state.path.length > 1) seen.multiPage += 1;
    if (Object.keys(state.values).length) seen.answered += 1;
  });
  return { mismatches, seen };
}

describe('client/server EvalState parity (WP-1.12)', () => {
  const total = { sets: 0, hidden: 0, required: 0, errors: 0, multiPage: 0, answered: 0 };
  const tally = (fixture: Fixture, seen: ReturnType<typeof replay>['seen']) => {
    total.sets += fixture.sets.length;
    for (const key of ['hidden', 'required', 'errors', 'multiPage', 'answered'] as const) total[key] += seen[key];
  };

  const v1 = v1Fixtures();
  it.each(v1.map((fixture) => ({ name: fixture.name, fixture })))('v1 parity form $name: 200 answer sets', ({ fixture }) => {
    const { mismatches, seen } = replay(fixture);
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(seen.serverEffects).toBe(0);
    tally(fixture, seen);
  });

  const random = randomFixtures();
  it.each(random.map((fixture) => ({ name: fixture.name, fixture })))('random form $name: 200 answer sets', ({ fixture }) => {
    const { mismatches, seen } = replay(fixture);
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(seen.serverEffects).toBe(0);
    tally(fixture, seen);
  });

  it('covers the whole corpus: 35 v1 forms and the random forms, 200 answer sets each', () => {
    expect(v1).toHaveLength(35);
    expect(random.length).toBeGreaterThanOrEqual(15);
    expect(total.sets).toBe((v1.length + random.length) * ANSWER_SETS);
  });

  it('is not vacuous: the sets hide blocks, require fields, fail validation, walk several pages and carry answers', () => {
    expect(total.hidden).toBeGreaterThan(1000);
    expect(total.required).toBeGreaterThan(500);
    expect(total.errors).toBeGreaterThan(100);
    expect(total.multiPage).toBeGreaterThan(1000);
    expect(total.answered).toBeGreaterThan(total.sets * 0.9);
  });

  it('the comparison sees a difference when there is one', () => {
    const fixture = v1Fixtures()[0] as Fixture;
    const answers = (fixture.sets.find((set) => Object.keys(set).length > 1) ?? {}) as Answers;
    const client = clientSession(fixture.version)(answers);
    const mine = observe(fixture.version, client.state, client.errors);
    expect(differences(mine, mine)).toEqual([]);
    expect(differences(mine, { ...mine, visible: mine.visible.slice(1) })).toHaveLength(1);
    expect(differences(mine, { ...mine, required: [...mine.required, 'x'], endingId: 'other' })).toHaveLength(2);
    expect(differences(mine, { ...mine, errors: [...mine.errors, '{}'], path: [] })).toHaveLength(2);
    expect(differences(mine, { ...mine, enabled: [], values: [] })).not.toHaveLength(0);
  });
});

describe('server-scoped steps differ in serverEffects only', () => {
  const routeEmail: ServerAction = { type: 'route_email', notificationId: id('n1'), field: 'to', mode: 'add', recipients: [] };
  const tag: ServerAction = { type: 'tag_submission', tags: ['vip'] };

  /*
   * A published version with a server-only rule and a mixed rule, as a later engine would compile them (logic@2 P0 refuses
   * server actions, so the steps are added by hand, as in packages/logic/test/projectForRuntime.test.ts).
   */
  function withServerRules(): FormVersion {
    const def = form(
      [field('short_text', 'name'), field('number', 'age'), field('short_text', 'note')],
      [page('p1', ['name', 'age', 'note'])],
      [rule('client', cond(ans('age'), 'gt', num('17')), [hide('note')])],
    );
    const v = versionOf(def);
    const mixed = rule('mixed', cond(ans('name'), 'is_answered'), [hide('age'), routeEmail]);
    const server = rule('server', cond(ans('name'), 'is_answered'), [tag]);
    const steps: PlanStep[] = [
      { kind: 'rule', ruleId: mixed.id, scope: 'client+server' },
      { kind: 'rule', ruleId: server.id, scope: 'server' },
    ];
    const reads = ['onPath:p1', 'value:name', 'visible:name', 'visible:p1'];
    return {
      ...v,
      definition: { ...def, logic: { ...def.logic, rules: [...def.logic.rules, mixed, server] } },
      compiled: { ...v.compiled, plan: [...v.compiled.plan, ...steps], reads: { ...v.compiled.reads, ...Object.fromEntries(steps.map((s) => [stepKey(s), reads])) } },
    };
  }

  const cases: Array<{ name: string; answers: Record<string, AnswerValue>; effects: string[] }> = [
    { name: 'nothing answered: no rule fires', answers: {}, effects: [] },
    { name: 'a name: the mixed rule hides age on both sides, and both server actions fire', answers: { name: a.text('Asha'), age: a.number('30') }, effects: ['route_email', 'tag_submission'] },
    { name: 'an adult with a name: client rule and mixed rule both apply', answers: { name: a.text('Ravi'), age: a.number('21'), note: a.text('x') }, effects: ['route_email', 'tag_submission'] },
  ];

  it.each(cases)('$name', ({ answers, effects }) => {
    const version = withServerRules();
    const wire = JSON.parse(JSON.stringify(answers)) as Record<string, unknown>;
    const client = clientSession(version)(answers as Answers);
    const checked = checkAnswers(version, VERSION_ID, wire, LOCALE, NOW);
    const state = serverEvaluation(version, VERSION_ID, wire);
    expect(JSON.stringify(checked.values)).toBe(JSON.stringify(state.values));
    expect(differences(observe(version, client.state, client.errors), observe(version, state, checked.errors))).toEqual([]);
    expect(client.state.serverEffects).toEqual([]);
    expect(state.serverEffects.map((e) => e.type)).toEqual(effects);
    if (effects.length) expect(state.visible.has(bid('age'))).toBe(false);
  });
});
