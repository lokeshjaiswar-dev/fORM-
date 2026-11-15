import { randomUUID } from 'node:crypto';
import { compile } from '@form/logic';
import { REGISTRY } from '@form/registry';
import { contentHash, type FormDefinition } from '@form/schema';
import { describe, expect, it, vi } from 'vitest';
import { draftWith, fieldBlock, publishableDraft, withLogicCycle, withRedirectEnding } from '../../test/publishable-draft.ts';
import { publishPipeline, type PublishContext } from './pipeline.ts';
import type { OrgProfile, OrgProfileSource } from './resolve.ts';

const orgId = randomUUID();
const formId = randomUUID();
const ctx = (over: Partial<PublishContext> = {}): PublishContext => ({ orgId, formId, redirectAllowlist: null, ...over });

const must = async (draft: unknown, over: Partial<PublishContext> = {}) => {
  const outcome = await publishPipeline(draft, ctx(over));
  if (!outcome.ok) throw new Error(`expected the draft to publish: ${JSON.stringify(outcome)}`);
  return outcome;
};

const blockedBy = async (draft: unknown, over: Partial<PublishContext> = {}) => {
  const outcome = await publishPipeline(draft, ctx(over));
  if (outcome.ok || outcome.reason !== 'blocked') throw new Error(`expected the publish to be blocked: ${JSON.stringify(outcome).slice(0, 300)}`);
  return outcome.issues;
};

const shape = (issues: ReadonlyArray<{ severity: string; code: string; path: string }>) => issues.map((i) => `${i.severity}:${i.code}:${i.path}`);

describe('publishPipeline', () => {
  describe('with an OrgProfileSource', () => {
    const profile: OrgProfile = { values: { 'org.legal_name': 'Acme Pvt Ltd', 'org.support_email': 'help@acme.test' } };

    it('passes the definition through unchanged for a stub source that has a profile (resolving it is WP-T1.3)', async () => {
      const source: OrgProfileSource = { load: vi.fn(() => Promise.resolve(profile)) };
      const draft = publishableDraft(formId);
      const outcome = await must(draft, { profiles: source });
      expect(source.load).toHaveBeenCalledExactlyOnceWith(orgId);
      expect(outcome.definition).toEqual(draft);
      expect(outcome.variablesSnapshot).toEqual({});
      expect(outcome.templateLineage).toEqual([]);
      // The draft's `var` nodes (the org's legal name, privacy contact, ...) are still there: nothing was baked in.
      expect(JSON.stringify(outcome.definition)).toContain('"var"');
    });

    it('does the same with the default source, which has no profile for any org', async () => {
      const draft = publishableDraft(formId);
      const outcome = await must(draft);
      expect(outcome.definition).toEqual(draft);
    });

    it('asks the source for the context’s org, not for anything the draft says', async () => {
      const source: OrgProfileSource = { load: vi.fn(() => Promise.resolve(null)) };
      await must(publishableDraft(formId), { profiles: source });
      expect(source.load).toHaveBeenCalledWith(orgId);
    });
  });

  it('hashes and compiles the definition it returns, which is what gets stored', async () => {
    const draft = draftWith(formId, [fieldBlock('name', 'short_text', {}, { required: true })]);
    const outcome = await must(draft);
    const again = compile(outcome.definition, REGISTRY);
    expect(again.ok).toBe(true);
    expect(outcome.compiled).toEqual(again.ok ? again.compiled : undefined);
    expect(outcome.contentHash).toBe(outcome.compiled.definitionHash);
    expect(outcome.contentHash).toBe(contentHash(outcome.definition));
    expect(outcome.engine).toBe('logic@2');
    expect(outcome.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('files the draft under the form id the route names, whatever id the draft carries', async () => {
    const outcome = await must(publishableDraft(randomUUID()));
    expect(outcome.definition.formId).toBe(formId);
    expect(outcome.contentHash).toBe(contentHash(outcome.definition));
  });

  describe('step 1, the strict parse', () => {
    it('refuses what is not a v2 form, saying where', async () => {
      expect(shape(await blockedBy({ schemaVersion: 2, title: 'Not a form' }))).toContain('error:invalid_definition:/revision');
      expect(shape(await blockedBy(null))).toEqual(['error:invalid_definition:']);
    });

    it('refuses a key the schema does not have, instead of dropping it', async () => {
      const draft = { ...publishableDraft(formId), smuggled: { note: 'kept by nobody' } };
      const issues = await blockedBy(draft);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: 'error', code: 'invalid_definition' });
      expect(issues[0]!.message).toContain('smuggled');
    });
  });

  describe('step 3, the checks', () => {
    it('reports an author regex that RE2 cannot run, at the pattern', async () => {
      const draft = draftWith(formId, [fieldBlock('code', 'short_text', { pattern: { source: '(?=a)b' } })]);
      const issues = await blockedBy(draft);
      expect(shape(issues)).toEqual(['error:unsafe_regex:/blocks/code/config/pattern/source']);
      expect(issues[0]!.message).toContain('lookahead');
    });

    it('reports a redirect to a script URL, at the ending', async () => {
      const draft = withRedirectEnding(publishableDraft(formId), ['javascript:alert(1)']);
      expect(shape(await blockedBy(draft))).toEqual(['error:invalid_url_scheme:/endings/1/url']);
    });

    it('reports a logic cycle, at the rule', async () => {
      const draft = withLogicCycle(draftWith(formId, [fieldBlock('name', 'short_text')]), 'name');
      const issues = await blockedBy(draft);
      expect(shape(issues)).toEqual(['error:logic_cycle:/logic/rules/0']);
      expect(issues[0]!.message).toContain('logic cycle');
    });

    it('reports every problem at once, errors before warnings, each issue once', async () => {
      const base = draftWith(formId, [fieldBlock('name', 'short_text'), fieldBlock('code', 'short_text', { pattern: { source: '(?<=a)b' } })]);
      const draft = withLogicCycle(withRedirectEnding(base, ['javascript:alert(1)']), 'name');
      const issues = await blockedBy(draft);
      const codes = issues.map((i) => i.code);
      expect(codes).toEqual(expect.arrayContaining(['unsafe_regex', 'invalid_url_scheme', 'logic_cycle']));
      const firstWarning = issues.findIndex((i) => i.severity !== 'error');
      if (firstWarning !== -1) expect(issues.slice(firstWarning).every((i) => i.severity !== 'error')).toBe(true);
      expect(new Set(issues.map((i) => `${i.code}${i.path}${i.message}`)).size).toBe(issues.length);
    });

    describe('the redirect allowlist', () => {
      const toward = (url: unknown[]) => withRedirectEnding(publishableDraft(formId), url);

      it('is not applied when the form has no list, and a redirect to any http(s) host publishes', async () => {
        await must(toward(['https://anywhere.example/thanks']));
      });

      it('lets a redirect to a listed host through, and refuses one to another host, at the ending', async () => {
        await must(toward(['https://forms.acme.test/thanks?ref=', { pipe: { source: { kind: 'submission', key: 'unique_id' } } }]), { redirectAllowlist: ['forms.acme.test'] });
        const issues = await blockedBy(toward(['https://evil.test/thanks']), { redirectAllowlist: ['forms.acme.test'] });
        expect(shape(issues)).toEqual(['error:redirect_not_allowed:/endings/1/url']);
        expect(issues[0]!.message).toContain("'evil.test'");
      });

      it('refuses every redirect when the list is empty', async () => {
        const issues = await blockedBy(toward(['https://forms.acme.test/']), { redirectAllowlist: [] });
        expect(issues[0]).toMatchObject({ code: 'redirect_not_allowed' });
        expect(issues[0]!.message).toContain('empty');
        await must(publishableDraft(formId), { redirectAllowlist: [] });
      });
    });
  });

  describe('step 4, the client’s plan', () => {
    it('accepts the hash of the server’s own compile, in either case', async () => {
      const draft = publishableDraft(formId);
      const { contentHash: hash } = await must(draft);
      await must(draft, { clientDefinitionHash: hash });
      await must(draft, { clientDefinitionHash: hash.toUpperCase() });
    });

    it('refuses a hash that differs, as a plan mismatch that names both, and returns no plan to store', async () => {
      const draft = publishableDraft(formId);
      const { contentHash: hash } = await must(draft);
      const forged = 'f'.repeat(64);
      const outcome = await publishPipeline(draft, ctx({ clientDefinitionHash: forged }));
      expect(outcome).toEqual({ ok: false, reason: 'plan_mismatch', serverHash: hash, clientHash: forged });
      expect(outcome).not.toHaveProperty('compiled');
    });

    it('compares against the hash of the definition as the server resolves it (the route’s form id), not the client’s', async () => {
      const foreign = publishableDraft(randomUUID());
      const hashOfForeign = contentHash(foreign as FormDefinition);
      const outcome = await publishPipeline(foreign, ctx({ clientDefinitionHash: hashOfForeign }));
      expect(outcome).toMatchObject({ ok: false, reason: 'plan_mismatch' });
    });

    it('is checked after the other checks: a blocked draft is blocked, whatever hash came with it', async () => {
      const draft = withLogicCycle(draftWith(formId, [fieldBlock('name', 'short_text')]), 'name');
      const outcome = await publishPipeline(draft, ctx({ clientDefinitionHash: 'a'.repeat(64) }));
      expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
    });
  });
});
