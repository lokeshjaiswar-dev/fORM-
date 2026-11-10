import type { AvailableType } from '@form/registry';
import { AddressField } from './address.tsx';
import { AppointmentField } from './appointment.tsx';
import { Calculation } from './calculation.tsx';
import { CardSortField } from './card_sort.tsx';
import { Captcha } from './captcha.tsx';
import { ConstantSumField } from './constant_sum.tsx';
import { ConsentField } from './consent.tsx';
import { ContextField } from './context.tsx';
import { DateInput } from './date.tsx';
import { DateRangeField } from './date_range.tsx';
import { DateTimeInput } from './datetime.tsx';
import { Divider } from './divider.tsx';
import { Email } from './email.tsx';
import { FileUpload } from './file_upload.tsx';
import { FullName } from './full_name.tsx';
import { Heading } from './heading.tsx';
import type { Control } from './hooks.ts';
import { LikertField } from './likert.tsx';
import { LinearScale } from './linear_scale.tsx';
import { LongText } from './long_text.tsx';
import { MatchingField } from './matching.tsx';
import { MaxDiffField } from './maxdiff.tsx';
import { Matrix } from './matrix.tsx';
import { MultiChoice } from './multi_choice.tsx';
import { Nps } from './nps.tsx';
import { NumberInput } from './number.tsx';
import { NumberRangeField } from './number_range.tsx';
import { ScheduleGridField } from './schedule_grid.tsx';
import { SemanticDifferentialField } from './semantic_differential.tsx';
import { Paragraph } from './paragraph.tsx';
import { Phone } from './phone.tsx';
import { Ranking } from './ranking.tsx';
import { Section } from './section.tsx';
import { RepeatingGroup } from './repeating_group.tsx';
import { Rating } from './rating.tsx';
import { ShortText } from './short_text.tsx';
import { Signature } from './signature.tsx';
import { SingleChoice } from './single_choice.tsx';
import { TimeInput } from './time.tsx';
import { UniqueIdField } from './unique_id.tsx';
import { Url } from './url.tsx';

/**
 * The renderer side of the registry (`RendererRegistry`, architecture §1.2): one control per available type, with how
 * it is labelled. A type made available without a control does not compile.
 */
export const CONTROLS: { readonly [T in AvailableType]: Control<T> } = {
  short_text: { labelling: () => 'input', Component: ShortText },
  long_text: { labelling: () => 'input', Component: LongText },
  full_name: { labelling: () => 'group', Component: FullName },
  email: { labelling: () => 'input', Component: Email },
  phone: { labelling: () => 'input', Component: Phone },
  address: { labelling: () => 'group', Component: AddressField },
  number: { labelling: () => 'input', Component: NumberInput },
  url: { labelling: () => 'input', Component: Url },
  single_choice: { labelling: (block) => (block.config.display === 'dropdown' ? 'input' : 'radiogroup'), Component: SingleChoice },
  multi_choice: { labelling: () => 'group', Component: MultiChoice },
  date: { labelling: () => 'input', Component: DateInput },
  date_range: { labelling: () => 'group', Component: DateRangeField },
  datetime: { labelling: () => 'input', Component: DateTimeInput },
  time: { labelling: (block) => (block.config.range?.enabled ? 'group' : 'input'), Component: TimeInput },
  rating: { labelling: () => 'radiogroup', Component: Rating },
  linear_scale: { labelling: () => 'radiogroup', Component: LinearScale },
  nps: { labelling: () => 'radiogroup', Component: Nps },
  ranking: { labelling: () => 'group', Component: Ranking },
  matching: { labelling: () => 'group', Component: MatchingField },
  likert: { labelling: () => 'group', Component: LikertField },
  constant_sum: { labelling: () => 'group', Component: ConstantSumField },
  maxdiff: { labelling: () => 'group', Component: MaxDiffField },
  card_sort: { labelling: () => 'group', Component: CardSortField },
  semantic_differential: { labelling: () => 'group', Component: SemanticDifferentialField },
  number_range: { labelling: () => 'group', Component: NumberRangeField },
  schedule_grid: { labelling: () => 'group', Component: ScheduleGridField },
  matrix: { labelling: () => 'group', Component: Matrix },
  repeating_group: { labelling: () => 'group', Component: RepeatingGroup },
  file_upload: { labelling: () => 'input', Component: FileUpload },
  signature: { labelling: () => 'group', Component: Signature },
  /* FLD-30: never rendered; logic captures its value (URL parameter, UTM, static or expression). */
  hidden: { labelling: () => 'none', Component: () => null },
  consent: { labelling: () => 'group', Component: ConsentField },
  calculation: { labelling: (block) => (block.config.display === 'hidden' ? 'none' : 'input'), Component: Calculation },
  context: { labelling: () => 'input', Component: ContextField },
  unique_id: { labelling: () => 'input', Component: UniqueIdField },
  appointment: { labelling: () => 'group', Component: AppointmentField },
  captcha: { labelling: () => 'content', Component: Captcha },
  heading: { labelling: () => 'content', Component: Heading },
  paragraph: { labelling: () => 'content', Component: Paragraph },
  divider: { labelling: () => 'content', Component: Divider },
  section: { labelling: () => 'content', Component: Section },
};

export type { Control, ControlProps, FieldIds, FieldState, Labelling } from './hooks.ts';
