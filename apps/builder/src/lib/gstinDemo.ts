import type {
  BlockId, ConditionId, FieldBlock, FormDefinition, OptionId, Rule, RuleId, StoredBlock,
} from '@form/schema';
import { APP_IDS, blankDefinition, createBlock, inlineDoc, isField, placementOf, richDoc, type IdSource } from '@/lib/definition';

const STATES: Array<{ id: string; label: string; code: string }> = [
  { id: 'mh', label: 'Maharashtra', code: '27' },
  { id: 'ka', label: 'Karnataka', code: '29' },
  { id: 'dl', label: 'Delhi', code: '07' },
  { id: 'gj', label: 'Gujarat', code: '24' },
  { id: 'tn', label: 'Tamil Nadu', code: '33' },
];

function add(def: FormDefinition, ids: IdSource, type: Parameters<typeof createBlock>[0]['type'], patch: Record<string, unknown> = {}, configOverrides: Record<string, unknown> = {}): StoredBlock {
  const { label, key, required, ...rest } = patch;
  const made = createBlock({ type, configOverrides }, def, ids) as StoredBlock;
  const next: StoredBlock = { ...made, ...rest } as StoredBlock;
  if (isField(next)) {
    if (typeof key === 'string') (next as FieldBlock).key = key as FieldBlock['key'];
    if (typeof label === 'string') next.label = inlineDoc(label);
    if (required === true) next.required = true;
  }
  def.blocks[next.id] = next;
  const page = def.pages[0];
  if (page) page.children = [...page.children, next.id];
  return next;
}

function gstinRule(ids: IdSource, gstin: BlockId, state: BlockId, atPage: FormDefinition['pages'][number]['id'] | undefined): Rule {
  return {
    id: ids.newId() as RuleId,
    name: 'GSTIN matches state code',
    enabled: true,
    when: {
      kind: 'group',
      id: ids.newId() as ConditionId,
      combinator: 'all',
      children: [
        { kind: 'condition', id: ids.newId() as ConditionId, left: { kind: 'ref', ref: { kind: 'answer', blockId: gstin } }, op: 'is_answered' },
        { kind: 'condition', id: ids.newId() as ConditionId, left: { kind: 'ref', ref: { kind: 'answer', blockId: state } }, op: 'is_answered' },
        {
          kind: 'condition',
          id: ids.newId() as ConditionId,
          left: { kind: 'ref', ref: { kind: 'answer', blockId: gstin } },
          op: 'not_starts_with',
          right: { kind: 'ref', ref: { kind: 'answer', blockId: state } },
        },
      ],
    },
    then: [{
      type: 'block_submit',
      message: 'GSTIN does not match the selected state. It must start with that state’s code (for example 27 for Maharashtra).',
      anchorBlockId: gstin,
      ...(atPage ? { atPage } : {}),
    }],
  };
}

/** A disposable form: State dropdown (GST codes) + GSTIN, with a Form-settings check that blocks a mismatch. */
export function gstinDemoDefinition(formId: string, ids: IdSource = APP_IDS): FormDefinition {
  const def = blankDefinition(formId, ids);
  def.title = 'Demo: GSTIN vs State';
  def.description = richDoc('Pick a state, then enter a GSTIN. A mismatch blocks submit. Delete this form from the list when you are done.');
  add(def, ids, 'heading', {}, { level: 1, text: inlineDoc('GSTIN vs State') });
  add(def, ids, 'paragraph', {}, {
    content: richDoc('Try Karnataka’s code (29…) while Maharashtra is selected — submit should fail. Then use 27AAAAA0000A1Z5 with Maharashtra — submit should succeed.'),
  });
  const state = add(def, ids, 'single_choice', { key: 'state', label: 'State', required: true }, {
    display: 'dropdown',
    searchable: true,
    placeholder: 'Select a state',
    options: STATES.map((s) => ({ id: s.id as OptionId, label: s.label, code: s.code })),
  });
  const gstin = add(def, ids, 'short_text', { key: 'gstin', label: 'GSTIN', required: true }, {
    preset: 'in_gstin',
    placeholder: '27AAAAA0000A1Z5',
    maxLength: 15,
  });
  def.logic = { ...def.logic, rules: [gstinRule(ids, gstin.id, state.id, placementOf(def, gstin.id)?.pageId)] };
  return def;
}
