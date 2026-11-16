import type { ComponentType } from 'react';
import { Trash2 } from 'lucide-react';
import { defineMessages, formatDate, formatTime, type MessageId } from '@form/i18n';
import { callingCodeOf, formatUniqueId, isAvailable, isRepeatableChildType, type AvailableType } from '@form/registry';
import { slotsOf } from '@form/renderer';
import type { AddressPart, BlockOf, NamePart, StoredBlock } from '@form/schema';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { CheckboxField, Select as DsSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@dmacq/ui';
import { CanvasCheck, CanvasDate, CanvasDateTime, CanvasRadio, CanvasTime, Chip, FileDropzone, MultiSelectBox, OptionList, Points, RankingList, Select, Slider, TextBox } from '@/fields/canvasParts';
import { TILES } from '@/fields/tiles';
import { labelString, labelStyle } from '@/fields/style';
import { InlineEditor } from '@/components/editor/InlineEditor';
import { RichEditor } from '@/components/editor/RichEditor';
import { addChildBlock, focusNextField, requestDeleteBlock, updateBlock } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { inlineDoc, isField, plainText } from '@/lib/definition';

/*
 * The canvas view of every available block type (FND-03): what an author sees in place of the respondent control.
 * Value fields show a static preview of their control under the label editor; content blocks are edited in place.
 * The registry's AVAILABLE_TYPES is the key set, so a new available type does not compile without a view.
 */

export interface CanvasProps<T extends AvailableType> {
  block: BlockOf<T>;
  focused: boolean;
  onEnter: () => void;
}

export type CanvasView<T extends AvailableType> = ComponentType<CanvasProps<T>>;

const M = defineMessages('builder', {
  'canvas.hidden': 'Hidden from respondents · filled from the URL parameter ‘{name}’',
  'canvas.hidden_utm': 'Hidden from respondents · filled from utm_{param}',
  'canvas.hidden_other': 'Hidden from respondents',
  'canvas.consent': 'I agree to the terms',
  'canvas.captcha': "I'm not a robot",
  'canvas.appointment_day': 'Date',
  'canvas.section': 'Section',
  'canvas.section_name': 'Section name',
  'canvas.section_hint': 'Fields in this collapse',
  'canvas.section_pick': 'Add a field',
  'canvas.name.first': 'First name',
  'canvas.name.last': 'Last name',
  'canvas.name.middle': 'Middle name',
  'canvas.name.prefix': 'Prefix',
  'canvas.name.suffix': 'Suffix',
  'canvas.date_start': 'Start date',
  'canvas.date_end': 'End date',
  'canvas.match': 'Match…',
  'canvas.best': 'Best',
  'canvas.worst': 'Worst',
  'canvas.group': 'Group…',
  'canvas.groups': 'Groups…',
  'canvas.number_from': 'From',
  'canvas.number_to': 'To',
  'canvas.day_0': 'Sunday',
  'canvas.day_1': 'Monday',
  'canvas.day_2': 'Tuesday',
  'canvas.day_3': 'Wednesday',
  'canvas.day_4': 'Thursday',
  'canvas.day_5': 'Friday',
  'canvas.day_6': 'Saturday',
  'canvas.time_start': 'Start time',
  'canvas.time_end': 'End time',
  'canvas.address.line1': 'Address line 1',
  'canvas.address.line2': 'Address line 2',
  'canvas.address.city': 'City',
  'canvas.address.state': 'State',
  'canvas.address.postalCode': 'PIN / postal code',
  'canvas.address.country': 'Country',
  'canvas.sum_total': '{total} of {target}',
  'canvas.session.page_url': 'Page URL',
  'canvas.session.referrer': 'Referrer',
  'canvas.session.user_agent': 'Browser',
  'canvas.session.started_at': 'Started at',
  'canvas.session.submitted_at': 'Submitted at',
  'canvas.session.locale': 'Locale',
  'canvas.session.time_zone': 'Time zone',
  'canvas.session.embed_origin': 'Embed origin',
  'canvas.session.utm_source': 'UTM source',
  'canvas.session.utm_medium': 'UTM medium',
  'canvas.session.utm_campaign': 'UTM campaign',
  'canvas.session.utm_term': 'UTM term',
  'canvas.session.utm_content': 'UTM content',
  'canvas.session_capture_only': 'Not shown on the form · captured in the answers',
  'canvas.heading': 'Heading',
  'canvas.paragraph': 'Type something…',
  'canvas.repeat_hint': '{min}–{max} rows · respondents can add more while filling',
  'canvas.repeat_pick': 'Choose a field type',
  'canvas.repeat_remove': 'Remove this field',
  'canvas.question': 'Type a question',
});

const DAY_LABEL = {
  0: M['canvas.day_0'],
  1: M['canvas.day_1'],
  2: M['canvas.day_2'],
  3: M['canvas.day_3'],
  4: M['canvas.day_4'],
  5: M['canvas.day_5'],
  6: M['canvas.day_6'],
} as const;

const headingSize = { 1: 'text-[32px]', 2: 'text-[24px]', 3: 'text-[20px]' } as const;
const NAME_PART: Record<NamePart, MessageId<'builder'>> = {
  prefix: M['canvas.name.prefix'],
  first: M['canvas.name.first'],
  middle: M['canvas.name.middle'],
  last: M['canvas.name.last'],
  suffix: M['canvas.name.suffix'],
};
const ADDRESS_PART: Record<AddressPart, MessageId<'builder'>> = {
  line1: M['canvas.address.line1'],
  line2: M['canvas.address.line2'],
  city: M['canvas.address.city'],
  state: M['canvas.address.state'],
  postalCode: M['canvas.address.postalCode'],
  country: M['canvas.address.country'],
};
const SESSION_SOURCE = {
  page_url: M['canvas.session.page_url'],
  referrer: M['canvas.session.referrer'],
  user_agent: M['canvas.session.user_agent'],
  started_at: M['canvas.session.started_at'],
  submitted_at: M['canvas.session.submitted_at'],
  locale: M['canvas.session.locale'],
  time_zone: M['canvas.session.time_zone'],
  embed_origin: M['canvas.session.embed_origin'],
  utm_source: M['canvas.session.utm_source'],
  utm_medium: M['canvas.session.utm_medium'],
  utm_campaign: M['canvas.session.utm_campaign'],
  utm_term: M['canvas.session.utm_term'],
  utm_content: M['canvas.session.utm_content'],
} as const;
const flag = (region: string) => String.fromCodePoint(...[...region].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
const SPACING = { sm: 'my-2', md: 'my-4', lg: 'my-6' } as const;
const LINE = { solid: '', dashed: 'border-dashed', dotted: 'border-dotted', none: 'border-transparent' } as const;

export const CANVAS: { readonly [T in AvailableType]: CanvasView<T> } = {
  short_text: ({ block }) =>
    block.config.placeholder === '_____' ? (
      <span className="fr-blank-line pointer-events-none">
        {block.config.prefix ? <span className="fr-blank-words">{block.config.prefix}</span> : null}
        <span className="fr-blank-input">{'\u00a0'}</span>
        {block.config.suffix ? <span className="fr-blank-words">{block.config.suffix}</span> : null}
      </span>
    ) : (
      <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />
    ),
  long_text: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} tall />,
  full_name: ({ block }) => (
    <div className="fr-name pointer-events-none">
      {block.config.parts.map((part) => (
        <label key={part} className="fr-name-part">
          <span>{block.config.sublabels?.[part] || t(NAME_PART[part])}</span>
          <TextBox block={block} placeholder={block.config.placeholders?.[part]} />
        </label>
      ))}
    </div>
  ),
  email: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  phone: ({ block }) => (
    <div className="fr-phone pointer-events-none">
      {block.config.showCountrySelect ? (
        <div className="fr-phone-country">
          <Select block={block} placeholder={`${flag(block.config.defaultCountry)} +${callingCodeOf(block.config.defaultCountry) ?? ''}`} />
        </div>
      ) : null}
      <TextBox block={block} placeholder={block.config.placeholder} />
    </div>
  ),
  address: ({ block }) => (
    <div className="fr-address pointer-events-none">
      {block.config.parts.filter((part) => part !== 'country' || block.config.country.mode !== 'fixed').map((part) => (
        <label key={part} className="fr-address-part" data-part={part}>
          <span>{block.config.sublabels?.[part] || t(ADDRESS_PART[part])}</span>
          {part === 'country' || (part === 'state' && block.config.stateInput === 'auto' && (block.config.country.default ?? '') === 'IN') ? (
            <Select block={block} />
          ) : (
            <TextBox block={block} />
          )}
        </label>
      ))}
    </div>
  ),
  number: ({ block }) => <NumberCanvas block={block} />,
  url: ({ block }) => <TextBox block={block} placeholder={block.config.placeholder} prefix={block.config.prefix} suffix={block.config.suffix} />,
  single_choice: ({ block }) =>
    block.config.display === 'dropdown' ? (
      <Select block={block} placeholder={block.config.placeholder} />
    ) : (
      <OptionList options={block.config.options} shape="round" other={block.config.other?.enabled === true} pictures={block.config.display === 'image'} columns={block.config.columns} />
    ),
  multi_choice: ({ block }) =>
    block.config.display === 'dropdown' ? (
      <MultiSelectBox placeholder={block.config.placeholder} />
    ) : (
      <OptionList options={block.config.options} shape="square" other={block.config.other?.enabled === true} pictures={block.config.display === 'image'} columns={block.config.columns} />
    ),
  date: () => <CanvasDate />,
  date_range: () => (
    <div className="fr-date-range pointer-events-none">
      <span className="fr-label">{t(M['canvas.date_start'])}</span>
      <CanvasDate />
      <span className="fr-label">{t(M['canvas.date_end'])}</span>
      <CanvasDate />
    </div>
  ),
  datetime: () => <CanvasDateTime />,
  time: ({ block }) =>
    block.config.range?.enabled ? (
      <div className="fr-range pointer-events-none">
        <span className="fr-sublabel">{t(M['canvas.time_start'])}</span>
        <CanvasTime />
        <span className="fr-sublabel">{t(M['canvas.time_end'])}</span>
        <CanvasTime />
      </div>
    ) : (
      <CanvasTime />
    ),
  rating: ({ block }) =>
    block.config.icon === 'number' ? (
      <Points from={1} to={Math.min(10, Math.max(1, block.config.max))} low={block.config.lowLabel} high={block.config.highLabel} />
    ) : (
      <div className="fr-points pointer-events-none" data-variant="icons">
        {block.config.lowLabel ? <span className="fr-point-label">{block.config.lowLabel}</span> : null}
        <div className="fr-point-row">
          {Array.from({ length: Math.min(10, Math.max(1, block.config.max)) }, (_, i) => (
            <span key={i} className="fr-point" aria-checked="false">
              <RatingGlyph icon={block.config.icon} />
            </span>
          ))}
        </div>
        {block.config.highLabel ? <span className="fr-point-label">{block.config.highLabel}</span> : null}
      </div>
    ),
  linear_scale: ({ block }) => <Points from={block.config.min} to={block.config.max} low={block.config.lowLabel} high={block.config.highLabel} />,
  nps: ({ block }) => <Points from={0} to={10} low={block.config.lowLabel} high={block.config.highLabel} />,
  ranking: ({ block }) => <RankingList options={block.config.options} />,
  matching: ({ block }) => (
    <div className="fr-matching pointer-events-none">
      {block.config.prompts.map((prompt) => (
        <div key={prompt.id} className="fr-matching-row">
          <span className="fr-label">{prompt.label}</span>
          <Select block={block} placeholder={t(M['canvas.match'])} />
        </div>
      ))}
    </div>
  ),
  constant_sum: ({ block }) => (
    <div className="fr-sum pointer-events-none">
      {block.config.options.map((option) => (
        <div key={option.id} className="fr-sum-row">
          <span className="fr-label">{labelString(option.label)}</span>
          <TextBox block={block} placeholder="0" />
        </div>
      ))}
      <p className="fr-sum-total">{t(M['canvas.sum_total'], { total: 0, target: block.config.target })}</p>
    </div>
  ),
  maxdiff: ({ block }) => (
    <div className="fr-maxdiff-wrap pointer-events-none">
      <table className="fr-maxdiff">
        <thead>
          <tr>
            <th>{t(M['canvas.best'])}</th>
            <th />
            <th>{t(M['canvas.worst'])}</th>
          </tr>
        </thead>
        <tbody>
          {block.config.options.map((option) => (
            <tr key={option.id}>
              <td><CanvasRadio /></td>
              <th scope="row">{labelString(option.label)}</th>
              <td><CanvasRadio /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  card_sort: ({ block }) => (
    <div className="fr-cardsort pointer-events-none">
      {block.config.items.map((item) => (
        <div key={item.id} className="fr-cardsort-row">
          <span className="fr-label">{item.label}</span>
          <Select block={block} placeholder={block.config.exclusive ? t(M['canvas.group']) : t(M['canvas.groups'])} />
        </div>
      ))}
    </div>
  ),
  semantic_differential: ({ block }) => (
    <div className="fr-semantic-wrap pointer-events-none">
      <table className="fr-semantic">
        <thead>
          <tr>
            <th />
            {Array.from({ length: Math.max(2, Math.min(10, block.config.max)) }, (_, i) => (
              <th key={i}>{block.config.min + i}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {block.config.pairs.map((pair) => (
            <tr key={pair.id}>
              <th scope="row">{pair.left}</th>
              {Array.from({ length: Math.max(2, Math.min(10, block.config.max)) }, (_, i) => (
                <td key={i}><CanvasRadio /></td>
              ))}
              <th scope="row">{pair.right}</th>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  number_range: ({ block }) => (
    <div className="fr-number-range pointer-events-none">
      <span className="fr-label">{t(M['canvas.number_from'])}</span>
      <TextBox block={block} />
      <span className="fr-label">{t(M['canvas.number_to'])}</span>
      <TextBox block={block} />
    </div>
  ),
  schedule_grid: ({ block }) => (
    <div className="fr-schedule-wrap pointer-events-none">
      <table className="fr-schedule">
        <thead>
          <tr>
            <th />
            {block.config.weekdays.map((day) => (
              <th key={day}>{t(DAY_LABEL[day])}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.slots.map((slot) => (
            <tr key={slot}>
              <th scope="row">{slot}</th>
              {block.config.weekdays.map((day) => (
                <td key={day}><CanvasCheck /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  likert: ({ block }) => (
    <div className="fr-likert-wrap pointer-events-none">
      <table className="fr-likert">
        <thead>
          <tr>
            <th />
            {Array.from({ length: Math.max(2, Math.min(10, block.config.max)) }, (_, i) => (
              <th key={i}>
                {i === 0 && block.config.lowLabel
                  ? `${block.config.min} · ${block.config.lowLabel}`
                  : i === Math.max(2, Math.min(10, block.config.max)) - 1 && block.config.highLabel
                    ? `${block.config.min + i} · ${block.config.highLabel}`
                    : block.config.min + i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.statements.map((stmt) => (
            <tr key={stmt.id}>
              <th scope="row">{stmt.label}</th>
              {Array.from({ length: Math.max(2, Math.min(10, block.config.max)) }, (_, i) => (
                <td key={i}><CanvasRadio /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  repeating_group: ({ block }) => <RepeatingGroupCanvas block={block} />,
  matrix: ({ block }) => (
    <div className="fr-matrix-wrap pointer-events-none">
      <table className="fr-matrix">
        <thead>
          <tr>
            <th />
            {block.config.columns.map((col) => (
              <th key={col.id}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{labelString(row.label)}</th>
              {block.config.columns.map((col) => (
                <td key={col.id}>
                  {block.config.mode === 'grid' ? (
                    <span className="fr-input" />
                  ) : block.config.mode === 'multi' ? (
                    <CanvasCheck />
                  ) : (
                    <CanvasRadio />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  file_upload: ({ block }) => (
    <div className="fr-files pointer-events-none">
      <FileDropzone disabled size="compact" multiple={block.config.maxFiles > 1} />
    </div>
  ),
  signature: ({ block }) => (
    <div className="fr-signature-field pointer-events-none">
      {block.config.statement ? <p className="fr-statement">{plainText(block.config.statement)}</p> : null}
      <div className="fr-signature">
        <div
          className="fr-signature-canvas"
          style={{ height: Math.min(400, Math.max(80, block.config.heightPx)) }}
          aria-hidden
        />
      </div>
    </div>
  ),
  calculation: () => <output className="fr-input fr-computed">—</output>,
  context: ({ block }) => {
    const extras = [...(block.config.urlParams ?? []), ...(block.config.staticFacts ?? []).map((f) => f.key)];
    const hidden = block.config.display === 'hidden';
    return (
      <output className="fr-input fr-computed fr-session">
        {hidden ? <p className="text-[12px] text-[var(--fr-muted)]">{t(M['canvas.session_capture_only'])}</p> : null}
        {block.config.sources.map((source) => (
          <span key={source} className="fr-session-row">
            <span className="fr-session-key">{t(SESSION_SOURCE[source])}</span>
            <span>—</span>
          </span>
        ))}
        {extras.map((key) => (
          <span key={key} className="fr-session-row">
            <span className="fr-session-key">{key}</span>
            <span>—</span>
          </span>
        ))}
      </output>
    );
  },
  consent: ({ block }) => (
    <div className="fr-consent pointer-events-none">
      {block.config.items.map((item) => (
        <CheckboxField
          key={item.id}
          className="fr-consent-item pointer-events-none"
          disabled
          label={plainText(item.label) || t(M['canvas.consent'])}
        />
      ))}
    </div>
  ),
  appointment: ({ block }) => <AppointmentCanvas block={block} />,
  captcha: () => (
    <div className="fr-captcha pointer-events-none">
      <CheckboxField className="fr-captcha-box pointer-events-none" disabled label={t(M['canvas.captcha'])} />
    </div>
  ),
  section: ({ block }) => <SectionCanvas block={block} />,
  unique_id: ({ block }) => <output className="fr-input fr-computed">{formatUniqueId(block.config)}</output>,
  hidden: ({ block }) => {
    const source = block.config.source;
    const text = source.kind === 'url_param' ? t(M['canvas.hidden'], { name: source.name ?? block.key }) : source.kind === 'utm' ? t(M['canvas.hidden_utm'], { param: source.param }) : t(M['canvas.hidden_other']);
    return <p className="text-[12px] text-[var(--fr-muted)]">{text}</p>;
  },
  heading: ({ block, focused, onEnter }) => (
    <InlineEditor
      value={block.config.text}
      onChange={(text) => updateBlock(block.id, { config: { ...block.config, text } })}
      onEnter={onEnter}
      autoFocus={focused}
      className={cn('flex min-h-8 w-full items-center bg-transparent text-left font-bold leading-8 tracking-[-0.01em]', headingSize[block.config.level])}
      style={labelStyle(block.style)}
      placeholder={t(M['canvas.heading'])}
    />
  ),
  paragraph: ({ block, focused, onEnter }) => (
    <RichEditor
      value={block.config.content}
      onChange={(content) => updateBlock(block.id, { config: { ...block.config, content } })}
      onEnter={onEnter}
      autoFocus={focused}
      className="flex min-h-8 w-full items-center bg-transparent text-[16px] leading-8"
      style={labelStyle(block.style)}
      placeholder={t(M['canvas.paragraph'])}
    />
  ),
  divider: ({ block }) => <hr className={cn(SPACING[block.config.spacing], LINE[block.config.lineStyle])} style={{ borderColor: 'var(--fr-inputBorder)' }} />,
  section_break: ({ block, focused }) => (
    <div
      className="fr-section-break"
      data-fr-section={block.id}
      data-marker={block.config.marker ?? 'card'}
      id={`section-${block.id}`}
      role="separator"
      aria-label={block.config.name.trim() || t(M['canvas.section'])}
    >
      <div className="fr-section-break-mark">
        {(block.config.marker ?? 'card') === 'badge' ? <span className="fr-section-break-badge" aria-hidden /> : null}
        <input
          className="fr-section-break-name min-w-0 flex-1 bg-transparent outline-none"
          value={block.config.name}
          placeholder={t(M['canvas.section'])}
          aria-label={t(M['canvas.section_name'])}
          autoFocus={focused}
          onChange={(e) => updateBlock(block.id, { config: { ...block.config, name: e.target.value.slice(0, 80) } })}
        />
      </div>
    </div>
  ),
};

const RATING_PATH = {
  star: 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z',
  heart: 'M12 20.3l-1.3-1.2C5.6 14.5 2.5 11.7 2.5 8.2 2.5 5.4 4.7 3.2 7.5 3.2c1.6 0 3.1.7 4.5 2 1.4-1.3 2.9-2 4.5-2 2.8 0 5 2.2 5 5 0 3.5-3.1 6.3-8.2 10.9z',
  thumb: 'M2.5 10.5h3.5v10H2.5zM8 20.5V10.3l4.6-7.3c.9-.4 2 .2 2 1.3v4.9h5.2c1.2 0 2.1 1.1 1.8 2.3l-1.9 7.2c-.3 1-1.2 1.8-2.3 1.8z',
  smiley: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM8.6 9.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm6.8 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7.7 14.2h8.6c-.6 2-2.3 3.4-4.3 3.4s-3.7-1.4-4.3-3.4z',
} as const;

function RatingGlyph({ icon }: { icon: keyof typeof RATING_PATH | 'number' }) {
  if (icon === 'number') return null;
  return (
    <svg className="fr-icon" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d={RATING_PATH[icon]} />
    </svg>
  );
}

function AppointmentCanvas({ block }: { block: BlockOf<'appointment'> }) {
  const slots = slotsOf(block.config);
  const days = [...new Set(slots.map((s) => s.day))];
  const shown = slots.filter((s) => s.day === days[0]);
  const dayLabel = days[0] ? formatDate(days[0], 'D MMM YYYY') : t(M['canvas.appointment_day']);
  return (
    <div className="fr-appointment pointer-events-none">
      <label className="fr-appointment-date">
        <span className="fr-appointment-caption">{t(M['canvas.appointment_day'])}</span>
        <Select block={block} placeholder={dayLabel} />
      </label>
      <div className="fr-appointment-slots" role="list">
        {shown.map((slot) => (
          <Chip key={slot.start} kind="filter" size="md" color="primary" disabled role="listitem">{formatTime(slot.time, 'h12')}</Chip>
        ))}
      </div>
    </div>
  );
}

function NumberCanvas({ block }: { block: BlockOf<'number'> }) {
  const c = block.config;
  const slider = c.display === 'stepper' && c.min !== undefined && c.max !== undefined;
  if (!slider) return <TextBox block={block} placeholder={c.placeholder} prefix={c.prefix} suffix={c.suffix} />;
  const control = (
    <div className="fr-slider pointer-events-none">
      <span className="fr-slider-edge">{c.min}</span>
      <Slider min={Number(c.min)} max={Number(c.max)} step={Number(c.step ?? 1) || 1} defaultValue={[Number(c.min)]} disabled aria-hidden />
      <span className="fr-slider-edge">{c.max}</span>
    </div>
  );
  if (!c.prefix && !c.suffix) return control;
  return (
    <div className="fr-affix pointer-events-none">
      {c.prefix ? <span className="fr-affix-text">{c.prefix}</span> : null}
      {control}
      {c.suffix ? <span className="fr-affix-text">{c.suffix}</span> : null}
    </div>
  );
}

const CHILD_TILES = TILES.filter((tile) => tile.kind === 'block' && isRepeatableChildType(tile.choice.type));

function RepeatChild({ child, selected, onEnter }: { child: StoredBlock; selected: boolean; onEnter: () => void }) {
  const openInspector = useUiStore((s) => s.openInspector);
  if (child.type === 'unsupported' || !isAvailable(child.type)) return null;
  const View = CANVAS[child.type] as CanvasView<AvailableType>;
  return (
    <div
      className={cn('group/child relative flex min-w-0 flex-col px-2 py-2', selected && 'rounded-md bg-[color-mix(in_srgb,var(--fr-accent)_10%,transparent)]')}
      onClick={(e) => {
        e.stopPropagation();
        openInspector(child.id);
      }}
    >
      <button
        type="button"
        className={cn(
          'absolute right-1 top-1 rounded p-0.5 text-[var(--fr-muted)] hover:bg-black/5 hover:text-destructive',
          selected ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
        )}
        aria-label={t(M['canvas.repeat_remove'])}
        onClick={(e) => {
          e.stopPropagation();
          requestDeleteBlock(child.id);
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
      {isField(child) && !child.hideLabel ? (
        <InlineEditor
          value={child.label}
          onChange={(label) => updateBlock(child.id, { label })}
          onEnter={onEnter}
          autoFocus={selected}
          fill={false}
          className="mb-1 min-h-7 w-full shrink-0 bg-transparent pr-5 text-left text-[13px] font-medium leading-7"
          style={labelStyle(child.style)}
          placeholder={t(M['canvas.question'])}
        />
      ) : isField(child) ? (
        <div className="mb-1 min-h-7 shrink-0" aria-hidden />
      ) : null}
      <View block={child as never} focused={selected} onEnter={onEnter} />
    </div>
  );
}

const SECTION_TILES = TILES.filter((tile) => tile.kind === 'block' && tile.choice.type !== 'section');

function SectionCanvas({ block }: { block: BlockOf<'section'> }) {
  const blocks = useDoc((d) => d.blocks);
  const selected = useUiStore((s) => s.activeBlockId);
  const children = block.config.children.map((id) => blocks[id]).filter((b): b is StoredBlock => !!b && b.type !== 'unsupported' && isAvailable(b.type));
  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--fr-inputBorder)' }} onClick={(e) => e.stopPropagation()}>
      <InlineEditor
        value={block.config.title ?? inlineDoc('')}
        onChange={(title) => updateBlock(block.id, { config: { ...block.config, title } })}
        autoFocus={selected === block.id}
        fill={false}
        className="w-full bg-transparent px-3 py-2 text-left text-[16px] font-semibold"
        placeholder={t(M['canvas.section'])}
      />
      <p className="border-y px-3 py-1.5 text-[12px] text-[var(--fr-muted)]" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        {t(M['canvas.section_hint'])}
      </p>
      <div className="flex flex-col">
        {children.map((child) => (
          <RepeatChild key={child.id} child={child} selected={selected === child.id} onEnter={() => focusNextField(child.id)} />
        ))}
      </div>
      <div className="flex items-center gap-2 border-t px-2 py-1.5" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        <DsSelect
          key={children.length}
          onValueChange={(id) => {
            const tile = SECTION_TILES.find((item) => item.id === id);
            if (tile?.kind === 'block') addChildBlock(block.id, tile.choice, { label: inlineDoc(tile.label) });
          }}
        >
          <SelectTrigger className="h-8 min-w-[10rem]" aria-label={t(M['canvas.section_pick'])}>
            <SelectValue placeholder={t(M['canvas.section_pick'])} />
          </SelectTrigger>
          <SelectContent>
            {SECTION_TILES.filter((tile) => tile.kind === 'block').map((tile) => (
              <SelectItem key={tile.id} value={tile.id}>{tile.label}</SelectItem>
            ))}
          </SelectContent>
        </DsSelect>
      </div>
    </div>
  );
}

function RepeatingGroupCanvas({ block }: { block: BlockOf<'repeating_group'> }) {
  const blocks = useDoc((d) => d.blocks);
  const selected = useUiStore((s) => s.activeBlockId);
  const children = block.config.children.map((id) => blocks[id]).filter((b): b is StoredBlock => !!b && b.type !== 'unsupported' && isAvailable(b.type));
  const addPickerId = `${block.id}-add-field`;
  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--fr-inputBorder)' }} onClick={(e) => e.stopPropagation()}>
      <p className="border-b px-3 py-1.5 text-[12px] text-[var(--fr-muted)]" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        {t(M['canvas.repeat_hint'], { min: block.config.minRows, max: block.config.maxRows })}
      </p>
      <div className="grid grid-cols-3 items-start">
        {children.map((child, index) => (
          <RepeatChild
            key={child.id}
            child={child}
            selected={selected === child.id}
            onEnter={() => {
              // Enter moves to the list's next field, and from the last one to the "add a field" picker.
              const next = children[index + 1];
              if (next) useUiStore.getState().setActiveBlock(next.id);
              else document.getElementById(addPickerId)?.focus();
            }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 border-t px-2 py-1.5" style={{ borderColor: 'var(--fr-inputBorder)' }}>
        <DsSelect
          key={children.length}
          onValueChange={(id) => {
            const tile = CHILD_TILES.find((item) => item.id === id);
            if (tile?.kind === 'block') addChildBlock(block.id, tile.choice, { label: inlineDoc(tile.label) });
          }}
        >
          <SelectTrigger id={addPickerId} className="h-8 min-w-[10rem]" aria-label={t(M['canvas.repeat_pick'])}>
            <SelectValue placeholder={t(M['canvas.repeat_pick'])} />
          </SelectTrigger>
          <SelectContent>
            {CHILD_TILES.filter((tile) => tile.kind === 'block').map((tile) => (
              <SelectItem key={tile.id} value={tile.id}>{tile.label}</SelectItem>
            ))}
          </SelectContent>
        </DsSelect>
      </div>
    </div>
  );
}
