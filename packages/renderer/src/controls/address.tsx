import type { AddressPart, CountryCode } from '@form/schema';
import { COUNTRY_OPTIONS, IN_STATES } from '@form/registry';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const AUTO: Partial<Record<AddressPart, string>> = {
  line1: 'address-line1',
  line2: 'address-line2',
  city: 'address-level2',
  state: 'address-level1',
  postalCode: 'postal-code',
  country: 'country',
};

const LABELS = {
  line1: 'address.line1',
  line2: 'address.line2',
  city: 'address.city',
  state: 'address.state',
  postalCode: 'address.postal',
  country: 'address.country',
} as const;

/** FLD-06: line, city, state, PIN, country. Indian states when the country is IN and stateInput is auto. */
export function AddressField({ block, field }: ControlProps<'address'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const attrs = inputAttrs(field);
  const value = answer.value ?? {};
  const countryMode = block.config.country.mode;
  const country = (value.country ?? block.config.country.default ?? '') as string;
  const parts = block.config.parts.filter((part) => !(part === 'country' && countryMode === 'fixed'));
  const setPart = (part: AddressPart, next: string, extra: Partial<typeof value> = {}) => {
    const merged = {
      ...value,
      ...(countryMode === 'fixed' && block.config.country.default ? { country: block.config.country.default } : {}),
      [part]: next,
      ...extra,
    };
    const empty = block.config.parts.every((p) => !(merged[p] ?? '').trim());
    answer.set(empty ? undefined : merged);
  };
  return (
    <div className="fr-address">
      {parts.map((part) => {
        const label = block.config.sublabels?.[part] || t(MESSAGES[LABELS[part]]);
        const id = `${field.ids.input}-${part}`;
        if (part === 'country') {
          const allowed = countryMode === 'list' ? new Set(block.config.country.allowed ?? []) : null;
          const options = COUNTRY_OPTIONS.filter((o) => !allowed || allowed.has(o.id as CountryCode));
          return (
            <label key={part} className="fr-address-part" htmlFor={id}>
              <span>{label}</span>
              <select id={id} className="fr-input fr-select" value={country} onChange={(e) => setPart('country', e.target.value, { state: '', stateCode: '' })} onBlur={answer.onBlur} {...attrs}>
                <option value="" />
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{typeof o.label === 'string' ? o.label : o.id}</option>
                ))}
              </select>
            </label>
          );
        }
        if (part === 'state' && block.config.stateInput === 'auto' && country === 'IN') {
          return (
            <label key={part} className="fr-address-part" htmlFor={id}>
              <span>{label}</span>
              <select
                id={id}
                className="fr-input fr-select"
                value={value.stateCode ?? ''}
                onChange={(e) => {
                  const code = e.target.value;
                  const name = IN_STATES.find(([id]) => id === code)?.[1] ?? '';
                  setPart('state', name, { stateCode: code });
                }}
                onBlur={answer.onBlur}
                {...attrs}
              >
                <option value="" />
                {IN_STATES.map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label key={part} className="fr-address-part" htmlFor={id} data-part={part}>
            <span>{label}</span>
            <input
              id={id}
              className="fr-input"
              type="text"
              autoComplete={AUTO[part]}
              value={value[part] ?? ''}
              onChange={(e) => setPart(part, e.target.value)}
              onBlur={answer.onBlur}
              {...attrs}
            />
          </label>
        );
      })}
    </div>
  );
}
