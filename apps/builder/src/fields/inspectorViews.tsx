import { defineMessages } from '@form/i18n';
import { REGISTRY, SHORT_TEXT_MAX, type AvailableType } from '@form/registry';
import { DATE_PATTERNS, type BlockOf, type DecimalString, type SchemaLike } from '@form/schema';
import { patternProblem } from '@form/validation';
import { t } from '@/i18n';
import { NumberField, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { parseInteger } from '@/components/builder/inspector/parse';
import { OptionsEditor } from '@/components/builder/inspector/OptionsEditor';
import { updateBlock } from '@/state/actions';

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
  'inspector.level': 'Level',
  'inspector.level_n': 'Heading {n}',
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
    <p role="alert" className="text-[12px] text-[#eb5757]">
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
        ]}
        onChange={(display) => setConfig(block, { display })}
      />
      {block.config.display === 'dropdown' ? <Placeholder block={block} /> : null}
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

export function HeadingGeneral({ block }: InspectorProps<'heading'>) {
  return (
    <SelectField
      label={t(M['inspector.level'])}
      value={String(block.config.level)}
      options={[1, 2, 3].map((n) => ({ value: String(n), label: t(M['inspector.level_n'], { n }) }))}
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
