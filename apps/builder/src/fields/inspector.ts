import type { ComponentType } from 'react';
import type { AvailableType } from '@form/registry';
import {
  ChoiceGeneral, ChoiceOptions, ChromeGeneral, DateGeneral, DividerGeneral, EndLabels, FileValidation, HeadingGeneral, HiddenGeneral, LongTextGeneral,
  LongTextValidation, MultiChoiceValidation, NumberGeneral, NumberValidation, PhoneGeneral, RatingGeneral, ScaleGeneral, ShortTextValidation,
  SignatureGeneral, TimeGeneral, type InspectorProps,
} from '@/fields/inspectorViews';

/*
 * The inspector view of every available block type (FND-03): the type's own settings in the General, Options and
 * Validation sections. The envelope settings every block shares (key, label options, width, required, logic,
 * privacy) are in BlockInspector. Edits replace the block's `config`; the command checks it against the type's twin.
 */

export type { InspectorProps };

export interface InspectorView<T extends AvailableType> {
  general?: ComponentType<InspectorProps<T>>;
  options?: ComponentType<InspectorProps<T>>;
  validation?: ComponentType<InspectorProps<T>>;
}

export const INSPECTOR: { readonly [T in AvailableType]: InspectorView<T> } = {
  short_text: { general: ChromeGeneral, validation: ShortTextValidation },
  long_text: { general: LongTextGeneral, validation: LongTextValidation },
  email: { general: ChromeGeneral },
  phone: { general: PhoneGeneral },
  number: { general: NumberGeneral, validation: NumberValidation },
  url: { general: ChromeGeneral },
  single_choice: { general: ChoiceGeneral, options: ChoiceOptions },
  multi_choice: { general: ChoiceGeneral, options: ChoiceOptions, validation: MultiChoiceValidation },
  date: { general: DateGeneral },
  time: { general: TimeGeneral },
  rating: { general: RatingGeneral },
  linear_scale: { general: ScaleGeneral },
  nps: { general: EndLabels },
  ranking: { options: ChoiceOptions },
  file_upload: { validation: FileValidation },
  signature: { general: SignatureGeneral },
  hidden: { general: HiddenGeneral },
  heading: { general: HeadingGeneral },
  paragraph: {},
  divider: { general: DividerGeneral },
};
