import type { DecimalString, ScalarValue } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { NUMBER_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const asText = (value: ScalarValue): string => {
  if (value.t === 'null') return '';
  if (value.t === 'number' || value.t === 'text' || value.t === 'date' || value.t === 'time' || value.t === 'boolean') return String(value.v);
  if (value.t === 'money') return value.v;
  return '';
};

/** FLD-33. The value is produced by capture from `expr` (a literal or another field's answer in P0). */
export const calculation = defineField({
  type: 'calculation',
  kind: 'computed',
  palette: [
    entry('calculation', null, 'advanced', PALETTE_LABELS['palette.calculation'], 'hash', ['formula', 'total', 'sum', 'calculate', 'arithmetic']),
    entry('calculation', 'count', 'advanced', PALETTE_LABELS['palette.calculation.count'], 'hash', ['count', 'rows', 'how many', 'total rows']),
  ],
  defaultConfig: () => ({
    expr: { k: 'lit', value: { type: 'number', value: '0' as DecimalString } },
    resultType: 'number' as const,
    display: 'visible' as const,
  }),
  paths: { '': 'number' },
  operators: { number: NUMBER_OPS },
  toScalar: (value, path) => (isRootPath(path) ? (value.t === 'null' ? NULL : value) : NULL),
  isEmpty: (value) => value.t === 'null' || asText(value) === '',
  cells: (value) => [asText(value)],
  hasDefault: () => true,
});

