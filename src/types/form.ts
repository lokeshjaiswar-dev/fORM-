export type FieldType =
  | 'heading'
  | 'heading_2'
  | 'heading_3'
  | 'paragraph'
  | 'divider'
  | 'page_break'
  | 'thank_you'
  | 'text'
  | 'long_text'
  | 'number'
  | 'email'
  | 'phone'
  | 'url'
  | 'dropdown'
  | 'multiple_choice'
  | 'checkbox'
  | 'multi_select'
  | 'date'
  | 'time'
  | 'rating'
  | 'linear_scale'
  | 'nps'
  | 'ranking'
  | 'file_upload'
  | 'signature'
  | 'hidden';

export interface BlockOption {
  id: string;
  label: string;
  value: string;
}

export interface BlockValidation {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  errorMessage?: string;
}

export type LogicOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'answered'
  | 'not_answered'
  | 'is_empty';

export interface BlockLogic {
  enabled?: boolean;
  action?: 'show' | 'hide';
  sourceBlockId?: string;
  operator?: LogicOperator;
  value?: string;
}

export interface BlockCustomize {
  hideLabel?: boolean;
  defaultValue?: string;
  width?: 'full' | 'half';
  besidePrevious?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  prefix?: string;
  suffix?: string;
  showCharCount?: boolean;
  allowMultiple?: boolean;
  otherOption?: boolean;
  randomize?: boolean;
  ratingMax?: number;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  labelColor?: string;
  inputTextColor?: string;
  inputBg?: string;
  borderColor?: string;
  labelSize?: number;
  inputSize?: number;
  labelWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  align?: 'left' | 'center';
  placeholderColor?: string;
}

export interface FormBlock {
  id: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  helpText?: string;
  options?: BlockOption[];
  validation?: BlockValidation;
  logic?: BlockLogic;
  customize?: BlockCustomize;
  order: number;
}

export interface FormSettings {
  submitButtonText: string;
  successMessage: string;
  themeColor: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  font: string;
  progressBar: boolean;
  redirectUrl: string;
  closed: boolean;
  closedMessage: string;
  password: string;
  logoUrl: string;
  coverUrl: string;
  successAnimation: boolean;
}

export interface FormSchema {
  id: string;
  title: string;
  description: string;
  blocks: FormBlock[];
  settings: FormSettings;
}

export type BuilderMode = 'edit' | 'preview';
export type PreviewDevice = 'desktop' | 'tablet' | 'mobile';
