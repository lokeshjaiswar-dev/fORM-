import type { FieldType, FormBlock } from '@/types/form';
import { uid } from '@/lib/utils';

export interface FieldMeta {
  type: FieldType;
  label: string;
  description: string;
  category: 'Layout' | 'Text' | 'Contact' | 'Choice' | 'Rating' | 'Media';
}

export const FIELD_CATALOG: FieldMeta[] = [
  { type: 'heading', label: 'Heading 1', description: 'Large title', category: 'Layout' },
  { type: 'heading_2', label: 'Heading 2', description: 'Medium title', category: 'Layout' },
  { type: 'heading_3', label: 'Heading 3', description: 'Small title', category: 'Layout' },
  { type: 'paragraph', label: 'Text', description: 'Body copy', category: 'Layout' },
  { type: 'divider', label: 'Divider', description: 'Horizontal line', category: 'Layout' },
  { type: 'page_break', label: 'Page break', description: 'New page', category: 'Layout' },
  { type: 'thank_you', label: 'Thank you', description: 'End screen', category: 'Layout' },
  { type: 'text', label: 'Short answer', description: 'Single line', category: 'Text' },
  { type: 'long_text', label: 'Long answer', description: 'Multi-line', category: 'Text' },
  { type: 'number', label: 'Number', description: 'Numeric value', category: 'Text' },
  { type: 'hidden', label: 'Hidden field', description: 'Not shown to respondents', category: 'Text' },
  { type: 'email', label: 'Email', description: 'Email address', category: 'Contact' },
  { type: 'phone', label: 'Phone', description: 'Phone number', category: 'Contact' },
  { type: 'url', label: 'Link', description: 'Website URL', category: 'Contact' },
  { type: 'signature', label: 'Signature', description: 'Draw a signature', category: 'Contact' },
  { type: 'dropdown', label: 'Dropdown', description: 'Select one', category: 'Choice' },
  { type: 'multiple_choice', label: 'Multiple choice', description: 'Radio options', category: 'Choice' },
  { type: 'checkbox', label: 'Checkboxes', description: 'Select many', category: 'Choice' },
  { type: 'multi_select', label: 'Multi-select', description: 'Dropdown, many', category: 'Choice' },
  { type: 'date', label: 'Date', description: 'Pick a date', category: 'Rating' },
  { type: 'time', label: 'Time', description: 'Pick a time', category: 'Rating' },
  { type: 'rating', label: 'Rating', description: 'Stars', category: 'Rating' },
  { type: 'linear_scale', label: 'Linear scale', description: 'Numeric scale', category: 'Rating' },
  { type: 'nps', label: 'NPS', description: '0–10 score', category: 'Rating' },
  { type: 'ranking', label: 'Ranking', description: 'Order options', category: 'Rating' },
  { type: 'file_upload', label: 'File upload', description: 'Attach a file', category: 'Media' },
];

export const CATEGORIES = ['Layout', 'Text', 'Contact', 'Choice', 'Rating', 'Media'] as const;

const DEFAULT_OPTIONS = () => [
  { id: uid(), label: 'Option 1', value: 'option_1' },
  { id: uid(), label: 'Option 2', value: 'option_2' },
  { id: uid(), label: 'Option 3', value: 'option_3' },
];

const CHOICE: FieldType[] = ['dropdown', 'multiple_choice', 'checkbox', 'multi_select', 'ranking'];

export function createBlock(type: FieldType, order: number): FormBlock {
  const meta = FIELD_CATALOG.find((f) => f.type === type)!;
  const choice = CHOICE.includes(type);
  return {
    id: uid(),
    type,
    label: '',
    placeholder: isContentBlock(type) ? undefined : `Enter ${meta.label.toLowerCase()}`,
    helpText: '',
    options: choice ? DEFAULT_OPTIONS() : undefined,
    validation: { required: false },
    customize: {
      ratingMax: 5,
      scaleMin: 1,
      scaleMax: 5,
      scaleMinLabel: 'Low',
      scaleMaxLabel: 'High',
    },
    order,
  };
}

export function isContentBlock(type: FieldType) {
  return (
    type === 'heading' ||
    type === 'heading_2' ||
    type === 'heading_3' ||
    type === 'paragraph' ||
    type === 'divider' ||
    type === 'page_break' ||
    type === 'thank_you'
  );
}

export function isInputBlock(type: FieldType) {
  return !isContentBlock(type) && type !== 'hidden';
}
