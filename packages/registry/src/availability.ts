import type { BlockType } from '@form/schema';

export type Phase = 'P0' | 'P1' | 'P2';

/** Types with a full registry entry: palette, answer schema, operators, export and lint. */
export const AVAILABLE_TYPES = [
  'short_text', 'long_text', 'full_name', 'email', 'phone', 'address', 'number', 'url', 'single_choice', 'multi_choice',
  'date', 'datetime', 'time', 'rating', 'linear_scale', 'nps', 'ranking', 'matrix', 'repeating_group', 'file_upload',
  'signature', 'hidden', 'consent', 'calculation', 'context', 'unique_id', 'appointment', 'captcha', 'heading',
  'paragraph', 'divider', 'section',
] as const satisfies readonly BlockType[];
export type AvailableType = (typeof AVAILABLE_TYPES)[number];
/** Types registered through `defineStub`: real config schema, no palette, refused by compile. */
export type StubType = Exclude<BlockType, AvailableType>;

/** The phase each stubbed type becomes available in (feature matrix FLD rows). */
export const STUB_AVAILABILITY: { readonly [T in StubType]: Exclude<Phase, 'P0'> } = {
  payment: 'P2',
  image: 'P2',
};

const AVAILABLE: ReadonlySet<string> = new Set(AVAILABLE_TYPES);

export const isAvailable = (type: string): type is AvailableType => AVAILABLE.has(type);

export const availability = (type: BlockType): Phase => (isAvailable(type) ? 'P0' : STUB_AVAILABILITY[type]);
