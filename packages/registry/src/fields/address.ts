import type { AddressPart, CountryCode } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS, regionOf } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { COUNTRY_OPTIONS } from './countries.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const PARTS: readonly AddressPart[] = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'];

const joined = (value: Partial<Record<AddressPart, string>>): string =>
  PARTS.map((part) => value[part]?.trim() ?? '').filter(Boolean).join(', ');

const pinOf = (country: string | undefined, postal: string): boolean => {
  if (country === 'IN') return /^\d{6}$/.test(postal);
  if (country === 'US') return /^\d{5}(?:-\d{4})?$/.test(postal);
  return postal.trim().length >= 3;
};

/** FLD-06. Structured address with India-first PIN and state handling. */
export const address = defineField({
  type: 'address',
  palette: [entry('address', null, 'basic', PALETTE_LABELS['palette.address'], 'map-pin', ['address', 'street', 'city', 'pin', 'pincode', 'location', 'contact'])],
  defaultConfig: (locale) => ({
    parts: ['line1', 'line2', 'city', 'state', 'postalCode', 'country'],
    requiredParts: ['line1', 'city', 'state', 'postalCode', 'country'],
    country: { mode: 'fixed', default: regionOf(locale) },
    stateInput: 'auto',
    validatePostalCode: true,
  }),
  checkConfig: (config, report) => {
    config.requiredParts.forEach((part, i) => {
      if (!config.parts.includes(part)) report('requiredParts must be listed in parts', ['requiredParts', i]);
    });
    if (config.country.mode === 'list' && !config.country.allowed?.length) report('country.allowed is required when mode is list', ['country', 'allowed']);
    if (config.country.mode === 'fixed' && !config.country.default) report('country.default is required when mode is fixed', ['country', 'default']);
  },
  checkAnswer: (value, block, state, report) => {
    const country = (value.country ?? block.config.country.default) as CountryCode | undefined;
    if (state.required) {
      for (const part of block.config.requiredParts) {
        if (part === 'country' && block.config.country.mode === 'fixed') continue;
        if (isBlank(value[part])) report('required', [part]);
      }
    }
    const allowed = block.config.country.allowed;
    if (block.config.country.mode === 'list' && country && allowed?.length && !allowed.includes(country)) report('country_not_allowed', ['country']);
    const postal = value.postalCode?.trim();
    if (block.config.validatePostalCode && postal && !pinOf(country, postal)) report('invalid_format', ['postalCode']);
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: joined(value) } : NULL),
  isEmpty: (value) => isBlank(value),
  columns: (block) => {
    const header = headerOf(block);
    return block.config.parts.map((part) => ({ suffix: `.${part}`, header: `${header} / ${part}` }));
  },
  cells: (value, block) => block.config.parts.map((part) => value[part] ?? ''),
  text: (value) => joined(value),
});

export const ADDRESS_COUNTRIES = COUNTRY_OPTIONS;

/** Indian states and union territories for `stateInput: 'auto'` when the country is IN. */
export const IN_STATES: ReadonlyArray<readonly [string, string]> = [
  ['AN', 'Andaman and Nicobar Islands'], ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'],
  ['BR', 'Bihar'], ['CH', 'Chandigarh'], ['CT', 'Chhattisgarh'], ['DH', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['DL', 'Delhi'], ['GA', 'Goa'], ['GJ', 'Gujarat'], ['HR', 'Haryana'], ['HP', 'Himachal Pradesh'], ['JK', 'Jammu and Kashmir'],
  ['JH', 'Jharkhand'], ['KA', 'Karnataka'], ['KL', 'Kerala'], ['LA', 'Ladakh'], ['LD', 'Lakshadweep'], ['MP', 'Madhya Pradesh'],
  ['MH', 'Maharashtra'], ['MN', 'Manipur'], ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'], ['OR', 'Odisha'],
  ['PY', 'Puducherry'], ['PB', 'Punjab'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'], ['TG', 'Telangana'],
  ['TR', 'Tripura'], ['UP', 'Uttar Pradesh'], ['UK', 'Uttarakhand'], ['WB', 'West Bengal'],
];
