import type { ConsentItemId, Locale, RichDoc } from '@form/schema';
import { defineField, isBlank } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const emptyDoc = (): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** FLD-36 terms mode: one required checkbox plus a notice. DPDP extras stay on the config for later. */
export const consent = defineField({
  type: 'consent',
  palette: [entry('consent', null, 'advanced', PALETTE_LABELS['palette.consent'], 'check-square', ['terms', 'conditions', 'consent', 'agree', 'privacy', 'gdpr', 'dpdp'])],
  defaultConfig: (locale: Locale) => ({
    mode: 'terms' as const,
    notice: emptyDoc(),
    itemiseData: false,
    items: [{
      id: 'item_1' as ConsentItemId,
      label: { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: message(locale, DEFAULT_TEXT['defaults.terms_item']) }] }] },
      requiredToSubmit: true,
      defaultChecked: false as const,
    }],
    presentation: 'checkboxes' as const,
    noticeVersion: 0,
  }),
  checkConfig: (config, report) => {
    if (config.items.length < 1) report('items must not be empty', ['items']);
    if (config.mode === 'terms' && config.items.length !== 1) report('terms mode needs exactly one item', ['items']);
  },
  checkAnswer: (value, block, _state, report) => {
    for (const item of block.config.items) {
      if (item.requiredToSubmit && value.items[item.id] !== true) report('required', ['items', item.id]);
    }
    if (block.config.presentation === 'scroll_to_agree' && value.scrolledToEnd !== true) report('required', ['scrolledToEnd']);
  },
  paths: { '': 'boolean' },
  operators: { boolean: [...PRESENCE_OPS, 'eq', 'neq'] },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'boolean', v: Object.values(value.items).some((granted) => granted === true) } : NULL),
  isEmpty: (value) => isBlank(value.items) || Object.values(value.items).every((granted) => granted === undefined),
  cells: (value, block) => block.config.items.map((item) => (value.items[item.id] === true ? 'yes' : value.items[item.id] === false ? 'no' : '')),
  columns: (block) => block.config.items.map((item, i) => ({ suffix: `.${item.id}`, header: `Terms ${i + 1}` })),
  hasDefault: () => false,
});
