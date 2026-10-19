import { defineMessages } from '@form/i18n';
import { DEFAULT_COMPLIANCE, REGISTRY, type AvailableType } from '@form/registry';
import {
  SCHEMA_VERSION, toPlain,
  type Block, type BlockConfigMap, type BlockId, type EndingId, type FieldBlock, type FieldKey, type FormDefinition, type FormId,
  type InlineDoc, type PageId, type PaletteEntry, type PurposeId, type RichDoc, type StoredBlock, type ValueFieldType,
} from '@form/schema';
import { uniqueKey } from '@form/templates-core';
import { BUILDER_LOCALE, BUILDER_TIME_ZONE, t } from '@/i18n';
import { uid } from '@/lib/utils';

/*
 * The v2 definition helpers the builder shares: a blank form, new blocks from registry palette entries, keys, and
 * the placement of blocks on pages. Everything here is pure; new ids come from an IdSource so tests replay.
 */

export interface IdSource {
  newId: () => string;
}

export const APP_IDS: IdSource = { newId: uid };

const M = defineMessages('builder', {
  'form.default_purpose': 'Respond to this form',
  'form.default_purpose_description': 'Read and act on what you send in this form.',
  'form.default_purpose_justification': 'The respondent provides these details to have this form handled.',
  'form.ending_name': 'Thank you',
  'form.ending_message': 'Thanks for your response!',
  'form.submit_label': 'Submit',
  'form.closed_message': 'This form is no longer accepting responses.',
});

export const inlineDoc = (text: string): InlineDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });
export const richDoc = (text: string): RichDoc => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });

/** The plain text of a label or rich text, for lists and dialogs. */
export const plainText = (doc: InlineDoc | RichDoc | undefined): string => (doc ? toPlain(doc) : '');

export const closedMessage = (): RichDoc => richDoc(t(M['form.closed_message']));

/** A new, empty form: one empty page, a thank-you ending and the default purpose (schema §4.2 defaults). */
export function blankDefinition(formId: string, ids: IdSource = APP_IDS): FormDefinition {
  const purposeId = ids.newId() as PurposeId;
  const endingId = ids.newId() as EndingId;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    formId: formId as FormId,
    title: '',
    blocks: {},
    pages: [{ id: ids.newId() as PageId, children: [] }],
    endings: [{ id: endingId, kind: 'message', name: t(M['form.ending_name']), content: richDoc(t(M['form.ending_message'])), actions: [{ kind: 'fill_again', prefill: 'none' }], confetti: true }],
    defaultEndingId: endingId,
    logic: { rules: [], ruleGroups: [], variables: [] },
    privacy: {
      fiduciary: {
        legalName: [{ var: { name: 'org.legal_name' } }],
        contactEmail: [{ var: { name: 'org.support_email' } }],
        privacyContact: { name: [{ var: { name: 'org.privacy_contact.name' } }], email: [{ var: { name: 'org.privacy_contact.email' } }] },
        rightsUrl: [{ var: { name: 'org.rights_url' } }],
        boardComplaintInfo: [{ var: { name: 'org.board_complaint_info' } }],
      },
      purposes: [{
        id: purposeId,
        name: t(M['form.default_purpose']),
        description: inlineDoc(t(M['form.default_purpose_description'])),
        lawfulBasis: { kind: 'legitimate_use', ground: 's7a_voluntarily_provided_for_specified_purpose', justification: t(M['form.default_purpose_justification']) },
        retention: { kind: 'org_default' },
      }],
      children: { mode: 'not_applicable' },
      encryption: { mode: 'server' },
      dropAnswersWithoutConsent: true,
      networkSignals: { ipHash: true, userAgentHash: true, ttlDays: 30 },
    },
    theme: {
      layout: 'classic',
      tokens: {
        colors: {},
        typography: { body: 'inter' as FormDefinition['theme']['tokens']['typography']['body'], baseSizePx: 16 },
        radius: 'md',
        density: 'comfortable',
        formWidth: 'normal',
        labelAlign: 'top',
        inputStyle: 'outlined',
        progress: 'none',
      },
    },
    behavior: {
      submit: { label: t(M['form.submit_label']), align: 'left' },
      navigation: { allowBack: true, showPageTitles: false },
      saveAndResume: { enabled: false, showButton: false, delivery: [], expiryDays: 30 },
      localAutosave: { enabled: false, allowWithSensitive: false },
      timeZone: BUILDER_TIME_ZONE,
      spam: { honeypot: true, minFillSeconds: 3, captcha: 'off' },
      urlPrefill: false,
      showBranding: true,
      a11y: { announceErrors: 'polite', focusFirstError: true },
      successAnimation: true,
    },
    i18n: {
      defaultLocale: BUILDER_LOCALE,
      locales: [{ locale: BUILDER_LOCALE, direction: 'ltr' }],
      detect: ['url_param'],
      urlParam: 'lang',
      switcher: 'none',
      messages: {},
      systemMessages: {},
      reviewedConsentLocales: [],
    },
  };
}

export const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

/** Every key in use: value blocks and logic variables share one namespace (I3). */
export function takenKeys(def: FormDefinition, except?: BlockId): Set<string> {
  const taken = new Set<string>();
  for (const [id, block] of Object.entries(def.blocks)) if (id !== except && isField(block)) taken.add(block.key);
  for (const v of def.logic.variables) taken.add(v.key);
  return taken;
}

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** A key made from `text` (or the type), unique in the form. */
export function freshKey(def: FormDefinition, base: string): FieldKey {
  let key = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!/^[a-z]/.test(key)) key = `f_${key}`.replace(/_+$/, '');
  return uniqueKey(key || 'field', takenKeys(def)) as FieldKey;
}

/** A block for a registry palette entry: the type's default config with the entry's overrides (FND-03). */
export function createBlock(entry: Pick<PaletteEntry<AvailableType>, 'configOverrides'> & { type: AvailableType }, def: FormDefinition, ids: IdSource = APP_IDS): Block {
  const id = ids.newId() as BlockId;
  const config = { ...REGISTRY[entry.type].defaultConfig(def.i18n.defaultLocale), ...entry.configOverrides } as BlockConfigMap[AvailableType];
  if (entry.type === 'heading' || entry.type === 'paragraph' || entry.type === 'divider') return { id, type: entry.type, config } as Block;
  const type = entry.type as Extract<AvailableType, ValueFieldType>;
  const defaults = DEFAULT_COMPLIANCE[type];
  const purpose = def.privacy.purposes[0]?.id;
  return {
    id,
    type,
    key: freshKey(def, type),
    label: inlineDoc(''),
    required: false,
    compliance: { ...defaults, purposeIds: defaults.classification === 'none' || !purpose ? [] : [purpose] },
    config,
  } as Block;
}

export type Parent = { pageId: PageId } | { blockId: BlockId };

/** Children of a container block (sections, repeating groups); none for anything else. */
export const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** Every placed block id in document order (pages, then children depth-first). */
export function blockOrder(def: FormDefinition): BlockId[] {
  const out: BlockId[] = [];
  const visit = (id: BlockId) => {
    out.push(id);
    childrenOf(def.blocks[id]).forEach(visit);
  };
  for (const page of def.pages) page.children.forEach(visit);
  return out;
}

/** Where a block sits: its parent (a page or a container) and its index there. */
export function placementOf(def: FormDefinition, id: BlockId): { parent: Parent; index: number; pageId: PageId } | null {
  for (const page of def.pages) {
    const top = page.children.indexOf(id);
    if (top >= 0) return { parent: { pageId: page.id }, index: top, pageId: page.id };
    const stack = [...page.children];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const children = childrenOf(def.blocks[next]);
      const at = children.indexOf(id);
      if (at >= 0) return { parent: { blockId: next }, index: at, pageId: page.id };
      stack.push(...children);
    }
  }
  return null;
}

/** The label of a block as plain text, for pickers and dialogs; empty when it has none. */
export function blockText(block: StoredBlock | undefined): string {
  if (!block || block.type === 'unsupported') return '';
  if ('label' in block) return plainText(block.label).trim();
  if (block.type === 'heading') return plainText(block.config.text).trim();
  if (block.type === 'paragraph') return plainText(block.config.content).trim();
  return '';
}
