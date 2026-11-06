import { defineMessages } from '@form/i18n';
import { isRepeatableChildType, PALETTE_LABELS, REGISTRY, SHORT_TEXT_MAX, type AvailableType } from '@form/registry';
import { CONTEXT_SOURCES, DATE_PATTERNS, type BlockOf, type ContextSource, type DecimalString, type MatrixColumnId, type MatrixRowId, type SchemaLike } from '@form/schema';
import { patternProblem } from '@form/validation';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { NumberField, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { parseInteger } from '@/components/builder/inspector/parse';
import { OptionsEditor } from '@/components/builder/inspector/OptionsEditor';
import { APP_IDS, inlineDoc, isField, plainText } from '@/lib/definition';
import { formatFormula, parseFormula } from '@/lib/formula';
import { addChildBlock, requestDeleteBlock, updateBlock } from '@/state/actions';
import { currentDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { TILES } from '@/fields/tiles';
import { Button } from '@dmacq/ui';

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
  'inspector.pattern': 'Pattern (regular expression)',
  'inspector.pattern_invalid': 'This pattern is ignored until fixed: {problem}',
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
  'inspector.allow_negative': 'Allow negative numbers',
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
  'inspector.matrix_rows': 'Rows',
  'inspector.matrix_columns': 'Columns',
  'inspector.matrix_add_row': 'Add row',
  'inspector.matrix_add_column': 'Add column',
  'inspector.matrix_row_n': 'Row {n}',
  'inspector.matrix_column_n': 'Column {n}',
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
  'inspector.calc_formula_hint': 'Use field keys with + − × ÷. Click a field below to insert it.',
  'inspector.calc_fields': 'Insert a field',
  'inspector.calc_no_fields': 'Add a number, rating or scale field first.',
  'inspector.context_facts': 'Facts to capture',
  'inspector.context_strip': 'Drop the query string from URLs',
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
  'inspector.rolling_days': 'Days ahead',
  'inspector.min_notice': 'Minimum notice (minutes)',
  'inspector.collapsible': 'Collapsible',
  'inspector.initially_collapsed': 'Start collapsed',
  'inspector.postal_validate': 'Validate PIN / postal code',
  'inspector.country_mode': 'Country',
  'inspector.country_fixed': 'Fixed (India by default)',
  'inspector.country_any': 'Respondent picks any country',
});

const MIB = 1024 * 1024;

type AnyBlock = BlockOf<AvailableType>;

/** Replaces the block's config with `patch` applied; `undefined` removes a setting. */
function setConfig(block: Pick<AnyBlock, 'id' | 'config'>, patch: Readonly<Record<string, unknown>>): void {
  updateBlock(block.id, { config: { ...block.config, ...patch } });
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

export function ShortTextValidation({ block }: InspectorProps<'short_text'>) {
  const pattern = block.config.pattern?.source ?? '';
  const problem = pattern ? patternProblem({ source: pattern }) : null;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.min_length'])} value={block.config.minLength} parse={count(SHORT_TEXT_MAX)} onChange={(minLength) => setConfig(block, { minLength })} />
        <NumberField label={t(M['inspector.max_length'])} value={block.config.maxLength} parse={count(SHORT_TEXT_MAX)} onChange={(maxLength) => setConfig(block, { maxLength })} />
      </div>
      <TextField
        label={t(M['inspector.pattern'])}
        value={pattern}
        placeholder="^[A-Z].+"
        error={problem ? t(M['inspector.pattern_invalid'], { problem }) : null}
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
  const setLimit = (patch: { min?: number | undefined; max?: number | undefined }) => {
    const next = { unit: 'characters' as const, ...limit, ...patch };
    setConfig(block, { limit: next.min === undefined && next.max === undefined ? undefined : next });
  };
  return (
    <>
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
      <ToggleRow label={t(M['inspector.integer_only'])} checked={block.config.integerOnly === true} onChange={(on) => setConfig(block, { integerOnly: on || undefined })} />
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
        value={block.config.display === 'dropdown' ? 'dropdown' : list}
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

export function AppointmentGeneral({ block }: InspectorProps<'appointment'>) {
  return (
    <>
      <NumberField label={t(M['inspector.slot_minutes'])} value={block.config.slotMinutes} parse={parseInteger(5, 480)} onChange={(slotMinutes) => slotMinutes !== undefined && setConfig(block, { slotMinutes })} />
      <NumberField label={t(M['inspector.rolling_days'])} value={block.config.rollingDays} parse={parseInteger(1, 365)} onChange={(rollingDays) => rollingDays !== undefined && setConfig(block, { rollingDays })} />
      <NumberField label={t(M['inspector.min_notice'])} value={block.config.minNoticeMinutes} parse={parseInteger(0, 10_080)} onChange={(minNoticeMinutes) => minNoticeMinutes !== undefined && setConfig(block, { minNoticeMinutes })} />
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

export function EndLabels({ block }: { block: BlockOf<'rating' | 'linear_scale' | 'nps'> }) {
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

export function CalculationGeneral({ block }: InspectorProps<'calculation'>) {
  const doc = currentDoc();
  const sources = Object.values(doc.blocks).flatMap((b) => {
    if (!b || b.id === block.id || !isField(b) || !CALC_SOURCES.has(b.type)) return [];
    return [{ id: b.id, key: b.key, label: plainText(b.label) || b.key }];
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
                const text = draft.trim() ? `${draft.trimEnd()} ${source.key}` : source.key;
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

export function ContextGeneral({ block }: InspectorProps<'context'>) {
  const selected = new Set(block.config.sources);
  const toggle = (source: ContextSource, on: boolean) => {
    const next = CONTEXT_SOURCES.filter((item) => (item === source ? on : selected.has(item)));
    if (next.length === 0) return;
    setConfig(block, { sources: [...next] });
  };
  const urls = selected.has('page_url') || selected.has('referrer');
  return (
    <>
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

export function ChoiceOptions({ block }: { block: BlockOf<'single_choice' | 'multi_choice' | 'ranking'> }) {
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

export function MatrixGeneral({ block }: InspectorProps<'matrix'>) {
  const mode = block.config.mode;
  const inputFor = (next: typeof mode) => (next === 'single' ? 'choice' as const : next === 'multi' ? 'checkbox' as const : 'text' as const);
  return (
    <>
      <SelectField
        label={t(M['inspector.matrix_mode'])}
        value={mode}
        options={[
          { value: 'single', label: t(M['inspector.matrix_mode_single']) },
          { value: 'multi', label: t(M['inspector.matrix_mode_multi']) },
          { value: 'grid', label: t(M['inspector.matrix_mode_grid']) },
        ]}
        onChange={(next) => {
          const input = inputFor(next);
          setConfig(block, {
            mode: next,
            columns: block.config.columns.map((col) => ({ id: col.id, label: col.label, input })),
          });
        }}
      />
      <LabelList
        title={t(M['inspector.matrix_rows'])}
        addLabel={t(M['inspector.matrix_add_row'])}
        items={block.config.rows.map((row) => ({ id: row.id, label: typeof row.label === 'string' ? row.label : '' }))}
        onChange={(rows) => setConfig(block, { rows: rows.map((row) => ({ id: row.id as MatrixRowId, label: row.label || t(M['inspector.matrix_row_n'], { n: 1 }) })) })}
      />
      <LabelList
        title={t(M['inspector.matrix_columns'])}
        addLabel={t(M['inspector.matrix_add_column'])}
        items={block.config.columns.map((col) => ({ id: col.id, label: col.label }))}
        onChange={(columns) =>
          setConfig(block, {
            columns: columns.map((col) => ({ id: col.id as MatrixColumnId, label: col.label || t(M['inspector.matrix_column_n'], { n: 1 }), input: inputFor(mode) })),
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
