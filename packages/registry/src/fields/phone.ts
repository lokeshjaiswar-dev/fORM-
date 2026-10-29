import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS, regionOf } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { matchesCallingCode } from '../util/calling-codes.ts';
import { NULL, entry, isRootPath } from './shared.ts';

/** FLD-05 (basic): E.164 plus country, whose calling code must prefix the number; per-country number rules (libphonenumber) arrive in P2. */
export const phone = defineField({
  type: 'phone',
  palette: [entry('phone', null, 'basic', PALETTE_LABELS['palette.phone'], 'phone', ['phone', 'mobile', 'telephone', 'contact', 'number'])],
  defaultConfig: (locale) => ({ defaultCountry: regionOf(locale), showCountrySelect: true }),
  checkConfig: (config, report) => {
    if (config.allowedCountries?.length && !config.allowedCountries.includes(config.defaultCountry)) {
      report('defaultCountry must be one of allowedCountries', ['defaultCountry']);
    }
  },
  checkAnswer: (value, block, _state, report) => {
    const allowed = block.config.allowedCountries;
    if (allowed?.length && !allowed.includes(value.country)) report('country_not_allowed', ['country']);
    if (!matchesCallingCode(value.e164, value.country)) report('invalid_phone', ['e164']);
  },
  paths: { '': 'text', e164: 'text', country: 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path) || path === 'e164') return { t: 'text', v: value.e164 };
    return path === 'country' ? { t: 'text', v: value.country } : NULL;
  },
  isEmpty: (value) => value.e164 === '',
  cells: (value) => [value.e164],
  texts: (block) => configTexts(block, ['placeholder']),
});
