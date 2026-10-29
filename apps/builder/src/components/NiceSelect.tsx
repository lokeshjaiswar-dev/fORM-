import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@dmacq/ui';

export type SelectOption = { value: string; label: string };

/** Single-value dMACQ Select with an options list. */
export function NiceSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  className,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size={size} fullWidth className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent data-nice-select="">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
