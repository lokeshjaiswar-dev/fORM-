import type { CountryCode, TextPreset } from '@form/schema';

/** Keep a typed decimal (optional leading minus, one dot) and drop letters. */
export function sanitizeDecimal(raw: string, integerOnly: boolean, allowNegative: boolean): string {
  let next = raw.replace(/[^\d.-]/g, '');
  if (!allowNegative) next = next.replace(/-/g, '');
  else {
    const neg = next.startsWith('-');
    next = `${neg ? '-' : ''}${next.replace(/-/g, '')}`;
  }
  if (integerOnly) return next.replace(/\./g, '');
  const dot = next.indexOf('.');
  if (dot < 0) return next;
  return `${next.slice(0, dot + 1)}${next.slice(dot + 1).replace(/\./g, '')}`;
}

/** Digits (and a leading + for international). Indian mobiles: 10 digits, trunk 0 / extra 91 dropped. */
export function sanitizePhoneNational(raw: string, country: CountryCode): string {
  const international = raw.trim().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (country === 'IN' && !international) {
    digits = digits.replace(/^0+/, '');
    if (digits.startsWith('91') && digits.length > 10) digits = digits.slice(2);
    return digits.slice(0, 10);
  }
  if (international) return digits ? `+${digits.slice(0, 15)}` : '+';
  if (country === 'US' || country === 'CA') return digits.slice(0, 10);
  return digits.slice(0, 15);
}

export function sanitizeEmail(raw: string): string {
  return raw.replace(/\s/g, '');
}

export function sanitizePreset(raw: string, preset: TextPreset | undefined, maxLength: number | undefined): string {
  let next = raw;
  if (preset === 'numeric' || preset === 'in_pincode' || preset === 'in_aadhaar_last4') next = raw.replace(/\D/g, '');
  else if (preset === 'alphabetic') next = raw.replace(/[^\p{L}\p{M} ]/gu, '');
  else if (preset === 'alphanumeric') next = raw.replace(/[^\p{L}\p{M}\p{Nd}]/gu, '');
  else if (preset === 'no_spaces') next = raw.replace(/\s/g, '');
  else if (preset === 'in_pan' || preset === 'in_gstin' || preset === 'in_ifsc' || preset === 'in_vehicle_reg') {
    next = raw.toUpperCase().replace(/[^A-Z0-9 -]/g, '');
  }
  return maxLength !== undefined ? [...next].slice(0, maxLength).join('') : next;
}
/**
 * Drops characters a short text does not allow as they are typed: letters, marks and spaces always stay; digits only
 * when `numbers`; anything else only when `special`. Validation applies the same rule to what reaches the server.
 */
export function sanitizeCharacters(raw: string, characters: { numbers: boolean; special: boolean } | undefined): string {
  if (!characters || (characters.numbers && characters.special)) return raw;
  if (characters.special) return raw.replace(/\p{Nd}/gu, '');
  return raw.replace(characters.numbers ? /[^\p{L}\p{M}\p{Nd}\s]/gu : /[^\p{L}\p{M}\s]/gu, '');
}
