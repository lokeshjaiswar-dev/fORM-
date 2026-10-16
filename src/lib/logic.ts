import type { FormBlock, LogicOperator } from '@/types/form';

export const LOGIC_OPERATORS: { value: LogicOperator; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'Equals', needsValue: true },
  { value: 'not_equals', label: 'Does not equal', needsValue: true },
  { value: 'contains', label: 'Contains', needsValue: true },
  { value: 'not_contains', label: 'Does not contain', needsValue: true },
  { value: 'starts_with', label: 'Starts with', needsValue: true },
  { value: 'ends_with', label: 'Ends with', needsValue: true },
  { value: 'greater_than', label: 'Greater than', needsValue: true },
  { value: 'less_than', label: 'Less than', needsValue: true },
  { value: 'answered', label: 'Is answered', needsValue: false },
  { value: 'not_answered', label: 'Is not answered', needsValue: false },
  { value: 'is_empty', label: 'Is empty', needsValue: false },
];

export function operatorNeedsValue(op?: LogicOperator) {
  return LOGIC_OPERATORS.find((o) => o.value === op)?.needsValue ?? true;
}

export function isBlockVisible(block: FormBlock, values: Record<string, unknown>, blocks: FormBlock[]) {
  const logic = block.logic;
  if (!logic?.enabled || !logic.sourceBlockId) return true;
  const raw = values[logic.sourceBlockId];
  const source = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '');
  const target = logic.value ?? '';
  const op = logic.operator ?? 'equals';
  const src = source.trim();
  const srcL = src.toLowerCase();
  const tgtL = target.toLowerCase();
  const nSrc = Number(src);
  const nTgt = Number(target);

  let matched = false;
  switch (op) {
    case 'equals':
      matched = src === target;
      break;
    case 'not_equals':
      matched = src !== target;
      break;
    case 'contains':
      matched = srcL.includes(tgtL);
      break;
    case 'not_contains':
      matched = !srcL.includes(tgtL);
      break;
    case 'starts_with':
      matched = srcL.startsWith(tgtL);
      break;
    case 'ends_with':
      matched = srcL.endsWith(tgtL);
      break;
    case 'greater_than':
      matched = Number.isFinite(nSrc) && Number.isFinite(nTgt) ? nSrc > nTgt : src > target;
      break;
    case 'less_than':
      matched = Number.isFinite(nSrc) && Number.isFinite(nTgt) ? nSrc < nTgt : src < target;
      break;
    case 'answered':
      matched = src.length > 0;
      break;
    case 'not_answered':
    case 'is_empty':
      matched = src.length === 0;
      break;
    default:
      matched = src === target;
  }

  const show = logic.action !== 'hide';
  void blocks;
  return show ? matched : !matched;
}
