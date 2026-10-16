import type { CSSProperties } from 'react';
import type { FormBlock } from '@/types/form';


export function labelStyle(block: FormBlock): CSSProperties {
  const c = block.customize;
  return {
    color: c?.labelColor || undefined,
    fontSize: c?.labelSize ? `${c.labelSize}px` : undefined,
    fontWeight: c?.labelWeight,
    textAlign: c?.align,
  };
}

export function inputStyle(block: FormBlock): CSSProperties {
  const c = block.customize;
  return {
    color: c?.inputTextColor || undefined,
    backgroundColor: c?.inputBg || undefined,
    borderColor: c?.borderColor || undefined,
    fontSize: c?.inputSize ? `${c.inputSize}px` : undefined,
    textAlign: c?.align,
  };
}
