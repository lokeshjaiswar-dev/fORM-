import { defineMessages } from '@form/i18n';
import { REGISTRY, type AvailableType } from '@form/registry';
import { type BlockOf, type CountryCode, type DateBound, type DateLimits, type IsoDate, type IsoTime, type SchemaLike, type Weekday } from '@form/schema';
import { t } from '@/i18n';
import { NumberField, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { parseInteger } from '@/components/builder/inspector/parse';
import { updateBlock } from '@/state/actions';

type InspectorProps<T extends AvailableType> = { block: BlockOf<T> };

const M = defineMessages('builder', {
  'inspector.mask': 'Input mask',
  'inspector.mask_hint': 'Use # for a digit, @ for a letter, * for either. Optional tail in [brackets].',
  'inspector.mask_store': 'Store the mask characters (spaces and dashes)',
  'inspector.limit_unit': 'Count',
  'inspector.limit_characters': 'Characters',
  'inspector.limit_words': 'Words',
  'inspector.email_confirm': 'Ask the respondent to type the email twice',
  'inspector.email_block_free': 'Block free providers (Gmail, Yahoo, …)',
  'inspector.email_block_disposable': 'Block disposable addresses',
  'inspector.email_domains': 'Allowed domains',
  'inspector.email_domains_hint': 'Comma-separated, e.g. company.com, org.in. Empty allows any domain.',
  'inspector.url_https': 'Allow https',
  'inspector.url_http': 'Allow http',
  'inspector.phone_mask': 'Input mask',
  'inspector.phone_countries': 'Allowed country codes',
  'inspector.phone_countries_hint': 'Comma-separated ISO codes, e.g. IN, US. Empty allows any country.',
  'inspector.date_earliest': 'Earliest date',
  'inspector.date_latest': 'Latest date',
  'inspector.bound_none': 'No limit',
  'inspector.bound_today': 'Today',
  'inspector.bound_days': 'A number of days from today',
  'inspector.bound_fixed': 'A specific date',
  'inspector.bound_days_offset': 'Days from today (negative = past)',
  'inspector.bound_date': 'Date (YYYY-MM-DD)',
  'inspector.age_min': 'Minimum age',
  'inspector.age_max': 'Maximum age',
  'inspector.no_weekends': 'Do not allow Saturdays or Sundays',
  'inspector.time_period': 'Time of day',
  'inspector.time_any': 'Any',
  'inspector.time_am': 'Morning only',
  'inspector.time_pm': 'Afternoon only',
  'inspector.time_from': 'Earliest time (HH:MM)',
  'inspector.time_to': 'Latest time (HH:MM)',
  'inspector.min_files': 'Minimum files',
  'inspector.min_size': 'Minimum file size (KB)',
  'inspector.other_text_required': 'Require text when Other is chosen',
  'inspector.required_part': 'Require {part}',
  'inspector.config_problem': 'Check this setting: {problem}',
});

function setConfig(block: Pick<BlockOf<AvailableType>, 'id' | 'config'>, patch: Readonly<Record<string, unknown>>): void {
  updateBlock(block.id, { config: { ...block.config, ...patch } });
}

function ConfigProblem({ block }: { block: BlockOf<AvailableType> }) {
  const parsed = (REGISTRY[block.type].configSchema as SchemaLike<unknown>).safeParse(block.config);
  if (parsed.success) return null;
  const issues = (parsed.error as { issues?: Array<{ message: string }> }).issues ?? [];
  return (
    <p role="alert" className="text-[12px] text-destructive">
      {t(M['inspector.config_problem'], { problem: issues.map((i) => i.message).join('; ') })}
    </p>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function MaskFields({
  value,
  onChange,
}: {
  value: { pattern: string; storeMasked: boolean } | undefined;
  onChange: (mask: { pattern: string; storeMasked: boolean } | undefined) => void;
}) {
  const pattern = value?.pattern ?? '';
  return (
    <>
      <TextField
        label={t(M['inspector.mask'])}
        hint={t(M['inspector.mask_hint'])}
        value={pattern}
        placeholder="AAA-####"
        onChange={(next) => {
          if (!next) onChange(undefined);
          else if (next.length <= 64) onChange({ pattern: next, storeMasked: value?.storeMasked !== false });
        }}
      />
      {pattern ? (
        <ToggleRow
          label={t(M['inspector.mask_store'])}
          checked={value?.storeMasked !== false}
          onChange={(on) => onChange({ pattern, storeMasked: on })}
        />
      ) : null}
    </>
  );
}

type BoundSlot = 'min' | 'max';

function boundMode(bound: DateBound | undefined): 'none' | 'today' | 'days' | 'fixed' {
  if (!bound) return 'none';
  if (bound.kind === 'absolute') return 'fixed';
  if (bound.kind === 'relative' && bound.unit === 'day' && bound.offset === 0) return 'today';
  if (bound.kind === 'relative') return 'days';
  return 'none';
}

function DateBoundFields({
  label,
  bound,
  onChange,
}: {
  label: string;
  bound: DateBound | undefined;
  onChange: (bound: DateBound | undefined) => void;
}) {
  const mode = boundMode(bound);
  return (
    <>
      <SelectField
        label={label}
        value={mode}
        options={[
          { value: 'none', label: t(M['inspector.bound_none']) },
          { value: 'today', label: t(M['inspector.bound_today']) },
          { value: 'days', label: t(M['inspector.bound_days']) },
          { value: 'fixed', label: t(M['inspector.bound_fixed']) },
        ]}
        onChange={(next) => {
          if (next === 'none') onChange(undefined);
          else if (next === 'today') onChange({ kind: 'relative', offset: 0, unit: 'day' });
          else if (next === 'days') onChange({ kind: 'relative', offset: -1, unit: 'day' });
          else onChange({ kind: 'absolute', date: '1970-01-01' as IsoDate });
        }}
      />
      {mode === 'days' && bound?.kind === 'relative' ? (
        <NumberField
          label={t(M['inspector.bound_days_offset'])}
          value={bound.offset}
          parse={parseInteger(-3650, 3650)}
          onChange={(offset) => offset !== undefined && onChange({ kind: 'relative', offset, unit: 'day' })}
        />
      ) : null}
      {mode === 'fixed' && bound?.kind === 'absolute' ? (
        <TextField
          label={t(M['inspector.bound_date'])}
          value={bound.date}
          onChange={(raw) => {
            if (ISO_DATE.test(raw)) onChange({ kind: 'absolute', date: raw as IsoDate });
          }}
        />
      ) : null}
    </>
  );
}

function DateLimitsEditor({ limits, onChange }: { limits: DateLimits | undefined; onChange: (limits: DateLimits | undefined) => void }) {
  const write = (patch: Partial<DateLimits>) => {
    const next: DateLimits = { ...limits, ...patch };
    for (const key of Object.keys(next) as Array<keyof DateLimits>) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(Object.keys(next).length ? next : undefined);
  };
  const weekendsOff = (limits?.disallowWeekdays ?? []).includes(0) && (limits?.disallowWeekdays ?? []).includes(6);
  return (
    <>
      <DateBoundFields label={t(M['inspector.date_earliest'])} bound={limits?.min} onChange={(min) => write({ min })} />
      <DateBoundFields label={t(M['inspector.date_latest'])} bound={limits?.max} onChange={(max) => write({ max })} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label={t(M['inspector.age_min'])} value={limits?.age?.min} parse={parseInteger(0, 130)} onChange={(min) => {
          const age = { ...limits?.age, min };
          if (age.min === undefined && age.max === undefined) write({ age: undefined });
          else write({ age });
        }} />
        <NumberField label={t(M['inspector.age_max'])} value={limits?.age?.max} parse={parseInteger(0, 130)} onChange={(max) => {
          const age = { ...limits?.age, max };
          if (age.min === undefined && age.max === undefined) write({ age: undefined });
          else write({ age });
        }} />
      </div>
      <ToggleRow
        label={t(M['inspector.no_weekends'])}
        checked={weekendsOff}
        onChange={(on) => write({ disallowWeekdays: on ? ([0, 6] as Weekday[]) : undefined })}
      />
    </>
  );
}

export function EmailValidation({ block }: InspectorProps<'email'>) {
  return (
    <>
      <ToggleRow label={t(M['inspector.email_confirm'])} checked={block.config.confirm === true} onChange={(on) => setConfig(block, { confirm: on || undefined })} />
      <ToggleRow label={t(M['inspector.email_block_free'])} checked={block.config.blockFreeProviders === true} onChange={(on) => setConfig(block, { blockFreeProviders: on || undefined })} />
      <ToggleRow label={t(M['inspector.email_block_disposable'])} checked={block.config.blockDisposable === true} onChange={(on) => setConfig(block, { blockDisposable: on || undefined })} />
      <TextField
        label={t(M['inspector.email_domains'])}
        hint={t(M['inspector.email_domains_hint'])}
        value={(block.config.allowedDomains ?? []).join(', ')}
        onChange={(raw) => {
          const allowedDomains = raw.split(',').map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0 && d.length <= 253);
          setConfig(block, { allowedDomains: allowedDomains.length ? allowedDomains : undefined });
        }}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function UrlValidation({ block }: InspectorProps<'url'>) {
  const schemes = block.config.schemes;
  const has = (s: 'https' | 'http') => schemes.includes(s);
  const toggle = (s: 'https' | 'http', on: boolean) => {
    const next = on ? [...new Set([...schemes, s])] : schemes.filter((x) => x !== s);
    if (next.length) setConfig(block, { schemes: next as Array<'https' | 'http'> });
  };
  return (
    <>
      <ToggleRow label={t(M['inspector.url_https'])} checked={has('https')} onChange={(on) => toggle('https', on)} />
      <ToggleRow label={t(M['inspector.url_http'])} checked={has('http')} onChange={(on) => toggle('http', on)} />
      <ConfigProblem block={block} />
    </>
  );
}

export function PhoneValidation({ block }: InspectorProps<'phone'>) {
  return (
    <>
      <MaskFields value={block.config.mask} onChange={(mask) => setConfig(block, { mask })} />
      <TextField
        label={t(M['inspector.phone_countries'])}
        hint={t(M['inspector.phone_countries_hint'])}
        value={(block.config.allowedCountries ?? []).join(', ')}
        onChange={(raw) => {
          const allowedCountries = raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) as CountryCode[];
          setConfig(block, { allowedCountries: allowedCountries.length ? allowedCountries : undefined });
        }}
      />
      <ConfigProblem block={block} />
    </>
  );
}

export function DateValidation({ block }: InspectorProps<'date'>) {
  return (
    <>
      <DateLimitsEditor limits={block.config.limits} onChange={(limits) => setConfig(block, { limits })} />
      <ConfigProblem block={block} />
    </>
  );
}

export function DateTimeValidation({ block }: InspectorProps<'datetime'>) {
  return (
    <>
      <DateLimitsEditor limits={block.config.limits} onChange={(limits) => setConfig(block, { limits })} />
      <ConfigProblem block={block} />
    </>
  );
}

export function TimeValidation({ block }: InspectorProps<'time'>) {
  const window = block.config.window;
  const writeWindow = (from: string | undefined, to: string | undefined) => {
    const nextFrom = from === '' ? undefined : from && ISO_TIME.test(from) ? (from as IsoTime) : window?.from;
    const nextTo = to === '' ? undefined : to && ISO_TIME.test(to) ? (to as IsoTime) : window?.to;
    setConfig(block, { window: nextFrom || nextTo ? { from: nextFrom, to: nextTo } : undefined });
  };
  return (
    <>
      <SelectField
        label={t(M['inspector.time_period'])}
        value={block.config.period ?? 'any'}
        options={[
          { value: 'any', label: t(M['inspector.time_any']) },
          { value: 'am_only', label: t(M['inspector.time_am']) },
          { value: 'pm_only', label: t(M['inspector.time_pm']) },
        ]}
        onChange={(period) => setConfig(block, { period: period === 'any' ? undefined : (period as 'am_only' | 'pm_only') })}
      />
      <TextField label={t(M['inspector.time_from'])} value={window?.from} onChange={(from) => writeWindow(from, window?.to)} />
      <TextField label={t(M['inspector.time_to'])} value={window?.to} onChange={(to) => writeWindow(window?.from, to)} />
      <ConfigProblem block={block} />
    </>
  );
}

export function FullNameValidation({ block }: InspectorProps<'full_name'>) {
  return (
    <>
      {block.config.parts.map((part) => (
        <ToggleRow
          key={part}
          label={t(M['inspector.required_part'], { part })}
          checked={block.config.requiredParts.includes(part)}
          onChange={(on) => {
            const requiredParts = on
              ? [...block.config.requiredParts, part]
              : block.config.requiredParts.filter((p) => p !== part);
            setConfig(block, { requiredParts });
          }}
        />
      ))}
      <ConfigProblem block={block} />
    </>
  );
}

export function AddressValidation({ block }: InspectorProps<'address'>) {
  return (
    <>
      {block.config.parts.map((part) => (
        <ToggleRow
          key={part}
          label={t(M['inspector.required_part'], { part })}
          checked={block.config.requiredParts.includes(part)}
          onChange={(on) => {
            const requiredParts = on
              ? [...block.config.requiredParts, part]
              : block.config.requiredParts.filter((p) => p !== part);
            setConfig(block, { requiredParts });
          }}
        />
      ))}
      <ConfigProblem block={block} />
    </>
  );
}

export function ChoiceOtherValidation({ block }: { block: BlockOf<'single_choice' | 'multi_choice'> }) {
  if (!block.config.other?.enabled) return null;
  return (
    <ToggleRow
      label={t(M['inspector.other_text_required'])}
      checked={block.config.other.textRequired}
      onChange={(on) => setConfig(block, { other: { ...block.config.other, textRequired: on } })}
    />
  );
}

export function FileMinLimits({ block }: InspectorProps<'file_upload'>) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField label={t(M['inspector.min_files'])} value={block.config.minFiles} parse={parseInteger(0, 20)} onChange={(minFiles) => setConfig(block, { minFiles })} />
      <NumberField
        label={t(M['inspector.min_size'])}
        value={block.config.minFileBytes === undefined ? undefined : Math.round(block.config.minFileBytes / 1024)}
        parse={parseInteger(0, 1024 * 1024)}
        onChange={(kb) => setConfig(block, { minFileBytes: kb === undefined ? undefined : kb * 1024 })}
      />
    </div>
  );
}
