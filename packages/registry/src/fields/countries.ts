import type { ChoiceOption, OptionId } from '@form/schema';

/** Common ISO 3166-1 alpha-2 regions for a searchable country list (ids are the codes). */
const NAMES: ReadonlyArray<readonly [string, string]> = [
  ['IN', 'India'], ['US', 'United States'], ['GB', 'United Kingdom'], ['AE', 'United Arab Emirates'], ['SG', 'Singapore'],
  ['AU', 'Australia'], ['CA', 'Canada'], ['DE', 'Germany'], ['FR', 'France'], ['JP', 'Japan'], ['CN', 'China'],
  ['BR', 'Brazil'], ['ZA', 'South Africa'], ['NG', 'Nigeria'], ['KE', 'Kenya'], ['PK', 'Pakistan'], ['BD', 'Bangladesh'],
  ['LK', 'Sri Lanka'], ['NP', 'Nepal'], ['MY', 'Malaysia'], ['ID', 'Indonesia'], ['TH', 'Thailand'], ['PH', 'Philippines'],
  ['VN', 'Vietnam'], ['KR', 'South Korea'], ['NZ', 'New Zealand'], ['IE', 'Ireland'], ['NL', 'Netherlands'], ['SE', 'Sweden'],
  ['CH', 'Switzerland'], ['IT', 'Italy'], ['ES', 'Spain'], ['MX', 'Mexico'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'],
  ['BH', 'Bahrain'], ['KW', 'Kuwait'], ['OM', 'Oman'], ['EG', 'Egypt'], ['TR', 'Türkiye'],
];

export const COUNTRY_OPTIONS: ChoiceOption[] = NAMES.map(([id, label]) => ({ id: id as OptionId, label }));
