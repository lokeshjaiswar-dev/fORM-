import { useEffect, useMemo, useState } from 'react';
import { CALLING_CODE_REGIONS, callingCodeOf } from '@form/registry';
import type { CountryCode } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';
import { sanitizePhoneNational } from './sanitize.ts';

/** Region names in the form's language from the browser (Intl.DisplayNames), so no catalogue is needed; the code when it has none. */
function regionNames(locale: string): (region: string) => string {
  try {
    const names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    return (region) => names.of(region) ?? region;
  } catch {
    return (region) => region;
  }
}

/** The region's flag image, loaded after mount (the server render and the first client render show the empty frame). */
function useFlag(region: string): string | undefined {
  const [shown, setShown] = useState<{ region: string; url: string | undefined } | null>(null);
  useEffect(() => {
    let live = true;
    import('./flags/index.ts')
      .then((m) => m.flagUrl(region))
      .then((url) => live && setShown({ region, url }))
      .catch(() => live && setShown({ region, url: undefined }));
    return () => {
      live = false;
    };
  }, [region]);
  return shown?.region === region ? shown.url : undefined;
}

/**
 * The calling-code picker: what shows is our own flag and "+91"; the native <select> lies over it, invisible, so the
 * keyboard, screen readers and phone pickers keep the platform's control, and its list names each country.
 */
function CountryPicker({ country, regions, label, disabled, onChange }: {
  country: CountryCode;
  regions: readonly CountryCode[];
  label: string;
  disabled: boolean | undefined;
  onChange: (region: CountryCode) => void;
}) {
  const { i18n, t } = useRenderer();
  const name = useMemo(() => regionNames(i18n.locale), [i18n.locale]);
  const url = useFlag(country);
  return (
    <div className="fr-input fr-select fr-phone-picker" data-disabled={disabled ? '' : undefined}>
      <span className="fr-flag" aria-hidden="true">
        {url ? <img src={url} alt="" width={24} height={16} decoding="async" /> : null}
      </span>
      <span className="fr-phone-code" aria-hidden="true">{`+${callingCodeOf(country) ?? ''}`}</span>
      <select
        className="fr-phone-country"
        aria-label={label}
        value={country}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as CountryCode)}
      >
        {regions.map((region) => (
          <option key={region} value={region}>{t(MESSAGES['phone.country_option'], { name: name(region), code: callingCodeOf(region) ?? '' })}</option>
        ))}
      </select>
    </div>
  );
}

/** E.164 from what was typed: a leading + keeps the number as is, otherwise the calling code is prefixed and trunk zeros dropped. */
function toE164(typed: string, code: string | undefined): string {
  const digits = typed.replace(/\D/g, '');
  if (typed.trim().startsWith('+')) return digits ? `+${digits}` : '';
  const national = digits.replace(/^0+/, '');
  return national ? `+${code ?? ''}${national}` : '';
}

/**
 * FLD-05 (basic): calling-code picker and a number; per-country number rules arrive in P2. The input shows what the
 * respondent typed (a lone `+` or trunk `0` included) and the answer is the E.164 form of it.
 */
export function Phone({ block, field }: ControlProps<'phone'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const [picked, setPicked] = useState<CountryCode>(answer.value?.country ?? c.defaultCountry);
  const country = answer.value?.country ?? picked;
  const [typed, setTyped] = useState(() => {
    const code = callingCodeOf(country);
    const e164 = answer.value?.e164 ?? '';
    return code !== undefined && e164.startsWith(`+${code}`) ? e164.slice(code.length + 1) : e164;
  });
  const regions = c.allowedCountries?.length ? c.allowedCountries : CALLING_CODE_REGIONS;
  const update = (typed: string, region: CountryCode) => {
    const next = toE164(typed, callingCodeOf(region));
    answer.set(next ? { e164: next, country: region } : undefined);
  };
  const attrs = inputAttrs(field);
  return (
    <div className="fr-phone">
      {c.showCountrySelect ? (
        <CountryPicker
          country={country}
          regions={regions}
          label={t(MESSAGES['phone.country'])}
          disabled={attrs.disabled || field.readOnly}
          onChange={(region) => {
            setPicked(region);
            update(typed, region);
          }}
        />
      ) : null}
      <input
        id={field.ids.input}
        className="fr-input"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={typed}
        placeholder={c.placeholder}
        onChange={(e) => {
          const next = sanitizePhoneNational(e.target.value, country);
          setTyped(next);
          update(next, country);
        }}
        maxLength={country === 'IN' || country === 'US' || country === 'CA' ? 10 : 16}
        onBlur={answer.onBlur}
        {...attrs}
      />
    </div>
  );
}
