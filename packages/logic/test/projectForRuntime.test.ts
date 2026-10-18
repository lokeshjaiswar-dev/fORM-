import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { evalStateJson, evaluate, projectForRuntime, stepKey } from '../src/index.ts';
import { META, a, ans, bid, cond, field, form, hide, id, num, page, rule, versionOf } from './build.ts';

const origin: S.Origin = { bindingId: id<S.TemplateBindingId>('binding_1'), sourceId: 'src_1' };
const publicConfig: S.RuntimeFormVersion['publicConfig'] = {
  edition: 'saas',
  upload: { presignUrl: 'https://api.example/v1/uploads', maxFileBytes: 10_000_000 },
  branding: true,
  thirdPartyTrackingAllowed: false,
};
const routeEmail: S.ServerAction = { type: 'route_email', notificationId: id<S.NotificationId>('n1'), field: 'to', mode: 'add', recipients: [] };

/** A published version with a server-only rule and a mixed rule, as a later engine would compile them. */
function version(): S.FormVersion {
  const def = form([
    { ...field('short_text', 'name'), note: 'ask for the legal name', origin },
    /* A block whose id is 'origin' is data, not a stamp. */
    field('long_text', 'origin'),
    field('number', 'age'),
  ], [page('p1', ['name', 'origin', 'age'], { origin })], [
    rule('client', cond(ans('age'), 'gt', num('17')), [hide('origin')], undefined, { origin }),
  ]);
  def.i18n.messages = { [id<S.Locale>('hi-IN')]: { 'form:title': { value: 'फ़ॉर्म', sourceHash: id<S.Sha256Hex>('a'.repeat(64)), origin: 'human' } } };
  const v = versionOf(def);
  const mixed = rule('mixed', cond(ans('name'), 'is_answered'), [hide('age'), routeEmail]);
  const server = rule('server', cond(ans('name'), 'is_answered'), [routeEmail]);
  const serverStep: S.PlanStep = { kind: 'rule', ruleId: server.id, scope: 'server' };
  const mixedStep: S.PlanStep = { kind: 'rule', ruleId: mixed.id, scope: 'client+server' };
  const reads = ['onPath:p1', 'value:name', 'visible:name', 'visible:p1'];
  return {
    ...v,
    definition: { ...def, logic: { ...def.logic, rules: [...def.logic.rules, mixed, server] } },
    compiled: { ...v.compiled, plan: [...v.compiled.plan, mixedStep, serverStep], reads: { ...v.compiled.reads, [stepKey(mixedStep)]: reads, [stepKey(serverStep)]: reads } },
  };
}

describe('projectForRuntime', () => {
  it('strips notes, origin stamps, server actions and server steps, and keeps client reads', () => {
    const v = version();
    const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
    expect(runtime).toMatchObject({ versionId: v.id, formId: v.formId, contentHash: v.contentHash, status: { state: 'open' }, publicConfig });
    const json = JSON.stringify(runtime.definition);
    expect(json).not.toContain('"note"');
    expect(json).not.toContain('binding_1');
    expect(runtime.definition.blocks[bid('origin')]).toEqual(v.definition.blocks[bid('origin')]);
    expect(runtime.definition.i18n.messages[id<S.Locale>('hi-IN')]?.['form:title']?.origin).toBe('human');
    expect(runtime.definition.logic.rules.map((r) => [r.id, r.then.map((x) => x.type)])).toEqual([['client', ['hide']], ['mixed', ['hide']]]);
    expect(runtime.compiled.plan.map(stepKey)).toEqual(['on_path:p1', 'rule:client', 'rule:mixed']);
    expect(Object.keys(runtime.compiled.reads).sort()).toEqual(['on_path:p1', 'rule:client', 'rule:mixed']);
    expect(runtime.compiled).not.toHaveProperty('dataInventory');
    expect(runtime.compiled).not.toHaveProperty('taint');
    expect(runtime.compiled.definitionHash).toBe(v.compiled.definitionHash);
    expect(v.definition.blocks[bid('name')]).toHaveProperty('note');
  });

  it('evaluates to the same client state as the version it was projected from', () => {
    const v = version();
    const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
    const pages = v.definition.pages.map((p) => p.id);
    for (const answers of [{}, { [bid('name')]: a.text('Asha') }, { [bid('name')]: a.text('Asha'), [bid('age')]: a.number('21'), [bid('origin')]: a.long('x') }] as S.Answers[]) {
      expect(evalStateJson(evaluate(runtime, answers, META, 'client'), pages)).toBe(evalStateJson(evaluate(v, answers, META, 'client'), pages));
    }
  });

  it('drops the steps of rules with no actions, so the runtime trace matches the full version', () => {
    const def = form([field('number', 'age'), field('short_text', 'name')], [page('p1', ['age', 'name'])], [
      rule('empty', cond(ans('age'), 'gt', num('1')), []),
      rule('client', cond(ans('age'), 'gt', num('17')), [hide('name')]),
    ]);
    const v = versionOf(def);
    expect(v.compiled.plan.map(stepKey)).toContain('rule:empty');
    const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
    expect(runtime.compiled.plan.map(stepKey)).toEqual(['on_path:p1', 'rule:client']);
    expect(Object.keys(runtime.compiled.reads)).not.toContain('rule:empty');
    const answers = { [bid('age')]: a.number('21') } as S.Answers;
    const trace = evaluate(runtime, answers, META, 'client', { trace: true }).trace ?? [];
    expect(trace.every((t) => !t.diagnostics?.length)).toBe(true);
    expect(trace.map((t) => [stepKey(t.step), t.fired])).toEqual([['on_path:p1', null], ['rule:client', true]]);
  });

  it('runs server actions only in server scope', () => {
    const v = version();
    const answers = { [bid('name')]: a.text('Asha') } as S.Answers;
    expect(evaluate(v, answers, META, 'client').serverEffects).toEqual([]);
    expect(evaluate(v, answers, META, 'server').serverEffects).toEqual([{ ...routeEmail, ruleId: 'mixed' }, { ...routeEmail, ruleId: 'server' }]);
    expect(evaluate(v, {}, META, 'server').serverEffects).toEqual([]);
    const trace = evaluate(v, answers, META, 'client', { trace: true }).trace ?? [];
    expect(trace.map((t) => [stepKey(t.step), t.fired])).toEqual([['on_path:p1', null], ['rule:client', false], ['rule:mixed', true], ['rule:server', null]]);
  });
});
