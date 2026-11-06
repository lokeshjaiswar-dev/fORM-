import { defineBlock } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { entry } from './shared.ts';

/** FLD-29. Platform proof-of-work by default; third-party widgets stay config-only until hosted. */
export const captcha = defineBlock({
  type: 'captcha',
  kind: 'transient',
  palette: [entry('captcha', null, 'advanced', PALETTE_LABELS['palette.captcha'], 'shield', ['captcha', 'spam', 'robot', 'bot', 'honeypot'])],
  defaultConfig: () => ({ provider: 'platform_default' as const }),
  texts: () => [],
  content: () => [],
});
