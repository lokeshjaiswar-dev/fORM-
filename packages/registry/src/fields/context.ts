import { CONTEXT_SOURCES } from '@form/schema';
import { defineField } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const LABELS = {
  page_url: PALETTE_LABELS['palette.context.page_url'],
  referrer: PALETTE_LABELS['palette.context.referrer'],
  user_agent: PALETTE_LABELS['palette.context.user_agent'],
  started_at: PALETTE_LABELS['palette.context.started_at'],
  submitted_at: PALETTE_LABELS['palette.context.submitted_at'],
  locale: PALETTE_LABELS['palette.context.locale'],
  time_zone: PALETTE_LABELS['palette.context.time_zone'],
  embed_origin: PALETTE_LABELS['palette.context.embed_origin'],
} as const;

/** FLD-31. Session facts (page URL, referrer, locale, clock) captured on the client, never a third-party pixel. */
export const context = defineField({
  type: 'context',
  kind: 'computed',
  palette: CONTEXT_SOURCES.map((source) =>
    entry(
      'context',
      source === 'page_url' ? null : source,
      'advanced',
      LABELS[source],
      'globe',
      [source.replace(/_/g, ' '), 'session', 'page', 'device'],
      { source },
    )),
  defaultConfig: () => ({ source: 'page_url' as const }),
  paths: { '': 'text' },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => (isRootPath(path) ? { t: 'text', v: value } : NULL),
  isEmpty: (value) => value === '',
  cells: (value) => [value],
  hasDefault: () => true,
});
