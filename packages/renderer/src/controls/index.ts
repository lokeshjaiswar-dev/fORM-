import type { AvailableType } from '@form/registry';
import { DateInput } from './date.tsx';
import { Divider } from './divider.tsx';
import { Email } from './email.tsx';
import { FileUpload } from './file_upload.tsx';
import { FullName } from './full_name.tsx';
import { Heading } from './heading.tsx';
import type { Control } from './hooks.ts';
import { LinearScale } from './linear_scale.tsx';
import { LongText } from './long_text.tsx';
import { Matrix } from './matrix.tsx';
import { MultiChoice } from './multi_choice.tsx';
import { Nps } from './nps.tsx';
import { NumberInput } from './number.tsx';
import { Paragraph } from './paragraph.tsx';
import { Phone } from './phone.tsx';
import { Ranking } from './ranking.tsx';
import { Rating } from './rating.tsx';
import { ShortText } from './short_text.tsx';
import { Signature } from './signature.tsx';
import { SingleChoice } from './single_choice.tsx';
import { TimeInput } from './time.tsx';
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
  number: { labelling: () => 'input', Component: NumberInput },
  url: { labelling: () => 'input', Component: Url },
  single_choice: { labelling: (block) => (block.config.display === 'dropdown' ? 'input' : 'radiogroup'), Component: SingleChoice },
  multi_choice: { labelling: () => 'group', Component: MultiChoice },
  date: { labelling: () => 'input', Component: DateInput },
  time: { labelling: (block) => (block.config.range?.enabled ? 'group' : 'input'), Component: TimeInput },
  rating: { labelling: () => 'radiogroup', Component: Rating },
  linear_scale: { labelling: () => 'radiogroup', Component: LinearScale },
  nps: { labelling: () => 'radiogroup', Component: Nps },
  ranking: { labelling: () => 'group', Component: Ranking },
  matrix: { labelling: () => 'group', Component: Matrix },
  file_upload: { labelling: () => 'input', Component: FileUpload },
  signature: { labelling: () => 'group', Component: Signature },
  /* FLD-30: never rendered; logic captures its value (URL parameter, UTM, static or expression). */
  hidden: { labelling: () => 'none', Component: () => null },
  heading: { labelling: () => 'content', Component: Heading },
  paragraph: { labelling: () => 'content', Component: Paragraph },
  divider: { labelling: () => 'content', Component: Divider },
};

export type { Control, ControlProps, FieldIds, FieldState, Labelling } from './hooks.ts';
