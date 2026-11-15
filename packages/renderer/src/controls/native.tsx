/*
 * The renderer's own widgets. A public form must render the same markup on the server and in the browser, speak every
 * locale the form is published in, and stay small, so the controls use the platform's elements (<select>, <input
 * type="date">, <input type="range">, ...). styles.css gives them the dmacq look from the theme variables.
 */

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A native <select>. The empty first option is the placeholder (its text comes from the caller, so it is translated);
 * every option is in the markup from the first render, so the server and the client agree.
 */
export function NativeSelect({
  id,
  value,
  onChange,
  onBlur,
  options,
  placeholder,
  disabled,
  allowEmpty = true,
  autoFocus,
  className,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-required': required,
  'aria-label': ariaLabel,
}: {
  id?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onBlur?: (() => void) | undefined;
  options: readonly SelectOption[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  allowEmpty?: boolean | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  'aria-describedby'?: string | undefined;
  'aria-required'?: boolean | undefined;
  'aria-label'?: string | undefined;
}) {
  return (
    <select
      id={id}
      className={className ? `fr-input fr-select ${className}` : 'fr-input fr-select'}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      aria-required={required}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    >
      {allowEmpty ? <option value="">{placeholder ?? ''}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
