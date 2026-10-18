import type * as S from '@form/schema';
import { applyDocumentOps, insertSnippet, instantiate, lockFingerprint, sanitizeForTemplate, uuidv5, SEED_NAMESPACE } from '../src/index.ts';
import { ORG_PROFILE, context, eventPayload, hostForm, kycSnippet, onceSnippet, pid, versionOf } from './build.ts';
import { PII_CORPUS } from './pii-corpus.ts';
import { build, randomSpec } from './random.ts';

/*
 * The templates-core determinism corpus (WP-T0.2): instantiate, insertSnippet, the sanitiser and lock
 * fingerprints over fixed inputs. Node (test/determinism.test.ts, digest pinned) and Chromium, Firefox and
 * WebKit (`pnpm test:determinism`) must produce byte-identical JSON for every case.
 */

export interface CorpusCase { name: string; json: string }

const SEEDS = ['s0', 's1', 'idem-ключ-७', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'Idempotency-Key: 2026-10-18T10:00:00Z#42'];
const VARIABLES: Array<S.InstantiateContext['variables']> = [
  { 'custom.event_name': 'Diwali Mela', 'custom.venue': 'मैदान' },
  { 'custom.event_name': 'Pongal', 'custom.dietary': false },
  {},
];
const INCLUDES: Array<S.InstantiateContext['include']> = [
  { theme: true, emails: true, endings: true, pdf: true, workflow: true },
  { theme: false, emails: false, endings: true, pdf: false, workflow: false },
];

export function runCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const add = (name: string, value: unknown) => cases.push({ name, json: JSON.stringify(value) });
  const event = versionOf(eventPayload());

  SEEDS.forEach((idSeed, s) => VARIABLES.forEach((variables, v) => INCLUDES.forEach((include, i) => {
    add(`instantiate_event_${s}_${v}_${i}`, instantiate(event, context({ idSeed, bindingIdSeed: `b-${idSeed}`, variables, include })));
  })));

  for (let seed = 1; seed <= 40; seed += 1) {
    const version = versionOf(build(randomSpec(seed)), `tpl_random_${seed}`);
    for (const idSeed of SEEDS.slice(0, 2)) add(`instantiate_random_${seed}_${idSeed}`, instantiate(version, context({ idSeed, variables: { 'custom.title': `T${seed}`, 'custom.part': seed % 2 === 0 } })));
  }

  const { newFormId: _n, include: _i, ...ctx } = context({ variables: { 'custom.bank': 'Canara Bank' } });
  const kyc = versionOf(kycSnippet(), 'tpl_kyc');
  const once = versionOf(onceSnippet(), 'tpl_once');
  SEEDS.forEach((idSeed, s) => {
    const host = hostForm();
    const first = insertSnippet(kyc, host, { pageId: pid('p1') }, { ...ctx, idSeed });
    add(`snippet_kyc_${s}`, first);
    const second = insertSnippet(kyc, applyDocumentOps(host, first.ops), { pageId: pid('p2') }, { ...ctx, idSeed: `${idSeed}-2` });
    add(`snippet_kyc_twice_${s}`, second);
    add(`snippet_once_${s}`, insertSnippet(once, host, { pageId: pid('p2') }, { ...ctx, idSeed }));
  });

  for (const c of PII_CORPUS) add(`sanitize_${c.name}`, sanitizeForTemplate(c.def, undefined, ORG_PROFILE));
  const instance = instantiate(event, context());
  add('sanitize_instance', sanitizeForTemplate(instance.definition, undefined, ORG_PROFILE));

  const binding = instance.bindings[0];
  if (binding) for (const lock of event.payload.kind === 'form' ? event.payload.locks : []) add(`lock_${lock.id}`, lockFingerprint(instance.definition, binding, lock));

  add('uuidv5_names', ['', 'a', 'नमस्ते', 'தமிழ்', '🙏🏽', 'é', 'é', 'x'.repeat(300)].map((name) => uuidv5(SEED_NAMESPACE, name)));
  return cases;
}
