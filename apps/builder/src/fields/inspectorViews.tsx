import { defineMessages } from '@form/i18n';
import { isRepeatableChildType, PALETTE_LABELS, REGISTRY, SHORT_TEXT_MAX, type AvailableType } from '@form/registry';
import {
  CONTEXT_SOURCES, DATE_PATTERNS, NAME_PARTS,
  type BlockOf, type CardBucketId, type CardItemId, type ContextSource, type DecimalString, type IsoTime, type LikertStatementId, type MatchingPromptId, type MatrixColumnId, type MatrixRowId, type NamePart, type SchemaLike, type SemanticPairId, type Weekday,
} from '@form/schema';
import { patternProblem, patternUnsupportedFeature } from '@form/validation';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { Field, NumberField, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { parseInteger } from '@/components/builder/inspector/parse';
import { OptionsEditor } from '@/components/builder/inspector/OptionsEditor';
import { APP_IDS, inlineDoc, isField, plainText } from '@/lib/definition';
import { formatFormula, parseFormula } from '@/lib/formula';
import { patchBlockConfig } from '@/fields/configSink';
import { addChildBlock, requestDeleteBlock } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { TILES } from '@/fields/tiles';
import { ChoiceOtherValidation, FileMinLimits } from '@/fields/validationViews';
import { Button, Input } from '@dmacq/ui';

/* The type's own inspector sections; `INSPECTOR` in fields/inspector.ts maps each available type to them. */

export interface InspectorProps<T extends AvailableType> {
  block: BlockOf<T>;
}

const M = defineMessages('builder', {
  'inspector.placeholder': 'Placeholder',
  'inspector.placeholder_hint': 'Shown inside the empty input',
  'inspector.prefix': 'Prefix',
  'inspector.suffix': 'Suffix',
  'inspector.min_length': 'Minimum characters',
  'inspector.max_length': 'Maximum characters',
  'inspector.limit_unit': 'Count',
  'inspector.limit_characters': 'Characters',
  'inspector.limit_words': 'Words',
  'inspector.pattern': 'Pattern (regular expression)',
  'inspector.pattern_hint': 'RE2, not JavaScript or Python. Use ^…$ for the whole answer.',
  'inspector.pattern_invalid': 'This pattern is ignored until fixed: {problem}',
  'inspector.pattern_unsupported_lookaround': 'Lookahead and lookbehind are not supported in RE2. This pattern is ignored until fixed.',
  'inspector.pattern_unsupported_backref': 'Backreferences such as \\1 are not supported in RE2. This pattern is ignored until fixed.',
  'inspector.rows': 'Rows',
  'inspector.counter': 'Show a character counter',
  'inspector.display': 'Display',
  'inspector.display_radio': 'Radio buttons',
  'inspector.display_checkbox': 'Checkboxes',
  'inspector.display_dropdown': 'Dropdown',
  'inspector.display_input': 'Input',
  'inspector.display_stepper': 'Stepper',
  'inspector.min': 'Minimum',
  'inspector.max': 'Maximum',
  'inspector.step': 'Step',
  'inspector.integer_only': 'Whole numbers only',
  'inspector.integer_only_hint': 'Letters are blocked while typing. Turn this on to also block decimals.',
  'inspector.allow_negative': 'Allow negative numbers',
  'inspector.phone_format_hint': 'Only digits can be typed. Indian numbers must be 10 digits starting with 6–9.',
  'inspector.country': 'Default country (ISO code)',
  'inspector.country_select': 'Show the country picker',
  'inspector.min_selected': 'Minimum selected',
  'inspector.max_selected': 'Maximum selected',
  'inspector.date_pattern': 'Date format',
  'inspector.picker': 'Picker',
  'inspector.picker_calendar': 'Calendar',
  'inspector.picker_selects': 'Day, month and year lists',
  'inspector.picker_native': 'Browser picker',
  'inspector.hour_cycle': 'Clock',
  'inspector.hour_cycle_h12': '12-hour',
  'inspector.hour_cycle_h23': '24-hour',
  'inspector.minute_step': 'Minute step',
  'inspector.rating_max': 'Number of points',
  'inspector.rating_icon': 'Icon',
  'inspector.icon_star': 'Stars',
  'inspector.icon_heart': 'Hearts',
  'inspector.icon_thumb': 'Thumbs',
  'inspector.icon_smiley': 'Smileys',
  'inspector.icon_number': 'Numbers',
  'inspector.low_label': 'Low end label',
  'inspector.high_label': 'High end label',
  'inspector.scale_min': 'Scale starts at',
  'inspector.scale_max': 'Scale ends at',
  'inspector.max_files': 'Maximum files',
  'inspector.max_size': 'Maximum file size (MB)',
  'inspector.extensions': 'Allowed file types',
  'inspector.extensions_hint': 'Extensions separated by commas, e.g. pdf, jpg',
  'inspector.typed_signature': 'Allow a typed signature',
  'inspector.height': 'Height (px)',
  'inspector.source': 'Value comes from',
  'inspector.source_url_param': 'A URL parameter',
  'inspector.source_utm': 'A UTM parameter',
  'inspector.source_static': 'A fixed value',
  'inspector.param_name': 'URL parameter name',
  'inspector.param_name_hint': 'Defaults to the field key',
  'inspector.static_value': 'Value',
  'inspector.size': 'Size',
  'inspector.size_large': 'Large',
  'inspector.size_medium': 'Medium',
  'inspector.size_small': 'Small',
  'inspector.line': 'Line',
  'inspector.line_solid': 'Solid',
  'inspector.line_dashed': 'Dashed',
  'inspector.line_dotted': 'Dotted',
  'inspector.line_none': 'None',
  'inspector.spacing': 'Spacing',
  'inspector.spacing_sm': 'Small',
  'inspector.spacing_md': 'Medium',
  'inspector.spacing_lg': 'Large',
  'inspector.config_problem': 'Check this setting: {problem}',
  'inspector.matrix_mode': 'Answer type',
  'inspector.matrix_mode_single': 'One choice per row',
  'inspector.matrix_mode_multi': 'Several choices per row',
  'inspector.matrix_mode_grid': 'Text in each cell',
  'inspector.matrix_multi': 'Select multiple columns per row',
  'inspector.matrix_multi_hint': 'When on, a respondent can tick more than one column in the same row.',
  'inspector.matrix_rows': 'Rows',
  'inspector.matrix_columns': 'Columns',
  'inspector.matrix_add_row': 'Add row',
  'inspector.matrix_add_column': 'Add column',
  'inspector.matrix_row_n': 'Row {n}',
  'inspector.matrix_column_n': 'Column {n}',
  'inspector.allow_same_day': 'Allow the same start and end date',
  'inspector.min_span': 'Minimum span (days)',
  'inspector.max_span': 'Maximum span (days)',
  'inspector.matching_exclusive': 'Each option can pair with only one item',
  'inspector.matching_prompts': 'Items to match',
  'inspector.matching_add_prompt': 'Add item',
  'inspector.prompt_n': 'Item {n}',
  'inspector.likert_statements': 'Statements',
  'inspector.likert_add_statement': 'Add statement',
  'inspector.statement_n': 'Statement {n}',
  'inspector.sum_target': 'Points to allocate',
  'inspector.sum_allow_zero': 'Allow zero on an option',
  'inspector.card_items': 'Cards',
  'inspector.card_add_item': 'Add card',
  'inspector.card_item_n': 'Card {n}',
  'inspector.card_buckets': 'Groups',
  'inspector.card_add_bucket': 'Add group',
  'inspector.card_bucket_n': 'Group {n}',
  'inspector.card_exclusive': 'A card can sit in only one group',
  'inspector.semantic_pairs': 'Adjective pairs',
  'inspector.semantic_add': 'Add pair',
  'inspector.semantic_left': 'Left pole',
  'inspector.semantic_right': 'Right pole',
  'inspector.schedule_days': 'Weekdays',
  'inspector.schedule_slots': 'Time slots',
  'inspector.schedule_add_slot': 'Add slot',
  'inspector.weekday_0': 'Sunday',
  'inspector.weekday_1': 'Monday',
  'inspector.weekday_2': 'Tuesday',
  'inspector.weekday_3': 'Wednesday',
  'inspector.weekday_4': 'Thursday',
  'inspector.weekday_5': 'Friday',
  'inspector.weekday_6': 'Saturday',
  'inspector.repeat_min': 'Minimum rows',
  'inspector.repeat_max': 'Maximum rows',
  'inspector.repeat_initial': 'Rows shown at start',
  'inspector.repeat_add_label': 'Add-row button',
  'inspector.repeat_remove_label': 'Remove-row button',
  'inspector.repeat_fields': 'Fields in each row',
  'inspector.repeat_add_field': 'Add field',
  'inspector.repeat_pick_field': 'Choose a field type',
  'inspector.repeat_remove_field': 'Remove this field',
  'inspector.searchable': 'Search options',
  'inspector.time_range': 'Start and end time',
  'inspector.capture': 'Camera',
  'inspector.capture_none': 'File picker only',
  'inspector.capture_user': 'Front camera',
  'inspector.capture_environment': 'Rear camera',
  'inspector.email_verify': 'Ask for a one-time code',
  'inspector.calc_source': 'Take the value from',
  'inspector.calc_none': 'Fixed zero until a field is chosen',
  'inspector.calc_display': 'Show on the form',
  'inspector.calc_hidden': 'Keep in the answers only',
  'inspector.calc_formula': 'Formula',
  'inspector.calc_formula_hint': 'Use field keys with + − × ÷. Use sum(field) to add every row of a list number. Click a field below to insert it.',
  'inspector.calc_fields': 'Insert a field',
  'inspector.calc_no_fields': 'Add a number, rating or scale field first.',
  'inspector.context_facts': 'Facts to capture',
  'inspector.context_strip': 'Drop the query string from URLs',
  'inspector.context_hidden': 'Do not show this field on the form',
  'inspector.context_url_params': 'URL parameter names',
  'inspector.context_url_params_hint': 'Comma-separated query names to capture, for example ref, affiliate',
  'inspector.context_static': 'Fixed values',
  'inspector.context_static_key': 'Key',
  'inspector.context_static_value': 'Value',
  'inspector.context_static_add': 'Add a fixed value',
  'inspector.display_image': 'Image choices',
  'inspector.unique_prefix': 'Prefix',
  'inspector.unique_pad': 'Digit padding',
  'inspector.unique_start': 'Start at',
  'inspector.unique_reset': 'Reset the counter',
  'inspector.unique_reset_never': 'Never',
  'inspector.unique_reset_year': 'Each year',
  'inspector.unique_reset_month': 'Each month',
  'inspector.consent_notice': 'Checkbox only — add a notice later if you need one',
  'inspector.slot_minutes': 'Slot length (minutes)',
  'inspector.appointment_multi': 'Allow more than one time',
  'inspector.appointment_multi_hint': 'When on, a respondent can pick several times on the chosen date.',
  'inspector.hours_from': 'Hours from',
  'inspector.hours_to': 'Hours to',
  'inspector.rolling_days': 'Days ahead',
  'inspector.section_name': 'Section name',
  'inspector.section_name_hint': 'Shown in the section navigator, for example Personal information',
  'inspector.section_desc': 'Description',
  'inspector.section_in_nav': 'Show in the section navigator',
  'inspector.section_heading': 'Show this name on the form',
  'inspector.section_heading_align': 'Heading alignment',
  'inspector.heading_align_left': 'Left',
  'inspector.heading_align_center': 'Centre',
  'inspector.heading_align_right': 'Right',
  'inspector.section_nav': 'Navigator',
  'inspector.section_nav_enabled': 'Show the section navigator',
  'inspector.section_placement': 'Placement',
  'inspector.section_placement_top': 'Top',
  'inspector.section_placement_bottom': 'Bottom',
  'inspector.section_placement_left': 'Left',
  'inspector.section_placement_right': 'Right',
  'inspector.section_placement_top_left': 'Top left',
  'inspector.section_placement_top_right': 'Top right',
  'inspector.section_placement_bottom_left': 'Bottom left',
  'inspector.section_placement_bottom_right': 'Bottom right',
  'inspector.section_variant': 'Style',
  'inspector.section_variant_stepper': 'Steps with labels',
  'inspector.section_variant_pills': 'Pills',
  'inspector.section_variant_dots': 'Dots',
  'inspector.section_variant_numbers': 'Numbers',
  'inspector.section_variant_breadcrumb': 'Breadcrumb',
  'inspector.section_variant_timeline': 'Timeline',
  'inspector.section_chrome': 'Navigator frame',
  'inspector.section_chrome_plain': 'Plain',
  'inspector.section_chrome_cards': 'Cards',
  'inspector.section_chrome_circles': 'Circles',
  'inspector.section_chrome_bar': 'Bar',
  'inspector.section_marker': 'Break look',
  'inspector.section_marker_line': 'Line',
  'inspector.section_marker_card': 'Card',
  'inspector.section_marker_pill': 'Pill',
  'inspector.section_marker_badge': 'Badge',
  'inspector.section_current': 'Current section',
  'inspector.section_current_color': 'Accent colour',
  'inspector.section_current_fill': 'Filled background',
  'inspector.section_current_pulse': 'Pulse / blink',
  'inspector.section_current_underline': 'Underline',
  'inspector.section_current_bold': 'Bold',
  'inspector.section_completed': 'Completed sections',
  'inspector.section_completed_check': 'Tick mark',
  'inspector.section_completed_muted': 'Muted',
  'inspector.section_completed_keep': 'Same as upcoming',
  'inspector.section_connector': 'Between steps',
  'inspector.section_connector_arrow': 'Arrow',
  'inspector.section_connector_line': 'Line',
  'inspector.section_connector_chevron': 'Chevron',
  'inspector.section_connector_none': 'None',
  'inspector.section_sticky': 'Stick to the edge while scrolling',
  'inspector.section_clickable': 'Allow jumping to a completed section',
  'inspector.section_show_index': 'Show step numbers',
  'inspector.section_include_submit': 'Include a Submit step',
  'inspector.section_submit_label': 'Submit step label',
  'inspector.section_align': 'Alignment',
  'inspector.section_align_start': 'Start',
  'inspector.section_align_center': 'Centre',
  'inspector.section_align_end': 'End',
  'inspector.collapsible': 'Collapsible',
  'inspector.initially_collapsed': 'Start collapsed',
  'inspector.postal_validate': 'Validate PIN / postal code',
  'inspector.country_mode': 'Country',
  'inspector.country_fixed': 'Fixed (India by default)',
  'inspector.country_any': 'Respondent picks any country',
  'inspector.parent_name': 'Father or mother name',
  'inspector.parent_name_hint': 'Adds a field between first and last name. It is optional unless you require it under Validation.',
  'inspector.parent_name_label': 'Father / Mother name',
});

const MIB = 1024 * 1024;

type AnyBlock = BlockOf<AvailableType>;

/** Replaces the block's config with `patch` applied; `undefined` removes a setting. */
function setConfig(block: Pick<AnyBlock, 'id' | 'config'>, patch: Readonly<Record<string, unknown>>): void {
  patchBlockConfig(block, patch);
}

const text = (value: string) => (value === '' ? undefined : value);
const decimal = (s: string): DecimalString | null => (/^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(s) ? (s as DecimalString) : null);

/** A cross-field problem the type's registry schema reports (min above max …), shown under the section. */
function ConfigProblem({ block }: { block: AnyBlock }) {
  const parsed = (REGISTRY[block.type].configSchema as SchemaLike<unknown>).safeParse(block.config);
  if (parsed.success) return null;
  const issues = (parsed.error as { issues?: Array<{ message: string }> }).issues ?? [];
  return (
    <p role="alert" className="text-[12px] text-destructive">
      {t(M['inspector.config_problem'], { problem: issues.map((i) => i.message).join('; ') })}
    </p>
  );
}

function Placeholder({ block }: { block: AnyBlock }) {
  const config = block.config as { placeholder?: string };
  return <TextField label={t(M['inspector.placeholder'])} hint={t(M['inspector.placeholder_hint'])} value={config.placeholder} onChange={(v) => setConfig(block, { placeholder: text(v) })} />;
}

type Chrome = BlockOf<'short_text' | 'email' | 'number' | 'url'>;

function Affixes({ block }: { block: Chrome }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <TextField label={t(M['inspector.prefix'])} value={block.config.prefix} onChange={(v) => setConfig(block, { prefix: text(v) })} />
      <TextField label={t(M['inspector.suffix'])} value={block.config.suffix} onChange={(v) => setConfig(block, { suffix: text(v) })} />
    </div>
  );
}

export function ChromeGeneral({ block }: { block: Chrome }) {
  return (
    <>
      <Placeholder block={block} />
      <Affixes block={block} />
    </>
  );
}

const PARENT_PART: NamePart = 'middle';

function orderedNameParts(parts: readonly NamePart[], include: NamePart, on: boolean): NamePart[] {
  const next = new Set(on ? [...parts, include] : parts.filter((part) => part !== include));
  return NAME_PARTS.filter((part) => next.has(part));
}

export function FullNameGeneral({ block }: InspectorProps<'full_name'>) {
  const on = block.config.parts.includes(PARENT_PART);
  return (
    <ToggleRow
      label={t(M['inspector.parent_name'])}
      hint={t(M['inspector.parent_name_hint'])}
      checked={on}
      onChange={(checked) => {
        const parts = orderedNameParts(block.config.parts, PARENT_PART, checked);
        const requiredParts = checked ? block.config.requiredParts : block.config.requiredParts.filter((part) => part !== PARENT_PART);
        const sublabels = { ...block.config.sublabels };
        if (checked) sublabels[PARENT_PART] = t(M['inspector.parent_name_label']);
        else delete sublabels[PARENT_PART];
        setConfig(block, { parts, requiredParts, sublabels: Object.keys(sublabels).length ? sublabels : undefined });
      }}
    />
  );
}

export function EmailGeneral({ block }: InspectorProps<'email'>) {
  return (
    <>
      <ChromeGeneral block={block} />
      <ToggleRow
        label={t(M['inspector.email_verify'])}
        checked={block.config.verify?.enabled === true}
        onChange={(on) => setConfig(block, { verify: on ? { enabled: true, codeLength: 6, ttlMinutes: 10 } : undefined })}
      />
    </>
  );
}

const count = (max: number) => parseInteger(0, max);

const PATTERN_FEATURE_MESSAGE = {
  lookaround: 'inspector.pattern_unsupported_lookaround',
  backref: 'inspector.pattern_unsupported_backref',
} as const;

function shortTextPatternError(source: string): string | null {
  const problem = patternProblem({ source });
  if (!problem) return null;
  const feature = patternUnsupportedFeature(source);
  return feature ? t(M[PATTERN_FEATURE_MESSAGE[feature]]) : t(M['inspector.pattern_invalid'], { problem });
}

export function ShortTextValidation({ block }: InspectorProps<'short_text'>) {
  const pattern = block.config.pattern?.source ?? '';
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min_length'])} value={block.config.minLength} parse={count(SHORT_TEXT_MAX)} onChange={(minLength) => setConfig(block, { minLength })} />
        <NumberField label={t(M['inspector.max_length'])} value={block.config.maxLength} parse={count(SHORT_TEXT_MAX)} onChange={(maxLength) => setConfig(block, { maxLength })} />
      </div>
      <TextField
        label={t(M['inspector.pattern'])}
        hint={t(M['inspector.pattern_hint'])}
        value={pattern}
        placeholder="^[A-Z].+"
        error={pattern ? shortTextPatternError(pattern) : null}
        onChange={(source) => setConfig(block, { pattern: source && source.length <= 256 ? { source } : undefined })}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function LongTextGeneral({ block }: InspectorProps<'long_text'>) {
  return (
    <>
      <Placeholder block={block} />
      <NumberField label={t(M['inspector.rows'])} value={block.config.rows} parse={parseInteger(1, 50)} onChange={(rows) => setConfig(block, { rows })} />
    </>
  );
}

export function LongTextValidation({ block }: InspectorProps<'long_text'>) {
  const limit = block.config.limit;
  const setLimit = (patch: { unit?: 'characters' | 'words'; min?: number | undefined; max?: number | undefined }) => {
    const next = { unit: 'characters' as const, ...limit, ...patch };
    const unused = next.min === undefined && next.max === undefined && next.unit === 'characters';
    setConfig(block, { limit: unused ? undefined : next });
  };
  return (
    <>
      <SelectField
        label={t(M['inspector.limit_unit'])}
        value={limit?.unit ?? 'characters'}
        options={[
          { value: 'characters', label: t(M['inspector.limit_characters']) },
          { value: 'words', label: t(M['inspector.limit_words']) },
        ]}
        onChange={(unit) => setLimit({ unit: unit as 'characters' | 'words' })}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min_length'])} value={limit?.min} parse={count(50_000)} onChange={(min) => setLimit({ min })} />
        <NumberField label={t(M['inspector.max_length'])} value={limit?.max} parse={count(50_000)} onChange={(max) => setLimit({ max })} />
      </div>
      <ToggleRow label={t(M['inspector.counter'])} checked={block.config.showCounter === true} onChange={(on) => setConfig(block, { showCounter: on || undefined })} />
      <ConfigProblem block={block} />
    </>
  );
}

export function PhoneGeneral({ block }: InspectorProps<'phone'>) {
  return (
    <>
      <Placeholder block={block} />
      <TextField
        label={t(M['inspector.country'])}
        value={block.config.defaultCountry}
        onChange={(v) => {
          if (/^[A-Z]{2}$/.test(v.toUpperCase())) setConfig(block, { defaultCountry: v.toUpperCase() });
        }}
      />
      <ToggleRow label={t(M['inspector.country_select'])} checked={block.config.showCountrySelect} onChange={(showCountrySelect) => setConfig(block, { showCountrySelect })} />
    </>
  );
}

export function NumberGeneral({ block }: InspectorProps<'number'>) {
  return (
    <>
      <ChromeGeneral block={block} />
      <SelectField
        label={t(M['inspector.display'])}
        value={block.config.display}
        options={[{ value: 'input', label: t(M['inspector.display_input']) }, { value: 'stepper', label: t(M['inspector.display_stepper']) }]}
        onChange={(display) => setConfig(block, { display })}
      />
    </>
  );
}

export function NumberValidation({ block }: InspectorProps<'number'>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min'])} value={block.config.min} parse={decimal} onChange={(min) => setConfig(block, { min })} />
        <NumberField label={t(M['inspector.max'])} value={block.config.max} parse={decimal} onChange={(max) => setConfig(block, { max })} />
      </div>
      <NumberField label={t(M['inspector.step'])} value={block.config.step} parse={decimal} onChange={(step) => setConfig(block, { step })} />
      <ToggleRow label={t(M['inspector.integer_only'])} hint={t(M['inspector.integer_only_hint'])} checked={block.config.integerOnly === true} onChange={(on) => setConfig(block, { integerOnly: on || undefined })} />
      <ToggleRow label={t(M['inspector.allow_negative'])} checked={block.config.allowNegative !== false} onChange={(on) => setConfig(block, { allowNegative: on ? undefined : false })} />
      <ConfigProblem block={block} />
    </>
  );
}

export function ChoiceGeneral({ block }: { block: BlockOf<'single_choice' | 'multi_choice'> }) {
  const list = block.type === 'single_choice' ? 'radio' : 'checkbox';
  return (
    <>
      <SelectField
        label={t(M['inspector.display'])}
        value={block.config.display === 'dropdown' || block.config.display === 'image' ? block.config.display : list}
        options={[
          { value: list, label: t(list === 'radio' ? M['inspector.display_radio'] : M['inspector.display_checkbox']) },
          { value: 'dropdown', label: t(M['inspector.display_dropdown']) },
          { value: 'image', label: t(M['inspector.display_image']) },
        ]}
        onChange={(display) => setConfig(block, { display })}
      />
      {block.config.display === 'dropdown' ? <Placeholder block={block} /> : null}
      {block.config.display === 'dropdown' ? (
        <ToggleRow label={t(M['inspector.searchable'])} checked={block.config.searchable === true} onChange={(on) => setConfig(block, { searchable: on || undefined })} />
      ) : null}
    </>
  );
}

export function MultiChoiceValidation({ block }: InspectorProps<'multi_choice'>) {
  const n = block.config.options.length;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min_selected'])} value={block.config.minSelected} parse={parseInteger(0, n)} onChange={(minSelected) => setConfig(block, { minSelected })} />
        <NumberField label={t(M['inspector.max_selected'])} value={block.config.maxSelected} parse={parseInteger(1, n)} onChange={(maxSelected) => setConfig(block, { maxSelected })} />
      </div>
      <ChoiceOtherValidation block={block} />
      <ConfigProblem block={block} />
    </>
  );
}

export function SingleChoiceValidation({ block }: InspectorProps<'single_choice'>) {
  return (
    <>
      <ChoiceOtherValidation block={block} />
      <ConfigProblem block={block} />
    </>
  );
}

export function AddressGeneral({ block }: InspectorProps<'address'>) {
  return (
    <>
      <SelectField
        label={t(M['inspector.country_mode'])}
        value={block.config.country.mode}
        options={[
          { value: 'fixed', label: t(M['inspector.country_fixed']) },
          { value: 'any', label: t(M['inspector.country_any']) },
        ]}
        onChange={(mode) => setConfig(block, { country: { ...block.config.country, mode } })}
      />
      <ToggleRow label={t(M['inspector.postal_validate'])} checked={block.config.validatePostalCode} onChange={(on) => setConfig(block, { validatePostalCode: on })} />
    </>
  );
}

export function DateTimeGeneral({ block }: InspectorProps<'datetime'>) {
  return (
    <>
      <SelectField label={t(M['inspector.date_pattern'])} value={block.config.pattern} options={DATE_PATTERNS.map((p) => ({ value: p, label: p }))} onChange={(pattern) => setConfig(block, { pattern })} />
      <SelectField
        label={t(M['inspector.hour_cycle'])}
        value={block.config.hourCycle}
        options={[{ value: 'h12', label: t(M['inspector.hour_cycle_h12']) }, { value: 'h23', label: t(M['inspector.hour_cycle_h23']) }]}
        onChange={(hourCycle) => setConfig(block, { hourCycle })}
      />
      <SelectField
        label={t(M['inspector.minute_step'])}
        value={String(block.config.minuteStep)}
        options={['1', '5', '10', '15', '30'].map((v) => ({ value: v, label: v }))}
        onChange={(v) => setConfig(block, { minuteStep: Number(v) })}
      />
    </>
  );
}

export function ConsentGeneral({ block }: InspectorProps<'consent'>) {
  return <p className="text-[13px] leading-5 text-muted-foreground">{t(M['inspector.consent_notice'])} ({block.config.mode})</p>;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_HOURS = { from: '09:00' as IsoTime, to: '17:00' as IsoTime };

export function AppointmentGeneral({ block }: InspectorProps<'appointment'>) {
  const window = block.config.weekly[0] ?? DEFAULT_HOURS;
  const setHours = (from: IsoTime, to: IsoTime) => {
    const days = block.config.weekly.length > 0 ? block.config.weekly : ([1, 2, 3, 4, 5] as Weekday[]).map((weekday) => ({ weekday, from, to }));
    setConfig(block, { weekly: days.map((day) => ({ ...day, from, to })) });
  };
  return (
    <>
      <ToggleRow
        label={t(M['inspector.appointment_multi'])}
        hint={t(M['inspector.appointment_multi_hint'])}
        checked={block.config.allowMultipleTimes === true}
        onChange={(allowMultipleTimes) => setConfig(block, { allowMultipleTimes })}
      />
      <NumberField label={t(M['inspector.slot_minutes'])} value={block.config.slotMinutes} parse={parseInteger(5, 480)} onChange={(slotMinutes) => slotMinutes !== undefined && setConfig(block, { slotMinutes })} />
      <NumberField label={t(M['inspector.rolling_days'])} value={block.config.rollingDays} parse={parseInteger(1, 365)} onChange={(rollingDays) => rollingDays !== undefined && setConfig(block, { rollingDays })} />
      <Field label={t(M['inspector.hours_from'])}>
        <Input type="time" value={window.from} onChange={(e) => {
          const next = e.target.value.slice(0, 5);
          if (TIME.test(next)) setHours(next as IsoTime, window.to);
        }} />
      </Field>
      <Field label={t(M['inspector.hours_to'])}>
        <Input type="time" value={window.to} onChange={(e) => {
          const next = e.target.value.slice(0, 5);
          if (TIME.test(next)) setHours(window.from, next as IsoTime);
        }} />
      </Field>
    </>
  );
}

export function SectionGeneral({ block }: InspectorProps<'section'>) {
  const doc = currentDoc();
  const childOptions = TILES.filter((tile) => tile.kind === 'block' && tile.choice.type !== 'section').map((tile) => ({ value: tile.id, label: tile.label }));
  return (
    <>
      <ToggleRow label={t(M['inspector.collapsible'])} checked={block.config.collapsible} onChange={(collapsible) => setConfig(block, { collapsible })} />
      {block.config.collapsible ? (
        <ToggleRow label={t(M['inspector.initially_collapsed'])} checked={block.config.initiallyCollapsed === true} onChange={(on) => setConfig(block, { initiallyCollapsed: on || undefined })} />
      ) : null}
      <SectionTitle>{t(M['inspector.repeat_fields'])}</SectionTitle>
      {block.config.children.map((id) => {
        const child = doc.blocks[id];
        const name = child && isField(child) ? (plainText(child.label) || child.key) : id;
        return (
          <div key={id} className="flex items-center justify-between gap-2 text-[13px]">
            <button type="button" className="truncate text-left hover:underline" onClick={() => useUiStore.getState().openInspector(id)}>
              {name}{child ? ` · ${child.type.replace(/_/g, ' ')}` : ''}
            </button>
            <Button type="button" variant="ghost" size="icon-xs" className="text-destructive" aria-label={t(M['inspector.repeat_remove_field'])} onClick={() => requestDeleteBlock(id)}>×</Button>
          </div>
        );
      })}
      <SelectField
        label={t(M['inspector.repeat_add_field'])}
        value=""
        placeholder={t(M['inspector.repeat_pick_field'])}
        options={childOptions}
        onChange={(tileId) => {
          const tile = TILES.find((item) => item.id === tileId);
          if (tile?.kind === 'block') addChildBlock(block.id, tile.choice, { label: inlineDoc(tile.label) });
        }}
      />
    </>
  );
}

export function UniqueIdGeneral({ block }: InspectorProps<'unique_id'>) {
  const prefix = block.config.prefix.map((part) => (typeof part === 'string' ? part : '')).join('');
  return (
    <>
      <TextField label={t(M['inspector.unique_prefix'])} value={prefix} onChange={(value) => setConfig(block, { prefix: value ? [value] : [] })} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.unique_pad'])} value={block.config.padTo} parse={parseInteger(1, 20)} onChange={(padTo) => padTo !== undefined && setConfig(block, { padTo })} />
        <NumberField label={t(M['inspector.unique_start'])} value={block.config.startAt} parse={parseInteger(0, 1_000_000)} onChange={(startAt) => startAt !== undefined && setConfig(block, { startAt })} />
      </div>
      <SelectField
        label={t(M['inspector.unique_reset'])}
        value={block.config.resetEvery}
        options={[
          { value: 'never', label: t(M['inspector.unique_reset_never']) },
          { value: 'year', label: t(M['inspector.unique_reset_year']) },
          { value: 'month', label: t(M['inspector.unique_reset_month']) },
        ]}
        onChange={(resetEvery) => setConfig(block, { resetEvery })}
      />
    </>
  );
}

export function DateGeneral({ block }: InspectorProps<'date'>) {
  return (
    <>
      <SelectField label={t(M['inspector.date_pattern'])} value={block.config.pattern} options={DATE_PATTERNS.map((p) => ({ value: p, label: p }))} onChange={(pattern) => setConfig(block, { pattern })} />
      <SelectField
        label={t(M['inspector.picker'])}
        value={block.config.picker}
        options={[
          { value: 'calendar', label: t(M['inspector.picker_calendar']) },
          { value: 'selects', label: t(M['inspector.picker_selects']) },
          { value: 'native', label: t(M['inspector.picker_native']) },
        ]}
        onChange={(picker) => setConfig(block, { picker })}
      />
    </>
  );
}

export function DateRangeGeneral({ block }: InspectorProps<'date_range'>) {
  return (
    <>
      <SelectField label={t(M['inspector.date_pattern'])} value={block.config.pattern} options={DATE_PATTERNS.map((p) => ({ value: p, label: p }))} onChange={(pattern) => setConfig(block, { pattern })} />
      <SelectField
        label={t(M['inspector.picker'])}
        value={block.config.picker}
        options={[
          { value: 'calendar', label: t(M['inspector.picker_calendar']) },
          { value: 'selects', label: t(M['inspector.picker_selects']) },
          { value: 'native', label: t(M['inspector.picker_native']) },
        ]}
        onChange={(picker) => setConfig(block, { picker })}
      />
      <ToggleRow label={t(M['inspector.allow_same_day'])} checked={block.config.allowSameDay} onChange={(allowSameDay) => setConfig(block, { allowSameDay })} />
    </>
  );
}

export function TimeGeneral({ block }: InspectorProps<'time'>) {
  return (
    <>
      <SelectField
        label={t(M['inspector.hour_cycle'])}
        value={block.config.hourCycle}
        options={[{ value: 'h12', label: t(M['inspector.hour_cycle_h12']) }, { value: 'h23', label: t(M['inspector.hour_cycle_h23']) }]}
        onChange={(hourCycle) => setConfig(block, { hourCycle })}
      />
      <SelectField
        label={t(M['inspector.minute_step'])}
        value={String(block.config.minuteStep)}
        options={['1', '5', '10', '15', '30'].map((v) => ({ value: v, label: v }))}
        onChange={(v) => setConfig(block, { minuteStep: Number(v) })}
      />
      <ToggleRow
        label={t(M['inspector.time_range'])}
        checked={block.config.range?.enabled === true}
        onChange={(on) => setConfig(block, { range: on ? { enabled: true } : undefined })}
      />
    </>
  );
}

export function EndLabels({ block }: { block: BlockOf<'rating' | 'linear_scale' | 'nps' | 'likert'> }) {
  return (
    <>
      <TextField label={t(M['inspector.low_label'])} value={block.config.lowLabel} onChange={(v) => setConfig(block, { lowLabel: text(v) })} />
      <TextField label={t(M['inspector.high_label'])} value={block.config.highLabel} onChange={(v) => setConfig(block, { highLabel: text(v) })} />
    </>
  );
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).map((v) => ({ value: v, label: v }));

/** B28: the point count is a choice of 1–10, so it can never leave the range the schema allows. */
export function RatingGeneral({ block }: InspectorProps<'rating'>) {
  const icons = ['star', 'heart', 'thumb', 'smiley', 'number'] as const;
  const labels = { star: M['inspector.icon_star'], heart: M['inspector.icon_heart'], thumb: M['inspector.icon_thumb'], smiley: M['inspector.icon_smiley'], number: M['inspector.icon_number'] };
  return (
    <>
      <SelectField
        label={t(M['inspector.rating_max'])}
        value={String(block.config.max)}
        options={range(1, 10)}
        onChange={(v) => {
          const max = Number(v);
          setConfig(block, { max, defaultValue: block.config.defaultValue !== undefined && block.config.defaultValue > max ? undefined : block.config.defaultValue });
        }}
      />
      <SelectField label={t(M['inspector.rating_icon'])} value={block.config.icon} options={icons.map((i) => ({ value: i, label: t(labels[i]) }))} onChange={(icon) => setConfig(block, { icon })} />
      <EndLabels block={block} />
    </>
  );
}

export function ScaleGeneral({ block }: InspectorProps<'linear_scale'>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <SelectField label={t(M['inspector.scale_min'])} value={String(block.config.min)} options={range(0, 1)} onChange={(v) => setConfig(block, { min: Number(v) })} />
        <SelectField label={t(M['inspector.scale_max'])} value={String(block.config.max)} options={range(2, 10)} onChange={(v) => setConfig(block, { max: Number(v) })} />
      </div>
      <EndLabels block={block} />
    </>
  );
}

export function FileValidation({ block }: InspectorProps<'file_upload'>) {
  const { accept } = block.config;
  return (
    <>
      <FileMinLimits block={block} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.max_files'])} value={block.config.maxFiles} parse={parseInteger(1, 20)} onChange={(maxFiles) => maxFiles !== undefined && setConfig(block, { maxFiles })} />
        <NumberField
          label={t(M['inspector.max_size'])}
          value={Math.round(block.config.maxFileBytes / MIB)}
          parse={parseInteger(1, 1024)}
          onChange={(mb) => mb !== undefined && setConfig(block, { maxFileBytes: mb * MIB })}
        />
      </div>
      <SelectField
        label={t(M['inspector.capture'])}
        value={block.config.capture}
        options={[
          { value: 'none', label: t(M['inspector.capture_none']) },
          { value: 'user', label: t(M['inspector.capture_user']) },
          { value: 'environment', label: t(M['inspector.capture_environment']) },
        ]}
        onChange={(capture) => setConfig(block, { capture })}
      />
      <TextField
        label={t(M['inspector.extensions'])}
        hint={t(M['inspector.extensions_hint'])}
        value={accept.extensions.join(', ')}
        onChange={(v) => {
          const extensions = v.split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter((e) => /^[a-z0-9]{1,10}$/.test(e));
          setConfig(block, { accept: { extensions, mimeTypes: extensions.length ? [] : accept.mimeTypes } });
        }}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function SignatureGeneral({ block }: InspectorProps<'signature'>) {
  return (
    <>
      <ToggleRow label={t(M['inspector.typed_signature'])} checked={block.config.allowTyped} onChange={(allowTyped) => setConfig(block, { allowTyped })} />
      <NumberField label={t(M['inspector.height'])} value={block.config.heightPx} parse={parseInteger(80, 400)} onChange={(heightPx) => heightPx !== undefined && setConfig(block, { heightPx })} />
    </>
  );
}

export function HiddenGeneral({ block }: InspectorProps<'hidden'>) {
  const source = block.config.source;
  const kind = source.kind === 'expr' ? 'static' : source.kind;
  const utm = ['source', 'medium', 'campaign', 'term', 'content'] as const;
  return (
    <>
      <SelectField
        label={t(M['inspector.source'])}
        value={kind}
        options={[
          { value: 'url_param', label: t(M['inspector.source_url_param']) },
          { value: 'utm', label: t(M['inspector.source_utm']) },
          { value: 'static', label: t(M['inspector.source_static']) },
        ]}
        onChange={(next) => setConfig(block, { source: next === 'utm' ? { kind: 'utm', param: 'source' } : next === 'static' ? { kind: 'static', value: [] } : { kind: 'url_param' } })}
      />
      {source.kind === 'url_param' ? (
        <TextField
          label={t(M['inspector.param_name'])}
          hint={t(M['inspector.param_name_hint'])}
          value={source.name}
          placeholder={block.key}
          onChange={(name) => setConfig(block, { source: { kind: 'url_param', ...(/^[A-Za-z0-9_.-]{1,64}$/.test(name) ? { name } : {}) } })}
        />
      ) : null}
      {source.kind === 'utm' ? (
        <SelectField label={t(M['inspector.param_name'])} value={source.param} options={utm.map((p) => ({ value: p, label: `utm_${p}` }))} onChange={(param) => setConfig(block, { source: { kind: 'utm', param } })} />
      ) : null}
      {source.kind === 'static' ? (
        <TextField
          label={t(M['inspector.static_value'])}
          value={source.value.filter((p) => typeof p === 'string').join('')}
          onChange={(value) => setConfig(block, { source: { kind: 'static', value: value ? [value] : [] } })}
        />
      ) : null}
    </>
  );
}

const CALC_SOURCES = new Set(['number', 'rating', 'linear_scale', 'nps', 'repeating_group', 'calculation']);

function listParentOf(id: string): boolean {
  return Object.values(currentDoc().blocks).some((b) => b?.type === 'repeating_group' && b.config.children.includes(id as never));
}

export function CalculationGeneral({ block }: InspectorProps<'calculation'>) {
  const doc = currentDoc();
  const sources = Object.values(doc.blocks).flatMap((b) => {
    if (!b || b.id === block.id || !isField(b) || !CALC_SOURCES.has(b.type)) return [];
    const list = listParentOf(b.id);
    const insert = list ? `sum(${b.key})` : b.key;
    return [{ id: b.id, key: b.key, insert, label: list ? `sum(${plainText(b.label) || b.key})` : plainText(b.label) || b.key }];
  });
  const keys = new Map(sources.map((s) => [s.key, s.id]));
  const labels = new Map(sources.map((s) => [s.id, s.key]));
  const stored = formatFormula(block.config.expr, labels);
  const shown = stored === '0' && block.config.expr.k === 'lit' ? '' : stored;
  const [draft, setDraft] = useDraft(shown);
  const parsed = parseFormula(draft, keys);
  return (
    <>
      <TextField
        label={t(M['inspector.calc_formula'])}
        hint={t(M['inspector.calc_formula_hint'])}
        value={draft}
        error={parsed.ok ? null : parsed.error}
        placeholder="qty * price"
        onChange={(text) => {
          setDraft(text);
          const next = parseFormula(text, keys);
          if (next.ok) setConfig(block, { expr: next.expr });
        }}
      />
      <SectionTitle>{t(M['inspector.calc_fields'])}</SectionTitle>
      {sources.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t(M['inspector.calc_no_fields'])}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {sources.map((source) => (
            <Button
              key={source.id}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const text = draft.trim() ? `${draft.trimEnd()} ${source.insert}` : source.insert;
                setDraft(text);
                const next = parseFormula(text, keys);
                if (next.ok) setConfig(block, { expr: next.expr });
              }}
            >
              {source.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {(['+', '-', '*', '/', '(', ')'] as const).map((op) => (
          <Button
            key={op}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const text = `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}${op} `;
              setDraft(text);
              const next = parseFormula(text, keys);
              if (next.ok) setConfig(block, { expr: next.expr });
            }}
          >
            {op}
          </Button>
        ))}
      </div>
      <SelectField
        label={t(M['inspector.calc_display'])}
        value={block.config.display}
        options={[
          { value: 'visible', label: t(M['inspector.calc_display']) },
          { value: 'hidden', label: t(M['inspector.calc_hidden']) },
        ]}
        onChange={(display) => setConfig(block, { display })}
      />
    </>
  );
}

const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function ContextGeneral({ block }: InspectorProps<'context'>) {
  const selected = new Set(block.config.sources);
  const extras = (block.config.urlParams?.length ?? 0) + (block.config.staticFacts?.length ?? 0);
  const toggle = (source: ContextSource, on: boolean) => {
    const next = CONTEXT_SOURCES.filter((item) => (item === source ? on : selected.has(item)));
    if (next.length === 0 && extras === 0) return;
    setConfig(block, { sources: [...next] });
  };
  const urls = selected.has('page_url') || selected.has('referrer');
  const facts = block.config.staticFacts ?? [];
  return (
    <>
      <ToggleRow
        label={t(M['inspector.context_hidden'])}
        checked={block.config.display === 'hidden'}
        onChange={(on) => setConfig(block, { display: on ? 'hidden' : 'visible' })}
      />
      <SectionTitle>{t(M['inspector.context_facts'])}</SectionTitle>
      {CONTEXT_SOURCES.map((source) => (
        <ToggleRow
          key={source}
          label={t(PALETTE_LABELS[`palette.context.${source}`])}
          checked={selected.has(source)}
          onChange={(on) => toggle(source, on)}
        />
      ))}
      {urls ? (
        <ToggleRow label={t(M['inspector.context_strip'])} checked={block.config.stripQuery === true} onChange={(on) => setConfig(block, { stripQuery: on || undefined })} />
      ) : null}
      <TextField
        label={t(M['inspector.context_url_params'])}
        hint={t(M['inspector.context_url_params_hint'])}
        value={(block.config.urlParams ?? []).join(', ')}
        onChange={(text) => {
          const urlParams = text.split(',').map((part) => part.trim()).filter((name) => PARAM_NAME.test(name));
          setConfig(block, { urlParams: urlParams.length > 0 ? [...new Set(urlParams)] : undefined });
        }}
      />
      <SectionTitle>{t(M['inspector.context_static'])}</SectionTitle>
      {facts.map((fact, i) => (
        <div key={`${fact.key}-${i}`} className="grid grid-cols-2 gap-2">
          <TextField
            label={t(M['inspector.context_static_key'])}
            value={fact.key}
            onChange={(key) => {
              if (!PARAM_NAME.test(key) && key !== '') return;
              const next = facts.map((item, j) => (j === i ? { ...item, key } : item));
              setConfig(block, { staticFacts: next });
            }}
          />
          <TextField
            label={t(M['inspector.context_static_value'])}
            value={fact.value}
            onChange={(value) => {
              const next = facts.map((item, j) => (j === i ? { ...item, value } : item));
              setConfig(block, { staticFacts: next.filter((item) => item.key && item.value) });
            }}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setConfig(block, { staticFacts: [...facts, { key: `value_${facts.length + 1}`, value: 'fixed' }] })}
      >
        {t(M['inspector.context_static_add'])}
      </Button>
    </>
  );
}

export function HeadingGeneral({ block }: InspectorProps<'heading'>) {
  return (
    <SelectField
      label={t(M['inspector.size'])}
      value={String(block.config.level)}
      options={[
        { value: '1', label: t(M['inspector.size_large']) },
        { value: '2', label: t(M['inspector.size_medium']) },
        { value: '3', label: t(M['inspector.size_small']) },
      ]}
      onChange={(v) => setConfig(block, { level: Number(v) })}
    />
  );
}

export function DividerGeneral({ block }: InspectorProps<'divider'>) {
  return (
    <>
      <SelectField
        label={t(M['inspector.line'])}
        value={block.config.lineStyle}
        options={(['solid', 'dashed', 'dotted', 'none'] as const).map((v) => ({ value: v, label: t(M[`inspector.line_${v}`]) }))}
        onChange={(lineStyle) => setConfig(block, { lineStyle })}
      />
      <SelectField
        label={t(M['inspector.spacing'])}
        value={block.config.spacing}
        options={(['sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: t(M[`inspector.spacing_${v}`]) }))}
        onChange={(spacing) => setConfig(block, { spacing })}
      />
    </>
  );
}

export function SectionBreakGeneral({ block }: InspectorProps<'section_break'>) {
  return (
    <>
      <TextField
        label={t(M['inspector.section_name'])}
        hint={t(M['inspector.section_name_hint'])}
        value={block.config.name}
        onChange={(name) => setConfig(block, { name: name.slice(0, 80) })}
      />
      <TextField
        label={t(M['inspector.section_desc'])}
        value={block.config.description ?? ''}
        onChange={(description) => setConfig(block, { description: text(description) })}
      />
      <ToggleRow
        label={t(M['inspector.section_in_nav'])}
        checked={block.config.showInNav !== false}
        onChange={(showInNav) => setConfig(block, { showInNav })}
      />
      <ToggleRow
        label={t(M['inspector.section_heading'])}
        checked={block.config.showHeading === true}
        onChange={(showHeading) => setConfig(block, { showHeading })}
      />
      {block.config.showHeading ? (
        <SelectField
          label={t(M['inspector.section_heading_align'])}
          value={block.config.headingAlign ?? 'left'}
          options={[
            { value: 'left', label: t(M['inspector.section_align_start']) },
            { value: 'center', label: t(M['inspector.section_align_center']) },
            { value: 'right', label: t(M['inspector.section_align_end']) },
          ]}
          onChange={(headingAlign) => setConfig(block, { headingAlign: headingAlign as 'left' | 'center' | 'right' })}
        />
      ) : null}
      <SelectField
        label={t(M['inspector.section_marker'])}
        value={block.config.marker ?? 'card'}
        options={(['line', 'card', 'pill', 'badge'] as const).map((v) => ({ value: v, label: t(M[`inspector.section_marker_${v}`]) }))}
        onChange={(marker) => setConfig(block, { marker })}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function ChoiceOptions({ block }: { block: BlockOf<'single_choice' | 'multi_choice' | 'ranking' | 'matching' | 'constant_sum' | 'maxdiff'> }) {
  return <OptionsEditor block={block} />;
}

function LabelList({
  title,
  addLabel,
  items,
  onChange,
}: {
  title: string;
  addLabel: string;
  items: Array<{ id: string; label: string }>;
  onChange: (next: Array<{ id: string; label: string }>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto px-1 py-0 text-[12px] text-primary"
          onClick={() => onChange([...items, { id: APP_IDS.newId(), label: `${title.replace(/s$/, '')} ${items.length + 1}` }])}
        >
          {addLabel}
        </Button>
      </div>
      {items.map((item, i) => (
        <div key={item.id} className="flex gap-1">
          <TextField
            label=""
            value={item.label}
            onChange={(label) => onChange(items.map((row, j) => (j === i ? { ...row, label } : row)))}
          />
          {items.length > 1 ? (
            <Button type="button" variant="ghost" size="icon-xs" className="text-destructive" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function MatchingGeneral({ block }: InspectorProps<'matching'>) {
  return (
    <>
      <ToggleRow label={t(M['inspector.matching_exclusive'])} checked={block.config.exclusive} onChange={(exclusive) => setConfig(block, { exclusive })} />
      <LabelList
        title={t(M['inspector.matching_prompts'])}
        addLabel={t(M['inspector.matching_add_prompt'])}
        items={block.config.prompts}
        onChange={(prompts) => setConfig(block, { prompts: prompts.map((row) => ({ id: row.id as MatchingPromptId, label: row.label })) })}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function LikertGeneral({ block }: InspectorProps<'likert'>) {
  return (
    <>
      <SelectField label={t(M['inspector.scale_max'])} value={String(block.config.max)} options={range(2, 10)} onChange={(v) => setConfig(block, { max: Number(v) })} />
      <EndLabels block={block} />
      <LabelList
        title={t(M['inspector.likert_statements'])}
        addLabel={t(M['inspector.likert_add_statement'])}
        items={block.config.statements}
        onChange={(statements) => setConfig(block, { statements: statements.map((row) => ({ id: row.id as LikertStatementId, label: row.label })) })}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function ConstantSumGeneral({ block }: InspectorProps<'constant_sum'>) {
  return (
    <>
      <NumberField label={t(M['inspector.sum_target'])} value={block.config.target} parse={parseInteger(1, 10_000)} onChange={(target) => target !== undefined && setConfig(block, { target })} />
      <ToggleRow label={t(M['inspector.sum_allow_zero'])} checked={block.config.allowZero} onChange={(allowZero) => setConfig(block, { allowZero })} />
      <ConfigProblem block={block} />
    </>
  );
}

export function SemanticDifferentialGeneral({ block }: InspectorProps<'semantic_differential'>) {
  return (
    <>
      <SelectField label={t(M['inspector.scale_max'])} value={String(block.config.max)} options={range(2, 10)} onChange={(v) => setConfig(block, { max: Number(v) })} />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t(M['inspector.semantic_pairs'])}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1 py-0 text-[12px] text-primary"
            onClick={() => setConfig(block, { pairs: [...block.config.pairs, { id: APP_IDS.newId() as SemanticPairId, left: t(M['inspector.semantic_left']), right: t(M['inspector.semantic_right']) }] })}
          >
            {t(M['inspector.semantic_add'])}
          </Button>
        </div>
        {block.config.pairs.map((pair, i) => (
          <div key={pair.id} className="grid grid-cols-[1fr_1fr_auto] gap-1">
            <TextField label="" value={pair.left} onChange={(left) => setConfig(block, { pairs: block.config.pairs.map((row, j) => (j === i ? { ...row, left } : row)) })} />
            <TextField label="" value={pair.right} onChange={(right) => setConfig(block, { pairs: block.config.pairs.map((row, j) => (j === i ? { ...row, right } : row)) })} />
            {block.config.pairs.length > 1 ? (
              <Button type="button" variant="ghost" size="icon-xs" className="text-destructive" onClick={() => setConfig(block, { pairs: block.config.pairs.filter((_, j) => j !== i) })}>
                ×
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <ConfigProblem block={block} />
    </>
  );
}

export function NumberRangeValidation({ block }: InspectorProps<'number_range'>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min'])} value={block.config.min} parse={decimal} onChange={(min) => setConfig(block, { min })} />
        <NumberField label={t(M['inspector.max'])} value={block.config.max} parse={decimal} onChange={(max) => setConfig(block, { max })} />
      </div>
      <ToggleRow label={t(M['inspector.integer_only'])} hint={t(M['inspector.integer_only_hint'])} checked={block.config.integerOnly === true} onChange={(on) => setConfig(block, { integerOnly: on || undefined })} />
      <ToggleRow label={t(M['inspector.allow_negative'])} checked={block.config.allowNegative !== false} onChange={(on) => setConfig(block, { allowNegative: on ? undefined : false })} />
      <ConfigProblem block={block} />
    </>
  );
}

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_LABEL = {
  0: M['inspector.weekday_0'],
  1: M['inspector.weekday_1'],
  2: M['inspector.weekday_2'],
  3: M['inspector.weekday_3'],
  4: M['inspector.weekday_4'],
  5: M['inspector.weekday_5'],
  6: M['inspector.weekday_6'],
} as const;
const SLOT = /^\d{2}:\d{2}$/;

export function ScheduleGridGeneral({ block }: InspectorProps<'schedule_grid'>) {
  const toggleDay = (day: Weekday, on: boolean) => {
    const weekdays = on ? [...block.config.weekdays, day].sort((a, b) => a - b) : block.config.weekdays.filter((d) => d !== day);
    if (weekdays.length === 0) return;
    setConfig(block, { weekdays });
  };
  return (
    <>
      <div className="space-y-1">
        <span className="text-[12px] font-medium">{t(M['inspector.schedule_days'])}</span>
        {WEEKDAYS.map((day) => (
          <ToggleRow
            key={day}
            label={t(WEEKDAY_LABEL[day])}
            checked={block.config.weekdays.includes(day)}
            onChange={(on) => toggleDay(day, on)}
          />
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium">{t(M['inspector.schedule_slots'])}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1 py-0 text-[12px] text-primary"
            onClick={() => setConfig(block, { slots: [...block.config.slots, '09:00' as IsoTime] })}
          >
            {t(M['inspector.schedule_add_slot'])}
          </Button>
        </div>
        {block.config.slots.map((slot, i) => (
          <div key={`${slot}-${i}`} className="flex gap-1">
            <TextField
              label=""
              value={slot}
              onChange={(raw) => {
                if (!SLOT.test(raw)) return;
                setConfig(block, { slots: block.config.slots.map((s, j) => (j === i ? (raw as IsoTime) : s)) });
              }}
            />
            {block.config.slots.length > 1 ? (
              <Button type="button" variant="ghost" size="icon-xs" className="text-destructive" onClick={() => setConfig(block, { slots: block.config.slots.filter((_, j) => j !== i) })}>
                ×
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <ConfigProblem block={block} />
    </>
  );
}

export function CardSortGeneral({ block }: InspectorProps<'card_sort'>) {
  return (
    <>
      <ToggleRow label={t(M['inspector.card_exclusive'])} checked={block.config.exclusive} onChange={(exclusive) => setConfig(block, { exclusive })} />
      <LabelList
        title={t(M['inspector.card_items'])}
        addLabel={t(M['inspector.card_add_item'])}
        items={block.config.items}
        onChange={(items) => setConfig(block, { items: items.map((row) => ({ id: row.id as CardItemId, label: row.label })) })}
      />
      <LabelList
        title={t(M['inspector.card_buckets'])}
        addLabel={t(M['inspector.card_add_bucket'])}
        items={block.config.buckets}
        onChange={(buckets) => {
          if (buckets.length < 2) return;
          setConfig(block, { buckets: buckets.map((row) => ({ id: row.id as CardBucketId, label: row.label })) });
        }}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function MatrixGeneral({ block }: InspectorProps<'matrix'>) {
  const mode = block.config.mode;
  const MATRIX_MODES: readonly (typeof mode)[] = ['single', 'multi', 'grid'];
  const inputFor = (next: typeof mode) => (next === 'single' ? 'choice' as const : next === 'multi' ? 'checkbox' as const : 'text' as const);
  const setMode = (next: typeof mode) => {
    const input = inputFor(next);
    setConfig(block, {
      mode: next,
      columns: block.config.columns.map((col) => ({ id: col.id, label: col.label, input })),
    });
  };
  return (
    <>
      <ToggleRow
        label={t(M['inspector.matrix_multi'])}
        hint={t(M['inspector.matrix_multi_hint'])}
        checked={mode !== 'single'}
        onChange={(on) => setMode(on ? (mode === 'grid' ? 'grid' : 'multi') : 'single')}
      />
      {mode === 'grid' ? (
        <SelectField
          label={t(M['inspector.matrix_mode'])}
          value={mode}
          options={[
            { value: 'single', label: t(M['inspector.matrix_mode_single']) },
            { value: 'multi', label: t(M['inspector.matrix_mode_multi']) },
            { value: 'grid', label: t(M['inspector.matrix_mode_grid']) },
          ]}
          onChange={(value) => {
            const next = MATRIX_MODES.find((m) => m === value);
            if (next) setMode(next);
          }}
        />
      ) : null}
      <LabelList
        title={t(M['inspector.matrix_rows'])}
        addLabel={t(M['inspector.matrix_add_row'])}
        items={block.config.rows.map((row) => ({ id: row.id, label: typeof row.label === 'string' ? row.label : '' }))}
        onChange={(rows) => setConfig(block, { rows: rows.map((row) => ({ id: row.id as MatrixRowId, label: row.label })) })}
      />
      <LabelList
        title={t(M['inspector.matrix_columns'])}
        addLabel={t(M['inspector.matrix_add_column'])}
        items={block.config.columns.map((col) => ({ id: col.id, label: col.label }))}
        onChange={(columns) =>
          setConfig(block, {
            columns: columns.map((col) => ({
              id: col.id as MatrixColumnId,
              label: col.label,
              input: block.config.columns.find((c) => c.id === col.id)?.input ?? inputFor(mode),
            })),
          })
        }
      />
      <ConfigProblem block={block} />
    </>
  );
}

const CHILD_TILES = TILES.filter((tile) => tile.kind === 'block' && isRepeatableChildType(tile.choice.type));

export function RepeatingGroupGeneral({ block }: InspectorProps<'repeating_group'>) {
  const doc = currentDoc();
  const childOptions = CHILD_TILES.filter((tile) => tile.kind === 'block').map((tile) => ({ value: tile.id, label: tile.label }));
  return (
    <>
      <NumberField label={t(M['inspector.repeat_min'])} value={block.config.minRows} parse={parseInteger(0, 200)} onChange={(minRows) => minRows !== undefined && setConfig(block, { minRows })} />
      <NumberField label={t(M['inspector.repeat_max'])} value={block.config.maxRows} parse={parseInteger(1, 200)} onChange={(maxRows) => maxRows !== undefined && setConfig(block, { maxRows })} />
      <NumberField label={t(M['inspector.repeat_initial'])} value={block.config.initialRows} parse={parseInteger(0, 200)} onChange={(initialRows) => setConfig(block, { initialRows })} />
      <TextField label={t(M['inspector.repeat_add_label'])} value={block.config.addLabel} onChange={(addLabel) => setConfig(block, { addLabel: text(addLabel) })} />
      <TextField label={t(M['inspector.repeat_remove_label'])} value={block.config.removeLabel} onChange={(removeLabel) => setConfig(block, { removeLabel: text(removeLabel) })} />
      <SectionTitle>{t(M['inspector.repeat_fields'])}</SectionTitle>
      {block.config.children.map((id) => {
        const child = doc.blocks[id];
        const name = child && isField(child) ? (plainText(child.label) || child.key) : id;
        return (
          <div key={id} className="flex items-center justify-between gap-2 text-[13px]">
            <button type="button" className="truncate text-left hover:underline" onClick={() => useUiStore.getState().openInspector(id)}>
              {name}{child ? ` · ${child.type.replace(/_/g, ' ')}` : ''}
            </button>
            <Button type="button" variant="ghost" size="icon-xs" className="text-destructive" aria-label={t(M['inspector.repeat_remove_field'])} onClick={() => requestDeleteBlock(id)}>×</Button>
          </div>
        );
      })}
      <SelectField
        label={t(M['inspector.repeat_add_field'])}
        value=""
        placeholder={t(M['inspector.repeat_pick_field'])}
        options={childOptions}
        onChange={(tileId) => {
          const tile = CHILD_TILES.find((item) => item.id === tileId);
          if (tile?.kind === 'block') addChildBlock(block.id, tile.choice, { label: inlineDoc(tile.label) });
        }}
      />
      <ConfigProblem block={block} />
    </>
  );
}
