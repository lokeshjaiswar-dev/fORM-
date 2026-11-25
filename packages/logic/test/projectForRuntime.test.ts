import { RuntimeFormVersionSchema } from '@form/schema';
import type * as S from '@form/schema';
import { describe, expect, it } from 'vitest';
import { evalStateJson, evaluate, projectForRuntime, stepKey } from '../src/index.ts';
import { META, a, ans, bid, choices, cond, field, form, hide, id, num, page, rule, versionOf } from './build.ts';
import { REVIEW_ASSIGNMENTS, reviewForm } from './corpus/review.ts';

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

describe('projectForRuntime and review units (WP-2.33)', () => {
  /** A published version whose unit objects carry keys that belong to the server only, as a hostile or future draft might. */
  function reviewed(): S.FormVersion {
    const def = reviewForm();
    const units = (def.review?.units ?? []).map((unit) => ({ ...unit, groupId: 'g_secret', visibility: 'own_unit', 'x-note': 'internal' }));
    return versionOf({ ...def, review: { units } as unknown as S.FormReviewDefinition });
  }

  it('keeps unit ids and names only: no targets, groups, visibility or reviewUnits', () => {
    const v = reviewed();
    expect(v.compiled.reviewUnits).toBeDefined();
    const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
    expect(runtime.definition.review).toMatchInlineSnapshot(`
      {
        "units": [
          {
            "id": "u_applicant",
            "name": "Applicant details",
          },
          {
            "id": "u_contact",
            "name": "Contact details",
          },
          {
            "id": "u_bank",
            "name": "Bank details",
          },
        ],
      }
    `);
    expect(runtime.compiled).not.toHaveProperty('reviewUnits');
    expect(RuntimeFormVersionSchema.safeParse(JSON.parse(JSON.stringify(runtime))).success).toBe(true);
    const json = JSON.stringify(runtime);
    for (const leak of ['reviewUnits', 'groupId', 'g_secret', 'visibility', 'own_unit', 'x-note', 'internal']) expect(json).not.toContain(leak);
    for (const assignment of REVIEW_ASSIGNMENTS) expect(json).not.toContain(assignment.groupId);
  });

  describe('server-side lookups: the respondent gets markers, never the upstream request (T-LK-01 unit)', () => {
    const url = 'https://hr.example/api/employees?secret_path=1' as S.SafeUrl;
    const secretId = '0192f7a2-0000-7000-8000-00000000c0de';
    const lookupVersion = () => {
      const def = form([
        { ...field('short_text', 'emp'), apiValidation: { url, auth: { type: 'bearer', token: 'CHECK-SECRET' }, credentialRef: { secretId }, responseKey: 'SECRET_RESPONSE_KEY', success: { type: 'boolean', equals: true } } },
        { ...field('single_choice', 'city', { config: { display: 'dropdown', options: choices('pune') } }), apiOptions: { url, method: 'GET', auth: { type: 'api_key', header: 'X-Key', value: 'OPTIONS-SECRET' }, credentialRef: { secretId }, itemsPath: 'SECRET_ITEMS_PATH', labelKey: 'SECRET_LABEL_KEY' } },
        field('short_text', 'city_name'),
        field('short_text', 'phone'),
      ], [page('p1', ['emp', 'city', 'city_name', 'phone'])], []);
      def.lookups = [
        { id: 'hr', name: 'HR', enabled: true, url, method: 'GET', auth: { type: 'bearer', token: 'HR-SECRET-TOKEN' }, credentialRef: { secretId }, itemsPath: 'SECRET_ITEMS', searchParam: 'SECRET_SEARCH', pickerFieldId: bid('emp'), pickerKey: 'name',
          mappings: [{ key: 'city', fieldId: bid('city_name') }, { key: 'orphan' }, { key: 'ghost', fieldId: bid('not_a_block') }, { key: 'phone', fieldId: bid('phone') }], minChars: 1, maxRows: 5 },
        { id: 'off', enabled: false, url, pickerFieldId: bid('emp'), pickerKey: 'name' },
        { id: 'vendor', source: 'dms_master', enabled: true, masterId: 'm-1', pickerFieldId: bid('emp'), pickerKey: 'b2000000-0000-4000-8000-000000000001', mappings: [{ key: 'b2000000-0000-4000-8000-000000000002', fieldId: bid('city_name') }] },
      ];
      def.lookup = { url, auth: { type: 'basic', username: 'hr', password: 'LEGACY-SECRET' }, enabled: true, pickerFieldId: bid('phone'), pickerKey: 'legacy_name', mappings: [{ key: 'legacy_city', fieldId: bid('city_name') }] };
      return versionOf(def);
    };

    it('carries no credential, secretId, host, path, query, itemsPath, searchParam, response key or label key', () => {
      const v = lookupVersion();
      const before = JSON.stringify(v);
      const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
      const json = JSON.stringify(runtime);
      for (const leak of ['HR-SECRET-TOKEN', 'LEGACY-SECRET', 'OPTIONS-SECRET', 'CHECK-SECRET', '"auth"', secretId, 'credentialRef', 'hr.example', 'secret_path', 'SECRET_ITEMS', 'SECRET_SEARCH', 'SECRET_RESPONSE_KEY', 'SECRET_LABEL_KEY', 'searchParam', 'itemsPath', 'responseKey', '"url"']) {
        expect(json, leak).not.toContain(leak);
      }
      expect(JSON.stringify(v)).toBe(before);
      const parsed = RuntimeFormVersionSchema.safeParse(JSON.parse(json));
      expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('/')} ${i.message}`)).toEqual([]);
    });

    it('pins the public key sets of a lookup and of the block markers (allowlist)', () => {
      const runtime = projectForRuntime(lookupVersion(), { state: 'open' }, publicConfig);
      const lookups = runtime.definition.lookups ?? [];
      for (const l of lookups) expect(Object.keys(l).sort()).toEqual(l.source === 'dms_master'
        ? ['id', 'masterId', 'maxRows', 'mappings', 'minChars', 'pickerFieldId', 'pickerKey', 'source'].sort()
        : ['id', 'maxRows', 'mappings', 'minChars', 'pickerFieldId', 'pickerKey', 'source'].concat(l.name ? ['name'] : []).sort());
      const emp = runtime.definition.blocks[bid('emp')] as unknown as { apiValidation: unknown };
      const city = runtime.definition.blocks[bid('city')] as unknown as { apiOptions: unknown };
      expect(emp.apiValidation).toEqual({ remote: true });
      expect(city.apiOptions).toEqual({ remote: true });
    });

    it('keeps only enabled lookups, folds the legacy `lookup` in as id "lookup", and drops mappings without an existing field', () => {
      const runtime = projectForRuntime(lookupVersion(), { state: 'open' }, publicConfig);
      expect(runtime.definition).not.toHaveProperty('lookup');
      const lookups = runtime.definition.lookups ?? [];
      expect(lookups.map((l) => l.id)).toEqual(['hr', 'vendor', 'lookup']);
      expect(lookups[0]).toMatchObject({ id: 'hr', source: 'http', name: 'HR', pickerFieldId: bid('emp'), pickerKey: 'name', minChars: 1, maxRows: 5, mappings: [{ key: 'city', fieldId: bid('city_name') }, { key: 'phone', fieldId: bid('phone') }] });
      expect(lookups[1]).toMatchObject({ id: 'vendor', source: 'dms_master', masterId: 'm-1', minChars: 2, maxRows: 20 });
      expect(lookups[2]).toMatchObject({ id: 'lookup', source: 'http', pickerKey: 'legacy_name', minChars: 2, maxRows: 20 });
    });

    it('a lookup without a picker field or key is not public, and a form without lookups has none', () => {
      const def = form([field('short_text', 'emp')], [page('p1', ['emp'])], []);
      def.lookups = [{ id: 'a', enabled: true, url }, { id: 'b', enabled: true, url, pickerFieldId: bid('emp') }, { id: 'c', enabled: true, url, pickerFieldId: bid('gone'), pickerKey: 'name' }];
      expect(projectForRuntime(versionOf(def), { state: 'open' }, publicConfig).definition).not.toHaveProperty('lookups');
    });
  });

  it('does not touch the version it projects, and leaves a form without review as it was', () => {
    const v = reviewed();
    const before = JSON.stringify(v);
    projectForRuntime(v, { state: 'open' }, publicConfig);
    expect(JSON.stringify(v)).toBe(before);
    const plain = projectForRuntime(version(), { state: 'open' }, publicConfig);
    expect(plain.definition).not.toHaveProperty('review');
    expect(plain.compiled).not.toHaveProperty('reviewUnits');
  });

  it('evaluates to the same client state as the version it was projected from', () => {
    const v = reviewed();
    const runtime = projectForRuntime(v, { state: 'open' }, publicConfig);
    const pages = v.definition.pages.map((p) => p.id);
    for (const answers of [{}, { [bid('applicant')]: a.text('skip') }, { [bid('has_bank')]: a.single('no') }] as S.Answers[]) {
      expect(evalStateJson(evaluate(runtime, answers, META, 'client'), pages)).toBe(evalStateJson(evaluate(v, answers, META, 'client'), pages));
    }
  });
});
