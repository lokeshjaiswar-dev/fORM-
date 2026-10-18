import { configTexts, defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { asciiLower } from '../util/text.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const domainOf = (address: string): string => asciiLower(address.slice(address.lastIndexOf('@') + 1));
const normalizeDomain = (domain: string): string => asciiLower(domain.trim().replace(/^@/, ''));

/**
 * FLD-04 (basic). Format comes from the answer twin; free-provider and disposable lists, confirmation
 * and OTP are server or @form/validation checks.
 */
export const email = defineField({
  type: 'email',
  palette: [entry('email', null, 'contact', PALETTE_LABELS['palette.email'], 'mail', ['email', 'mail', 'address', 'contact'])],
  defaultConfig: () => ({}),
  checkAnswer: (value, block, _state, report) => {
    const allowed = block.config.allowedDomains;
    if (allowed?.length && !allowed.map(normalizeDomain).includes(domainOf(value.address))) report('email_domain_blocked', ['address']);
  },
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value.address } : NULL),
  isEmpty: (value) => value.address === '',
  cells: (value) => [value.address],
  texts: (block) => configTexts(block, ['placeholder', 'prefix', 'suffix']),
  hasDefault: (block) => block.config.defaultValue !== undefined,
});
