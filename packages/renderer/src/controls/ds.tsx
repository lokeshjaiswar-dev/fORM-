import {
  Checkbox,
  Chip,
  Combobox,
  FileDropzone,
  Input,
  MultiSelect,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Textarea,
} from '@dmacq/ui';
import type { ComponentProps } from 'react';

export { Chip, FileDropzone, Input as DsInput, Slider, Textarea as DsTextarea };

const NONE = '__fr_none__';

export type DsOption = { value: string; label: string };

/**
 * `exactOptionalPropertyTypes`: the @dmacq/ui components declare `placeholder?: string`, which means "absent or a
 * string", not "or undefined". Spread the props that might be unset through this so unset ones are left out
 * instead of passed as `undefined`. The cast is safe: the loop copies only the entries whose value is not `undefined`.
 */
function omitUndefined<T extends Record<string, unknown>>(props: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) if (value !== undefined) out[key] = value;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export function DsSelect({
  id,
  value,
  onChange,
  onBlur,
  options,
  placeholder = 'Select…',
  disabled,
  allowEmpty = true,
  className,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-required': required,
  'aria-label': ariaLabel,
}: {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  options: readonly DsOption[];
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  className?: string;
  'aria-invalid'?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  'aria-required'?: boolean | undefined;
  'aria-label'?: string | undefined;
}) {
  const mapped = !value && allowEmpty ? NONE : value;
  return (
    <Select value={mapped || undefined} onValueChange={(next) => onChange(next === NONE ? '' : next)} disabled={disabled}>
      <SelectTrigger
        id={id}
        fullWidth
        className={className}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-required={required}
        aria-label={ariaLabel}
        onBlur={onBlur}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowEmpty ? <SelectItem value={NONE}>{placeholder}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DsCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  disabled,
  className,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-required': required,
  'aria-label': ariaLabel,
}: {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: readonly DsOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-invalid'?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  'aria-required'?: boolean | undefined;
  'aria-label'?: string | undefined;
}) {
  return (
    <Combobox
      options={options.map((option) => ({ value: option.value, label: option.label }))}
      onValueChange={(next) => onChange(next)}
      {...omitUndefined({
        id,
        className,
        value: value || undefined,
        placeholder,
        searchPlaceholder: searchPlaceholder ?? placeholder,
        disabled,
        'aria-invalid': invalid,
        'aria-describedby': describedBy,
        'aria-required': required,
        'aria-label': ariaLabel,
      })}
    />
  );
}

export function DsMultiSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  disabled,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-required': required,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
}: {
  id?: string | undefined;
  value: string[];
  onChange: (value: string[]) => void;
  options: readonly DsOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  'aria-required'?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
}) {
  return (
    <MultiSelect
      options={options.map((option) => ({ value: option.value, label: option.label }))}
      value={value}
      onValueChange={onChange}
      {...omitUndefined({
        id,
        placeholder,
        searchPlaceholder: searchPlaceholder ?? placeholder,
        disabled,
        'aria-invalid': invalid,
        'aria-describedby': describedBy,
        'aria-required': required,
        'aria-label': ariaLabel,
        'aria-labelledby': labelledBy,
      })}
    />
  );
}

export function DsRadioCell({
  id,
  value,
  checked,
  onSelect,
  onBlur,
  disabled,
  grouped,
  'aria-label': ariaLabel,
  'aria-invalid': invalid,
}: {
  id?: string | undefined;
  value: string;
  checked: boolean;
  onSelect: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** When true, the cell is already inside a RadioGroup (one group per matrix row). */
  grouped?: boolean;
  'aria-label': string;
  'aria-invalid'?: boolean | undefined;
}) {
  const item = <RadioGroupItem id={id} value={value} aria-label={ariaLabel} onBlur={onBlur} />;
  if (grouped) return item;
  /* Keep a sentinel when unchecked: `undefined` lets Radix go uncontrolled and the radio stays visually on. */
  return (
    <RadioGroup className="flex justify-center" value={checked ? value : NONE} onValueChange={() => onSelect()} disabled={disabled} aria-invalid={invalid}>
      {item}
    </RadioGroup>
  );
}

export function DsCheckCell({
  id,
  checked,
  onChange,
  onBlur,
  disabled,
  'aria-label': ariaLabel,
  'aria-invalid': invalid,
}: {
  id?: string | undefined;
  checked: boolean;
  onChange: (on: boolean) => void;
  onBlur?: () => void;
  disabled?: boolean;
  'aria-label': string;
  'aria-invalid'?: boolean | undefined;
}) {
  return (
    <Checkbox
      id={id}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid}
      onCheckedChange={(on) => onChange(on === true)}
      onBlur={onBlur}
    />
  );
}

export function DsText(props: ComponentProps<typeof Input>) {
  return <Input {...props} />;
}
