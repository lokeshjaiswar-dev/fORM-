import type * as S from '../src/index.ts';
import { definition, id, ids } from './fixtures.ts';

/* One small, valid payload per template kind (06-templates.md §1), with var nodes, brand refs, locks and placeholders. */

const legalName: S.VarNode = { type: 'var', attrs: { name: 'org.legal_name', fallback: 'Our organisation' } };
const eventName: S.VarNode = { type: 'var', attrs: { name: 'custom.event_name' } };

const common = (): Omit<S.FormTemplatePayload, 'kind' | 'document' | 'dataInventory' | 'estimatedMinutes'> => ({
  schemaVersion: 2,
  variables: [
    { name: 'org.legal_name', source: 'org_profile', type: 'text', label: 'Legal name', required: true, binding: 'live' },
    { name: 'custom.event_name', source: 'prompt', type: 'text', label: 'Event name', help: 'Shown in the title', required: true, binding: 'bake' },
    { name: 'custom.dietary', source: 'prompt', type: 'boolean', label: 'Ask about dietary needs?', required: false, default: false, binding: 'bake' },
  ],
  locks: [],
  requiredFeatures: [],
  i18n: { defaultLocale: id<S.Locale>('en-IN'), locales: [{ locale: id<S.Locale>('en-IN'), direction: 'ltr' }], messages: {} },
});

const templateRef: S.TemplateRef = { templateId: id<S.TemplateId>('tpl_theme'), versionId: id<S.TemplateVersionId>('tplv_theme_1') };

export function themePayload(): S.ThemeTemplatePayload {
  return {
    ...common(),
    variables: [],
    kind: 'theme',
    layout: 'cards',
    tokens: { ...definition().theme.tokens, colors: { accent: { ref: 'brand.primary' } }, logo: { image: { ref: 'brand.logo' }, position: 'left' } },
    customCss: '.fr-root h1 { letter-spacing: 0.01em; }',
    locks: [{ id: id<S.LockId>('lock_brand'), target: { kind: 'theme', tokens: ['colors.accent', 'logo'] }, modes: ['content'], reason: 'Brand guidelines' }],
  };
}

export function emailPayload(): S.EmailTemplatePayload {
  return {
    ...common(),
    kind: 'email',
    role: 'autoresponder',
    subject: ['Thanks for registering for ', { var: eventName.attrs }],
    body: {
      type: 'email_doc',
      content: [
        { type: 'brandBlock', attrs: { part: 'header' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Regards, ' }, legalName] },
        { type: 'answersTable', attrs: { include: 'all', hideEmpty: true, maskSensitive: true } },
        { type: 'button', attrs: { label: 'Withdraw consent', action: 'withdraw_consent' } },
      ],
    },
    headerRef: { ref: 'brand.email_header' },
    footerRef: { ref: 'brand.legal_footer' },
    replyTo: { kind: 'role', role: 'form_owner' },
    defaultRecipients: [{ kind: 'field', blockId: id<S.BlockId>('email_1') }],
    includeWithdrawalLink: true,
    locks: [{ id: id<S.LockId>('lock_footer'), target: { kind: 'email', sourceId: 'autoresponder', parts: ['footer'] }, modes: ['content', 'presence'], reason: 'Legal footer' }],
  };
}

export function endingPayload(): S.EndingTemplatePayload {
  return {
    ...common(),
    kind: 'ending',
    role: 'thank_you',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See you at ' }, eventName] }] },
    actions: [{ kind: 'fill_again', prefill: 'none' }],
    redirect: ['https://example.org/events'],
    confetti: true,
  };
}

export function pdfPayload(): S.PdfTemplatePayload {
  return {
    ...common(),
    kind: 'pdf',
    layout: {
      pageSize: 'A4',
      orientation: 'portrait',
      marginsMm: { top: 20, right: 15, bottom: 20, left: 15 },
      header: { type: 'doc', content: [{ type: 'image', attrs: { asset: { ref: 'brand.logo' } } }] },
      footer: { type: 'doc', content: [{ type: 'paragraph', content: [legalName] }] },
      fields: { mode: 'by_classification', include: ['personal'] },
      hideEmpty: true,
      maskSensitive: true,
      watermark: [{ var: legalName.attrs }],
    },
  };
}

export function snippetPayload(): S.SnippetTemplatePayload {
  const form = definition();
  const { consent } = ids;
  const block = form.blocks[consent];
  if (block?.type !== 'consent') throw new Error('fixture drifted');
  return {
    ...common(),
    kind: 'snippet',
    rootId: consent,
    blocks: { [consent]: block },
    rules: [],
    logicVariables: [],
    purposes: form.privacy.purposes,
    insertHints: { preferredPosition: 'start', oncePerForm: true },
    locks: [{ id: id<S.LockId>('lock_consent'), target: { kind: 'block', sourceId: consent }, modes: ['content', 'presence'], reason: 'Legal-approved consent text' }],
  };
}

export function workflowPayload(): S.WorkflowTemplatePayload {
  const approve = id<S.WorkflowStepId>('step_approve');
  const notify = id<S.WorkflowStepId>('step_notify');
  return {
    ...common(),
    kind: 'workflow',
    workflow: {
      id: id<S.WorkflowId>('wf_1'),
      name: 'Manager approval',
      start: approve,
      steps: [
        { id: approve, kind: 'approval', name: 'Manager', approver: { kind: 'role', role: 'team_admins' }, onApprove: notify, onDeny: 'end_denied' },
        { id: notify, kind: 'notify', name: 'Tell the applicant', to: [{ kind: 'field', blockId: id<S.BlockId>('email_1') }], emailTemplate: templateRef, next: 'end' },
      ],
    },
  };
}

export function formPayload(): S.FormTemplatePayload {
  const document = definition();
  const name = document.blocks[ids.name];
  if (name?.type !== 'short_text') throw new Error('fixture drifted');
  document.title = 'Event registration';
  document.blocks[ids.name] = { ...name, label: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name for ' }, eventName] }] } };
  return {
    ...common(),
    kind: 'form',
    document,
    refs: { theme: templateRef, endings: [endingPayload()], emails: [emailPayload()] },
    dataInventory: [{ purposeName: 'Respond to this form', fieldSourceIds: [ids.name], classification: 'personal', suggestedRetentionDays: 365, encrypted: false }],
    estimatedMinutes: 2,
    optionalParts: [{ id: id<S.TemplatePartId>('part_dietary'), label: 'Dietary preferences', when: { variable: 'custom.dietary', equals: true }, includes: { blockSourceIds: [ids.marketing] } }],
    locks: [{ id: id<S.LockId>('lock_purpose'), target: { kind: 'purpose', sourceId: ids.respond }, modes: ['content'], reason: 'Approved purpose text' }],
  };
}

export const PAYLOADS: { [K in S.TemplateKind]: () => Extract<S.TemplateVersionPayload, { kind: K }> } = {
  form: formPayload,
  theme: themePayload,
  email: emailPayload,
  ending: endingPayload,
  pdf: pdfPayload,
  snippet: snippetPayload,
  workflow: workflowPayload,
};

export const manifest = (): S.FormpackManifest => ({
  format: 'fORM-template-bundle',
  formatVersion: 1,
  pack: { publisher: 'fORM-', name: 'system-core', version: '2026.10.0' },
  minAppVersion: '1.4.0',
  schemaVersion: 2,
  templates: [{
    slug: 'core/event-registration',
    kind: 'form',
    version: 1,
    path: 'templates/event-registration.v1.json',
    sha256: id<S.Sha256Hex>('a'.repeat(64)),
    requiredFeatures: ['field:short_text'],
    dependsOn: ['core/theme-corporate@1'],
  }],
  categories: 'categories.json',
  attestations: 'attestations.json',
  assets: [{ path: 'assets/logo.png', sha256: id<S.Sha256Hex>('b'.repeat(64)), mime: 'image/png', bytes: 48213 }],
});
