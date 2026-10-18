import { expectTypeOf, test } from 'vitest';
import type * as S from '../src/index.ts';

declare const b: S.BlockId; declare const step: S.WorkflowStepId; declare const ref: S.TemplateRef; declare const address: S.EmailAddress;
declare const user: S.UserId; declare const email: S.EmailTemplatePayload; declare const kindsOk: typeof S._kindsOk;

export const okRcpt: S.EmailTemplatePayload['defaultRecipients'] = [{ kind: 'field', blockId: b }, { kind: 'role', role: 'form_owner' }];
// @ts-expect-error a template email cannot name a literal recipient
export const badRcpt: S.EmailTemplatePayload['defaultRecipients'] = [{ kind: 'email', address }];
// @ts-expect-error a template email cannot name a member either
export const badMember: S.EmailTemplatePayload['replyTo'] = { kind: 'member', userId: user };
// @ts-expect-error a payload with a literal reply-to address is not an EmailTemplatePayload
export const badEmail: S.EmailTemplatePayload = { ...email, replyTo: { kind: 'email', address } };
// @ts-expect-error workflow approvers are placeholders or roles
export const badApprover: S.WorkflowStep = { id: step, kind: 'approval', name: 'x', approver: { kind: 'email', address }, onApprove: 'end_approved', onDeny: 'end_denied' };
// @ts-expect-error workflow notifications go to placeholders only
export const badNotify: S.WorkflowStep = { id: step, kind: 'notify', name: 'x', to: [{ kind: 'email', address }], emailTemplate: ref, next: 'end' };
// @ts-expect-error var nodes name a namespaced variable
export const badVar: S.VarNode = { type: 'var', attrs: { name: 'event_name' } };
// @ts-expect-error there is no 'survey' template kind
export const badKind: S.TemplateKind = 'survey';

test('the seven kinds are exactly the payload discriminants', () => {
  expectTypeOf<S.TemplateVersionPayload['kind']>().toEqualTypeOf<S.TemplateKind>();
  expectTypeOf<S.TemplateKind>().toEqualTypeOf<'form' | 'theme' | 'email' | 'ending' | 'pdf' | 'snippet' | 'workflow'>();
  expectTypeOf(kindsOk).toEqualTypeOf<true>();
  expectTypeOf<Extract<S.RecipientPlaceholder, { kind: 'email' | 'member' }>>().toBeNever();
});
