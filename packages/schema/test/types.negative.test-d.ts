import { test } from 'vitest';
import type * as S from '../src/index.ts';

declare const b: S.BlockId; declare const o: S.OptionId; declare const n: S.NotificationId; declare const g: S.ConditionId; declare const r: S.RuleId;
const when: S.ConditionGroup = { kind: 'group', id: g, combinator: 'all', children: [{ kind: 'condition', id: g, left: { kind: 'ref', ref: { kind: 'answer', blockId: b } }, op: 'includes_any', right: { kind: 'options', blockId: b, optionIds: [o] } }] };
export const pub: S.Rule<S.ClientAction> = { id: r, enabled: true, when, then: [{ type: 'show', targets: [b] }] };
// @ts-expect-error server-only action is not a ClientAction
export const bad: S.Rule<S.ClientAction> = { id: r, enabled: true, when, then: [{ type: 'mark_spam', reason: 'x' }] };
export const ok: S.AnswerValue = { type: 'single_choice', value: { optionId: o } };
// @ts-expect-error number answers are DecimalString, not JS numbers
export const badNum: S.AnswerValue = { type: 'number', value: 3 };
// @ts-expect-error template recipients cannot be literal addresses
export const badRcpt: S.RecipientPlaceholder = { kind: 'email', address: 'a@b.c' as S.EmailAddress };
void n;
// @ts-expect-error storing answers without consent is not configurable
export const badPriv: S.PrivacyConfig['dropAnswersWithoutConsent'] = false;
// @ts-expect-error server-only rule steps never reach the runtime plan
export const badStep: S.RuntimeFormVersion['compiled']['plan'][number] = { kind: 'rule', ruleId: r, scope: 'server' };
export const okStep: S.RuntimeFormVersion['compiled']['plan'][number] = { kind: 'rule', ruleId: r, scope: 'client+server' };

test('negative type checks are enforced by tsc', () => {});
