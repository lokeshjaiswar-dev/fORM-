import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@dmacq/ui';
import { useInSettingsPanel } from '@/components/builder/inspector/settingsPanelScope';

export type SelectOption = { value: string; label: string; disabled?: boolean };

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
  /* The menu opens in a portal; inside a settings panel it is marked for the panel's Figma dropdown look. */
  const inSettingsPanel = useInSettingsPanel();
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size={size} fullWidth className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent data-nice-select="" {...(inSettingsPanel ? { 'data-settings-menu': '' } : {})}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
