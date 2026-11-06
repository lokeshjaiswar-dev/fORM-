import type { ComponentType } from 'react';
import type { AvailableType } from '@form/registry';
import {
  AddressGeneral, AppointmentGeneral, CalculationGeneral, ChoiceGeneral, ChoiceOptions, ChromeGeneral, ConsentGeneral, ContextGeneral, DateGeneral, DateTimeGeneral, DividerGeneral, EmailGeneral, EndLabels, FileValidation, HeadingGeneral, HiddenGeneral, LongTextGeneral, UniqueIdGeneral, SectionGeneral,
  LongTextValidation, MatrixGeneral, MultiChoiceValidation, NumberGeneral, NumberValidation, PhoneGeneral, RatingGeneral, RepeatingGroupGeneral, ScaleGeneral, ShortTextValidation,
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
  full_name: {},
  email: { general: EmailGeneral },
  phone: { general: PhoneGeneral },
  address: { general: AddressGeneral },
  datetime: { general: DateTimeGeneral },
  consent: { general: ConsentGeneral },
  unique_id: { general: UniqueIdGeneral },
  appointment: { general: AppointmentGeneral },
  captcha: {},
  section: { general: SectionGeneral },
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
  matrix: { general: MatrixGeneral },
  repeating_group: { general: RepeatingGroupGeneral },
  file_upload: { validation: FileValidation },
  signature: { general: SignatureGeneral },
  hidden: { general: HiddenGeneral },
  calculation: { general: CalculationGeneral },
  context: { general: ContextGeneral },
  heading: { general: HeadingGeneral },
  paragraph: {},
  divider: { general: DividerGeneral },
};
