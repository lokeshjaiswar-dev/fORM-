import { toPlain, type Block, type FieldBlock, type FormDefinition, type LabelText, type StoredBlock } from '@form/schema';
import { createBlock } from '@/lib/fields';
import { defaultSettings } from '@/lib/defaultSettings';
import { textToV1Html, toV1Html } from '@/lib/v1html';
import type { BlockOption, FieldType, FormBlock, FormSchema } from '@/types/form';

/*
 * The builder still edits the v1 store, so a form instantiated from a v2 template is shown through it until WP-0.11b
 * moves the store to v2 documents. Covers what the v1 store can hold: the P0 block types, required, placeholders,
 * help text, options, scale and rating settings, pages (as page breaks), the default ending's message and the theme
 * colours. Blocks and rules it cannot hold are counted in `skipped`.
 */

const SAME: Partial<Record<Block['type'], FieldType>> = {
  short_text: 'text', long_text: 'long_text', email: 'email', phone: 'phone', url: 'url', number: 'number', date: 'date', time: 'time',
  rating: 'rating', linear_scale: 'linear_scale', nps: 'nps', ranking: 'ranking', file_upload: 'file_upload', signature: 'signature',
  hidden: 'hidden', paragraph: 'paragraph', divider: 'divider',
};

function v1Type(block: Block): FieldType | undefined {
  switch (block.type) {
    case 'heading':
      return block.config.level === 1 ? 'heading' : block.config.level === 2 ? 'heading_2' : 'heading_3';
    case 'single_choice':
      return block.config.display === 'dropdown' ? 'dropdown' : 'multiple_choice';
    case 'multi_choice':
      return block.config.display === 'dropdown' ? 'multi_select' : 'checkbox';
    default:
      return SAME[block.type];
  }
}

const plainText = (text: LabelText | undefined): string =>
  typeof text === 'string' ? text : (text ?? []).map((part) => (typeof part === 'string' ? part : 'var' in part ? part.var.fallback ?? '' : part.pipe.fallback ?? '')).join('');

const hex = (value: unknown): string | undefined => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined);

function fieldParts(block: FieldBlock, v1: FormBlock): void {
  v1.label = toV1Html(block.label);
  v1.helpText = block.description ? toV1Html(block.description) : '';
  v1.validation = { ...v1.validation, required: block.required };
  if (block.hideLabel) v1.customize = { ...v1.customize, hideLabel: true };
  const config = block.config as Record<string, unknown>;
  if (typeof config['placeholder'] === 'string') v1.placeholder = config['placeholder'];
  switch (block.type) {
    case 'single_choice':
    case 'multi_choice':
    case 'ranking': {
      v1.options = block.config.options.map((o): BlockOption => ({ id: o.id, label: plainText(o.label), value: o.code ?? plainText(o.label) }));
      if ('other' in block.config && block.config.other?.enabled) v1.customize = { ...v1.customize, otherOption: true };
      if (block.config.shuffle) v1.customize = { ...v1.customize, randomize: true };
      break;
    }
    case 'number':
      v1.validation = {
        ...v1.validation,
        ...(block.config.min !== undefined ? { min: Number(block.config.min) } : {}),
        ...(block.config.max !== undefined ? { max: Number(block.config.max) } : {}),
      };
      break;
    case 'rating':
      v1.customize = { ...v1.customize, ratingMax: block.config.max };
      break;
    case 'linear_scale':
      v1.customize = { ...v1.customize, scaleMin: block.config.min, scaleMax: block.config.max, scaleMinLabel: block.config.lowLabel ?? '', scaleMaxLabel: block.config.highLabel ?? '' };
      break;
    case 'file_upload':
      if (block.config.maxFiles > 1) v1.customize = { ...v1.customize, allowMultiple: true };
      break;
    default:
      break;
  }
}

function v1Block(block: StoredBlock, order: number): FormBlock | null {
  if (block.type === 'unsupported') return null;
  const type = v1Type(block);
  if (!type) return null;
  const v1: FormBlock = { ...createBlock(type, order), id: block.id };
  if ('compliance' in block) fieldParts(block, v1);
  else if (block.type === 'heading') v1.label = toV1Html(block.config.text);
  else if (block.type === 'paragraph') v1.label = toV1Html(block.config.content);
  return v1;
}

export function v1FromV2(def: FormDefinition): { form: FormSchema; skipped: number } {
  const blocks: FormBlock[] = [];
  let skipped = def.logic.rules.length;
  def.pages.forEach((page, i) => {
    if (i > 0) blocks.push({ ...createBlock('page_break', blocks.length), id: page.id, label: textToV1Html(plainText(page.title)) });
    for (const id of page.children) {
      const block = def.blocks[id];
      const v1 = block ? v1Block(block, blocks.length) : null;
      if (v1) blocks.push(v1);
      else skipped += 1;
    }
  });
  const ending = def.endings.find((e) => e.id === def.defaultEndingId);
  const colors = def.theme.tokens.colors;
  const defaults = defaultSettings();
  const form: FormSchema = {
    id: def.formId,
    title: def.title,
    description: def.description ? toPlain(def.description) : '',
    blocks,
    settings: {
      ...defaults,
      submitButtonText: plainText(def.behavior.submit.label) || defaults.submitButtonText,
      successMessage: ending?.kind === 'message' ? toPlain(ending.content) : defaults.successMessage,
      accentColor: hex(colors.accent) ?? defaults.accentColor,
      backgroundColor: hex(colors.page) ?? defaults.backgroundColor,
      textColor: hex(colors.text) ?? defaults.textColor,
      progressBar: def.theme.tokens.progress !== 'none',
      successAnimation: def.behavior.successAnimation,
    },
  };
  return { form, skipped };
}
