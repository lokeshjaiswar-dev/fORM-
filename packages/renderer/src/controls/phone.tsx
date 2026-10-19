import { useState } from 'react';
import { CALLING_CODE_REGIONS, callingCodeOf } from '@form/registry';
import type { CountryCode } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

/** The region's flag: two regional-indicator symbols, so the picker needs no translated country names. */
const flag = (region: string) => String.fromCodePoint(...[...region].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

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
        <select
          className="fr-input fr-select fr-phone-country"
          aria-label={t(MESSAGES['phone.country'])}
          value={country}
          disabled={attrs.disabled || field.readOnly}
          onChange={(e) => {
            const region = e.target.value as CountryCode;
            setPicked(region);
            update(typed, region);
          }}
        >
          {regions.map((region) => (
            <option key={region} value={region}>{`${flag(region)} +${callingCodeOf(region) ?? ''}`}</option>
          ))}
        </select>
      ) : null}
      <input
        id={field.ids.input}
        className="fr-input"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={typed}
        placeholder={c.placeholder}
        onChange={(e) => {
          setTyped(e.target.value);
          update(e.target.value, country);
        }}
        onBlur={answer.onBlur}
        {...attrs}
      />
    </div>
  );
}
